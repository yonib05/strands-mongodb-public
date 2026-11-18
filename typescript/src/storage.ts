import { Buffer } from 'node:buffer'
import { type Logger, StorageError } from '@strands-agents/sdk'
import type { Storage } from '@strands-agents/sdk/storage'
import type { SearchStrategy, StorageSearchResult } from '@strands-agents/sdk/storage/search'
import { Binary, BSON, type Collection, type Document, type Filter, MongoError } from 'mongodb'
import { requireString, requireTtlSeconds } from './checks.js'
import { close as release, type Connection, onLiveClient, resolve } from './client.js'
import { ensure } from './ensure-indexes.js'
import { EXPIRES_FIELD, readyTimeout, type SearchIndexSpec, storageSpecs } from './index-specs.js'
import { abbreviate, NAMESPACED, normalizeKey, normalizePrefix, successor, tokenize } from './keys.js'
import { defaultLogger } from './logging.js'
import { annotate, type SpanBase, traced } from './telemetry.js'
import type { MongoDBConfig } from './types.js'

/** Longest key this package writes, in UTF-8 bytes, prefix included. A package limit, not a server one. */
export const MAX_KEY_BYTES = 1024

/** The BSON document size limit (16 MiB) that `write` checks before sending. */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

const MISSING_DATABASE =
  "strands_mongodb: the configuration has no 'database'. Set it to the database holding this store's collection."

// Not `\w+`: MongoDB's `\w` is ASCII-only, so `münchen` would split and `日本語` would vanish. This is the SDK tokenizer's class.
const WORD = '[\\p{L}\\p{N}_]+'

/** Per-instance placement of a `MongoDBStorage` within a deployment. */
export interface MongoDBStorageOptions {
  /** Collection holding this instance's documents. Defaults to `storage`. */
  collection?: string
  /** Prefix prepended to every key. Normalized to end in exactly one `/`, or to be empty. */
  prefix?: string
  /** Lifetime of written documents in seconds. Stamps `expires_at` only; `ensureIndexes()` creates the index that acts on it. */
  ttlSeconds?: number | undefined
  /** What `search` runs instead of scoring keys. Without one, payloads are never searched. */
  searchStrategy?: SearchStrategy<MongoDBStorage> | undefined
}

/** The document `write` stores: the prefixed key in `_id`, the payload, and the stamps the TTL index reads. */
interface StoredDocument {
  _id: string
  data: Binary
  updated_at: Date
  expires_at?: Date
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Copies a stored payload out of the `Binary` any copy of bson decoded, or the `Buffer` `promoteBuffers` yields.
 *
 * @param data - The document's `data` field
 * @param id - The document's `_id`, for the message
 * @returns The bytes as a plain `Uint8Array`
 * @throws StorageError if `data` is neither
 * @internal
 */
export function payloadBytes(data: unknown, id: string): Uint8Array {
  if (data instanceof Uint8Array) return new Uint8Array(data)
  // By tag, not `instanceof`: an injected client may come from a second installed copy of the driver.
  if (typeof data === 'object' && data !== null && Reflect.get(data, '_bsontype') === 'Binary') {
    return new Uint8Array((data as Binary).value())
  }
  throw new StorageError(
    `strands_mongodb: the document '${abbreviate(id)}' holds no binary payload in 'data'. Write the key again with write().`
  )
}

// A strategy may declare the search index it queries, as `MongoDBVectorSearchStrategy` does.
type IndexedStrategy = SearchStrategy<MongoDBStorage> & { indexSpec?(): SearchIndexSpec }

/**
 * A `Storage` backed by a MongoDB collection: one document per key, the prefixed key in `_id`.
 *
 * @example
 * ```typescript
 * const config: MongoDBConfig = { database: 'agents', connectionString: 'mongodb+srv://...' }
 * const sessions = new MongoDBStorage(config, { collection: 'sessions' })
 * const transcripts = new MongoDBStorage(config, { collection: 'transcripts' }) // same pool
 * ```
 */
export class MongoDBStorage implements Storage {
  // Declared only: the SDK tests `NAMESPACED in storage`, so the property must be absent until `namespace()` sets it.
  declare [NAMESPACED]?: true
  // Non-enumerable, so `util.inspect` and `JSON.stringify` of a store never render the connection string.
  declare private readonly _config: MongoDBConfig
  private readonly _databaseName: string
  private readonly _collectionName: string
  private readonly _prefix: string
  private readonly _ttlSeconds: number | undefined
  private readonly _indexReadyTimeout: number
  private readonly _searchStrategy: IndexedStrategy | undefined
  private readonly _logger: Logger

  /**
   * @param config - Connection and deployment settings; instances with the same connection identity share one pool
   * @param options - Collection, prefix, TTL and search strategy
   * @throws TypeError if `config` has no `database` or neither `client` nor `connectionString`, or `database`,
   * `collection` or `prefix` is not a string
   * @throws RangeError if `ttlSeconds` or `indexReadyTimeout` is not a finite number of at least `0`, or `ttlSeconds`
   * puts the expiry past the last date JavaScript can represent
   * @throws StorageError if `prefix` contains a backslash or a `..` segment
   * @throws MongoParseError if the driver cannot parse `connectionString` or `clientOptions`
   */
  constructor(config: MongoDBConfig, options: MongoDBStorageOptions = {}) {
    // Validated before `resolve`, which registers a pool nothing could close if this threw afterwards.
    const { database } = config
    if (database === undefined) throw new TypeError(MISSING_DATABASE)
    requireString('database', database)
    const { collection = 'storage', prefix = '', ttlSeconds } = options
    requireString('collection', collection)
    requireString('prefix', prefix)
    if (ttlSeconds !== undefined) requireTtlSeconds(ttlSeconds)
    this._databaseName = database
    this._collectionName = collection
    const normalized = normalizePrefix(prefix).replace(/\/+$/, '')
    this._prefix = normalized ? `${normalized}/` : ''
    this._ttlSeconds = ttlSeconds
    this._indexReadyTimeout = readyTimeout(config)
    this._searchStrategy = options.searchStrategy
    Object.defineProperty(this, '_config', { value: config, enumerable: false })
    this._logger = config.logger ?? defaultLogger
    // Called only to fail fast on a config with no client or connection string.
    resolve(config)
  }

  /** The normalized key prefix (ending in `/`), or `''` when none was configured. */
  get prefix(): string {
    return this._prefix
  }

  /**
   * Stores `data` under `key`, replacing whatever was there, in one upsert.
   *
   * @param key - The key to write under; `a//b` and `a/b` are one key
   * @param data - The bytes to store, round-tripped unchanged including an empty payload
   * @throws StorageError if the key is invalid or too long, the document exceeds {@link MAX_DOCUMENT_BYTES}, the
   * collation is not binary, the write fails, or the search strategy fails to index the already stored value
   */
  write(key: string, data: Uint8Array): Promise<void> {
    return this._run('write', 'writing', key, async () => {
      await this._requireBinaryKeys()
      const id = this._idFor(key)
      const now = new Date()
      const document: StoredDocument = { _id: id, data: new Binary(data), updated_at: now }
      if (this._ttlSeconds !== undefined) document[EXPIRES_FIELD] = new Date(now.getTime() + this._ttlSeconds * 1000)
      // Checked before sending so the caller sees the sizes, which the driver's error does not report.
      const size = BSON.calculateObjectSize(document)
      if (size > MAX_DOCUMENT_BYTES) {
        throw new StorageError(
          `strands_mongodb: the document for the key '${abbreviate(id)}' would encode to ${size} bytes, over the ${MAX_DOCUMENT_BYTES}-byte BSON limit in ${this._target}. Store the payload elsewhere and keep a reference here, or split it across keys.`
        )
      }
      await this._typed().replaceOne({ _id: id }, document, { upsert: true })

      const strategy = this._searchStrategy
      if (strategy === undefined || strategy.index === undefined) return
      try {
        await strategy.index(this, id.slice(this._prefix.length), data)
      } catch (error) {
        throw new StorageError(
          `strands_mongodb: wrote '${abbreviate(id)}' in ${this._target} but indexing it for search failed: ${reason(error)}`,
          { cause: error }
        )
      }
    })
  }

  /**
   * Returns the bytes stored under `key`, or `null` if there are none.
   *
   * @param key - The key to read
   * @returns The stored bytes as a `Uint8Array`, or `null` when the key is absent
   * @throws StorageError if the key is invalid or too long, the collation is not binary, the read fails, or the
   * document holds no binary payload
   */
  read(key: string): Promise<Uint8Array | null> {
    return this._run('read', 'reading', key, async () => {
      await this._requireBinaryKeys()
      const document = await this._typed().findOne({ _id: this._idFor(key) })
      annotate('strands_mongodb.found', document !== null)
      return document === null ? null : payloadBytes(document.data, document._id)
    })
  }

  /**
   * Removes `key`. Deleting a key that does not exist is not an error.
   *
   * @param key - The key to remove
   * @throws StorageError if the key is invalid or too long, the collation is not binary, or the delete fails
   */
  delete(key: string): Promise<void> {
    return this._run('delete', 'deleting', key, async () => {
      await this._requireBinaryKeys()
      const result = await this._typed().deleteOne({ _id: this._idFor(key) })
      annotate('strands_mongodb.deleted_count', result.deletedCount)
    })
  }

  /**
   * Returns every key that starts with `query`, in ascending byte order, without this instance's prefix.
   *
   * @remarks
   * A string prefix, not a path: `user1` also matches `user10/a`. End the prefix with `/` to match one path segment.
   *
   * @param query - A key prefix; `''` matches everything
   * @returns Full keys, not the part after `query`
   * @throws StorageError if the prefix is invalid, the collation is not binary, or the scan fails at any point
   */
  list(query: string): Promise<string[]> {
    return this._run('list', 'listing', query, async () => {
      await this._requireBinaryKeys()
      const documents = await this._typed()
        .find(this._rangeFor(query), { projection: { _id: 1 } })
        .sort({ _id: 1 })
        .toArray()
      // Strip only the instance prefix, so the keys returned can be passed straight back to `read`.
      const keys = documents.map((document) => document._id.slice(this._prefix.length))
      annotate('strands_mongodb.result_count', keys.length)
      return keys
    })
  }

  /**
   * Runs the `searchStrategy`, or without one ranks stored keys by how many of the query's tokens they contain.
   *
   * @remarks
   * Without a strategy only keys are scored, never payloads. The server lowercases ASCII letters only, so a key
   * word holding a non-ASCII capital, such as `ÉCOLE`, matches no query. Because this method exists, SDK consumers
   * such as `FileMemoryStore` call it in place of their own content keyword search: pass a `searchStrategy` to
   * search content.
   *
   * @param query - A natural-language string; one that tokenizes to nothing returns `[]` without a round trip
   * @returns Matched keys with scores, highest first, ties in ascending key order; `data` is left unset
   * @throws StorageError if the collation is not binary, the aggregation fails, or the strategy throws
   */
  search(query: string): Promise<StorageSearchResult[]> {
    return this._run('search', 'searching', query, async () => {
      const strategy = this._searchStrategy
      if (strategy !== undefined) return this._searchWith(strategy, query)
      const tokens = tokenize(query)
      // Same short circuit as `KeywordSearchStrategy`: scoring every key zero would cost a full scan.
      if (tokens.size === 0) return []
      await this._requireBinaryKeys()
      // The hint keeps the scan on `_id_`, reading no payload: without it an unprefixed store is a COLLSCAN.
      const documents = await this._typed()
        .aggregate(this._searchPipeline(tokens), { hint: { _id: 1 } })
        .toArray()
      const results = documents.map((document) => ({
        key: String(document._id).slice(this._prefix.length),
        score: Number(document.score),
      }))
      annotate('strands_mongodb.result_count', results.length)
      return results
    })
  }

  /**
   * Removes every key that starts with `prefix`, in one call. Not part of the `Storage` interface.
   *
   * @remarks
   * A string prefix, not a path: `deletePrefix('user1')` also removes `user10/a`. End the prefix with `/` to remove
   * one path segment. `deletePrefix('')` removes every key under this instance's prefix: the whole collection when
   * it has none.
   *
   * @param prefix - The key prefix to remove
   * @returns How many documents were removed
   * @throws StorageError if the prefix is invalid, the collation is not binary, or the delete fails
   */
  deletePrefix(prefix: string): Promise<number> {
    return this._run('delete_prefix', 'deleting the prefix', prefix, async () => {
      await this._requireBinaryKeys()
      const result = await this._typed().deleteMany(this._rangeFor(prefix))
      annotate('strands_mongodb.deleted_count', result.deletedCount)
      return result.deletedCount
    })
  }

  /**
   * Returns a new instance scoped to `prefix` within the same collection, sharing the pool, TTL and strategy.
   *
   * @param prefix - Prefix appended to any prefix already in force
   * @returns A full `MongoDBStorage`, so `deletePrefix` and the indexed `list` keep working
   * @throws StorageError if `prefix` contains a backslash or a `..` segment
   */
  namespace(prefix: string): MongoDBStorage {
    const scoped = new MongoDBStorage(this._config, {
      collection: this._collectionName,
      prefix: `${this._prefix}${prefix}`,
      ttlSeconds: this._ttlSeconds,
      searchStrategy: this._searchStrategy,
    })
    // The SDK reads this to tell that a storage is already scoped; without it memory keys would land one level deeper.
    scoped[NAMESPACED] = true
    return scoped
  }

  /**
   * Creates, or with `ensureIndexes: false` verifies, the TTL index and the search index the strategy declares.
   *
   * @remarks
   * Nothing in this package calls it, and without it `ttlSeconds` expires nothing. Call it once at startup. Idempotent.
   *
   * @throws StorageError if the collation is not binary, an index conflicts, something is missing in verify mode,
   * a strategy's search index fails or does not finish in time, or a driver call fails
   */
  ensureIndexes(): Promise<void> {
    return traced('storage', 'ensure_indexes', this._spanBase(), () =>
      onLiveClient(this._config, async () => {
        await this._requireBinaryKeys()
        const spec = this._searchStrategy?.indexSpec?.()
        await ensure(this._collection(), {
          ordinary: storageSpecs(),
          search: spec === undefined ? [] : [spec],
          create: this._config.ensureIndexes ?? true,
          timeout: this._indexReadyTimeout,
          logger: this._logger,
        })
      })
    )
  }

  /**
   * Closes the pool shared by every store with the same connection identity, unless the client was injected.
   *
   * @remarks
   * Idempotent, and not terminal: a later operation on any of those stores opens a fresh pool, which keeps the
   * Node.js process alive until `close()` is called again.
   */
  close(): Promise<void> {
    return release(this._config)
  }

  /**
   * Returns the live collection, for this package's search strategies.
   *
   * @internal
   */
  _collection(): Collection<Document> {
    return this._typed<Document>()
  }

  private _run<T>(operation: string, verb: string, subject: string, fn: () => Promise<T>): Promise<T> {
    return traced('storage', operation, this._spanBase(), () => this._reporting(verb, subject, fn))
  }

  // Wraps the whole operation, not one call: `list` fails while its cursor drains, after `find` returned.
  private async _reporting<T>(verb: string, subject: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await onLiveClient(this._config, fn)
    } catch (error) {
      if (!(error instanceof MongoError)) throw error
      throw new StorageError(
        `strands_mongodb: ${verb} '${abbreviate(subject)}' in ${this._target} failed: ${error.message}`,
        { cause: error }
      )
    }
  }

  private async _searchWith(strategy: SearchStrategy<MongoDBStorage>, query: string): Promise<StorageSearchResult[]> {
    let results: StorageSearchResult[]
    try {
      results = await strategy.search(this, query)
    } catch (error) {
      if (error instanceof StorageError || error instanceof MongoError) throw error
      throw new StorageError(`strands_mongodb: searching in ${this._target} failed: ${reason(error)}`, { cause: error })
    }
    annotate('strands_mongodb.result_count', results.length)
    return results
  }

  private _searchPipeline(tokens: Set<string>): Document[] {
    const stages: Document[] = []
    // Bounded by the instance prefix, not the query.
    const range = this._rangeFor('')
    if (Object.keys(range).length > 0) stages.push({ $match: range })
    // Score the key the caller wrote, without the prefix. `$substrCP` counts code points, as `Array.from` does.
    const key = this._prefix ? { $substrCP: ['$_id', Array.from(this._prefix).length, { $strLenCP: '$_id' }] } : '$_id'
    stages.push({
      $project: {
        score: {
          $size: {
            $setIntersection: [
              { $map: { input: { $regexFindAll: { input: { $toLower: key }, regex: WORD } }, in: '$$this.match' } },
              [...tokens].sort(),
            ],
          },
        },
      },
    })
    stages.push({ $match: { score: { $gt: 0 } } })
    // A blocking sort, unavoidably: `score` is computed above. `_id` breaks ties as the SDK's stable sort does.
    stages.push({ $sort: { score: -1, _id: 1 } })
    return stages
  }

  private async _requireBinaryKeys(): Promise<void> {
    await this._connection.requireBinaryKeys(this._collection())
  }

  private _spanBase(): SpanBase {
    return { database: this._databaseName, collection: this._collectionName }
  }

  private get _target(): string {
    return `${this._databaseName}.${this._collectionName}`
  }

  // Resolved on each access, never stored: after `close()` the next operation opens a fresh pool.
  private get _connection(): Connection {
    return resolve(this._config)
  }

  private _typed<TSchema extends Document = StoredDocument>(): Collection<TSchema> {
    return this._connection.client.db(this._databaseName).collection<TSchema>(this._collectionName)
  }

  private _idFor(key: string): string {
    const id = `${this._prefix}${normalizeKey(key)}`
    // Measured on the prefixed form, since that is what becomes the index entry.
    const encoded = Buffer.byteLength(id, 'utf8')
    if (encoded > MAX_KEY_BYTES) {
      throw new StorageError(
        `strands_mongodb: the key '${abbreviate(id)}' encodes to ${encoded} bytes, over the ${MAX_KEY_BYTES}-byte limit for keys in ${this._target}. The limit counts UTF-8 bytes, not characters.`
      )
    }
    return id
  }

  // A range, not `{ $regex: '^prefix' }`: the `_id` index serves a range, where the regex scans unless the planner sees the anchor.
  private _rangeFor(query: string): Filter<StoredDocument> {
    const lower = `${this._prefix}${normalizePrefix(query)}`
    if (!lower) return {}
    const upper = successor(lower)
    return upper === undefined ? { _id: { $gte: lower } } : { _id: { $gte: lower, $lt: upper } }
  }
}
