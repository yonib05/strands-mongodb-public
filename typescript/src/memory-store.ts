import {
  type ExtractionConfig,
  type Logger,
  type MemoryEntry,
  type MemoryStore,
  type SearchOptions,
  StorageError,
} from '@strands-agents/sdk'
import type { Embedder } from '@strands-agents/sdk/storage/search'
import { type Collection, type Document, MongoError } from 'mongodb'
import { type Capabilities, type Connection, resolve } from './client.js'
import { validate } from './filter.js'
import {
  checkTtl,
  declaredFilterFields,
  ensure,
  memorySearchSpecs,
  memorySpecs,
  rankFusionSupport,
  READY_TIMEOUT_SECONDS,
  requireBinaryComparison,
  SearchIndexNotReady,
  type SearchIndexSpec,
  searchSupport,
  vectorMode,
} from './indexes.js'
import { defaultLogger, logFields } from './logging.js'
import { annotate, type SpanBase, traced } from './telemetry.js'
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  type MongoDBConfig,
  type MongoDBMemoryStoreConfig,
  type MongoDBSearchQuery,
  type ResolvedSearchType,
  type SearchType,
  type VectorMode,
} from './types.js'

/** Collection this store uses when the config names none. Not `storage`: a vector index must never see session blobs. */
export const DEFAULT_COLLECTION = 'memory'

/** Scope stamped on writes and filtered on by reads when the config names none, so an unconfigured store still filters. */
export const UNSCOPED = '__unscoped__'

/** Delay in seconds before a search tier skipped under `auto` is tried again, inside the first store call after it. */
export const TIER_RETRY_SECONDS = 60

/** Ceiling in seconds on that delay, which doubles after each retry that still finds the tier missing. */
export const TIER_RETRY_MAX_SECONDS = 3600

const MISSING_CONFIG =
  "strands_mongodb: the memory store configuration has no 'config'. Set it to the MongoDBConfig naming the 'database' and a 'connectionString' or 'client'."

const MISSING_NAME =
  "strands_mongodb: the memory store configuration has no 'name'. The SDK's MemoryManager targets stores by name, so set it to a name unique among the stores an agent holds."

const MISSING_DATABASE =
  "strands_mongodb: the connection config has no 'database'. Set it to the name of the database holding this store's collection."

const EMBEDDER_ON_AUTO_EMBED =
  "strands_mongodb: 'embedder' is set, but this store is on the Atlas AutoEmbeddings path, where the deployment embeds the text. Remove 'embedder', or set 'embeddingDimensions' and 'similarity' in the connection config to embed client-side."

/** Where a search limit may come from, highest priority first. */
export interface Limits {
  /** `limit` from a `MongoDBSearchQuery`, if one was passed. */
  query?: number | undefined
  /** `maxSearchResults` from this call's `SearchOptions`. */
  options?: number | undefined
  /** The store's own `maxSearchResults`. */
  instance?: number | undefined
}

/**
 * Resolves the result limit for one search. Every supplied value is checked, not only the winner.
 *
 * @param limits - The candidates; `query` ranks above `options` because it only arrives on a direct call
 * @returns The highest-priority value supplied, or `DEFAULT_MAX_SEARCH_RESULTS`
 * @throws RangeError if any supplied value is below 1, naming the key it came from
 */
export function resolveLimit(limits: Limits): number {
  const supplied: Array<[string, number | undefined]> = [
    ['limit', limits.query],
    ['maxSearchResults', limits.options],
    ['maxSearchResults', limits.instance],
  ]
  for (const [name, value] of supplied) {
    if (value !== undefined && value < 1) {
      throw new RangeError(
        `strands_mongodb: '${name}' is ${value}, and a search limit must be at least 1. A limit below 1 cannot return anything, so it is rejected here rather than sent to a server that would reject it.`
      )
    }
  }
  return limits.query ?? limits.options ?? limits.instance ?? DEFAULT_MAX_SEARCH_RESULTS
}

// `Promise.any` with a boolean outcome: `true` on the first wait that settles ready, `false` once every wait has failed.
function anyReady(waits: Promise<void>[]): Promise<boolean> {
  return Promise.any(waits).then(
    () => true,
    () => false
  )
}

/**
 * A Strands `MemoryStore` backed by MongoDB Atlas Vector Search and Atlas Search.
 *
 * Every read, write and delete is limited to this store's `scope` and `name`, which the package stamps and
 * filters itself and never takes from caller input. A store accepts writes only when `writable` is `true`.
 *
 * @example
 * ```typescript
 * const connection: MongoDBConfig = { database: 'agents', connectionString: 'mongodb+srv://...' }
 * const store = new MongoDBMemoryStore({ name: 'preferences', config: connection, scope: 'user-abc' })
 * ```
 */
export class MongoDBMemoryStore implements MemoryStore {
  readonly name: string
  readonly description?: string
  readonly maxSearchResults?: number
  readonly writable: boolean
  readonly extraction?: boolean | ExtractionConfig
  readonly scope: string
  readonly filter?: Record<string, unknown>
  readonly minScore?: number
  readonly maxScore?: number
  readonly ttlSeconds?: number
  // Non-enumerable, so `util.inspect` and `JSON.stringify` of a store never render the connection string.
  declare private readonly _config: MongoDBMemoryStoreConfig
  declare private readonly _connectionConfig: MongoDBConfig
  private readonly _databaseName: string
  private readonly _collectionName: string
  private readonly _ensureIndexes: boolean
  private readonly _indexReadyTimeout: number
  private readonly _searchType: SearchType
  private readonly _declaredFields: string[]
  private readonly _mode: VectorMode
  private readonly _embedder: Embedder | undefined
  // Vector first, the order `auto` falls back through. A named type keeps only its own tier; `hybrid` keeps both.
  private readonly _specs: Array<[ResolvedSearchType, SearchIndexSpec]>
  private readonly _indexNames: Partial<Record<ResolvedSearchType, string>>
  // Whether a query may set both `text` and `vector`: only on the manual path, where `vector` has a meaning.
  private readonly _fusionPossible: boolean
  private readonly _logger: Logger
  private _initialized = false
  // The tiers that can answer, in preference order. Empty after `initialize()` means no Atlas Search.
  private _tiers: ResolvedSearchType[] = []
  private _warnedBelowVector = false
  // Epoch milliseconds of the next retry of a skipped tier, or `undefined` when none is skipped.
  private _tierRetryAt: number | undefined
  private _tierRetryDelay = TIER_RETRY_SECONDS
  private _waitedForATier = false
  // The first search's wait for a build, shared by the searches that arrive during it.
  private _tierWait: Promise<void> | undefined
  private _capabilities: Capabilities | undefined

  /**
   * @param config - The store's own fields plus the connection config under `config`
   * @throws TypeError if `name`, `config` or `config.database` is missing, both score bounds are set, the
   * configured `filter` is invalid, the vector keys contradict each other, or `embedder` is set on the
   * AutoEmbeddings path
   * @throws RangeError if `ttlSeconds` is negative or `maxSearchResults` is below 1
   */
  constructor(config: MongoDBMemoryStoreConfig) {
    // Every check runs before `resolve`, so a config that fails leaves no connection pool behind.
    const connection = config.config
    if (connection === undefined) throw new TypeError(MISSING_CONFIG)
    if (config.name === undefined) throw new TypeError(MISSING_NAME)
    if (connection.database === undefined) throw new TypeError(MISSING_DATABASE)
    this.name = config.name
    if (config.description !== undefined) this.description = config.description
    if (config.maxSearchResults !== undefined) this.maxSearchResults = config.maxSearchResults
    // `false` by default, unlike `FileMemoryStore`, because `writable` also gates automatic extraction.
    this.writable = config.writable ?? false
    if (config.extraction !== undefined) this.extraction = config.extraction
    this.scope = config.scope || UNSCOPED
    if (config.filter !== undefined) this.filter = config.filter
    if (config.minScore !== undefined) this.minScore = config.minScore
    if (config.maxScore !== undefined) this.maxScore = config.maxScore
    if (config.ttlSeconds !== undefined) this.ttlSeconds = config.ttlSeconds
    checkTtl(this.ttlSeconds)
    resolveLimit({ instance: this.maxSearchResults })
    if (this.minScore !== undefined && this.maxScore !== undefined) {
      throw new TypeError(
        `strands_mongodb: 'minScore' is ${this.minScore} and 'maxScore' is ${this.maxScore}, and the two are mutually exclusive: a floor and a ceiling on one similarity score describe a band, and this package applies one bound rather than a range. Keep whichever one you meant and remove the other.`
      )
    }

    this._databaseName = connection.database
    this._collectionName = config.collection ?? DEFAULT_COLLECTION
    this._ensureIndexes = connection.ensureIndexes ?? true
    this._indexReadyTimeout = connection.indexReadyTimeout ?? READY_TIMEOUT_SECONDS
    this._searchType = connection.searchType || 'auto'
    // The index definition decides what is filterable, so configured and per-query filters share one list.
    this._declaredFields = declaredFilterFields(connection.filterFields ?? [])
    if (this.filter !== undefined && Object.keys(this.filter).length > 0) {
      validate(this.filter, { declaredFields: this._declaredFields })
    }

    this._mode = vectorMode(connection)
    this._embedder = config.embedder
    if (this._embedder !== undefined && this._mode.autoEmbed) throw new TypeError(EMBEDDER_ON_AUTO_EMBED)
    const [vectorSpec, textSpec] = memorySearchSpecs(connection)
    const specs: Array<[ResolvedSearchType, SearchIndexSpec]> = [
      ['vector', vectorSpec!],
      ['text', textSpec!],
    ]
    const searchType = this._searchType
    this._specs =
      searchType === 'auto' || searchType === 'hybrid' ? specs : specs.filter(([tier]) => tier === searchType)
    this._indexNames = Object.fromEntries(this._specs.map(([tier, spec]) => [tier, spec.name]))
    this._fusionPossible = !this._mode.autoEmbed && (searchType === 'auto' || searchType === 'hybrid')

    Object.defineProperty(this, '_config', { value: config, enumerable: false })
    Object.defineProperty(this, '_connectionConfig', { value: connection, enumerable: false })
    this._logger = connection.logger ?? defaultLogger
    // Called only to fail fast on a config with no client or connection string.
    resolve(connection)
  }

  /**
   * Probes the deployment and creates this store's indexes. Idempotent and safe to call concurrently; after
   * the first call it returns at once unless a tier skipped under `auto` is due for a retry.
   *
   * Under `auto` this never waits for an index build: building tiers are skipped and retried with backoff.
   * A named `searchType` waits for its index, up to `indexReadyTimeout`. On a deployment without Atlas Search
   * this logs a warning once per connection, and writes still work.
   *
   * @throws StorageError if a driver call fails, the collection's collation is not binary, an existing index
   * conflicts, an index is missing and `ensureIndexes` is `false`, or `searchType` names a tier the deployment
   * cannot prepare
   */
  async initialize(): Promise<void> {
    if (this._initialized && !this._tierRetryDue()) return
    await this._run('initialize', 'initializing', () => this._initialize())
  }

  /**
   * Searches this store's scope. Implemented with the other operations.
   *
   * @param _query - A plain string, or a `MongoDBSearchQuery`
   * @param _options - The SDK's per-call options
   * @returns The matching entries, best first
   */
  async search(_query: string | MongoDBSearchQuery, _options?: SearchOptions): Promise<MemoryEntry[]> {
    throw new Error('not implemented')
  }

  private _tierRetryDue(): boolean {
    return this._tierRetryAt !== undefined && Date.now() >= this._tierRetryAt
  }

  // Split from the unlocked fast path so calls that find the work done record no span.
  private async _initialize(): Promise<void> {
    annotate('strands_mongodb.search.requested', this._searchType, this._logger)
    // Bound once, so the lock, the probe and the cache write all use the same connection.
    const connection = this._connection
    await connection.locked(async () => {
      if (this._initialized) {
        if (this._tierRetryDue()) await this._retrySearchTiers()
        return
      }
      const collection = this._collection()
      const target = this._target

      // Before any index is created: a case-folding collation would let one scope read another's documents.
      let verified = connection.binaryKeys.has(target)
      if (!verified) {
        verified = await requireBinaryComparison(collection, this._logger)
        if (verified) connection.binaryKeys.add(target)
      }

      const capabilities = await this._probe(connection, collection)
      // Ordinary indexes always, search or not: they include the unique index behind `add`'s deduplication.
      await ensure(collection, {
        ordinary: memorySpecs(),
        create: this._ensureIndexes,
        timeout: this._indexReadyTimeout,
        logger: this._logger,
      })

      this._capabilities = capabilities
      // `auto` can answer from another tier and retries skipped ones, so it never blocks on a build under the lock.
      const timeout = this._searchType === 'auto' ? 0 : this._indexReadyTimeout
      this._tiers = capabilities.search
        ? await this._ensureSearchTiers(collection, { rankFusion: capabilities.rankFusion, timeout })
        : []
      if (capabilities.search && this._missingATier(this._tiers)) {
        this._tierRetryAt = Date.now() + this._tierRetryDelay * 1000
      }

      // An absent collection could not be verified above; creating the indexes created it, so check it now.
      if (!verified && (await requireBinaryComparison(collection, this._logger))) connection.binaryKeys.add(target)

      annotate('strands_mongodb.search.tiers', this._tiers.join(','), this._logger)
      this._initialized = true
    })
  }

  // Search support belongs to the deployment, so stores sharing a connection probe once.
  private async _probe(connection: Connection, collection: Collection): Promise<Capabilities> {
    const cached = connection.capabilities
    if (cached !== undefined) return cached
    const support = await searchSupport(collection, this._logger)
    // Only where search exists: hybrid needs both search tiers, so without them the version changes nothing.
    const rankFusion = support.available ? await rankFusionSupport(collection, this._logger) : false
    const capabilities: Capabilities = { search: support.available, rankFusion }
    if (support.code !== undefined) capabilities.noSearchCode = support.code
    connection.capabilities = capabilities
    if (!capabilities.search) {
      this._logger.warn(
        `strands_mongodb: ${this._target} is on a deployment that does not run Atlas Search, so no search index was created and no query can be answered here. The server reported error code ${capabilities.noSearchCode} when asked to list its search indexes. Ordinary indexes and writes are unaffected, so this store can hold memories and cannot read them back. Point 'connectionString' at MongoDB Atlas, or at a local Atlas deployment started with 'atlas deployments setup --type local', which runs the same search process. | ${logFields('no_search_setup', { namespace: this._target })}`
      )
    }
    return capabilities
  }

  // A retry that fails, or still finds a tier missing, keeps the tiers the store has and doubles the delay.
  private async _retrySearchTiers(options: { waited?: boolean } = {}): Promise<void> {
    const rankFusion = this._capabilities?.rankFusion ?? false
    let tiers: ResolvedSearchType[] | undefined
    try {
      tiers = await this._ensureSearchTiers(this._collection(), { rankFusion, timeout: 0, waited: options.waited })
    } catch (error) {
      if (!(error instanceof StorageError)) throw error
    }
    if (tiers !== undefined) this._tiers = tiers
    if (tiers === undefined || this._missingATier(tiers)) {
      this._tierRetryDelay = Math.min(this._tierRetryDelay * 2, TIER_RETRY_MAX_SECONDS)
      this._tierRetryAt = Date.now() + this._tierRetryDelay * 1000
    } else {
      this._tierRetryAt = undefined
    }
    annotate('strands_mongodb.search.tiers', this._tiers.join(','), this._logger)
  }

  // Waits, outside the connection's lock, until the first tier `initialize()` skipped is ready. Callers share one wait.
  private _waitForATier(): Promise<void> {
    let wait = this._tierWait
    if (wait === undefined) {
      wait = this._waitForTheFirstReadyTier().finally(() => {
        if (this._tierWait === wait) this._tierWait = undefined
      })
      this._tierWait = wait
    }
    return wait
  }

  // Every tier is waited on together, so a quick text build is not held behind a slow vector one.
  private async _waitForTheFirstReadyTier(): Promise<void> {
    const collection = this._collection()
    const waits = this._specs.map(([, spec]) =>
      ensure(collection, {
        search: [spec],
        create: this._ensureIndexes,
        timeout: this._indexReadyTimeout,
        logger: this._logger,
      })
    )
    const ready = await anyReady(waits)
    await this._retrySearchTiers({ waited: !ready })
    this._waitedForATier = true
  }

  // Whether `auto` skipped a configured tier, which is the only case a retry is for.
  private _missingATier(tiers: ResolvedSearchType[]): boolean {
    return this._searchType === 'auto' && this._specs.some(([tier]) => !tiers.includes(tier))
  }

  // One `ensure` per tier, so a failing vector index does not stop the text index from being created.
  private async _ensureSearchTiers(
    collection: Collection,
    options: { rankFusion: boolean; timeout: number; waited?: boolean | undefined }
  ): Promise<ResolvedSearchType[]> {
    const { rankFusion, timeout, waited = false } = options
    const available: ResolvedSearchType[] = []
    let refused: StorageError | undefined
    let building = false
    for (const [tier, spec] of this._specs) {
      try {
        await ensure(collection, { search: [spec], create: this._ensureIndexes, timeout, logger: this._logger })
      } catch (error) {
        // A named `searchType` has nothing to fall through to: answering from another tier would change what matches.
        if (!(error instanceof StorageError) || this._searchType !== 'auto') throw error
        this._logSkippedTier(tier, error, timeout === 0 && !waited)
        refused = error
        building ||= error instanceof SearchIndexNotReady
        continue
      }
      available.push(tier)
    }

    if (available.length === 0 && building) return []
    if (available.length === 0) {
      // Chained to the last failure so the reason reaches callers who do not log at `warn`.
      throw new StorageError(
        `strands_mongodb: 'searchType' is 'auto' and no search tier could be prepared on ${this._target}, so no query can be answered. The last tier's failure is chained to this one and every tier's is logged above, each with the server's own reason.`,
        { cause: refused }
      )
    }

    if (this._hybridIsAvailable(available, rankFusion)) {
      // Under `auto` the single tiers stay as fallbacks for queries that set only one key.
      if (this._searchType === 'hybrid') return ['hybrid']
      available.unshift('hybrid')
    } else if (this._searchType === 'hybrid') {
      throw new StorageError(
        `strands_mongodb: 'searchType' is 'hybrid' but ${this._target} cannot run it. The hybrid tier is a $rankFusion over the vector and text pipelines, and that stage needs MongoDB 8.0 or later. Upgrade the deployment, or set 'searchType' to 'auto' to let this store resolve to the tiers it does have.`
      )
    }

    const first = available[0]!
    if (this._searchType === 'auto' && first !== 'hybrid' && first !== 'vector' && !this._warnedBelowVector) {
      this._warnedBelowVector = true
      this._logger.warn(
        `strands_mongodb: 'searchType' is 'auto' and the vector tier is not available on ${this._target}, so queries resolve to the ${first} tier. Answers are lexical rather than semantic, which is a difference in what matches rather than only in ranking. | ${logFields('below_vector', { namespace: this._target, tier: first })}`
      )
    }
    return available
  }

  // `info` for an index nobody has waited for yet, which is every fresh store, else `warn`.
  private _logSkippedTier(tier: ResolvedSearchType, error: StorageError, building: boolean): void {
    const message = `strands_mongodb: the ${tier} search tier is not available on ${this._target} and 'searchType' is 'auto', so it is skipped rather than fatal and any remaining tier answers queries instead. The '_searchType' key on every returned entry reports which one did. The server's own reason: ${error.message}`
    if (building && error instanceof SearchIndexNotReady) {
      this._logger.info(`${message} | ${logFields('tier_building', { namespace: this._target, tier })}`)
      return
    }
    this._logger.warn(`${message} | ${logFields('tier_unavailable', { namespace: this._target, tier })}`)
  }

  // Hybrid needs `$rankFusion`, both single tiers, and under `auto` no score bound: fused scores top out near
  // 0.033 while cosine scores land in roughly 0 to 1, so a bound meant for one would empty the other.
  private _hybridIsAvailable(available: ResolvedSearchType[], rankFusion: boolean): boolean {
    if (!rankFusion || !available.includes('vector') || !available.includes('text')) return false
    const bound = this.minScore !== undefined ? 'minScore' : this.maxScore !== undefined ? 'maxScore' : undefined
    // An explicit `hybrid` applies the bound on the fused scale, as documented, so it needs no warning.
    if (bound === undefined || this._searchType === 'hybrid') return true
    this._logger.warn(
      `strands_mongodb: 'searchType' is 'auto' and ${this._target} can run the hybrid tier, but '${bound}' is set to ${this[bound]} and the two are on different scales, so queries resolve to the vector tier as they did before hybrid existed. Reciprocal rank fusion scores sum to about 0.033 at best, while cosine scores land in roughly 0 to 1. Remove the bound to get fused ranking, or set 'searchType' to 'hybrid' to keep the bound and have it applied on the fusion's scale. | ${logFields('bound_declined_fusion', { namespace: this._target, tier: 'hybrid' })}`
    )
    return false
  }

  private _run<T>(operation: string, verb: string, fn: () => Promise<T>): Promise<T> {
    return traced('memory', operation, this._spanBase(), () => this._reporting(verb, fn))
  }

  // The message names only the namespace: the subject of a memory operation is user content.
  private async _reporting<T>(verb: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (!(error instanceof MongoError)) throw error
      throw new StorageError(`strands_mongodb: ${verb} ${this._target} failed: ${error.message}`, { cause: error })
    }
  }

  private _spanBase(): SpanBase {
    return {
      database: this._databaseName,
      collection: this._collectionName,
      storeName: this.name,
      logger: this._logger,
    }
  }

  private get _target(): string {
    return `${this._databaseName}.${this._collectionName}`
  }

  // Resolved on each access, never stored: after `close()` the next operation opens a fresh pool.
  private get _connection(): Connection {
    return resolve(this._connectionConfig)
  }

  private _collection(): Collection<Document> {
    return this._connection.client.db(this._databaseName).collection<Document>(this._collectionName)
  }
}
