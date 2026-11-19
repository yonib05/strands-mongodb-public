import { Buffer } from 'node:buffer'
import { inspect } from 'node:util'
import { trace } from '@opentelemetry/api'
import type { Logger } from '@strands-agents/sdk'
import type { Collection, MongoClient, MongoClientOptions } from 'mongodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConstructedMongoClient, FakeCollection, FakeMongoClient, freshUri } from '../__fixtures__/fake-mongo.js'
import { recordSpans } from '../__fixtures__/spans.js'
import { close, type Connection, resolve } from '../client.js'
import type { MongoDBConfig } from '../types.js'
import { PACKAGE_VERSION } from '../version.js'
import { errorOf } from '../__fixtures__/errors.js'

vi.mock('mongodb', async () => ({
  MongoClient: (await import('../__fixtures__/fake-mongo.js')).ConstructedMongoClient,
}))

const PASSWORD = 'SUPERSECRET'
const exporter = recordSpans()

const resolved: MongoDBConfig[] = []

beforeEach(() => {
  ConstructedMongoClient.built.length = 0
})

afterEach(async () => {
  await Promise.all(resolved.splice(0).map((config) => close(config)))
})

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function track(config: MongoDBConfig): Connection {
  resolved.push(config)
  return resolve(config)
}

function injected(options: { retryWrites?: boolean } = {}): FakeMongoClient & MongoClient {
  return new FakeMongoClient(options) as FakeMongoClient & MongoClient
}

function built(connection: Connection): ConstructedMongoClient {
  expect(connection.client).toBeInstanceOf(ConstructedMongoClient)
  return connection.client as unknown as ConstructedMongoClient
}

function warnings(logger: Logger): string[] {
  return vi.mocked(logger.warn).mock.calls.map((call) => String(call[0]))
}

describe('resolve', () => {
  describe('AT-015: construction requires a way to reach the database', () => {
    it('throws a TypeError naming both fields when neither is set', () => {
      const error = errorOf(() => resolve({ database: 'appdb' }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toMatch(/^strands_mongodb: /)
      expect(error.message).toContain("'client'")
      expect(error.message).toContain("'connectionString'")
    })

    it('treats an empty connection string as missing', () => {
      expect(() => resolve({ database: 'appdb', connectionString: '' })).toThrow(TypeError)
    })

    it('builds no client for a rejected config', () => {
      expect(() => resolve({ database: 'appdb' })).toThrow(TypeError)

      expect(ConstructedMongoClient.built).toEqual([])
    })
  })

  describe('AT-010, AT-011: ownership decides who may close', () => {
    it('never closes an injected client, however often close runs', async () => {
      const client = injected()
      const config = { database: 'appdb', client }

      resolve(config)
      await close(config)
      await close(config)

      expect(client.closeCount).toBe(0)
    })

    it('treats closing a config that never resolved as a no-op', async () => {
      await expect(close({ database: 'appdb' })).resolves.toBeUndefined()
      await expect(close({ database: 'appdb', connectionString: freshUri() })).resolves.toBeUndefined()
    })

    it('closes a client it constructed exactly once', async () => {
      const config = { database: 'appdb', connectionString: freshUri() }
      const client = built(resolve(config))

      await Promise.all([close(config), close(config)])
      await close(config)

      expect(client.closeCount).toBe(1)
    })

    it('lets an injected client win over a connection string, which is never read', () => {
      const client = injected()
      const config = {
        database: 'appdb',
        client,
        get connectionString(): string {
          throw new Error('the connection string was read')
        },
      }

      const connection = track(config)

      expect(connection.client).toBe(client)
      expect(ConstructedMongoClient.built).toEqual([])
    })
  })

  describe('AT-012: one client per connection identity', () => {
    it('returns one connection for a hundred resolutions of one config', () => {
      const config = { database: 'appdb', connectionString: freshUri() }

      const connections = new Set(Array.from({ length: 100 }, () => track(config)))

      expect(connections.size).toBe(1)
      expect(ConstructedMongoClient.built).toHaveLength(1)
    })

    it('shares across separate configs with the same string, whatever their database', () => {
      const connectionString = freshUri()

      const first = track({ database: 'appdb', connectionString })
      const second = track({ database: 'otherdb', connectionString })

      expect(second).toBe(first)
    })

    it('does not share across different connection strings', () => {
      const first = track({ database: 'appdb', connectionString: freshUri() })
      const second = track({ database: 'appdb', connectionString: freshUri() })

      expect(second.client).not.toBe(first.client)
    })

    it('does not share across different client options, and each client gets its own', () => {
      const connectionString = freshUri()

      const patient = built(track({ database: 'appdb', connectionString, clientOptions: { connectTimeoutMS: 20000 } }))
      const impatient = built(track({ database: 'appdb', connectionString, clientOptions: { connectTimeoutMS: 500 } }))

      expect(impatient).not.toBe(patient)
      expect(patient.clientOptions.connectTimeoutMS).toBe(20000)
      expect(impatient.clientOptions.connectTimeoutMS).toBe(500)
    })

    it('keys empty and absent client options the same', () => {
      const connectionString = freshUri()

      const absent = track({ database: 'appdb', connectionString })
      const empty = track({ database: 'appdb', connectionString, clientOptions: {} })

      expect(empty).toBe(absent)
    })

    it('ignores the key order of client options', () => {
      const connectionString = freshUri()

      const first = track({
        database: 'appdb',
        connectionString,
        clientOptions: { connectTimeoutMS: 500, auth: { username: 'u', password: 'p' } },
      })
      const second = track({
        database: 'appdb',
        connectionString,
        clientOptions: { auth: { password: 'p', username: 'u' }, connectTimeoutMS: 500 },
      })

      expect(second).toBe(first)
    })

    it('keys distinct non-JSON option values distinctly and one value the same', () => {
      const connectionString = freshUri()
      const options = (): MongoClientOptions => ({ ca: Buffer.from('pem') })
      const sharedOptions = options()

      const first = track({ database: 'appdb', connectionString, clientOptions: options() })
      const second = track({ database: 'appdb', connectionString, clientOptions: options() })
      const third = track({ database: 'appdb', connectionString, clientOptions: sharedOptions })
      const fourth = track({ database: 'appdb', connectionString, clientOptions: sharedOptions })

      expect(second).not.toBe(first)
      expect(third).not.toBe(first)
      expect(fourth).toBe(third)
    })

    it('keys injected clients by identity', () => {
      const firstClient = injected()
      const secondClient = injected()

      const first = track({ database: 'appdb', client: firstClient })
      const second = track({ database: 'appdb', client: secondClient })
      const again = track({ database: 'otherdb', client: firstClient })

      expect(first.client).toBe(firstClient)
      expect(second.client).toBe(secondClient)
      expect(again).toBe(first)
    })

    it('opens a fresh client after close', async () => {
      const config = { database: 'appdb', connectionString: freshUri() }
      const first = resolve(config)

      await close(config)
      const second = track(config)

      expect(second.client).not.toBe(first.client)
    })

    it('probes the deployment once and hands every later caller the same answer', async () => {
      const connection = track({ database: 'appdb', connectionString: freshUri() })
      const collection = new FakeCollection('appdb', 'memory')

      const first = await connection.probe(collection as unknown as Collection, silentLogger())
      const second = await connection.probe(collection as unknown as Collection, silentLogger())

      expect(first).toEqual({ search: true, rankFusion: true })
      expect(second).toBe(first)
      expect(collection.db.commandCalls).toHaveLength(1)
      expect(collection.searchIndexReads).toBe(1)
    })

    it('caches a binary collation only once the collection exists to be read', async () => {
      const connection = track({ database: 'appdb', connectionString: freshUri() })
      const collection = new FakeCollection('appdb', 'memory')
      const driver = collection as unknown as Collection

      await connection.requireBinaryKeys(driver)
      await connection.requireBinaryKeys(driver)
      expect(collection.db.listCollectionsCalls).toHaveLength(2)

      collection.setCollation(undefined)
      await connection.requireBinaryKeys(driver)
      await connection.requireBinaryKeys(driver)

      expect(collection.db.listCollectionsCalls).toHaveLength(3)
    })
  })

  describe('AT-013a, AT-013b, AT-230: driver attribution', () => {
    it('builds a client with the caller options unchanged and attributes it through appendMetadata', () => {
      const connectionString = freshUri()

      const client = built(track({ database: 'appdb', connectionString, clientOptions: { appName: 'mine' } }))

      expect(client.url).toBe(connectionString)
      expect(client.clientOptions).toEqual({ appName: 'mine' })
      expect(client.appended).toEqual([{ name: 'Strands-MongoDB', version: PACKAGE_VERSION }])
    })

    it("keeps a caller's own driverInfo beside this package's", () => {
      const driverInfo = { name: 'my-framework', version: '2.0.0' }

      const client = built(track({ database: 'appdb', connectionString: freshUri(), clientOptions: { driverInfo } }))

      expect(client.clientOptions).toEqual({ driverInfo })
      expect(client.options.metadata.driver.name).toBe('nodejs|my-framework|Strands-MongoDB')
      expect(client.options.metadata.driver.version).toBe(`7.8.0|2.0.0|${PACKAGE_VERSION}`)
    })

    it('attributes an injected client through appendMetadata', () => {
      const client = injected()

      track({ database: 'appdb', client })

      expect(client.appended).toEqual([{ name: 'Strands-MongoDB', version: PACKAGE_VERSION }])
      expect(client.options.metadata.driver.name).toBe('nodejs|Strands-MongoDB')
    })

    it('AT-190: appends once per client across repeated resolves and close cycles', async () => {
      const client = injected()
      const config = { database: 'appdb', client }

      for (let cycle = 0; cycle < 3; cycle += 1) {
        resolve(config)
        resolve({ database: 'otherdb', client })
        await close(config)
      }

      expect(client.appended).toHaveLength(1)
    })
  })

  describe('AT-016: disabled retryWrites is worth saying', () => {
    it('warns for a connection string disabling retries', () => {
      const logger = silentLogger()

      track({ database: 'appdb', connectionString: freshUri('?retryWrites=false'), logger })

      const [line, ...rest] = warnings(logger)
      expect(rest).toEqual([])
      expect(line).toMatch(/^strands_mongodb: retryWrites is disabled/)
      expect(line).toMatch(/\| event=retry_writes_disabled$/)
    })

    it('warns for client options disabling retries', () => {
      const logger = silentLogger()

      track({ database: 'appdb', connectionString: freshUri(), clientOptions: { retryWrites: false }, logger })

      expect(warnings(logger)).toHaveLength(1)
    })

    it('warns for an injected client with retries disabled', () => {
      const logger = silentLogger()

      track({ database: 'appdb', client: injected({ retryWrites: false }), logger })

      expect(warnings(logger)).toHaveLength(1)
    })

    it('warns once per connection however many stores resolve it', () => {
      const logger = silentLogger()
      const client = injected({ retryWrites: false })
      const constructed = { database: 'appdb', connectionString: freshUri('?retryWrites=false'), logger }

      for (let store = 0; store < 100; store += 1) {
        track(constructed)
        track({ database: 'appdb', client, logger })
      }

      expect(warnings(logger)).toHaveLength(2)
    })

    it('warns about nothing on the default configuration', () => {
      const logger = silentLogger()

      track({ database: 'appdb', connectionString: freshUri(), logger })
      track({ database: 'appdb', client: injected(), logger })

      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('falls back to console.warn without a logger', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      track({ database: 'appdb', connectionString: freshUri('?retryWrites=false') })

      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('event=retry_writes_disabled')
    })
  })

  describe('AT-014: the password never leaves the config', () => {
    it('keeps the password out of the logs and the connection state', () => {
      const logger = silentLogger()
      const connectionString = `mongodb://user:${PASSWORD}@127.0.0.1:1/?retryWrites=false`

      const connection = track({ database: 'appdb', connectionString, logger })

      const logged = Object.values(logger).flatMap((method) => vi.mocked(method).mock.calls.flat().map(String))
      expect(logged.join('\n')).not.toContain(PASSWORD)
      const { client: _client, ...state } = connection
      expect(inspect(state, { depth: 5 })).not.toContain(PASSWORD)
    })
  })

  describe('AT-117: the acquired span event', () => {
    async function eventsOf(run: () => void): Promise<{ name: string; attributes: unknown }[]> {
      await trace.getTracer('test').startActiveSpan('outer', async (outer) => {
        run()
        outer.end()
      })
      const [outer] = exporter.getFinishedSpans()
      return (outer?.events ?? []).map(({ name, attributes }) => ({ name, attributes }))
    }

    it('records a constructed client as not injected, once per connection', async () => {
      const config = { database: 'appdb', connectionString: `mongodb://user:${PASSWORD}@127.0.0.1:1/` }

      const events = await eventsOf(() => {
        track(config)
        track(config)
      })

      expect(events).toEqual([
        { name: 'strands_mongodb.client.acquired', attributes: { 'strands_mongodb.client.injected': false } },
      ])
      expect(JSON.stringify(exporter.getFinishedSpans()[0]?.events)).not.toContain(PASSWORD)
    })

    it('records an injected client as injected, once per connection', async () => {
      const config = { database: 'appdb', client: injected() }

      const events = await eventsOf(() => {
        track(config)
        track(config)
      })

      expect(events).toEqual([
        { name: 'strands_mongodb.client.acquired', attributes: { 'strands_mongodb.client.injected': true } },
      ])
    })
  })
})

describe('Connection.locked', () => {
  it('runs one call at a time, in call order', async () => {
    const connection = track({ database: 'appdb', connectionString: freshUri() })
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })

    const first = connection.locked(async () => {
      order.push('first:start')
      await gate
      order.push('first:end')
      return 1
    })
    const second = connection.locked(async () => {
      order.push('second')
      return 2
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['first:start'])

    release()

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('keeps serving callers after one rejects', async () => {
    const connection = track({ database: 'appdb', connectionString: freshUri() })
    const failure = new Error('boom')

    const first = connection.locked(async () => {
      throw failure
    })
    const second = connection.locked(async () => 'ok')

    await expect(first).rejects.toBe(failure)
    await expect(second).resolves.toBe('ok')
  })
})
