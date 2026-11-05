import { inspect } from 'node:util'
import { SpanStatusCode } from '@opentelemetry/api'
import { type Logger, type MemoryStore, StorageError } from '@strands-agents/sdk'
import type { Embedder } from '@strands-agents/sdk/storage/search'
import { type MongoClient, MongoNetworkTimeoutError, MongoServerError } from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConstructedMongoClient, FakeCollection, FakeMongoClient } from '../__fixtures__/fake-mongo.js'
import { oneSpan, recordSpans, spansNamed } from '../__fixtures__/spans.js'
import { close } from '../client.js'
import { memorySearchSpecs, READY_TIMEOUT_SECONDS, SearchIndexNotReady } from '../indexes.js'
import {
  DEFAULT_COLLECTION,
  MongoDBMemoryStore,
  resolveLimit,
  TIER_RETRY_MAX_SECONDS,
  TIER_RETRY_SECONDS,
  UNSCOPED,
} from '../memory-store.js'
import { MongoDBStorage } from '../storage.js'
import { DEFAULT_MAX_SEARCH_RESULTS, type MongoDBConfig, type MongoDBMemoryStoreConfig } from '../types.js'

vi.mock('mongodb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('mongodb')>()),
  MongoClient: (await import('../__fixtures__/fake-mongo.js')).ConstructedMongoClient,
}))

const exporter = recordSpans()

// A URI whose password must not appear in any message or rendering this module produces.
const LEAKY_URI = 'mongodb://appuser:SUPERSECRET@db.example.com:27017/appdb'

const CASE_INSENSITIVE = { locale: 'en', strength: 2 }

// The manual-vector path, where no embedding model is needed and `vector` has a meaning on a query.
const MANUAL_VECTOR = { embeddingDimensions: 4, similarity: 'cosine' } as const

// What a server without `$rankFusion` reports.
const MONGO_7 = { version: '7.0.12', versionArray: [7, 0, 12, 0] }

const NO_SEARCH_CODE = 31082

const SPECS = Object.fromEntries(memorySearchSpecs({ database: 'appdb' }).map((spec) => [spec.name, spec]))

let port = 0

// A fresh address per call, so registry entries never leak between tests.
function uri(): string {
  port += 1
  return `mongodb://127.0.0.1:${port}/`
}

type Level = 'debug' | 'info' | 'warn' | 'error'

// Keeps every line in call order, so the interleaving of info and warn lines can be asserted.
class RecordingLogger implements Logger {
  readonly records: Array<[Level, string]> = []
  debug = (...args: unknown[]): void => this.record('debug', args)
  info = (...args: unknown[]): void => this.record('info', args)
  warn = (...args: unknown[]): void => this.record('warn', args)
  error = (...args: unknown[]): void => this.record('error', args)

  lines(level: Level): string[] {
    return this.records.filter(([at]) => at === level).map(([, line]) => line)
  }

  private record(level: Level, args: unknown[]): void {
    this.records.push([level, args.map(String).join(' ')])
  }
}

function serverError(code: number, message = 'probed'): MongoServerError {
  return new MongoServerError({ message, code })
}

interface Setup {
  store: MongoDBMemoryStore
  collection: FakeCollection
  client: FakeMongoClient
  logger: RecordingLogger
}

interface SetupOptions {
  store?: Partial<Omit<MongoDBMemoryStoreConfig, 'config'>>
  config?: Partial<MongoDBConfig>
  client?: FakeMongoClient
  logger?: RecordingLogger
}

function setup(options: SetupOptions = {}): Setup {
  const client = options.client ?? new FakeMongoClient()
  const logger = options.logger ?? new RecordingLogger()
  const store = new MongoDBMemoryStore({
    name: 'facts',
    config: { database: 'appdb', client: client as unknown as MongoClient, logger, ...options.config },
    ...options.store,
  })
  const collection = client.db('appdb').collection(options.store?.collection ?? DEFAULT_COLLECTION)
  return { store, collection, client, logger }
}

// A store on a deployment whose server cannot run `$rankFusion`, so the two single tiers resolve on their own.
function withoutFusion(options: SetupOptions = {}): Setup {
  const built = setup(options)
  built.collection.db.buildInfo = MONGO_7
  return built
}

function withoutSearch(options: SetupOptions = {}): Setup {
  const built = setup(options)
  built.collection.failListSearchIndexes(serverError(NO_SEARCH_CODE, 'Unrecognized pipeline stage name'))
  return built
}

// Puts search indexes in place as the server would report them, so `ensure` reads them rather than creating them.
function reporting(collection: FakeCollection, status: 'PENDING' | 'FAILED', ...names: string[]): void {
  for (const name of names) collection.addSearchIndex(SPECS[name]!.toDescription(), status)
}

function tiers(store: MongoDBMemoryStore): string[] {
  return store['_tiers']
}

function createdSearchIndexes(collection: FakeCollection): string[] {
  return collection.createdSearchIndexes.map((index) => String(index.name))
}

function count(collection: FakeCollection, method: string): number {
  return collection.namesCalled.filter((name) => name === method).length
}

// The `(level, event, tier)` of every skipped-tier line, in order.
function skipped(logger: RecordingLogger): Array<[Level, string, string]> {
  return logger.records.flatMap(([level, line]): Array<[Level, string, string]> => {
    const event = /event=(tier_building|tier_unavailable)/.exec(line)
    return event ? [[level, event[1]!, /tier=(\w+)/.exec(line)?.[1] ?? '']] : []
  })
}

async function rejectionOf(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

function errorOf(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
}

class WordEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    return [text.length, 0, 0, 0]
  }
}

afterEach(() => {
  vi.useRealTimers()
  ConstructedMongoClient.built.length = 0
})

describe('MongoDBMemoryStore', () => {
  describe('AT-052: the MemoryStore interface is satisfied structurally', () => {
    it('is assignable to MemoryStore and offers search and initialize as functions', () => {
      const store: MemoryStore = setup().store

      expect(typeof store.search).toBe('function')
      expect(typeof store.initialize).toBe('function')
    })

    it('AT-044a: has no addMessages, so the manager extracts through add', () => {
      expect('addMessages' in setup().store).toBe(false)
    })
  })

  describe('AT-015: a bad config is rejected at construction, before a client is built', () => {
    it('throws a TypeError for a config with no nested config', () => {
      const error = errorOf(() => new MongoDBMemoryStore({ name: 'facts' } as unknown as MongoDBMemoryStoreConfig))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'config'")
    })

    it('throws a TypeError for a config with no name', () => {
      const error = errorOf(
        () =>
          new MongoDBMemoryStore({
            config: { database: 'appdb', connectionString: uri() },
          } as unknown as MongoDBMemoryStoreConfig)
      )

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'name'")
      expect(ConstructedMongoClient.built).toEqual([])
    })

    it('throws a TypeError for a connection config with no database', () => {
      const error = errorOf(
        () =>
          new MongoDBMemoryStore({
            name: 'facts',
            config: { connectionString: uri() } as unknown as MongoDBConfig,
          })
      )

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'database'")
      expect(ConstructedMongoClient.built).toEqual([])
    })

    it('throws a TypeError when neither client nor connectionString is set', () => {
      const error = errorOf(() => new MongoDBMemoryStore({ name: 'facts', config: { database: 'appdb' } }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain('connectionString')
    })

    it('AT-226: throws a RangeError for a negative ttlSeconds and registers no connection', () => {
      const connection = { database: 'appdb', connectionString: uri() }

      const error = errorOf(() => new MongoDBMemoryStore({ name: 'facts', config: connection, ttlSeconds: -1 }))

      expect(error).toBeInstanceOf(RangeError)
      expect(error.message).toContain('ttlSeconds')
      expect(ConstructedMongoClient.built).toEqual([])
    })

    it('AT-226: accepts 0 as a lifetime, and an explicit undefined as no lifetime', () => {
      expect(setup({ store: { ttlSeconds: 0 } }).store.ttlSeconds).toBe(0)
      const unset = setup({ store: { ttlSeconds: undefined } }).store
      expect(unset.ttlSeconds).toBeUndefined()
      expect(JSON.parse(JSON.stringify(unset))).not.toHaveProperty('ttlSeconds')
    })

    it('AT-041: throws a RangeError for a maxSearchResults below 1, naming the key', () => {
      const error = errorOf(() => setup({ store: { maxSearchResults: 0 } }))

      expect(error).toBeInstanceOf(RangeError)
      expect(error.message).toContain("'maxSearchResults' is 0")
    })

    it('AT-059a: throws a TypeError naming both keys when minScore and maxScore are both set', () => {
      const error = errorOf(() => setup({ store: { minScore: 0.1, maxScore: 0.9 } }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'minScore' is 0.1")
      expect(error.message).toContain("'maxScore' is 0.9")
    })

    it.each(['minScore', 'maxScore'] as const)('AT-059a: constructs with %s alone', (bound) => {
      const { store } = setup({ store: { [bound]: 0.5 } })

      expect(store[bound]).toBe(0.5)
    })

    it.each([
      [{ 'metadata.tier': 'gold' }, 'filterFields'],
      [{ $where: 'sleep(1000)' }, '$where'],
    ])('AT-076: validates a configured filter %j at construction', (filter, expected) => {
      const error = errorOf(() => setup({ store: { filter } }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain(expected)
    })

    it('AT-076: accepts a configured filter over a declared field', () => {
      const { store } = setup({
        store: { filter: { 'metadata.tier': 'gold' } },
        config: { filterFields: ['metadata.tier'] },
      })

      expect(store.filter).toEqual({ 'metadata.tier': 'gold' })
    })

    it('AT-243: throws a TypeError for an embedder on the AutoEmbeddings path', () => {
      const error = errorOf(() => setup({ store: { embedder: new WordEmbedder() } }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'embedder' is set")
      expect(error.message).toContain("'embeddingDimensions'")
    })

    it('accepts an embedder on the manual-vector path', () => {
      expect(() => setup({ store: { embedder: new WordEmbedder() }, config: MANUAL_VECTOR })).not.toThrow()
    })

    it('rejects a contradictory vector configuration before the connection is resolved', () => {
      const error = errorOf(
        () =>
          new MongoDBMemoryStore({
            name: 'facts',
            config: { database: 'appdb', connectionString: uri(), embeddingModel: 'm', ...MANUAL_VECTOR },
          })
      )

      expect(error).toBeInstanceOf(TypeError)
      expect(ConstructedMongoClient.built).toEqual([])
    })
  })

  describe('the fields the caller asks for', () => {
    it('records the SDK fields as given', () => {
      const { store } = setup({
        store: { description: 'facts about the user', maxSearchResults: 7, writable: true, extraction: true },
      })

      expect(store.name).toBe('facts')
      expect(store.description).toBe('facts about the user')
      expect(store.maxSearchResults).toBe(7)
      expect(store.writable).toBe(true)
      expect(store.extraction).toBe(true)
    })

    it('AT-058: defaults writable to false', () => {
      expect(setup().store.writable).toBe(false)
    })

    it('AT-048a: uses the unscoped sentinel for an absent or empty scope', () => {
      expect(setup().store.scope).toBe(UNSCOPED)
      expect(setup({ store: { scope: '' } }).store.scope).toBe(UNSCOPED)
      expect(setup({ store: { scope: 'tenant-a' } }).store.scope).toBe('tenant-a')
      expect(UNSCOPED).toBe('__unscoped__')
    })

    it('defaults the collection to memory, apart from the storage default', () => {
      expect(DEFAULT_COLLECTION).toBe('memory')
      expect(setup().store['_collectionName']).toBe('memory')
      expect(setup({ store: { collection: 'recall' } }).store['_collectionName']).toBe('recall')
    })

    it('records the database named in the nested config', () => {
      const { store } = setup({ config: { database: 'tenant_b' } })

      expect(store['_databaseName']).toBe('tenant_b')
    })

    it('keeps vector before text and narrows to a named tier', () => {
      const names = (store: MongoDBMemoryStore): string[] => store['_specs'].map(([tier]) => tier)

      expect(names(setup().store)).toEqual(['vector', 'text'])
      expect(names(setup({ config: { searchType: 'hybrid' } }).store)).toEqual(['vector', 'text'])
      expect(names(setup({ config: { searchType: 'text' } }).store)).toEqual(['text'])
      expect(names(setup({ config: { searchType: 'vector' } }).store)).toEqual(['vector'])
      expect(setup({ config: { vectorIndexName: 'v', textIndexName: 't' } }).store['_indexNames']).toEqual({
        vector: 'v',
        text: 't',
      })
    })

    it('allows a query to set both keys only on the manual path under auto or hybrid', () => {
      const possible = (config: Partial<MongoDBConfig>): boolean => setup({ config }).store['_fusionPossible']

      expect(possible({})).toBe(false)
      expect(possible(MANUAL_VECTOR)).toBe(true)
      expect(possible({ ...MANUAL_VECTOR, searchType: 'hybrid' })).toBe(true)
      expect(possible({ ...MANUAL_VECTOR, searchType: 'vector' })).toBe(false)
    })

    it('pins the retry constants', () => {
      expect(TIER_RETRY_SECONDS).toBe(60)
      expect(TIER_RETRY_MAX_SECONDS).toBe(3600)
    })
  })

  describe('AT-041: the result limit resolves query, then options, then the instance, then the default', () => {
    it('lets a query limit win over everything below it', () => {
      expect(resolveLimit({ query: 3, options: 7, instance: 11 })).toBe(3)
    })

    it('lets options win over the instance default', () => {
      expect(resolveLimit({ options: 7, instance: 11 })).toBe(7)
    })

    it('lets the instance value win over the package default', () => {
      expect(resolveLimit({ instance: 11 })).toBe(11)
    })

    it('resolves nothing supplied to the package default of 10', () => {
      expect(resolveLimit({})).toBe(DEFAULT_MAX_SEARCH_RESULTS)
      expect(DEFAULT_MAX_SEARCH_RESULTS).toBe(10)
    })

    it('rejects a value below 1 wherever it sits, naming the key it came from', () => {
      expect(() => resolveLimit({ query: 5, instance: 0 })).toThrow("'maxSearchResults' is 0")
      expect(() => resolveLimit({ query: 0 })).toThrow("'limit' is 0")
      expect(() => resolveLimit({ options: -1 })).toThrow(RangeError)
    })
  })

  describe('AT-012: stores built from one config share one client', () => {
    it('builds one client for 100 memory stores', () => {
      const connection = { database: 'appdb', connectionString: uri() }

      const stores = Array.from(
        { length: 100 },
        (_, index) => new MongoDBMemoryStore({ name: `facts${index}`, config: connection })
      )

      expect(new Set(stores.map((store) => store['_connection'].client)).size).toBe(1)
      expect(ConstructedMongoClient.built).toHaveLength(1)
    })

    it('shares the client between a storage and a memory store', () => {
      const connection = { database: 'appdb', connectionString: uri() }

      const storage = new MongoDBStorage(connection)
      const store = new MongoDBMemoryStore({ name: 'facts', config: connection })

      expect(store['_connection'].client).toBe(storage['_connection'].client)
      expect(ConstructedMongoClient.built).toHaveLength(1)
    })
  })

  describe('AT-014: no rendering of the store shows the connection string', () => {
    afterEach(() => close({ database: 'appdb', connectionString: LEAKY_URI }))

    it('renders neither the password nor the host from inspect or JSON', () => {
      const store = new MongoDBMemoryStore({
        name: 'facts',
        config: { database: 'appdb', connectionString: LEAKY_URI },
        scope: 'tenant-a',
      })

      for (const rendered of [inspect(store, { depth: 5 }), JSON.stringify(store)]) {
        expect(rendered).not.toContain('SUPERSECRET')
        expect(rendered).not.toContain('db.example.com')
        expect(rendered).toContain('tenant-a')
      }
    })

    it('renders no password from a wrapped driver failure in initialize', async () => {
      const store = new MongoDBMemoryStore({
        name: 'facts',
        config: { database: 'appdb', connectionString: LEAKY_URI },
      })
      const client = ConstructedMongoClient.built[0]!
      client.db('appdb').collection('memory').db.listCollectionsError = new MongoNetworkTimeoutError('socket timed out')

      const error = await rejectionOf(store.initialize())

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).not.toContain('SUPERSECRET')
      expect(inspect(error, { depth: 3 })).not.toContain('SUPERSECRET')
    })
  })

  describe('AT-078: what initialize decides', () => {
    it('creates both tiers vector first under auto and prefers the vector one', async () => {
      const { store, collection } = withoutFusion()

      await store.initialize()

      expect(createdSearchIndexes(collection)).toEqual(['vector_index', 'text_index'])
      expect(tiers(store)).toEqual(['vector', 'text'])
      expect(store['_initialized']).toBe(true)
    })

    it('creates the three ordinary indexes before any search index', async () => {
      const { store, collection } = withoutFusion()

      await store.initialize()

      expect(collection.indexes.map((index) => index.name)).toEqual([
        '_id_',
        'strands_scope_store_content_hash_unique',
        'strands_scope_store_created_at',
        'strands_expires_at_ttl',
      ])
      expect(count(collection, 'createIndexes')).toBe(1)
    })

    it('creates only its own index for a named search type', async () => {
      const { store, collection } = withoutFusion({ config: { searchType: 'text' } })

      await store.initialize()

      expect(createdSearchIndexes(collection)).toEqual(['text_index'])
      expect(tiers(store)).toEqual(['text'])
    })

    it("fails a named search type whose own tier failed, saying what refused and not naming 'auto'", async () => {
      const { store, collection } = withoutFusion({ config: { searchType: 'vector' } })
      reporting(collection, 'FAILED', 'vector_index')

      const error = await rejectionOf(store.initialize())

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain("'vector_index'")
      expect(error.message).toContain('FAILED')
      expect(error.message).not.toContain("'searchType' is 'auto'")
      expect(store['_initialized']).toBe(false)
    })

    it('warns per tier then raises when auto has every tier refused, chaining the last reason', async () => {
      const { store, collection, logger } = withoutFusion()
      reporting(collection, 'FAILED', 'vector_index', 'text_index')

      const error = await rejectionOf(store.initialize())

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('no search tier could be prepared on appdb.memory')
      expect((error.cause as Error).message).toContain("'text_index'")
      expect(skipped(logger)).toEqual([
        ['warn', 'tier_unavailable', 'vector'],
        ['warn', 'tier_unavailable', 'text'],
      ])
      expect(logger.lines('warn').every((line) => line.includes("'searchType' is 'auto'"))).toBe(true)
      expect(store['_initialized']).toBe(false)
    })

    it('AT-166: carries the server reason on the skipped-tier line and on the cause', async () => {
      const { store, collection, logger } = withoutFusion()
      reporting(collection, 'FAILED', 'vector_index', 'text_index')

      const error = await rejectionOf(store.initialize())

      const [line] = logger.lines('warn')
      expect(line).toContain('the vector search tier is not available on appdb.memory')
      expect(line).toContain("The server's own reason: strands_mongodb: the vectorSearch index 'vector_index'")
      expect(line).toMatch(/\| event=tier_unavailable, namespace=appdb\.memory, tier=vector$/)
      expect(error.cause).toBeInstanceOf(StorageError)
    })

    it('warns that answers became lexical when auto lands on text', async () => {
      const { store, collection, logger } = withoutFusion()
      reporting(collection, 'FAILED', 'vector_index')

      await store.initialize()

      expect(tiers(store)).toEqual(['text'])
      const warnings = logger.lines('warn')
      expect(warnings.some((line) => line.includes('the vector search tier is not available'))).toBe(true)
      const below = warnings.find((line) => line.includes('queries resolve to the text tier'))
      expect(below).toContain("'searchType' is 'auto' and the vector tier is not available on appdb.memory")
      expect(below).toMatch(/\| event=below_vector, namespace=appdb\.memory, tier=text$/)
    })

    it('warns below vector once per store, not once per retry', async () => {
      vi.useFakeTimers()
      const { store, collection, logger } = withoutFusion()
      reporting(collection, 'FAILED', 'vector_index')
      await store.initialize()

      vi.advanceTimersByTime(TIER_RETRY_SECONDS * 1000)
      await store.initialize()

      expect(logger.lines('warn').filter((line) => line.includes('event=below_vector'))).toHaveLength(1)
    })

    it('AT-053a: warns once per connection on a deployment without search, and initializes', async () => {
      const client = new FakeMongoClient()
      const logger = new RecordingLogger()
      const { store, collection } = withoutSearch({ client, logger })
      const others = Array.from(
        { length: 9 },
        (_, index) => setup({ client, logger, store: { name: `facts${index}` } }).store
      )

      await Promise.all([store, ...others].map((each) => each.initialize()))

      const warnings = logger.lines('warn')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('appdb.memory is on a deployment that does not run Atlas Search')
      expect(warnings[0]).toContain(`error code ${NO_SEARCH_CODE}`)
      expect(warnings[0]).toContain("Point 'connectionString' at MongoDB Atlas")
      expect(warnings[0]).toMatch(/\| event=no_search_setup, namespace=appdb\.memory$/)
      expect(createdSearchIndexes(collection)).toEqual([])
      expect(collection.indexes).toHaveLength(4)
      expect([store, ...others].every((each) => tiers(each).length === 0 && each['_initialized'])).toBe(true)
      expect(store['_connection'].capabilities).toEqual({
        search: false,
        noSearchCode: NO_SEARCH_CODE,
        rankFusion: false,
      })
    })

    it('schedules no retry where there is no search', async () => {
      const { store } = withoutSearch()

      await store.initialize()

      expect(store['_tierRetryAt']).toBeUndefined()
    })

    it('neither takes the lock nor redoes the setup on a second call', async () => {
      const { store, collection } = withoutFusion()
      collection.setCollation(undefined)
      const connection = store['_connection']
      const locked = vi.spyOn(connection, 'locked')

      await store.initialize()
      await store.initialize()

      expect(locked).toHaveBeenCalledTimes(1)
      expect(count(collection, 'createIndexes')).toBe(1)
      expect(collection.db.listCollectionsCalls).toHaveLength(1)
      expect(createdSearchIndexes(collection)).toEqual(['vector_index', 'text_index'])
    })

    it('does the work once when one store initializes twice at once', async () => {
      const { store, collection } = withoutFusion()

      await Promise.all([store.initialize(), store.initialize()])

      expect(count(collection, 'createIndexes')).toBe(1)
      expect(count(collection, 'listIndexes')).toBe(1)
      expect(createdSearchIndexes(collection)).toEqual(['vector_index', 'text_index'])
    })

    it('runs one capability probe for two stores on one connection', async () => {
      const client = new FakeMongoClient()
      const first = withoutFusion({ client })
      const second = setup({ client, store: { name: 'others' } })

      await first.store.initialize()
      await second.store.initialize()

      expect(first.collection.db.commandCalls).toEqual([{ buildInfo: 1 }])
      expect(second.store['_capabilities']).toBe(first.store['_capabilities'])
    })

    it('AT-036: turns a driver error escaping the setup into a StorageError naming the namespace', async () => {
      const { store, client } = setup()
      const failure = new MongoNetworkTimeoutError('socket timed out')
      client.db = () => {
        throw failure
      }

      const error = await rejectionOf(store.initialize())

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toBe('strands_mongodb: initializing appdb.memory failed: socket timed out')
      expect(error.cause).toBe(failure)
    })

    it('passes a non-driver error through unchanged', async () => {
      const { store, client } = setup()
      const failure = new Error('programming error')
      client.db = () => {
        throw failure
      }

      const error = await rejectionOf(store.initialize())

      expect(error).toBe(failure)
    })

    it('declares search but leaves it to the operations', async () => {
      const { store } = setup()

      await expect(store.search('dark mode')).rejects.toThrow('not implemented')
    })
  })

  describe('AT-126: the index ready budget reaches ensure', () => {
    it('AT-242: reads status without waiting for the search indexes under auto', async () => {
      const { store, collection, logger } = withoutFusion({ config: { indexReadyTimeout: 7 } })
      reporting(collection, 'PENDING', 'vector_index', 'text_index')

      await store.initialize()

      expect(collection.searchIndexReads).toBe(5)
      expect(logger.lines('info').filter((line) => line.includes('waited 0s'))).toHaveLength(2)
    })

    it('waits the configured budget for a named tier', async () => {
      vi.useFakeTimers()
      const { store, collection } = withoutFusion({ config: { indexReadyTimeout: 1, searchType: 'text' } })
      reporting(collection, 'PENDING', 'text_index')

      const pending = store.initialize()
      const settled = rejectionOf(pending)
      await vi.advanceTimersByTimeAsync(1500)
      const error = await settled

      expect(error).toBeInstanceOf(SearchIndexNotReady)
      expect(error.message).toContain('waited 1s')
    })

    it('resolves absence to the module default', async () => {
      vi.useFakeTimers()
      const { store, collection } = withoutFusion({ config: { searchType: 'text' } })
      reporting(collection, 'PENDING', 'text_index')

      const settled = rejectionOf(store.initialize())
      await vi.advanceTimersByTimeAsync((READY_TIMEOUT_SECONDS + 1) * 1000)
      const error = await settled

      expect(error.message).toContain(`waited ${READY_TIMEOUT_SECONDS}s`)
    })
  })

  describe('AT-242: auto does not wait for a build', () => {
    it('initializes with no tiers while every tier is still building, logging each at info', async () => {
      const { store, collection, logger } = withoutFusion()
      reporting(collection, 'PENDING', 'vector_index', 'text_index')

      await store.initialize()

      expect(tiers(store)).toEqual([])
      expect(store['_initialized']).toBe(true)
      expect(skipped(logger)).toEqual([
        ['info', 'tier_building', 'vector'],
        ['info', 'tier_building', 'text'],
      ])
      expect(logger.lines('info').at(-1)).toMatch(/\| event=tier_building, namespace=appdb\.memory, tier=text$/)
      expect(logger.lines('warn')).toEqual([])
    })

    it('schedules a retry and ignores it until it is due', async () => {
      vi.useFakeTimers()
      const { store, collection } = withoutFusion()
      reporting(collection, 'PENDING', 'vector_index', 'text_index')
      await store.initialize()
      const reads = collection.searchIndexReads

      expect(store['_tierRetryAt']).toBe(Date.now() + TIER_RETRY_SECONDS * 1000)
      vi.advanceTimersByTime(TIER_RETRY_SECONDS * 1000 - 1)
      await store.initialize()

      expect(collection.searchIndexReads).toBe(reads)
    })

    it('picks up the finished build on a retry and clears the schedule', async () => {
      vi.useFakeTimers()
      const { store, collection } = withoutFusion()
      reporting(collection, 'PENDING', 'vector_index', 'text_index')
      await store.initialize()

      collection.setSearchIndexStatus('vector_index', 'READY')
      collection.setSearchIndexStatus('text_index', 'READY')
      vi.advanceTimersByTime(TIER_RETRY_SECONDS * 1000)
      await store.initialize()

      expect(tiers(store)).toEqual(['vector', 'text'])
      expect(store['_tierRetryAt']).toBeUndefined()
    })

    it('offers hybrid once a retry finds both tiers on a deployment with the stage', async () => {
      vi.useFakeTimers()
      const { store, collection, logger } = setup()
      reporting(collection, 'PENDING', 'vector_index')
      await store.initialize()
      expect(tiers(store)).toEqual(['text'])
      expect(skipped(logger)).toEqual([['info', 'tier_building', 'vector']])
      expect(store['_tierRetryAt']).toBeDefined()

      collection.setSearchIndexStatus('vector_index', 'READY')
      vi.advanceTimersByTime(TIER_RETRY_SECONDS * 1000)
      await store.initialize()

      expect(tiers(store)).toEqual(['hybrid', 'vector', 'text'])
      expect(store['_tierRetryAt']).toBeUndefined()
    })

    it('doubles the delay after a retry that still finds the tier missing, up to the ceiling', async () => {
      vi.useFakeTimers()
      const { store, collection } = withoutFusion()
      reporting(collection, 'PENDING', 'vector_index')
      await store.initialize()

      let delay = TIER_RETRY_SECONDS
      for (const expected of [120, 240, 480, 960, 1920, 3600, 3600]) {
        vi.advanceTimersByTime(delay * 1000)
        await store.initialize()
        expect(store['_tierRetryDelay']).toBe(expected)
        expect(store['_tierRetryAt']).toBe(Date.now() + expected * 1000)
        delay = expected
      }
      expect(tiers(store)).toEqual(['text'])
    })

    it('keeps the tiers it has when a retry fails outright', async () => {
      vi.useFakeTimers()
      const { store, collection, logger } = withoutFusion()
      reporting(collection, 'PENDING', 'vector_index')
      await store.initialize()

      const outage = serverError(125, 'mongot unreachable')
      collection.failListSearchIndexes(outage, outage)
      vi.advanceTimersByTime(TIER_RETRY_SECONDS * 1000)
      await store.initialize()

      expect(tiers(store)).toEqual(['text'])
      expect(store['_tierRetryDelay']).toBe(2 * TIER_RETRY_SECONDS)
      expect(logger.lines('warn').filter((line) => line.includes('mongot unreachable'))).toHaveLength(2)
    })

    it('still warns a refused tier while a building one stays at info', async () => {
      const { store, collection, logger } = withoutFusion()
      reporting(collection, 'FAILED', 'vector_index')
      reporting(collection, 'PENDING', 'text_index')

      await store.initialize()

      expect(tiers(store)).toEqual([])
      expect(skipped(logger)).toEqual([
        ['warn', 'tier_unavailable', 'vector'],
        ['info', 'tier_building', 'text'],
      ])
    })

    it('raises when only refusals remain, since there is nothing to wait for', async () => {
      const { store, collection } = withoutFusion()
      reporting(collection, 'FAILED', 'vector_index', 'text_index')

      const error = await rejectionOf(store.initialize())

      expect(error.message).toContain('no search tier could be prepared')
    })

    describe('the first wait for a tier', () => {
      it('waits for the build beside a refusal and resolves to the tier that came up', async () => {
        const { store, collection } = withoutFusion()
        reporting(collection, 'FAILED', 'vector_index')
        reporting(collection, 'PENDING', 'text_index')
        await store.initialize()
        expect(tiers(store)).toEqual([])

        collection.setSearchIndexStatus('text_index', 'READY')
        await store['_waitForATier']()

        expect(tiers(store)).toEqual(['text'])
        expect(store['_waitedForATier']).toBe(true)
      })

      it('does not hold a ready tier behind one still building', async () => {
        const { store, collection, logger } = withoutFusion({ config: { indexReadyTimeout: 1 } })
        reporting(collection, 'PENDING', 'vector_index', 'text_index')
        await store.initialize()
        logger.records.length = 0

        collection.setSearchIndexStatus('text_index', 'READY')
        await store['_waitForATier']()

        expect(tiers(store)).toEqual(['text'])
        expect(skipped(logger)).toEqual([['info', 'tier_building', 'vector']])
        expect(store['_tierRetryAt']).toBeDefined()
      })

      it('warns each tier when the wait runs out', async () => {
        vi.useFakeTimers()
        const { store, collection, logger } = withoutFusion({ config: { indexReadyTimeout: 1 } })
        reporting(collection, 'PENDING', 'vector_index', 'text_index')
        await store.initialize()
        logger.records.length = 0

        const wait = store['_waitForATier']()
        await vi.advanceTimersByTimeAsync(1500)
        await wait

        expect(tiers(store)).toEqual([])
        expect(skipped(logger)).toEqual([
          ['warn', 'tier_unavailable', 'vector'],
          ['warn', 'tier_unavailable', 'text'],
        ])
        expect(store['_waitedForATier']).toBe(true)
      })

      it('shares one wait between callers and starts a new one after it settles', async () => {
        const { store, collection } = withoutFusion()
        reporting(collection, 'PENDING', 'vector_index', 'text_index')
        await store.initialize()

        collection.setSearchIndexStatus('text_index', 'READY')
        const first = store['_waitForATier']()
        const second = store['_waitForATier']()
        expect(second).toBe(first)
        await first

        expect(store['_tierWait']).toBeUndefined()
        const third = store['_waitForATier']()
        expect(third).not.toBe(first)
        await third
      })

      it('passes a failure through the wait and forgets the wait', async () => {
        const { store, collection, client } = withoutFusion()
        reporting(collection, 'PENDING', 'vector_index', 'text_index')
        await store.initialize()
        const failure = new Error('programming error')
        client.db = () => {
          throw failure
        }

        await expect(store['_waitForATier']()).rejects.toBe(failure)
        expect(store['_tierWait']).toBeUndefined()
        expect(store['_waitedForATier']).toBe(false)
      })
    })
  })

  describe('AT-176: a scope needs a collection that compares bytes', () => {
    it('refuses a case-folding collection before the probe and every index', async () => {
      const { store, collection } = setup()
      collection.setCollation(CASE_INSENSITIVE)

      const error = await rejectionOf(store.initialize())

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('collation')
      expect(collection.calls).toEqual([])
      expect(collection.searchIndexReads).toBe(0)
      expect(createdSearchIndexes(collection)).toEqual([])
      expect(store['_initialized']).toBe(false)
    })

    it('checks a collection that compares bytes once and then sets it up', async () => {
      const { store, collection } = setup()
      collection.setCollation(undefined)

      await store.initialize()

      expect(collection.db.listCollectionsCalls).toEqual([{ name: 'memory' }])
      expect(count(collection, 'createIndexes')).toBe(1)
    })

    it('does not cache a refusal, so the collection can be fixed', async () => {
      const { store, collection } = setup()
      collection.setCollation(CASE_INSENSITIVE)

      await expect(store.initialize()).rejects.toBeInstanceOf(StorageError)
      collection.setCollation(undefined)
      await store.initialize()

      expect(store['_initialized']).toBe(true)
      expect(collection.db.listCollectionsCalls).toHaveLength(2)
    })

    it('checks once between ten stores on one connection', async () => {
      const client = new FakeMongoClient()
      const stores = Array.from({ length: 10 }, (_, index) => setup({ client, store: { name: `facts${index}` } }))
      stores[0]!.collection.setCollation(undefined)

      for (const { store } of stores) await store.initialize()

      expect(stores[0]!.collection.db.listCollectionsCalls).toHaveLength(1)
    })
  })

  describe('AT-192: an absent collection is not a verified one', () => {
    it('reads the collation again once the indexes have created the collection', async () => {
      const { store, collection } = setup()
      expect(collection.exists).toBe(false)

      await store.initialize()

      expect(collection.db.listCollectionsCalls).toHaveLength(2)
      expect(store['_connection'].binaryKeys.has('appdb.memory')).toBe(true)
      expect(store['_initialized']).toBe(true)
    })

    it('caches the read that found something, so a second store adds no third read', async () => {
      const client = new FakeMongoClient()
      const first = setup({ client })
      const second = setup({ client, store: { name: 'others' } })

      await first.store.initialize()
      await second.store.initialize()

      expect(first.collection.db.listCollectionsCalls).toHaveLength(2)
    })

    it('fails initialize when a collation appears during provisioning', async () => {
      const { store, collection } = setup()
      collection.collectionOptions = { collation: CASE_INSENSITIVE }

      const error = await rejectionOf(store.initialize())

      expect(error.message).toContain('collation')
      expect(store['_initialized']).toBe(false)
      expect(collection.db.listCollectionsCalls).toHaveLength(2)
    })
  })

  describe('AT-146, AT-147: the hybrid tier is a statement about two others', () => {
    it('prefers fusion under auto where the deployment and both tiers allow it', async () => {
      const { store, collection } = setup()

      await store.initialize()

      expect(createdSearchIndexes(collection)).toEqual(['vector_index', 'text_index'])
      expect(tiers(store)).toEqual(['hybrid', 'vector', 'text'])
      expect(store['_connection'].capabilities).toEqual({ search: true, rankFusion: true })
    })

    it('resolves vector first without the stage, after one version read', async () => {
      const { store, collection } = withoutFusion()

      await store.initialize()

      expect(collection.db.commandCalls).toEqual([{ buildInfo: 1 }])
      expect(tiers(store)).toEqual(['vector', 'text'])
    })

    it('does not ask for the version where the deployment cannot search', async () => {
      const { store, collection } = withoutSearch()

      await store.initialize()

      expect(collection.db.commandCalls).toEqual([])
      expect(tiers(store)).toEqual([])
    })

    it('asks the version once for ten stores on one connection', async () => {
      const client = new FakeMongoClient()
      const stores = Array.from({ length: 10 }, (_, index) => setup({ client, store: { name: `facts${index}` } }))

      await Promise.all(stores.map(({ store }) => store.initialize()))

      expect(stores[0]!.collection.db.commandCalls).toHaveLength(1)
      expect(stores.every(({ store }) => tiers(store).join() === 'hybrid,vector,text')).toBe(true)
    })

    it('creates both indexes for an explicit hybrid store and keeps only that tier', async () => {
      const { store, collection } = setup({ config: { searchType: 'hybrid' } })

      await store.initialize()

      expect(createdSearchIndexes(collection)).toEqual(['vector_index', 'text_index'])
      expect(tiers(store)).toEqual(['hybrid'])
    })

    it('fails an explicit hybrid store with one tier refused', async () => {
      const { store, collection } = setup({ config: { searchType: 'hybrid' } })
      reporting(collection, 'FAILED', 'vector_index')

      const error = await rejectionOf(store.initialize())

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain("'vector_index'")
    })

    it('fails an explicit hybrid store on a deployment without the stage', async () => {
      const { store } = withoutFusion({ config: { searchType: 'hybrid' } })

      const error = await rejectionOf(store.initialize())

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain("'searchType' is 'hybrid' but appdb.memory cannot run it")
      expect(error.message).toContain('$rankFusion')
      expect(error.message).toContain('MongoDB 8.0')
    })

    it('skips fusion under auto where only one tier came up', async () => {
      const { store, collection, logger } = setup()
      reporting(collection, 'FAILED', 'text_index')

      await store.initialize()

      expect(tiers(store)).toEqual(['vector'])
      expect(logger.lines('warn').some((line) => line.includes('event=bound_declined_fusion'))).toBe(false)
    })
  })

  describe('AT-148, AT-149: a score bound keeps auto off the hybrid tier', () => {
    it.each([
      ['minScore', 0.7],
      ['maxScore', 0.2],
    ] as const)('resolves to vector and says why when %s is set', async (bound, value) => {
      const { store, logger } = setup({ store: { [bound]: value } })

      await store.initialize()

      expect(tiers(store)).toEqual(['vector', 'text'])
      const [line] = logger.lines('warn')
      expect(line).toContain(`appdb.memory can run the hybrid tier, but '${bound}' is set to ${value}`)
      expect(line).toContain("set 'searchType' to 'hybrid'")
      expect(line).toMatch(/\| event=bound_declined_fusion, namespace=appdb\.memory, tier=hybrid$/)
    })

    it('applies the bound on the fused scale for an explicit hybrid store, without a warning', async () => {
      const { store, logger } = setup({ store: { minScore: 0.01 }, config: { searchType: 'hybrid' } })

      await store.initialize()

      expect(tiers(store)).toEqual(['hybrid'])
      expect(logger.lines('warn')).toEqual([])
    })

    it('logs nothing about the bound where the deployment could not run hybrid anyway', async () => {
      const { store, logger } = withoutFusion({ store: { minScore: 0.7 } })

      await store.initialize()

      expect(tiers(store)).toEqual(['vector', 'text'])
      expect(logger.lines('warn')).toEqual([])
    })
  })

  describe('AT-202, AT-205: initialize records one span', () => {
    it('records the requested type and the tiers that came up, with the store name and no scope', async () => {
      const { store } = setup({ store: { scope: 'tenant-a', collection: 'recall' } })

      await store.initialize()

      const span = oneSpan(exporter, 'strands_mongodb.memory.initialize')
      expect(span.attributes['strands_mongodb.database']).toBe('appdb')
      expect(span.attributes['strands_mongodb.collection']).toBe('recall')
      expect(span.attributes['strands_mongodb.store_name']).toBe('facts')
      expect(span.attributes['strands_mongodb.search.requested']).toBe('auto')
      expect(span.attributes['strands_mongodb.search.tiers']).toBe('hybrid,vector,text')
      expect(JSON.stringify(span.attributes)).not.toContain('tenant-a')
      expect(span.status.code).not.toBe(SpanStatusCode.ERROR)
    })

    it('records an empty tier list where there is no search', async () => {
      const { store } = withoutSearch()

      await store.initialize()

      expect(oneSpan(exporter, 'strands_mongodb.memory.initialize').attributes['strands_mongodb.search.tiers']).toBe('')
    })

    it('records no span on the fast path', async () => {
      const { store } = setup()

      await store.initialize()
      await store.initialize()

      expect(spansNamed(exporter, 'strands_mongodb.memory.initialize')).toHaveLength(1)
    })

    it('records a retry under its own span with the tiers it resolved', async () => {
      vi.useFakeTimers()
      const { store, collection } = setup()
      reporting(collection, 'PENDING', 'vector_index')
      await store.initialize()

      collection.setSearchIndexStatus('vector_index', 'READY')
      vi.advanceTimersByTime(TIER_RETRY_SECONDS * 1000)
      await store.initialize()

      const spans = spansNamed(exporter, 'strands_mongodb.memory.initialize')
      expect(spans.map((span) => span.attributes['strands_mongodb.search.tiers'])).toEqual([
        'text',
        'hybrid,vector,text',
      ])
    })

    it('records a refusal as the StorageError the caller sees', async () => {
      const { store, collection } = setup()
      collection.setCollation(CASE_INSENSITIVE)

      await expect(store.initialize()).rejects.toBeInstanceOf(StorageError)

      const span = oneSpan(exporter, 'strands_mongodb.memory.initialize')
      expect(span.status.code).toBe(SpanStatusCode.ERROR)
      expect(span.status.message).toBe('StorageError')
    })

    it('parents the probes and the ensures under initialize', async () => {
      await setup().store.initialize()

      const operation = oneSpan(exporter, 'strands_mongodb.memory.initialize')
      const children = exporter
        .getFinishedSpans()
        .filter((span) => span.parentSpanContext?.spanId === operation.spanContext().spanId)
      const probes = children
        .filter((span) => span.name === 'strands_mongodb.indexes.probe')
        .map((span) => span.attributes['strands_mongodb.indexes.probe'])
      expect(probes).toEqual(['collation', 'search', 'rank_fusion', 'collation'])
      expect(children.filter((span) => span.name === 'strands_mongodb.indexes.ensure')).toHaveLength(3)
    })
  })
})
