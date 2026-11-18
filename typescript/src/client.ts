import { createHash } from 'node:crypto'
import { type Logger, StorageError } from '@strands-agents/sdk'
import { type Collection, MongoClient, type MongoClientOptions } from 'mongodb'
import { clientClosed, namespaceOf } from './driver-errors.js'
import { defaultLogger, logFields } from './logging.js'
import { rankFusionSupport, requireBinaryComparison, searchSupport } from './probes.js'
import { event } from './telemetry.js'
import type { MongoDBConfig } from './types.js'
import { PACKAGE_VERSION } from './version.js'

/** Name appended to the driver's handshake metadata. Server logs group by it, so changing it orphans usage data. */
export const DRIVER_NAME = 'Strands-MongoDB'

const MISSING_CONNECTION =
  "strands_mongodb: neither 'client' nor 'connectionString' is set in the configuration. Set 'connectionString' to a MongoDB URI, or 'client' to a MongoClient you already have."

const RETRY_WRITES_DISABLED =
  'strands_mongodb: retryWrites is disabled on this connection, so a write interrupted by a primary election fails instead of being retried. Remove retryWrites=false to restore the retries.'

const INJECTED_CLIENT_CLOSED =
  'strands_mongodb: the injected MongoClient is closed, which the driver does to a client whose first connection failed. Call connect() on it, or inject a new client.'

/** What a deployment can do, probed once and cached on its connection. */
export interface Capabilities {
  /** Whether the deployment runs Atlas Search. */
  search: boolean
  /** The server error code that reported no search; set only when `search` is `false`. */
  noSearchCode?: number
  /** Whether the server is new enough for `$rankFusion`. Probed only where search exists. */
  rankFusion: boolean
}

/** One MongoDB client and what has been learned about its deployment. Never holds the connection string. */
export class Connection {
  private _capabilities: Capabilities | undefined
  private readonly _binaryKeys = new Set<string>()
  private _tail: Promise<unknown> = Promise.resolve()

  /**
   * @param client - The shared client, built here or injected by the caller
   */
  constructor(readonly client: MongoClient) {}

  /** Result of {@link Connection.probe}, absent until it has run. */
  get capabilities(): Capabilities | undefined {
    return this._capabilities
  }

  /** `db.coll` namespaces whose default collation was read and found binary. */
  get binaryKeys(): ReadonlySet<string> {
    return this._binaryKeys
  }

  /**
   * Runs `fn` once every earlier call has settled, guarding one-time setup against concurrent stores.
   *
   * @param fn - The work to serialise
   * @returns Whatever `fn` resolves to
   * @throws Whatever `fn` throws; later callers still run
   */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this._tail.then(fn)
    this._tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /**
   * Verifies, once per namespace, that the collection compares keys byte for byte.
   *
   * @param collection - The collection about to be operated on. An absent one is read again on the next call
   * @throws StorageError if the collection's default collation is not binary, or reading it fails
   */
  async requireBinaryKeys(collection: Collection): Promise<void> {
    const namespace = namespaceOf(collection)
    if (this._binaryKeys.has(namespace)) return
    if (await requireBinaryComparison(collection)) this._binaryKeys.add(namespace)
  }

  /**
   * Probes what the deployment can do, once per connection, and warns if it has no Atlas Search.
   *
   * @param collection - Any collection on the deployment. Need not exist
   * @param logger - Receives the `no_search_setup` warning and the `rank_fusion_probe_failed` event
   * @returns The cached answer on every later call
   * @throws StorageError if the search probe fails for a reason other than "no Atlas Search"
   */
  async probe(collection: Collection, logger: Logger): Promise<Capabilities> {
    if (this._capabilities !== undefined) return this._capabilities
    const support = await searchSupport(collection)
    // Only where search exists: hybrid needs both search tiers, so without them the version changes nothing.
    const rankFusion = support.available ? await rankFusionSupport(collection, logger) : false
    const capabilities: Capabilities = { search: support.available, rankFusion }
    if (support.code !== undefined) capabilities.noSearchCode = support.code
    this._capabilities = capabilities
    if (!capabilities.search) {
      const namespace = namespaceOf(collection)
      logger.warn(
        `strands_mongodb: ${namespace} is on a deployment that does not run Atlas Search (server error code ${support.code}), so memories can be written but not searched. Point 'connectionString' at MongoDB Atlas or a local Atlas deployment. | ${logFields('no_search_setup', { namespace })}`
      )
    }
    return capabilities
  }
}

// Keyed by a digest, never by the connection string, so no key can leak a password.
const constructed = new Map<string, Connection>()
const injected = new WeakMap<MongoClient, Connection>()
const objectIds = new WeakMap<object, number>()
let nextObjectId = 0

/**
 * Returns the shared connection for a config, creating it on first use.
 *
 * @param config - Only the connection fields are read; `database` does not affect identity
 * @returns The same connection for every config with the same injected client, or the same connection string and
 * client options
 * @throws TypeError if neither `client` nor `connectionString` is set
 */
export function resolve(config: MongoDBConfig): Connection {
  const { client } = config
  if (client !== undefined) {
    const existing = injected.get(client)
    if (existing !== undefined) return existing
    const connection = register(client, config)
    injected.set(client, connection)
    return connection
  }

  const { connectionString } = config
  if (!connectionString) throw new TypeError(MISSING_CONNECTION)
  const key = identity(connectionString, config.clientOptions)
  const existing = constructed.get(key)
  if (existing !== undefined) return existing
  const connection = register(new MongoClient(connectionString, config.clientOptions), config)
  constructed.set(key, connection)
  return connection
}

/**
 * Closes the client built for a config's connection identity, for every store that shares it.
 *
 * @remarks
 * An injected client is forgotten, never closed. Idempotent, and a later {@link resolve} opens a fresh pool.
 *
 * @param config - The configuration whose connection to release
 */
export async function close(config: MongoDBConfig): Promise<void> {
  const { client } = config
  if (client !== undefined) {
    injected.delete(client)
    return
  }
  const { connectionString } = config
  if (!connectionString) return
  const key = identity(connectionString, config.clientOptions)
  const connection = constructed.get(key)
  if (connection === undefined) return
  // Forgotten before the await, so a concurrent close finds nothing to close again.
  constructed.delete(key)
  await connection.client.close()
}

/**
 * Runs `work`, and once more on a fresh client when the one this package built turns out to be closed.
 *
 * @remarks
 * The driver closes a client for good when its first connection fails, where pymongo selects a server again.
 *
 * @param config - The configuration `work` resolves its connection from, on every run
 * @param work - The operation
 * @returns Whatever `work` resolves to
 * @throws StorageError if the closed client was injected, since only its owner can reopen it
 */
export async function onLiveClient<T>(config: MongoDBConfig, work: () => Promise<T>): Promise<T> {
  const connection = resolve(config)
  try {
    return await work()
  } catch (error) {
    if (!clientClosed(error)) throw error
    if (config.client !== undefined) throw new StorageError(INJECTED_CLIENT_CLOSED, { cause: error })
    const key = identity(config.connectionString ?? '', config.clientOptions)
    const registered = constructed.get(key)
    // Absent after `close()`: the caller released the pool, so nothing reopens it here.
    if (registered === undefined) throw error
    if (registered === connection) {
      constructed.delete(key)
      await connection.client.close()
    }
    return work()
  }
}

// The driver ignores a repeated identical `appendMetadata`, so a re-registered injected client is attributed once.
function register(client: MongoClient, config: MongoDBConfig): Connection {
  client.appendMetadata({ name: DRIVER_NAME, version: PACKAGE_VERSION })
  if (client.options.retryWrites === false) {
    const logger = config.logger ?? defaultLogger
    logger.warn(`${RETRY_WRITES_DISABLED} | ${logFields('retry_writes_disabled')}`)
  }
  event('strands_mongodb.client.acquired', { 'strands_mongodb.client.injected': config.client !== undefined })
  return new Connection(client)
}

function identity(connectionString: string, clientOptions: MongoClientOptions = {}): string {
  return createHash('sha256')
    .update(`${connectionString}\0${stableJson(clientOptions)}`)
    .digest('hex')
}

// Non-JSON objects render with a per-object id, so distinct objects key distinctly, as Python's `repr` does.
function stableJson(value: unknown): string {
  return JSON.stringify(normalise(value))
}

function normalise(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (Array.isArray(value)) return value.map(normalise)
  if (typeof value === 'object' && isPlain(value)) {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, normalise(record[key])])
    )
  }
  if (typeof value === 'object' || typeof value === 'function')
    return `${Object.prototype.toString.call(value)}#${objectId(value)}`
  return String(value)
}

function isPlain(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function objectId(value: object): number {
  let id = objectIds.get(value)
  if (id === undefined) {
    id = ++nextObjectId
    objectIds.set(value, id)
  }
  return id
}
