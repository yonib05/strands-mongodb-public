import { createHash } from 'node:crypto'
import {
  type ExtractionConfig,
  type JSONValue,
  type Logger,
  type MemoryEntry,
  type MemoryStore,
  type SearchOptions,
  StorageError,
  type Tool,
} from '@strands-agents/sdk'
import type { Embedder } from '@strands-agents/sdk/storage/search'
import { BSON, type Collection, type Document, MongoError, MongoServerError, ObjectId } from 'mongodb'
import { type Capabilities, close as release, type Connection, resolve } from './client.js'
import { compose, validate } from './filter.js'
import {
  checkTtl,
  CONTENT_FIELD,
  declaredFilterFields,
  embed,
  ensure,
  EXPIRES_FIELD,
  memorySearchSpecs,
  memorySpecs,
  rankFusionSupport,
  READY_TIMEOUT_SECONDS,
  requireBinaryComparison,
  SearchIndexNotReady,
  type SearchIndexSpec,
  searchSupport,
  VECTOR_FIELD,
  vectorMode,
} from './indexes.js'
import { defaultLogger, logFields } from './logging.js'
import { checkQueryKeys, hybridStages, SCORE_FIELD, textStages, vectorStages } from './pipeline.js'
import { annotate, type SpanBase, traced } from './telemetry.js'
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  type MongoDBAddResult,
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

// The server's code for a unique index violation, which a concurrent upsert losing the insert race reports.
const DUPLICATE_KEY = 11000

/** The query keys a search may carry, as the caller set them. */
interface QueryKeys {
  queryText?: string | undefined
  queryVector?: number[] | undefined
}

/** What one search needs to build its stages once the tier is chosen. */
interface StageInputs extends QueryKeys {
  queryFilter: Record<string, unknown>
  limit: number
  oversamplingFactor?: number | undefined
}

function notWritable(name: string, call: string): string {
  return `strands_mongodb: the memory store '${name}' is not writable, so it does not accept ${call}. Set 'writable': true in its configuration to enable writes. It defaults to false so that a store built for retrieval does not start accepting model-distilled extraction writes, or deletions, that nobody asked for.`
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// Strict, with no fallback to matching the raw string, so a malformed id throws instead of quietly deleting nothing.
function objectId(memoryId: unknown): ObjectId {
  if (typeof memoryId !== 'string' || !/^[0-9a-f]{24}$/i.test(memoryId) || !ObjectId.isValid(memoryId)) {
    const rendered = typeof memoryId === 'string' ? `'${memoryId}'` : String(memoryId)
    throw new TypeError(
      `strands_mongodb: 'memoryId' is ${rendered}, which is not a 24-character hex ObjectId. Pass the '_id' a search result carries in its metadata, which is where a deletable id comes from.`
    )
  }
  return new ObjectId(memoryId)
}

// Drops the absent keys, so the pipeline builders see a key only when the caller set it.
function present(keys: QueryKeys): { queryText?: string; queryVector?: number[] } {
  return {
    ...(keys.queryText !== undefined && { queryText: keys.queryText }),
    ...(keys.queryVector !== undefined && { queryVector: keys.queryVector }),
  }
}

/**
 * Merges a document's stored metadata with this package's reserved keys, the reserved keys winning.
 *
 * @param caller - `metadata` as the document carries it, or `undefined` when it carries none
 * @param reserved - The reserved keys and their values for this result
 * @param context - The store and namespace named in the collision log, and the logger it goes to
 * @returns A new object holding only JSON: stored BSON values are rendered as relaxed EJSON
 */
export function mergeMetadata(
  caller: Document | undefined,
  reserved: Record<string, JSONValue>,
  context: { storeName: string; namespace: string; logger: Logger }
): Record<string, JSONValue> {
  // Relaxed EJSON, so a stored `Date` or `ObjectId` reaches the caller as JSON rather than as an object the type cannot hold.
  const merged = BSON.EJSON.serialize(caller ?? {}, { relaxed: true }) as Record<string, JSONValue>
  const collisions = Object.keys(reserved)
    .filter((key) => Object.hasOwn(merged, key))
    .sort()
  if (collisions.length > 0) {
    context.logger.warn(
      `strands_mongodb: metadata key(s) ${collisions.map((key) => `'${key}'`).join(', ')} on a document in the memory store '${context.storeName}' collide with the keys this package sets on every result, so the stored value(s) were dropped from the returned entry and this package's own value(s) kept. Rename them in whatever wrote them; a stored '_scope' that won would make a document report a scope it was not stored in. | ${logFields('reserved_key_collision', { namespace: context.namespace })}`
    )
  }
  return { ...merged, ...reserved }
}

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
   * Stores one memory in this store's scope, at most once: the same content again keeps one document.
   *
   * @param content - The memory to store, verbatim; never included in an error or a log line
   * @param metadata - Optional caller metadata, stored nested and returned by `search`
   * @returns The document id with the insert and duplicate counts; a duplicate reports the existing id
   * @throws TypeError if this store is not writable, before any network call
   * @throws RangeError if `embedder` returns a vector whose length is not `embeddingDimensions`
   * @throws StorageError if `initialize()` fails or a driver call fails
   */
  add(content: string, metadata?: Record<string, JSONValue>): Promise<MongoDBAddResult> {
    return this._run('add', 'adding a memory to', async () => {
      // Before `initialize()`, so a read-only store rejects a write without connecting or creating an index.
      if (!this.writable) throw new TypeError(notWritable(this.name, 'add()'))
      await this.initialize()
      // Before the upsert, so a failed embedding stores nothing rather than a memory no vector search finds.
      const vector = this._embedder === undefined ? undefined : await this._embed(content)

      // The server copies a selector's equality fields onto an inserted document; they are also the unique index's key.
      const selector = { scope: this.scope, store_name: this.name, content_hash: contentHash(content) }
      // `$setOnInsert`, not `$set`: a duplicate keeps its first-seen timestamp and expiry.
      const createdAt = new Date()
      const insert: Document = { [CONTENT_FIELD]: content, created_at: createdAt }
      // Nested, never merged into the root, so a caller's `scope` key cannot write into another scope.
      if (metadata !== undefined && Object.keys(metadata).length > 0) insert.metadata = { ...metadata }
      if (vector !== undefined) insert[VECTOR_FIELD] = vector
      if (this.ttlSeconds !== undefined) insert[EXPIRES_FIELD] = new Date(createdAt.getTime() + this.ttlSeconds * 1000)

      const collection = this._collection()
      let result
      try {
        result = await collection.updateOne(selector, { $setOnInsert: insert }, { upsert: true })
      } catch (error) {
        // Two concurrent upserts both inserted and this one lost; the memory is stored, so report the winner's document.
        if (error instanceof MongoServerError && error.code === DUPLICATE_KEY)
          return this._existing(collection, selector)
        throw error
      }
      if (result.upsertedId === null) return this._existing(collection, selector)
      annotate('strands_mongodb.duplicate', false, this._logger)
      return { ids: [String(result.upsertedId)], inserted: 1, duplicates: 0 }
    })
  }

  /**
   * Returns the memories that best match a query, most relevant first, from the first prepared tier that fits it.
   *
   * @param query - A plain string, or a `MongoDBSearchQuery` carrying `text`, `vector`, `filter`, `limit`, `oversamplingFactor`
   * @param options - The SDK's per-call options; a query's `limit` wins over `maxSearchResults`
   * @returns Up to the resolved limit of entries, each with `_id`, `_relevanceScore`, `_searchType` and `_scope` in its metadata
   * @throws TypeError if the query sets neither or both vector keys where nothing fuses them, the filter is invalid,
   * or no prepared tier fits the query's shape
   * @throws RangeError if a limit is below 1, or the candidate count is out of bounds
   * @throws StorageError if the deployment cannot search, no tier is ready, `initialize()` fails, or a driver call fails
   */
  search(query: string | MongoDBSearchQuery, options?: SearchOptions): Promise<MemoryEntry[]> {
    return this._run('search', 'searching', async () => {
      // First, so a search that fails early still records what was requested.
      annotate('strands_mongodb.search.requested', this._searchType, this._logger)
      const parts: MongoDBSearchQuery = typeof query === 'string' ? { text: query } : query
      let queryText = parts.text
      let queryVector = parts.vector
      const callerFilter = parts.filter

      const limit = resolveLimit({
        query: parts.limit,
        options: options?.maxSearchResults,
        instance: this.maxSearchResults,
      })
      // Only the mode-independent check; `vectorStages` runs the rest once the tier is known.
      checkQueryKeys({ ...present({ queryText, queryVector }), fusionPossible: this._fusionPossible })
      if (callerFilter !== undefined && Object.keys(callerFilter).length > 0) {
        validate(callerFilter, { declaredFields: this._declaredFields })
      }
      const queryFilter = compose([this.filter, callerFilter], { scope: this.scope, storeName: this.name })

      await this.initialize()
      if (this._tiers.length === 0 && this._canSearch() && !this._waitedForATier) await this._waitForATier()
      if (this._embedsQuery(queryText, queryVector)) {
        queryVector = await this._embed(queryText!)
        // Kept for hybrid, which feeds `text` to `$search`; anywhere else both keys would be refused.
        if (!this._tiers.includes('hybrid')) queryText = undefined
      }
      const tier = this._pickTier(queryText, queryVector)
      annotate('strands_mongodb.search.tier', tier, this._logger)
      const stages = this._stages(tier, {
        queryText,
        queryVector,
        queryFilter,
        limit,
        oversamplingFactor: parts.oversamplingFactor,
      })

      const documents = await this._collection().aggregate(stages).toArray()
      const scored = documents.map((document): [number, MemoryEntry] => {
        // `?? 0`: a stage that projected nothing yields `null`, which would break the bound comparison.
        const score = Number(document[SCORE_FIELD] ?? 0)
        // `_scope` comes from this store, never from the document, so a document cannot report another scope.
        const metadata = mergeMetadata(
          document.metadata,
          { _id: String(document._id), _relevanceScore: score, _searchType: tier, _scope: this.scope },
          { storeName: this.name, namespace: this._target, logger: this._logger }
        )
        return [score, { content: String(document[CONTENT_FIELD] ?? ''), storeName: this.name, metadata }]
      })

      const results = this._withinBounds(scored)
      annotate('strands_mongodb.result_count', results.length, this._logger)
      return results
    })
  }

  /**
   * Deletes one memory by the `_id` a search result reported, within this store's scope, name and filter.
   *
   * @param memoryId - The `_id` string from a search result's metadata
   * @returns `1` if a document was deleted, `0` if none matched: already gone, another scope, or another store
   * @throws TypeError if this store is not writable, or `memoryId` is not a 24-character hex ObjectId string
   * @throws StorageError if `initialize()` fails or a driver call fails
   */
  delete(memoryId: string): Promise<number> {
    return this._run('delete', 'deleting a memory from', async () => {
      // Writability first, so a read-only store says "not writable" rather than complaining about the id.
      if (!this.writable) throw new TypeError(notWritable(this.name, 'delete()'))
      const _id = objectId(memoryId)

      await this.initialize()
      const predicate = compose([this.filter], { scope: this.scope, storeName: this.name })
      const result = await this._collection().deleteOne({ ...predicate, _id })
      annotate('strands_mongodb.deleted_count', result.deletedCount, this._logger)
      return result.deletedCount
    })
  }

  /**
   * Deletes every memory this store can read: its scope and name, narrowed by any configured `filter`.
   *
   * @returns How many documents the server deleted
   * @throws TypeError if this store is not writable, before any network call
   * @throws StorageError if `initialize()` fails or a driver call fails
   */
  deleteAll(): Promise<number> {
    return this._run('delete_all', 'deleting every memory in', async () => {
      if (!this.writable) throw new TypeError(notWritable(this.name, 'deleteAll()'))

      await this.initialize()
      const predicate = compose([this.filter], { scope: this.scope, storeName: this.name })
      const result = await this._collection().deleteMany(predicate)
      annotate('strands_mongodb.deleted_count', result.deletedCount, this._logger)
      return result.deletedCount
    })
  }

  /**
   * Returns the agent tools this store contributes, which is none.
   *
   * @returns An empty array, which `MemoryManager` extends its tool list by
   */
  getTools(): Tool[] {
    return []
  }

  /**
   * Releases the connection shared by every store built from this config, closing the client only if this
   * package created it. Idempotent; a later operation opens a fresh pool.
   */
  close(): Promise<void> {
    return release(this._connectionConfig)
  }

  // Projects only `_id`, because the caller already has the content.
  private async _existing(collection: Collection<Document>, selector: Document): Promise<MongoDBAddResult> {
    const document = await collection.findOne(selector, { projection: { _id: 1 } })
    annotate('strands_mongodb.duplicate', true, this._logger)
    return { ids: document === null ? [] : [String(document._id)], inserted: 0, duplicates: 1 }
  }

  // Whether `search` should embed `text`: an embedder, no caller vector, and a tier to use it.
  private _embedsQuery(queryText: string | undefined, queryVector: number[] | undefined): boolean {
    if (this._embedder === undefined || queryText === undefined || queryVector !== undefined) return false
    const first = this._tiers[0]
    return first === 'hybrid' || first === 'vector'
  }

  private _embed(text: string): Promise<number[]> {
    // The constructor refuses an embedder on the AutoEmbeddings path, so the mode here is the manual one.
    const mode = this._mode as Extract<VectorMode, { autoEmbed: false }>
    return embed(this._embedder!, text, { dimensions: mode.dimensions, setting: 'embeddingDimensions' })
  }

  // The first prepared tier, in preference order, that fits the query's keys; the result reports the tier that ran.
  private _pickTier(queryText: string | undefined, queryVector: number[] | undefined): ResolvedSearchType {
    if (queryText !== undefined && queryVector !== undefined && !this._tiers.includes('hybrid')) {
      // Thrown rather than answered from one tier, which would silently ignore one of the two keys.
      throw new TypeError(
        `strands_mongodb: this query sets both 'text' and 'vector', which only the hybrid tier reads, and the hybrid tier is not available on ${this._target}. The tiers that are: ${this._tiers.join(', ') || 'none'}. Drop one of the two keys to use one of them, or see the initialization log for why the fused tier was not offered.`
      )
    }

    if (this._tiers.length === 0) {
      const capabilities = this._capabilities
      if (capabilities === undefined || !capabilities.search) {
        // A phrase rather than a bare code, because with no cached probe there is no code to name.
        const code = capabilities?.noSearchCode
        const evidence = code === undefined ? 'no probe result cached' : `server error code ${code}`
        throw new StorageError(
          `strands_mongodb: cannot search ${this._target} because this deployment does not run Atlas Search. Its capability probe came back with ${evidence}, and this package has no tier that answers without a search process, so there is nothing to fall back to. Writes still work, which is why initialize() only warned. Point 'connectionString' at MongoDB Atlas, or at a local Atlas deployment started with 'atlas deployments setup --type local'.`
        )
      }
      throw new StorageError(
        `strands_mongodb: 'searchType' is 'auto' and no search tier on ${this._target} was ready within 'indexReadyTimeout', so no query can be answered yet. Each tier's status is logged above. The tiers are retried with backoff, and searches raise until one is ready.`
      )
    }

    for (const tier of this._tiers) {
      // Hybrid needs `text` for `$search` and the vector path's own key, which with AutoEmbeddings is `text` again.
      if (tier === 'hybrid' && queryText !== undefined && this._vectorKey(queryText, queryVector) !== undefined) {
        return 'hybrid'
      }
      if (tier === 'text' && queryText !== undefined) return 'text'
      if (tier === 'vector' && this._vectorKey(queryText, queryVector) !== undefined) return 'vector'
    }

    const [needed, because] = this._mode.autoEmbed
      ? ["'text'", 'the deployment embeds it on the Atlas AutoEmbeddings path']
      : ["'vector'", "'embeddingDimensions' and 'similarity' select the manual-vector path"]
    throw new TypeError(
      `strands_mongodb: this query cannot be answered by any search tier prepared on ${this._target}, which is: ${this._tiers.join(', ')}. The text tier needs 'text' on the query. The vector tier needs ${needed}, because ${because}. Supply that key, or set 'searchType' to a tier this query fits.`
    )
  }

  // Whichever query key the vector tier reads on this store's path: AutoEmbeddings embeds `text`, the manual path takes `vector`.
  private _vectorKey(queryText: string | undefined, queryVector: number[] | undefined): string | number[] | undefined {
    return this._mode.autoEmbed ? queryText : queryVector
  }

  private _stages(tier: ResolvedSearchType, inputs: StageInputs): Document[] {
    const { queryText, queryVector, queryFilter, limit, oversamplingFactor } = inputs
    const vector = {
      mode: this._mode,
      limit,
      queryFilter,
      ...(queryVector !== undefined && { queryVector }),
      ...(oversamplingFactor !== undefined && { oversamplingFactor }),
    }
    if (tier === 'hybrid') {
      // `_pickTier` returns `hybrid` only when `text` and the key its vector branch needs are both present.
      return hybridStages({
        ...vector,
        vectorIndexName: this._indexNames.vector!,
        textIndexName: this._indexNames.text!,
        queryText: queryText!,
      })
    }
    if (tier === 'vector') {
      // Both keys pass through: `vectorStages` checks the mode itself.
      return vectorStages({ ...vector, indexName: this._indexNames.vector!, ...present({ queryText }) })
    }
    // `_pickTier` returns `text` only when `queryText` is set.
    return textStages({ queryText: queryText!, indexName: this._indexNames.text!, limit, queryFilter })
  }

  // Client-side, because the tiers' scores are on different scales and a server-side bound would differ per tier.
  private _withinBounds(scored: Array<[number, MemoryEntry]>): MemoryEntry[] {
    const minimum = this.minScore
    const maximum = this.maxScore
    let name: 'minScore' | 'maxScore'
    let bound: number
    let kept: Array<[number, MemoryEntry]>
    if (minimum !== undefined) {
      name = 'minScore'
      bound = minimum
      kept = scored.filter(([score]) => score >= minimum)
    } else if (maximum !== undefined) {
      name = 'maxScore'
      bound = maximum
      kept = scored.filter(([score]) => score <= maximum)
    } else {
      return scored.map(([, entry]) => entry)
    }

    // Logged only when the bound dropped something, so polling a corpus mongot has not indexed yet does not fill the log.
    if (kept.length !== scored.length) {
      this._logger.debug(
        `strands_mongodb: ${name} ${bound} on ${this._target} kept ${kept.length} of ${scored.length} results (applied after the query). | ${logFields('score_bound_applied', { namespace: this._target })}`
      )
    }
    return kept.map(([, entry]) => entry)
  }

  // Whether the deployment has Atlas Search, from the capability probe `initialize()` ran.
  private _canSearch(): boolean {
    return this._capabilities?.search === true
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

  // Every tier is waited on together, so a quick text build is not held behind a slow vector one. The losers are
  // aborted once the first is ready, as Python cancels them, so no poll outlives the caller's interest.
  private async _waitForTheFirstReadyTier(): Promise<void> {
    const collection = this._collection()
    const losers = new AbortController()
    const waits = this._specs.map(([, spec]) =>
      ensure(collection, {
        search: [spec],
        create: this._ensureIndexes,
        timeout: this._indexReadyTimeout,
        logger: this._logger,
        signal: losers.signal,
      })
    )
    const ready = await anyReady(waits)
    losers.abort()
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
