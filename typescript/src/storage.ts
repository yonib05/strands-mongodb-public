import { Buffer } from 'node:buffer'
import { type Logger, StorageError } from '@strands-agents/sdk'
import type { Storage } from '@strands-agents/sdk/storage'
import type { SearchStrategy, StorageSearchResult } from '@strands-agents/sdk/storage/search'
import { Binary, BSON, type Collection, type Document, type Filter, MongoError } from 'mongodb'
import { close as release, type Connection, resolve } from './client.js'
import {
  checkTtl,
  ensure,
  EXPIRES_FIELD,
  READY_TIMEOUT_SECONDS,
  requireBinaryComparison,
  type SearchIndexSpec,
  storageSpecs,
} from './indexes.js'
import { abbreviate, NAMESPACED, normalizeKey, normalizePrefix, successor, tokenize } from './keys.js'
import { defaultLogger } from './logging.js'
import { annotate, traced } from './telemetry.js'
import type { MongoDBConfig } from './types.js'

/** Longest key this package writes, in UTF-8 bytes, prefix included. A package limit, not a server one. */
export const MAX_KEY_BYTES = 1024

/** The BSON document size limit (16 MiB) that `write` checks before sending. */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

const MISSING_DATABASE =
  "strands_mongodb: the configuration has no 'database'. Set it to the name of the database holding this store's collection."

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
  /** What `search` runs instead of the default key-only scan. */
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

function hasIndexSpec(strategy: unknown): strategy is { indexSpec(): SearchIndexSpec } {
  return (
    typeof strategy === 'object' &&
    strategy !== null &&
    'indexSpec' in strategy &&
    typeof strategy.indexSpec === 'function'
  )
}

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
  private readonly _searchStrategy: SearchStrategy<MongoDBStorage> | undefined
  private readonly _logger: Logger

  /**
   * @param config - Connection and deployment settings; instances sharing a config share one pool
   * @param options - Collection, prefix, TTL and search strategy
   * @throws TypeError if `config` has no `database`, or neither `client` nor `connectionString`
   * @throws RangeError if `ttlSeconds` is negative
   * @throws StorageError if `prefix` contains a backslash or a `..` segment
   */
  constructor(config: MongoDBConfig, options: MongoDBStorageOptions = {}) {
    // Validated before `resolve`, which registers a pool nothing could close if this threw afterwards.
    const { database } = config
    if (database === undefined) throw new TypeError(MISSING_DATABASE)
    checkTtl(options.ttlSeconds)
    this._databaseName = database
    this._collectionName = options.collection ?? 'storage'
    const normalized = normalizePrefix(options.prefix ?? '').replace(/\/+$/, '')
    this._prefix = normalized ? `${normalized}/` : ''
    this._ttlSeconds = options.ttlSeconds
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
   * collation is not binary, the write fails, or the search strategy fails to index the (already stored) value
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
   * @throws StorageError if the key is invalid or too long, the collation is not binary, or the read fails
   */
  read(key: string): Promise<Uint8Array | null> {
    return this._run('read', 'reading', key, async () => {
      await this._requireBinaryKeys()
      const document = await this._typed().findOne({ _id: this._idFor(key) })
      annotate('strands_mongodb.found', document !== null, this._logger)
      if (document === null) return null
      // The driver hands back a `Binary` by default and a `Buffer` under `promoteBuffers`; both become one type here.
      const data: unknown = document.data
      return new Uint8Array(data instanceof Binary ? data.buffer : (data as Uint8Array))
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
      annotate('strands_mongodb.deleted_count', result.deletedCount, this._logger)
    })
  }

  /**
   * Returns every key under the prefix `query`, in ascending byte order, without this instance's prefix.
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
      annotate('strands_mongodb.result_count', keys.length, this._logger)
      return keys
    })
  }

  /**
   * Ranks stored keys by how many of the query's tokens they contain, unless a `searchStrategy` is set.
   * Only keys are scored, never payloads, in exchange for one covered aggregation.
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
      const documents = await this._typed().aggregate(this._searchPipeline(tokens)).toArray()
      const results = documents.map((document) => ({
        key: String(document._id).slice(this._prefix.length),
        score: Number(document.score),
      }))
      annotate('strands_mongodb.result_count', results.length, this._logger)
      return results
    })
  }

  /**
   * Removes every key under `prefix` in one call. Not part of the `Storage` interface.
   *
   * @param prefix - The key prefix to remove; `''` empties this instance's key space
   * @returns How many documents were removed
   * @throws StorageError if the prefix is invalid, the collation is not binary, or the delete fails
   */
  deletePrefix(prefix: string): Promise<number> {
    return this._run('delete_prefix', 'deleting the prefix', prefix, async () => {
      await this._requireBinaryKeys()
      const result = await this._typed().deleteMany(this._rangeFor(prefix))
      annotate('strands_mongodb.deleted_count', result.deletedCount, this._logger)
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
   * Creates the TTL index that makes `ttlSeconds` take effect, or verifies it when `ensureIndexes` is `false`.
   * Nothing in this package calls it; call it once at startup. Idempotent.
   *
   * @throws StorageError if the collation is not binary, an index conflicts, something is missing in verify mode,
   * a strategy's search index fails or does not finish in time, or a driver call fails
   */
  ensureIndexes(): Promise<void> {
    return traced('storage', 'ensure_indexes', this._spanBase(), async () => {
      await this._requireBinaryKeys()
      const strategy = this._searchStrategy
      await ensure(this._collection(), {
        ordinary: storageSpecs(),
        search: hasIndexSpec(strategy) ? [strategy.indexSpec()] : [],
        create: this._config.ensureIndexes ?? true,
        timeout: this._config.indexReadyTimeout ?? READY_TIMEOUT_SECONDS,
        logger: this._logger,
      })
    })
  }

  /**
   * Releases the pool shared by every instance built from this config, closing the client only if this package
   * created it. Idempotent; a later operation opens a fresh pool.
   */
  close(): Promise<void> {
    return release(this._config)
  }

  /**
   * Returns the live collection, resolved through the registry on each call. For this package's search strategies.
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
      return await fn()
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
    annotate('strands_mongodb.result_count', results.length, this._logger)
    return results
  }

  private _searchPipeline(tokens: Set<string>): Document[] {
    const stages: Document[] = []
    // Bounded by the instance prefix, not the query: a covered IXSCAN on `_id_` instead of a COLLSCAN.
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

  // Only a verified collection is cached: an absent one may yet be created with any collation.
  private async _requireBinaryKeys(): Promise<void> {
    const connection = this._connection
    if (connection.binaryKeys.has(this._target)) return
    if (await requireBinaryComparison(this._collection(), this._logger)) connection.binaryKeys.add(this._target)
  }

  private _spanBase(): { database: string; collection: string; logger: Logger } {
    return { database: this._databaseName, collection: this._collectionName, logger: this._logger }
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
        `strands_mongodb: the key '${abbreviate(id)}' encodes to ${encoded} bytes, over the ${MAX_KEY_BYTES}-byte limit this package applies to keys in ${this._target}. The limit is counted in UTF-8 bytes rather than characters.`
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
