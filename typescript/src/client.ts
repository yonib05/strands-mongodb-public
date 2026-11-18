import { createHash } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { defaultLogger, logFields } from './logging.js'
import { event } from './telemetry.js'
import type { MongoDBConfig } from './types.js'
import { PACKAGE_VERSION } from './version.js'

// The `driver.name` entry server logs and Atlas telemetry group by. Changing it orphans usage data.
/** Name this package appends to the driver's handshake metadata. */
export const DRIVER_NAME = 'Strands-MongoDB'

const MISSING_CONNECTION =
  "strands_mongodb: a MongoDB connection is required, but neither 'client' nor 'connectionString' was set in the configuration. Set 'connectionString' to a MongoDB URI, or set 'client' to a MongoClient you already have."

const RETRY_WRITES_DISABLED =
  "strands_mongodb: retryWrites is disabled on this MongoDB connection; this package relies on the driver's retries for its single-document writes, so a write interrupted by a primary election surfaces to the caller instead of being replayed. Nothing is corrupted; remove retryWrites=false to restore the designed behavior."

/** What a deployment can do, probed once and cached on its connection. */
export interface Capabilities {
  /** Whether the deployment runs Atlas Search. */
  search: boolean
  /** The server error code that reported no search; set only when `search` is `false`. */
  noSearchCode?: number
  /** Whether the server is new enough for `$rankFusion`. Probed only where search exists. */
  rankFusion: boolean
}

/** One MongoDB client and the per-connection state a config object cannot hold. Never holds the connection string. */
export class Connection {
  /** Result of the capability probe, absent until it has run. */
  capabilities?: Capabilities
  /** `db.coll` namespaces whose default collation was read and found binary. */
  readonly binaryKeys = new Set<string>()
  private _tail: Promise<unknown> = Promise.resolve()

  /**
   * @param client - The shared client, built here or injected by the caller
   * @param owned - Whether this module built the client; an injected one is never closed
   */
  constructor(
    readonly client: MongoClient,
    readonly owned: boolean
  ) {}

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
}

// Keyed by a digest, never by the connection string, so no key can leak a password.
const constructed = new Map<string, Connection>()
const injected = new WeakMap<MongoClient, Connection>()
// Outlives `close()`, so a close-and-resolve cycle never grows the handshake metadata.
const attributed = new WeakSet<MongoClient>()
const objectIds = new WeakMap<object, number>()
let nextObjectId = 0

/**
 * Returns the shared connection for a config, creating it on first use.
 *
 * @param config - Only the connection fields are read; `database` does not affect identity
 * @returns The same connection for every config with the same connection identity
 * @throws TypeError if neither `client` nor `connectionString` is set
 */
export function resolve(config: MongoDBConfig): Connection {
  const { client } = config
  if (client !== undefined) {
    const existing = injected.get(client)
    if (existing !== undefined) return existing
    if (!attributed.has(client)) {
      client.appendMetadata({ name: DRIVER_NAME, version: PACKAGE_VERSION })
      attributed.add(client)
    }
    const connection = register(client, false, config)
    injected.set(client, connection)
    return connection
  }

  const key = identity(config)
  const existing = constructed.get(key)
  if (existing !== undefined) return existing
  const created = new MongoClient(config.connectionString!, config.clientOptions)
  created.appendMetadata({ name: DRIVER_NAME, version: PACKAGE_VERSION })
  const connection = register(created, true, config)
  constructed.set(key, connection)
  return connection
}

/**
 * Releases the connection for a config, closing the client only if this module built it.
 * Idempotent, and a no-op for a config that never resolved. A later `resolve` opens a fresh pool.
 *
 * @param config - The configuration whose connection to release
 */
export async function close(config: MongoDBConfig): Promise<void> {
  const { client } = config
  if (client !== undefined) {
    injected.delete(client)
    return
  }
  if (!config.connectionString) return
  const key = identity(config)
  const connection = constructed.get(key)
  if (connection === undefined) return
  // Forgotten before the await, so a concurrent close finds nothing to close again.
  constructed.delete(key)
  await connection.client.close()
}

function register(client: MongoClient, owned: boolean, config: MongoDBConfig): Connection {
  if (client.options.retryWrites === false) {
    const logger = config.logger ?? defaultLogger
    logger.warn(`${RETRY_WRITES_DISABLED} | ${logFields('retry_writes_disabled')}`)
  }
  event('strands_mongodb.client.acquired', { 'strands_mongodb.client.injected': !owned })
  return new Connection(client, owned)
}

function identity(config: MongoDBConfig): string {
  const { connectionString } = config
  if (!connectionString) throw new TypeError(MISSING_CONNECTION)
  const options = stableJson(config.clientOptions ?? {})
  return createHash('sha256').update(`${connectionString}\0${options}`).digest('hex')
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
