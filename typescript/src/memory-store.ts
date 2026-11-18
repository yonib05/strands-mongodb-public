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
import { requireNumber, requireOneOf, requireString, requireTtlSeconds } from './checks.js'
import { close as release, type Connection, onLiveClient, resolve } from './client.js'
import { compose, validate } from './filter.js'
import { embed } from './embedding.js'
import { ensure } from './ensure-indexes.js'
import {
  CONTENT_FIELD,
  declaredFilterFields,
  EXPIRES_FIELD,
  memorySearchSpecs,
  memorySpecs,
  readyTimeout,
  VECTOR_FIELD,
  vectorMode,
} from './index-specs.js'
import { defaultLogger, logFields } from './logging.js'
import { checkQueryKeys, hybridStages, SCORE_FIELD, textStages, vectorStages } from './pipeline.js'
import { type PickedTier, type ScoreBound, SEARCH_TYPES, SearchTiers } from './search-tiers.js'
import { annotate, type SpanBase, traced } from './telemetry.js'
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  type MongoDBAddResult,
  type MongoDBConfig,
  type MongoDBMemoryStoreConfig,
  type MongoDBSearchQuery,
  type SearchType,
  type VectorMode,
} from './types.js'

/** Collection this store uses when the config names none. Not `storage`: a vector index must never see session blobs. */
export const DEFAULT_COLLECTION = 'memory'

/** Scope stamped on writes and filtered on by reads when the config names none, so an unconfigured store still filters. */
export const UNSCOPED = '__unscoped__'

const MISSING_CONFIG =
  "strands_mongodb: the memory store configuration has no 'config'. Set it to a MongoDBConfig with 'database' and a 'connectionString' or 'client'."

const MISSING_DATABASE =
  "strands_mongodb: the connection config has no 'database'. Set it to the database holding this store's collection."

const EMBEDDER_ON_AUTO_EMBED =
  "strands_mongodb: 'embedder' is set, but without 'embeddingDimensions' and 'similarity' the deployment embeds the text (Atlas AutoEmbeddings). Remove 'embedder', or set both keys to embed client-side."

// The server's code for a unique index violation, which a concurrent upsert losing the insert race reports.
const DUPLICATE_KEY = 11000

function notWritable(name: string, call: string): string {
  return `strands_mongodb: the memory store '${name}' is not writable, so it does not accept ${call}. Set 'writable': true in its configuration to enable writes.`
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// Strict, with no fallback to matching the raw string, so a malformed id throws instead of quietly deleting nothing.
function objectId(memoryId: unknown): ObjectId {
  if (typeof memoryId !== 'string' || !/^[0-9a-f]{24}$/i.test(memoryId) || !ObjectId.isValid(memoryId)) {
    const rendered = typeof memoryId === 'string' ? `'${memoryId}'` : String(memoryId)
    throw new TypeError(
      `strands_mongodb: 'memoryId' is ${rendered}, which is not a 24-character hex ObjectId. Pass the '_id' from a search result's metadata.`
    )
  }
  return new ObjectId(memoryId)
}

function queryParts(query: unknown): MongoDBSearchQuery {
  if (typeof query === 'string') return { text: query }
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw new TypeError(
      `strands_mongodb: 'query' must be a string or a MongoDBSearchQuery object, but it is ${query === null ? 'null' : Array.isArray(query) ? 'an array' : typeof query}.`
    )
  }
  const { text, vector } = query as MongoDBSearchQuery
  if (text !== undefined) requireString('text', text)
  if (vector !== undefined && !(Array.isArray(vector) && vector.every(Number.isFinite))) {
    throw new TypeError(
      "strands_mongodb: the query's 'vector' must be an array of finite numbers. Pass the embedding your model returned."
    )
  }
  return query
}

const LIMIT = { min: 1, integer: true }

// Every supplied limit is checked, not only the one that wins. The key names are the caller's, in priority order.
function resolveLimit(limits: Array<[key: string, value: number | undefined]>): number {
  for (const [key, value] of limits) {
    if (value !== undefined) requireNumber(key, value, LIMIT)
  }
  return limits.find(([, value]) => value !== undefined)?.[1] ?? DEFAULT_MAX_SEARCH_RESULTS
}

/**
 * A Strands `MemoryStore` on MongoDB Atlas Vector Search and Atlas Search, limited to its own `scope` and `name`.
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
  declare private readonly _connectionConfig: MongoDBConfig
  private readonly _databaseName: string
  private readonly _collectionName: string
  private readonly _ensureIndexes: boolean
  private readonly _searchType: SearchType
  private readonly _declaredFields: string[]
  private readonly _mode: VectorMode
  // Set only on the manual-vector path, with the length its index declares.
  private readonly _embedding: { embedder: Embedder; dimensions: number } | undefined
  private readonly _indexNames: { vector: string; text: string }
  // Whether a query may set both `text` and `vector`: only on the manual path, where `vector` has a meaning.
  private readonly _fusionPossible: boolean
  private readonly _bound: ScoreBound | undefined
  private readonly _logger: Logger
  private readonly _tiers: SearchTiers
  private _initialized = false

  /**
   * @param config - The store's own fields plus the connection config under `config`
   * @throws TypeError if `config` or `config.database` is missing, a string setting is not a string, `searchType` or
   * `similarity` is not a listed value, both score bounds are set, `filter` is invalid, the vector keys contradict
   * each other, or `embedder` is set on the AutoEmbeddings path
   * @throws RangeError if `minScore` or `maxScore` is not a finite number, `ttlSeconds` or `indexReadyTimeout` is not
   * a finite number of at least `0`, `ttlSeconds` puts the expiry past the last date JavaScript can represent, or
   * `maxSearchResults` or `embeddingDimensions` is not an integer within its bounds
   */
  constructor(config: MongoDBMemoryStoreConfig) {
    // Every check runs before `resolve`, so a config that fails leaves no connection pool behind.
    const connection = config.config
    if (connection === undefined) throw new TypeError(MISSING_CONFIG)
    requireString('name', config.name)
    if (config.scope !== undefined) requireString('scope', config.scope)
    if (config.collection !== undefined) requireString('collection', config.collection)
    if (connection.database === undefined) throw new TypeError(MISSING_DATABASE)
    requireString('database', connection.database)
    for (const key of ['vectorIndexName', 'textIndexName', 'embeddingModel'] as const) {
      if (connection[key] !== undefined) requireString(key, connection[key])
    }
    connection.filterFields?.forEach((field, index) => requireString(`filterFields[${index}]`, field))
    const searchType = connection.searchType || 'auto'
    requireOneOf('searchType', searchType, SEARCH_TYPES)
    this.name = config.name
    if (config.description !== undefined) this.description = config.description
    if (config.maxSearchResults !== undefined) this.maxSearchResults = config.maxSearchResults
    // `false` by default, unlike `FileMemoryStore`, because `writable` also gates automatic extraction.
    this.writable = config.writable ?? false
    if (config.extraction !== undefined) this.extraction = config.extraction
    this.scope = config.scope || UNSCOPED
    if (config.filter !== undefined) this.filter = config.filter
    for (const bound of ['minScore', 'maxScore'] as const) {
      const value = config[bound]
      if (value === undefined) continue
      requireNumber(bound, value)
      this[bound] = value
    }
    if (config.ttlSeconds !== undefined) {
      requireTtlSeconds(config.ttlSeconds)
      this.ttlSeconds = config.ttlSeconds
    }
    if (this.maxSearchResults !== undefined) requireNumber('maxSearchResults', this.maxSearchResults, LIMIT)
    if (this.minScore !== undefined && this.maxScore !== undefined) {
      throw new TypeError(
        `strands_mongodb: 'minScore' is ${this.minScore} and 'maxScore' is ${this.maxScore}, and only one bound can be set. Remove one of them.`
      )
    }
    if (this.minScore !== undefined) this._bound = { name: 'minScore', value: this.minScore }
    else if (this.maxScore !== undefined) this._bound = { name: 'maxScore', value: this.maxScore }

    this._databaseName = connection.database
    this._collectionName = config.collection ?? DEFAULT_COLLECTION
    this._ensureIndexes = connection.ensureIndexes ?? true
    this._searchType = searchType
    // The index definition decides what is filterable, so configured and per-query filters share one list.
    this._declaredFields = declaredFilterFields(connection.filterFields ?? [])
    if (this.filter !== undefined) validate(this.filter, { declaredFields: this._declaredFields })

    this._mode = vectorMode(connection)
    if (config.embedder !== undefined) {
      if (this._mode.autoEmbed) throw new TypeError(EMBEDDER_ON_AUTO_EMBED)
      this._embedding = { embedder: config.embedder, dimensions: this._mode.dimensions }
    }
    const [vector, text] = memorySearchSpecs(connection)
    this._indexNames = { vector: vector.name, text: text.name }
    this._fusionPossible = !this._mode.autoEmbed && (searchType === 'auto' || searchType === 'hybrid')

    Object.defineProperty(this, '_connectionConfig', { value: connection, enumerable: false })
    this._logger = connection.logger ?? defaultLogger
    this._tiers = new SearchTiers({
      namespace: this._target,
      searchType,
      mode: this._mode,
      specs: { vector, text },
      create: this._ensureIndexes,
      timeout: readyTimeout(connection),
      bound: this._bound,
      logger: this._logger,
    })
    // Called only to fail fast on a config with no client or connection string.
    resolve(connection)
  }

  /**
   * Probes the deployment and prepares this store's indexes. Every operation calls it, so calling it is optional.
   *
   * @remarks
   * Idempotent and safe to call concurrently. Calls on one connection run one at a time, and a named `searchType`
   * holds its turn while it waits for its index, up to `indexReadyTimeout`. Under `auto` a building index is
   * skipped instead and retried inside a later call: after 60 seconds, then at doubling intervals up to an hour.
   *
   * @throws StorageError if a driver call fails, the collection's collation is not binary, an existing index
   * conflicts, an index is missing and `ensureIndexes` is `false`, or `searchType` names a tier that a deployment
   * running Atlas Search cannot prepare. Without Atlas Search it resolves, and `search()` throws
   */
  async initialize(): Promise<void> {
    if (this._initialized && !this._tiers.retryDue) return
    await this._run('initialize', 'initializing', () => this._initialize())
  }

  /**
   * Stores one memory in this store's scope, at most once: the same content again keeps one document.
   *
   * @param content - The memory to store, verbatim; never included in an error or a log line
   * @param metadata - Optional caller metadata, stored nested and returned by `search`
   * @returns The document id with the insert and duplicate counts; a duplicate reports the existing id
   * @throws TypeError if this store is not writable or `content` is not a string, before any network call
   * @throws RangeError if `embedder` returns a vector whose length is not `embeddingDimensions`
   * @throws StorageError if `initialize()` fails or a driver call fails
   */
  add(content: string, metadata?: Record<string, JSONValue>): Promise<MongoDBAddResult> {
    return this._run('add', 'adding a memory to', async () => {
      if (!this.writable) throw new TypeError(notWritable(this.name, 'add()'))
      requireString('content', content)
      await this.initialize()
      // Before the upsert, so a failed embedding stores nothing rather than a memory no vector search finds.
      const vector = this._embedding === undefined ? undefined : await this._embed(this._embedding, content)

      // The server copies a selector's equality fields, `$eq` included, onto an inserted document; they are also the
      // unique index's key.
      const selector = {
        scope: { $eq: this.scope },
        store_name: { $eq: this.name },
        content_hash: contentHash(content),
      }
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
      annotate('strands_mongodb.duplicate', false)
      return { ids: [String(result.upsertedId)], inserted: 1, duplicates: 0 }
    })
  }

  /**
   * Returns the memories that best match a query, most relevant first, from the first prepared tier that fits it.
   *
   * @remarks
   * Under `auto`, the first search on a store whose indexes are all still building waits for one, up to
   * `indexReadyTimeout`. If none is ready by then, this and every later search throws `StorageError` until a retry
   * inside `initialize()` finds one, which can be up to an hour after the build finishes.
   *
   * @param query - A plain string, or a `MongoDBSearchQuery` carrying `text`, `vector`, `filter`, `limit`, `oversamplingFactor`
   * @param options - The SDK's per-call options; a query's `limit` wins over `maxSearchResults`
   * @returns Up to the resolved limit of entries, each with `_id`, `_relevanceScore`, `_searchType` and `_scope` in its metadata
   * @throws TypeError if `text` is not a string or `vector` is not an array of finite numbers, the query sets neither,
   * or both where no tier fuses them, the filter is invalid, or no prepared tier fits the query's shape
   * @throws RangeError if a limit is not an integer of at least 1, or the candidate count is out of bounds
   * @throws StorageError if the deployment cannot search, no tier is ready, `initialize()` fails, or a driver call fails
   */
  search(query: string | MongoDBSearchQuery, options?: SearchOptions): Promise<MemoryEntry[]> {
    return this._run('search', 'searching', async () => {
      // First, so a search that fails early still records what was requested.
      annotate('strands_mongodb.search.requested', this._searchType)
      const parts = queryParts(query)
      const { text: queryText, vector: queryVector } = parts

      // A query's `limit` ranks above `options` because it only arrives on a direct call.
      const limit = resolveLimit([
        ['limit', parts.limit],
        ['maxSearchResults', options?.maxSearchResults],
        ['maxSearchResults', this.maxSearchResults],
      ])
      // Only the mode-independent check; `vectorStages` runs the rest once the tier is known.
      checkQueryKeys({ queryText, queryVector, fusionPossible: this._fusionPossible })
      if (parts.filter !== undefined) validate(parts.filter, { declaredFields: this._declaredFields })
      const queryFilter = compose([this.filter, parts.filter], { scope: this.scope, storeName: this.name })

      await this.initialize()
      await this._tiers.waitForFirst(this._collection())
      const embedding = this._embedding
      const picked = await this._tiers.pick(
        queryText,
        queryVector,
        embedding && ((text): Promise<number[]> => this._embed(embedding, text))
      )
      annotate('strands_mongodb.search.tier', picked.tier)
      const stages = this._stages(picked, { queryFilter, limit, oversamplingFactor: parts.oversamplingFactor })

      const documents = await this._collection().aggregate(stages).toArray()
      const scored = documents.map((document): [number, MemoryEntry] => {
        // `?? 0`: a stage that projected nothing yields `null`, which would break the bound comparison.
        const score = Number(document[SCORE_FIELD] ?? 0)
        // `_scope` comes from this store, never from the document, so a document cannot report another scope.
        const metadata = this._metadata(document.metadata, {
          _id: String(document._id),
          _relevanceScore: score,
          _searchType: picked.tier,
          _scope: this.scope,
        })
        return [score, { content: String(document[CONTENT_FIELD] ?? ''), storeName: this.name, metadata }]
      })

      const results = this._withinBound(scored)
      annotate('strands_mongodb.result_count', results.length)
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
      if (!this.writable) throw new TypeError(notWritable(this.name, 'delete()'))
      const _id = objectId(memoryId)

      await this.initialize()
      const predicate = compose([this.filter], { scope: this.scope, storeName: this.name })
      const result = await this._collection().deleteOne({ ...predicate, _id })
      annotate('strands_mongodb.deleted_count', result.deletedCount)
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
      annotate('strands_mongodb.deleted_count', result.deletedCount)
      return result.deletedCount
    })
  }

  /**
   * Returns the agent tools this store contributes, which is none.
   *
   * @returns An empty array
   */
  getTools(): Tool[] {
    return []
  }

  /**
   * Closes the pool shared by every store with the same connection identity, unless the client was injected.
   *
   * @remarks
   * Idempotent, and not terminal: a later operation on any of those stores opens a fresh pool, which keeps the
   * Node.js process alive until `close()` is called again. The store stays initialized, so that operation does not
   * probe the deployment or check its indexes again.
   */
  close(): Promise<void> {
    return release(this._connectionConfig)
  }

  // Projects only `_id`, because the caller already has the content.
  private async _existing(collection: Collection<Document>, selector: Document): Promise<MongoDBAddResult> {
    const document = await collection.findOne(selector, { projection: { _id: 1 } })
    annotate('strands_mongodb.duplicate', true)
    return { ids: document === null ? [] : [String(document._id)], inserted: 0, duplicates: 1 }
  }

  private _embed(embedding: { embedder: Embedder; dimensions: number }, text: string): Promise<number[]> {
    return embed(embedding.embedder, text, { dimensions: embedding.dimensions, setting: 'embeddingDimensions' })
  }

  private _stages(
    picked: PickedTier,
    inputs: { queryFilter: Record<string, unknown>; limit: number; oversamplingFactor: number | undefined }
  ): Document[] {
    const { queryFilter, limit } = inputs
    const { vector: vectorIndexName, text: textIndexName } = this._indexNames
    if (picked.tier === 'text') {
      return textStages({ queryText: picked.text, indexName: textIndexName, limit, queryFilter })
    }
    const vector = { mode: this._mode, queryVector: picked.vector, ...inputs }
    if (picked.tier === 'hybrid') {
      return hybridStages({ ...vector, vectorIndexName, textIndexName, queryText: picked.text })
    }
    return vectorStages({ ...vector, indexName: vectorIndexName, queryText: picked.text })
  }

  // The reserved keys win over a stored key of the same name, and stored BSON values become relaxed EJSON.
  private _metadata(stored: Document | undefined, reserved: Record<string, JSONValue>): Record<string, JSONValue> {
    const merged = BSON.EJSON.serialize(stored ?? {}, { relaxed: true }) as Record<string, JSONValue>
    const collisions = Object.keys(reserved)
      .filter((key) => Object.hasOwn(merged, key))
      .sort()
    if (collisions.length > 0) {
      this._logger.warn(
        `strands_mongodb: metadata key(s) ${collisions.map((key) => `'${key}'`).join(', ')} on a document in the memory store '${this.name}' are reserved, so the stored value(s) were left out of the returned entry. Rename them where they are written. | ${logFields('reserved_key_collision', { namespace: this._target })}`
      )
    }
    return { ...merged, ...reserved }
  }

  // Client-side, because the tiers' scores are on different scales and a server-side bound would differ per tier.
  private _withinBound(scored: Array<[number, MemoryEntry]>): MemoryEntry[] {
    const bound = this._bound
    const kept =
      bound === undefined
        ? scored
        : scored.filter(([score]) => (bound.name === 'minScore' ? score >= bound.value : score <= bound.value))
    // Logged only when the bound dropped something, so polling a corpus mongot has not indexed yet does not fill the log.
    if (bound !== undefined && kept.length !== scored.length) {
      this._logger.debug(
        `strands_mongodb: ${bound.name} ${bound.value} on ${this._target} kept ${kept.length} of ${scored.length} results (applied after the query). | ${logFields('score_bound_applied', { namespace: this._target })}`
      )
    }
    return kept.map(([, entry]) => entry)
  }

  // Split from the unlocked fast path so calls that find the work done record no span.
  private async _initialize(): Promise<void> {
    annotate('strands_mongodb.search.requested', this._searchType)
    // Bound once, so the lock, the probe, the cache writes and the collection all use the same connection.
    const connection = resolve(this._connectionConfig)
    await connection.locked(async () => {
      const collection = this._collectionOn(connection)
      if (this._initialized) {
        if (this._tiers.retryDue) await this._tiers.retry(collection)
        return
      }

      // Before any index is created: a case-folding collation would let one scope read another's documents.
      await connection.requireBinaryKeys(collection)

      const capabilities = await connection.probe(collection, this._logger)
      // Ordinary indexes always, search or not: they include the unique index behind `add`'s deduplication.
      await ensure(collection, {
        ordinary: memorySpecs(),
        create: this._ensureIndexes,
        logger: this._logger,
      })
      await this._tiers.prepare(collection, capabilities)

      // An absent collection could not be verified above; creating the indexes created it, so check it now.
      await connection.requireBinaryKeys(collection)

      annotate('strands_mongodb.search.tiers', this._tiers.prepared.join(','))
      this._initialized = true
    })
  }

  private _run<T>(operation: string, verb: string, fn: () => Promise<T>): Promise<T> {
    return traced('memory', operation, this._spanBase(), () => this._reporting(verb, fn))
  }

  // The message names only the namespace: the subject of a memory operation is user content.
  private async _reporting<T>(verb: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await onLiveClient(this._connectionConfig, fn)
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
    }
  }

  private get _target(): string {
    return `${this._databaseName}.${this._collectionName}`
  }

  // Resolved on each call, never stored: after `close()` the next operation opens a fresh pool.
  private _collection(): Collection<Document> {
    return this._collectionOn(resolve(this._connectionConfig))
  }

  private _collectionOn(connection: Connection): Collection<Document> {
    return connection.client.db(this._databaseName).collection<Document>(this._collectionName)
  }
}
