import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import { SpanStatusCode } from '@opentelemetry/api'
import { type Logger, type MemoryEntry, MemoryManager, type MemoryStore, StorageError } from '@strands-agents/sdk'
import type { Embedder } from '@strands-agents/sdk/storage/search'
import { type Document, type MongoClient, MongoNetworkTimeoutError, MongoServerError, ObjectId } from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConstructedMongoClient, FakeCollection, FakeMongoClient } from '../__fixtures__/fake-mongo.js'
import { oneSpan, recordSpans, spansNamed } from '../__fixtures__/spans.js'
import { close } from '../client.js'
import { SearchIndexNotReady } from '../ensure-indexes.js'
import { CONTENT_FIELD, EXPIRES_FIELD, memorySearchSpecs, READY_TIMEOUT_SECONDS, VECTOR_FIELD } from '../index-specs.js'
import {
  DEFAULT_COLLECTION,
  mergeMetadata,
  MongoDBMemoryStore,
  resolveLimit,
  TIER_RETRY_MAX_SECONDS,
  TIER_RETRY_SECONDS,
  UNSCOPED,
} from '../memory-store.js'
import { MongoDBStorage } from '../storage.js'
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  type MongoDBConfig,
  type MongoDBMemoryStoreConfig,
  type ResolvedSearchType,
  RESERVED_METADATA_KEYS,
} from '../types.js'

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

// The query for every vector-tier test, aligned with the seeded vectors on the first axis.
const QUERY_VECTOR = [1, 0, 0, 0]

const CONTENT = 'the user prefers dark mode'

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

// A four-dimension embedder over `dark`, `mode`, `coffee` and `tea`, recording what it embeds.
class WordEmbedder implements Embedder {
  readonly calls: string[] = []

  constructor(private readonly dimensions = 4) {}

  async embed(text: string): Promise<number[]> {
    this.calls.push(text)
    const words = text.toLowerCase().split(/\s+/)
    const vector = ['dark', 'mode', 'coffee', 'tea'].map((word) => 0.01 + words.filter((w) => w === word).length)
    return [...vector, ...Array<number>(this.dimensions).fill(0.01)].slice(0, this.dimensions)
  }
}

// Puts a store in the state `initialize()` would leave it in, without the probes: the tiers that came up and what a search answers with.
function prepared(
  built: Setup,
  options: { documents?: Document[]; tiers?: ResolvedSearchType[]; failure?: Error } = {}
): FakeCollection {
  const { store, collection } = built
  store['_initialized'] = true
  store['_tiers'] = options.tiers ?? ['text']
  collection.searchResults = options.documents ?? [{ _id: 'abc', content: CONTENT }]
  collection.failure = options.failure
  return collection
}

function argsOf(collection: FakeCollection, method: string): unknown[] {
  const found = collection.calls.filter((call) => call.method === method)
  expect(found).toHaveLength(1)
  return found[0]!.args
}

// The one recorded search pipeline.
function stagesOf(collection: FakeCollection): Document[] {
  return argsOf(collection, 'aggregate')[0] as Document[]
}

function stageNames(collection: FakeCollection): string[] {
  return stagesOf(collection).map((stage) => Object.keys(stage)[0]!)
}

function stage(collection: FakeCollection, operator: string): Document {
  const found = stagesOf(collection).filter((candidate) => operator in candidate)
  expect(found).toHaveLength(1)
  return found[0]![operator] as Document
}

function metadataOf(entry: MemoryEntry): Record<string, unknown> {
  expect(entry.metadata).toBeDefined()
  return entry.metadata!
}

function insertOf(collection: FakeCollection): Document {
  return (argsOf(collection, 'updateOne')[1] as Document).$setOnInsert as Document
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
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

      it('does not hold a ready tier behind one still building, and stops waiting on the loser', async () => {
        vi.useFakeTimers()
        const { store, collection, logger } = withoutFusion({ config: { indexReadyTimeout: 60 } })
        reporting(collection, 'PENDING', 'vector_index', 'text_index')
        await store.initialize()
        logger.records.length = 0

        collection.setSearchIndexStatus('text_index', 'READY')
        await store['_waitForATier']()
        const reads = collection.searchIndexReads
        await vi.advanceTimersByTimeAsync(10_000)

        expect(tiers(store)).toEqual(['text'])
        expect(skipped(logger)).toEqual([['info', 'tier_building', 'vector']])
        expect(store['_tierRetryAt']).toBeDefined()
        expect(collection.searchIndexReads).toBe(reads)
        const outcomes = spansNamed(exporter, 'strands_mongodb.indexes.wait').map(
          (span) => span.attributes['strands_mongodb.indexes.outcome']
        )
        // Two timed-out reads from initialize, the retry's one, and the loser's abandoned wait; text was READY on its cold read.
        expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1)
        expect(outcomes).toHaveLength(4)
      })

      it("ends the loser's ensure span abandoned rather than in error once the first tier is ready", async () => {
        vi.useFakeTimers()
        const { store, collection } = withoutFusion({ config: { indexReadyTimeout: 60 } })
        reporting(collection, 'PENDING', 'vector_index', 'text_index')
        await store.initialize()
        exporter.reset()

        collection.setSearchIndexStatus('text_index', 'READY')
        await store['_waitForATier']()

        const abandoned = spansNamed(exporter, 'strands_mongodb.indexes.ensure').filter(
          (span) => span.attributes['strands_mongodb.indexes.outcome'] === 'abandoned'
        )
        expect(abandoned).toHaveLength(1)
        expect(abandoned[0]?.status.code).toBe(SpanStatusCode.UNSET)
        expect(abandoned[0]?.attributes).not.toHaveProperty('error.type')
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

    it('AT-147: falls past hybrid to the tier a one-key query fits on a manual-vector auto store', async () => {
      const { store, collection } = setup({ config: MANUAL_VECTOR })
      collection.searchResults = [{ _id: 'abc', content: CONTENT, score: 0.9 }]
      await store.initialize()
      expect(tiers(store)).toEqual(['hybrid', 'vector', 'text'])

      const picked: string[] = []
      for (const query of [
        { text: 'dark mode' },
        { vector: QUERY_VECTOR },
        { text: 'dark mode', vector: QUERY_VECTOR },
      ]) {
        const [entry] = await store.search(query)
        picked.push(String(metadataOf(entry!)._searchType))
      }

      expect(picked).toEqual(['text', 'vector', 'hybrid'])
      expect(
        spansNamed(exporter, 'strands_mongodb.memory.search').map(
          (span) => span.attributes['strands_mongodb.search.tier']
        )
      ).toEqual(['text', 'vector', 'hybrid'])
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

  describe('AT-052a: getTools is present and returns nothing', () => {
    it('returns an empty array, which the manager extends its tool list by', () => {
      const tools = setup().store.getTools()

      expect(Array.isArray(tools)).toBe(true)
      expect(tools).toEqual([])
    })

    it('AT-044b: a manager holding a writable store registers only its own two tools', () => {
      const { store } = setup({ store: { writable: true } })

      const manager = new MemoryManager({ stores: [store], addToolConfig: true })

      expect(manager.getTools().map((tool) => tool.name)).toEqual(['search_memory', 'add_memory'])
    })
  })

  describe('AT-044a, AT-044d: addMessages stays absent and add does not, with no stub standing in', () => {
    it('is absent by the in operator and add is present as a function', () => {
      const { store } = setup({ store: { writable: true } })

      expect('addMessages' in store).toBe(false)
      expect(typeof store.add).toBe('function')
      expect(() => new MemoryManager({ stores: [store] })).not.toThrow()
    })
  })

  describe('AT-057: reserved metadata keys win', () => {
    const logger = (): RecordingLogger => new RecordingLogger()
    const context = (log = logger()): { storeName: string; namespace: string; logger: RecordingLogger } => ({
      storeName: 'facts',
      namespace: 'appdb.memory',
      logger: log,
    })

    it('keeps the reserved value over a colliding caller key, not renamed and not nested', () => {
      const merged = mergeMetadata(
        { _scope: 'somebody-elses-scope', topic: 'cats' },
        { _scope: 'tenant-a', _id: 'abc', _searchType: 'vector', _relevanceScore: 0.5 },
        context()
      )

      expect(merged._scope).toBe('tenant-a')
      expect(merged.topic).toBe('cats')
      expect(Object.values(merged)).not.toContain('somebody-elses-scope')
    })

    it('leaves non-colliding caller keys untouched', () => {
      expect(mergeMetadata({ topic: 'cats', source: 'chat' }, { _id: 'abc' }, context())).toEqual({
        topic: 'cats',
        source: 'chat',
        _id: 'abc',
      })
    })

    it('logs the collision at warn with the key, the store and the namespace', () => {
      const log = logger()

      mergeMetadata({ _id: 'spoofed' }, { _id: 'real' }, context(log))

      expect(log.records).toHaveLength(1)
      const [level, line] = log.records[0]!
      expect(level).toBe('warn')
      expect(line).toContain("'_id'")
      expect(line).toContain("'facts'")
      expect(line).toMatch(/\| event=reserved_key_collision, namespace=appdb\.memory$/)
      expect(line).not.toContain('spoofed')
    })

    it('defends every key in RESERVED_METADATA_KEYS', () => {
      for (const key of RESERVED_METADATA_KEYS) {
        expect(mergeMetadata({ [key]: 'caller' }, { [key]: 'reserved' }, context())[key]).toBe('reserved')
      }
    })

    it('renders stored BSON values as relaxed EJSON, so the entry carries only JSON', () => {
      const merged = mergeMetadata(
        { seen: new Date('2026-01-02T03:04:05Z'), ref: new ObjectId('65f1c2d3e4f5a6b7c8d9e0f1'), tier: 'gold' },
        { _id: 'abc' },
        context()
      )

      expect(merged).toEqual({
        seen: { $date: '2026-01-02T03:04:05Z' },
        ref: { $oid: '65f1c2d3e4f5a6b7c8d9e0f1' },
        tier: 'gold',
        _id: 'abc',
      })
      expect(JSON.parse(JSON.stringify(merged))).toEqual(merged)
    })
  })

  describe('AT-058: writable gates add', () => {
    it('rejects add on a read-only store with a TypeError naming the key, before any round trip', async () => {
      const { store, collection } = setup()

      const error = await rejectionOf(store.add(CONTENT))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'writable'")
      expect(error.message).toContain("'facts'")
      expect(error.message).toContain('add()')
      expect(error.message).not.toContain(CONTENT)
      expect(collection.calls).toEqual([])
      expect(store['_initialized']).toBe(false)
    })
  })

  describe('AT-076, AT-041: every caller input is checked before the network', () => {
    it.each([
      [{ text: 'dark mode', vector: QUERY_VECTOR }, 'both'],
      [{ limit: 5 }, 'neither'],
    ])('rejects a query %j setting both or neither vector key with a TypeError', async (query, expected) => {
      const { store, collection } = setup()

      const error = await rejectionOf(store.search(query))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain(expected)
      expect(collection.calls).toEqual([])
    })

    it.each([
      [{ 'metadata.tier': 'gold' }, 'filterFields'],
      [{ $where: 'sleep(1000)' }, '$where'],
    ])('validates a per-query filter %j before the query runs', async (filter, expected) => {
      const { store, collection } = setup()

      const error = await rejectionOf(store.search({ text: 'dark mode', filter }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain(expected)
      expect(collection.calls).toEqual([])
    })

    it('rejects a limit below 1 in options or in a query with a RangeError, naming the key', async () => {
      const { store, collection } = setup()

      const options = await rejectionOf(store.search('dark mode', { maxSearchResults: 0 }))
      const query = await rejectionOf(store.search({ text: 'dark mode', limit: -1 }))

      expect(options).toBeInstanceOf(RangeError)
      expect(options.message).toContain("'maxSearchResults' is 0")
      expect(query).toBeInstanceOf(RangeError)
      expect(query.message).toContain("'limit' is -1")
      expect(collection.calls).toEqual([])
      expect(store['_initialized']).toBe(false)
    })
  })

  describe('AT-077: what the store sends and what it maps back', () => {
    it('sends the scope, the store and both caller filters, in that order', async () => {
      const built = setup({
        store: { scope: 'tenant-a', filter: { 'metadata.tier': 'gold' } },
        config: { filterFields: ['metadata.tier', 'metadata.region'] },
      })
      const collection = prepared(built)

      await built.store.search({ text: 'dark mode', filter: { 'metadata.region': 'emea' } })

      expect(stage(collection, '$match')).toEqual({
        $and: [
          { scope: { $eq: 'tenant-a' } },
          { store_name: { $eq: 'facts' } },
          { 'metadata.tier': 'gold' },
          { 'metadata.region': 'emea' },
        ],
      })
    })

    it('reads _scope off the store, so a stored _scope cannot make a document report another scope', async () => {
      const built = setup({ store: { scope: 'tenant-a' } })
      prepared(built, {
        documents: [{ _id: 'abc', content: CONTENT, score: 0.9, metadata: { _scope: 'tenant-b', tier: 'gold' } }],
      })

      const entries = await built.store.search('dark mode')

      expect(metadataOf(entries[0]!)._scope).toBe('tenant-a')
      expect(metadataOf(entries[0]!).tier).toBe('gold')
      const collisions = built.logger.lines('warn').filter((line) => line.includes('event=reserved_key_collision'))
      expect(collisions).toHaveLength(1)
      expect(collisions[0]).toContain("'_scope'")
      expect(collisions[0]).not.toContain('tenant-b')
    })

    it.each([[{ _id: 'abc', content: CONTENT }], [{ _id: 'abc', content: CONTENT, score: null }]])(
      'maps an unscored document %j to zero rather than failing',
      async (document) => {
        const built = setup()
        prepared(built, { documents: [document] })

        const entries = await built.store.search('dark mode')

        expect(metadataOf(entries[0]!)._relevanceScore).toBe(0)
      }
    )

    it('lets only the metadata the document carries reach the entry, beside the four reserved keys', async () => {
      const built = setup({ store: { scope: 'tenant-a' } })
      prepared(built, {
        documents: [
          {
            _id: 'abc',
            content: CONTENT,
            scope: 'tenant-a',
            store_name: 'facts',
            content_hash: 'f'.repeat(64),
            created_at: new Date(),
            score: 1.5,
            metadata: { tier: 'gold' },
          },
        ],
      })

      const entries = await built.store.search('dark mode')

      expect(entries).toHaveLength(1)
      expect(entries[0]!.content).toBe(CONTENT)
      expect(entries[0]!.storeName).toBe('facts')
      expect(metadataOf(entries[0]!)).toEqual({
        tier: 'gold',
        _id: 'abc',
        _relevanceScore: 1.5,
        _searchType: 'text',
        _scope: 'tenant-a',
      })
    })

    it('returns stored Date and ObjectId metadata as relaxed EJSON, never as objects a JSONValue cannot hold', async () => {
      const built = setup()
      const ref = new ObjectId()
      prepared(built, {
        documents: [
          { _id: ref, content: CONTENT, score: 0.5, metadata: { seen: new Date('2026-01-02T03:04:05Z'), ref } },
        ],
      })

      const entries = await built.store.search('dark mode')

      expect(metadataOf(entries[0]!)).toEqual({
        seen: { $date: '2026-01-02T03:04:05Z' },
        ref: { $oid: ref.toHexString() },
        _id: ref.toHexString(),
        _relevanceScore: 0.5,
        _searchType: 'text',
        _scope: UNSCOPED,
      })
    })

    it('answers with the first prepared tier that fits a plain string, and reports it', async () => {
      const built = setup()
      prepared(built, { tiers: ['hybrid', 'vector', 'text'] })

      const entries = await built.store.search('dark mode')

      expect(stageNames(built.collection)).toEqual(['$rankFusion', '$set', '$limit'])
      expect(metadataOf(entries[0]!)._searchType).toBe('hybrid')
    })

    it('initializes itself on the first search, so nobody has to call initialize()', async () => {
      const { store, collection } = setup()
      collection.searchResults = [{ _id: 'abc', content: CONTENT, score: 0.9 }]

      const entries = await store.search('dark mode')

      expect(store['_initialized']).toBe(true)
      expect(entries.map((entry) => entry.content)).toEqual([CONTENT])
      expect(metadataOf(entries[0]!)._searchType).toBe('hybrid')
    })
  })

  describe('AT-078: the query no tier fits', () => {
    it('names the build, not a missing module, when search exists and no tier is ready', () => {
      const built = setup()
      prepared(built, { tiers: [] })
      built.store['_capabilities'] = { search: true, rankFusion: true }

      const error = errorOf(() => built.store['_pickTier']('dark mode', undefined))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain("was ready within 'indexReadyTimeout'")
      expect(error.message).not.toContain('does not run Atlas Search')
    })

    it('AT-053c: names the code the probe reported and what to connect to where the deployment cannot search', async () => {
      const built = withoutSearch()

      const error = await rejectionOf(built.store.search('dark mode'))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain(`server error code ${NO_SEARCH_CODE}`)
      expect(error.message).toContain('Atlas')
      expect(error.message).not.toContain('createSearchIndexes')
    })

    it('says no probe result is cached where none ran', async () => {
      const built = setup()
      prepared(built, { tiers: [] })

      const error = await rejectionOf(built.store.search('dark mode'))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('no probe result cached')
    })

    it('names the key to add when a manual-vector store gets a plain string', async () => {
      const built = setup({ config: { ...MANUAL_VECTOR, searchType: 'vector' } })
      prepared(built, { tiers: ['vector'] })

      const error = await rejectionOf(built.store.search('dark mode'))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("needs 'vector'")
      expect(error.message).toContain("'embeddingDimensions'")
      expect(error.message).toContain('which is: vector')
    })

    it('names the text key when an AutoEmbeddings vector store gets only a vector', async () => {
      const built = setup({ config: { searchType: 'text' } })
      prepared(built, { tiers: ['text'] })

      const error = await rejectionOf(built.store.search({ vector: QUERY_VECTOR }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("needs 'text'")
      expect(error.message).toContain('AutoEmbeddings')
    })
  })

  describe('AT-157: the query shape only fusion can read', () => {
    it('still rejects both keys on the AutoEmbeddings path before the network', async () => {
      const { store, collection } = setup()

      const error = await rejectionOf(store.search({ text: 'dark mode', vector: QUERY_VECTOR }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("both 'text' and 'vector'")
      expect(collection.calls).toEqual([])
    })

    it.each(['vector', 'text'] as const)('rejects both keys on a store naming the %s tier', async (searchType) => {
      const { store, collection } = setup({ config: { ...MANUAL_VECTOR, searchType } })

      const error = await rejectionOf(store.search({ text: 'dark mode', vector: QUERY_VECTOR }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("both 'text' and 'vector'")
      expect(collection.calls).toEqual([])
    })

    it('answers both keys from the hybrid tier on a manual store that could fuse', async () => {
      const { store, collection } = setup({ config: MANUAL_VECTOR })
      collection.searchResults = [{ _id: 'abc', content: CONTENT, score: 0.03 }]

      const entries = await store.search({ text: 'dark mode', vector: QUERY_VECTOR })

      expect(stageNames(collection)).toEqual(['$rankFusion', '$set', '$limit'])
      expect(metadataOf(entries[0]!)._searchType).toBe('hybrid')
    })

    it('raises rather than answering from one key on a manual store that cannot fuse', async () => {
      const { store, collection } = withoutFusion({ config: MANUAL_VECTOR })
      collection.searchResults = [{ _id: 'abc', content: CONTENT, score: 0.9 }]

      const error = await rejectionOf(store.search({ text: 'dark mode', vector: QUERY_VECTOR }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain('hybrid')
      expect(error.message).toContain('vector, text')
      expect(count(collection, 'aggregate')).toBe(0)
    })
  })

  describe('AT-079, AT-150: the score bound on scores this test chose', () => {
    const documents = (): Document[] =>
      [0.9, 0.5, 0.1].map((score, index) => ({ _id: String(index), content: `fact ${index}`, score }))

    it.each([
      [{ minScore: 0.5 }, ['fact 0', 'fact 1']],
      [{ maxScore: 0.5 }, ['fact 1', 'fact 2']],
      [{ minScore: 0.1 }, ['fact 0', 'fact 1', 'fact 2']],
    ])('keeps a result scoring exactly the bound %j, dropping only its own side', async (bound, kept) => {
      const built = setup({ store: bound })
      prepared(built, { documents: documents() })

      const entries = await built.store.search('dark mode')

      expect(entries.map((entry) => entry.content)).toEqual(kept)
    })

    it('logs the bound, its value and both counts at debug only when something was dropped', async () => {
      const built = setup({ store: { maxScore: 0.5 } })
      prepared(built, { documents: documents() })

      await built.store.search('dark mode')

      const applied = built.logger.lines('debug').filter((line) => line.includes('event=score_bound_applied'))
      expect(applied).toHaveLength(1)
      expect(applied[0]).toContain('maxScore 0.5 on appdb.memory kept 2 of 3 results (applied after the query).')
      expect(applied[0]).toMatch(/\| event=score_bound_applied, namespace=appdb\.memory$/)
    })

    it('logs nothing when the bound drops nothing', async () => {
      const built = setup({ store: { minScore: 0.1 } })
      prepared(built, { documents: documents() })

      await built.store.search('dark mode')

      expect(built.logger.lines('debug').filter((line) => line.includes('score_bound_applied'))).toEqual([])
    })

    it('applies the bound to the fused score on an explicit hybrid store', async () => {
      const built = setup({ store: { minScore: 0.0164 }, config: { ...MANUAL_VECTOR, searchType: 'hybrid' } })
      const collection = prepared(built, {
        tiers: ['hybrid'],
        documents: [0.0328, 0.0164, 0.0161].map((score, index) => ({
          _id: String(index),
          content: `fact ${index}`,
          score,
        })),
      })

      const entries = await built.store.search({ text: 'dark mode', vector: QUERY_VECTOR })

      expect(entries.map((entry) => entry.content)).toEqual(['fact 0', 'fact 1'])
      expect(stageNames(collection)).toEqual(['$rankFusion', '$set', '$limit'])
      expect(metadataOf(entries[0]!)._searchType).toBe('hybrid')
    })
  })

  describe('AT-082: deleting one memory', () => {
    it('sends the read predicate with the id added as a sibling of $and', async () => {
      const built = setup({
        store: { scope: 'tenant-a', filter: { 'metadata.tier': 'gold' }, writable: true },
        config: { filterFields: ['metadata.tier'] },
      })
      const collection = prepared(built)
      collection.deletedCount = 1
      const memoryId = new ObjectId()

      const deleted = await built.store.delete(memoryId.toHexString())

      expect(deleted).toBe(1)
      expect(argsOf(collection, 'deleteOne')).toEqual([
        {
          $and: [{ scope: { $eq: 'tenant-a' } }, { store_name: { $eq: 'facts' } }, { 'metadata.tier': 'gold' }],
          _id: memoryId,
        },
      ])
    })

    it('reports the count the server gave rather than its own', async () => {
      const built = setup({ store: { writable: true } })
      prepared(built).deletedCount = 7

      expect(await built.store.delete(new ObjectId().toHexString())).toBe(7)
    })

    it('removes the document the id names and leaves the rest', async () => {
      const { store, collection } = setup({ store: { writable: true, scope: 'tenant-a' } })
      const mine = await store.add(CONTENT)
      await store.add('the user works in emea')

      expect(await store.delete(mine.ids[0]!)).toBe(1)
      expect(collection.docs.map((doc) => doc.content)).toEqual(['the user works in emea'])
      expect(await store.delete(mine.ids[0]!)).toBe(0)
    })

    it.each(['', 'nope', 'z'.repeat(24), '6a96a03ca471f4a00187022', 12, null])(
      'rejects %j as a memory id with a TypeError naming the argument, sending nothing',
      async (memoryId) => {
        const built = setup({ store: { writable: true } })
        const collection = prepared(built)

        const error = await rejectionOf(built.store.delete(memoryId as string))

        expect(error).toBeInstanceOf(TypeError)
        expect(error.message).toContain("'memoryId'")
        expect(error.message).toContain('24-character hex ObjectId')
        expect(count(collection, 'deleteOne')).toBe(0)
      }
    )
  })

  describe('AT-083: deleting every memory this store can see', () => {
    it('sends exactly the read predicate, configured filter included', async () => {
      const built = setup({
        store: { scope: 'tenant-a', filter: { 'metadata.tier': 'gold' }, writable: true },
        config: { filterFields: ['metadata.tier'] },
      })
      const collection = prepared(built)

      await built.store.deleteAll()

      expect(argsOf(collection, 'deleteMany')).toEqual([
        { $and: [{ scope: { $eq: 'tenant-a' } }, { store_name: { $eq: 'facts' } }, { 'metadata.tier': 'gold' }] },
      ])
    })

    it('passes the count the server gave through', async () => {
      const built = setup({ store: { writable: true } })
      prepared(built).deletedCount = 12

      expect(await built.store.deleteAll()).toBe(12)
    })

    it('AT-085: empties its own store and leaves a sibling in the same scope and collection', async () => {
      const client = new FakeMongoClient()
      const { store: mine } = setup({ client, store: { writable: true, scope: 'tenant-a' } })
      const { store: sibling, collection } = setup({
        client,
        store: { writable: true, scope: 'tenant-a', name: 'notes' },
      })
      await mine.add(CONTENT)
      await mine.add('the user works in emea')
      await sibling.add(CONTENT)

      expect(await mine.deleteAll()).toBe(2)
      expect(collection.docs.map((doc) => doc.store_name)).toEqual(['notes'])
    })
  })

  describe('AT-084: deletion is a write', () => {
    it.each(['delete', 'deleteAll'] as const)('refuses %s on a read-only store before it initializes', async (call) => {
      const { store, collection } = setup()

      const error = await rejectionOf(
        call === 'delete' ? store.delete(new ObjectId().toHexString()) : store.deleteAll()
      )

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'writable'")
      expect(error.message).toContain(`${call}()`)
      expect(store['_initialized']).toBe(false)
      expect(collection.calls).toEqual([])
    })

    it('checks writability before the id, so a read-only store never complains about the id', async () => {
      const error = await rejectionOf(setup().store.delete('nope'))

      expect(error.message).toContain("'writable'")
      expect(error.message).not.toContain("'memoryId'")
    })
  })

  describe('AT-042, AT-043, AT-046, AT-048a: add writes once, in the scope of this store', () => {
    it('sends the dedup selector and $setOnInsert, and reports one insert', async () => {
      const { store, collection } = setup({ store: { writable: true, scope: 'tenant-a' } })

      const result = await store.add(CONTENT, { source: 'chat' })

      const [selector, update, options] = argsOf(collection, 'updateOne')
      expect(selector).toEqual({ scope: 'tenant-a', store_name: 'facts', content_hash: sha256(CONTENT) })
      expect(Object.keys(update as Document)).toEqual(['$setOnInsert'])
      expect(options).toEqual({ upsert: true })
      const insert = insertOf(collection)
      expect(insert[CONTENT_FIELD]).toBe(CONTENT)
      expect(insert.created_at).toBeInstanceOf(Date)
      expect(insert.metadata).toEqual({ source: 'chat' })
      expect(insert).not.toHaveProperty(VECTOR_FIELD)
      expect(result).toEqual({ ids: [String(collection.docs[0]!._id)], inserted: 1, duplicates: 0 })
      expect(result.ids[0]).toMatch(/^[0-9a-f]{24}$/)
    })

    it('stores the same content twice as one document, the second call reporting the first id', async () => {
      const { store, collection } = setup({ store: { writable: true } })

      const first = await store.add(CONTENT)
      const createdAt = collection.docs[0]!.created_at
      const second = await store.add(CONTENT)

      expect(second).toEqual({ ids: first.ids, inserted: 0, duplicates: 1 })
      expect(collection.docs).toHaveLength(1)
      expect(collection.docs[0]!.created_at).toBe(createdAt)
      expect(argsOf(collection, 'findOne')).toEqual([
        { scope: UNSCOPED, store_name: 'facts', content_hash: sha256(CONTENT) },
        { projection: { _id: 1 } },
      ])
    })

    it('reports a lost insert race as a duplicate of the winner rather than an error', async () => {
      const { store, collection } = setup({ store: { writable: true } })
      const first = await store.add(CONTENT)
      collection.docs.splice(0, collection.docs.length)
      collection.insertFailure = serverError(11000, 'E11000 duplicate key error collection: injected')
      collection.docs.push({
        _id: new ObjectId(first.ids[0]),
        content: CONTENT,
        scope: UNSCOPED,
        store_name: 'facts',
        content_hash: sha256(CONTENT),
      })

      const second = await store.add(CONTENT)

      expect(second).toEqual({ ids: first.ids, inserted: 0, duplicates: 1 })
      expect(count(collection, 'updateOne')).toBe(2)
    })

    it('reports no id when the matched document vanished between the upsert and the read', async () => {
      const { store, collection } = setup({ store: { writable: true } })
      collection.docs.push({ _id: new ObjectId(), content: 'other', scope: UNSCOPED, store_name: 'facts' })
      collection.insertFailure = serverError(11000, 'E11000 duplicate key error collection: injected')

      expect(await store.add(CONTENT)).toEqual({ ids: [], inserted: 0, duplicates: 1 })
    })

    it('rethrows a server error that is not a duplicate key, wrapped by the operation', async () => {
      const { store, collection } = setup({ store: { writable: true } })
      await store.initialize()
      collection.failure = serverError(8, 'pretend failure')

      const error = await rejectionOf(store.add(CONTENT))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('adding a memory to appdb.memory failed')
    })

    it('nests caller metadata, so a scope key inside it is inert and stays visible', async () => {
      const { store, collection } = setup({ store: { writable: true, scope: 'tenant-a' } })

      await store.add('a fact', { scope: 'tenant-b', _scope: 'tenant-b' })

      expect(collection.docs[0]!.scope).toBe('tenant-a')
      expect(collection.docs[0]!.metadata).toEqual({ scope: 'tenant-b', _scope: 'tenant-b' })
    })

    it('stores no metadata field for absent or empty metadata', async () => {
      const { store, collection } = setup({ store: { writable: true } })

      await store.add('a fact')
      await store.add('another fact', {})

      expect(collection.docs.map((doc) => 'metadata' in doc)).toEqual([false, false])
    })

    it('never consults the configured filter on the write path', async () => {
      const { store, collection } = setup({
        store: { writable: true, scope: 'tenant-a', filter: { scope: 'tenant-b' } },
      })

      await store.add('a fact')

      expect(collection.docs[0]!.scope).toBe('tenant-a')
    })

    it('stamps the sentinel scope on a store nobody scoped', async () => {
      const { store, collection } = setup({ store: { writable: true } })

      await store.add('a fact from a store nobody scoped')

      expect(collection.docs[0]!.scope).toBe(UNSCOPED)
    })

    it('AT-047b: writes the same fact in two scopes as two documents', async () => {
      const client = new FakeMongoClient()
      const { store: first } = setup({ client, store: { writable: true, scope: 'tenant-a' } })
      const { store: second, collection } = setup({ client, store: { writable: true, scope: 'tenant-b' } })

      const a = await first.add(CONTENT)
      const b = await second.add(CONTENT)

      expect(a.inserted).toBe(1)
      expect(b.inserted).toBe(1)
      expect(a.ids).not.toEqual(b.ids)
      expect(collection.docs.map((doc) => doc.scope).sort()).toEqual(['tenant-a', 'tenant-b'])
    })

    it('embeds before the upsert and refuses a vector of the wrong length, writing nothing', async () => {
      const { store, collection } = setup({
        store: { writable: true, embedder: new WordEmbedder(3) },
        config: MANUAL_VECTOR,
      })

      const error = await rejectionOf(store.add('dark'))

      expect(error).toBeInstanceOf(RangeError)
      expect(error.message).toContain('3-dimension vector')
      expect(error.message).toContain("'embeddingDimensions' is 4")
      expect(count(collection, 'updateOne')).toBe(0)
    })
  })

  describe('AT-153, AT-154: expiry is stamped from the clock of the document itself', () => {
    it.each([0, 1, 3600, 86400])('stamps expires_at exactly %i seconds after created_at', async (ttl) => {
      const { store, collection } = setup({ store: { writable: true, ttlSeconds: ttl } })

      await store.add(CONTENT)

      const insert = insertOf(collection)
      expect((insert[EXPIRES_FIELD] as Date).getTime() - (insert.created_at as Date).getTime()).toBe(ttl * 1000)
    })

    it('stamps no field at all without a TTL', async () => {
      const { store, collection } = setup({ store: { writable: true } })

      await store.add(CONTENT)

      expect(store.ttlSeconds).toBeUndefined()
      expect(insertOf(collection)).not.toHaveProperty(EXPIRES_FIELD)
    })

    it('puts the stamp in $setOnInsert beside created_at, so a duplicate does not extend it', async () => {
      const { store, collection } = setup({ store: { writable: true, ttlSeconds: 60 } })

      await store.add(CONTENT)

      const update = argsOf(collection, 'updateOne')[1] as Document
      expect(Object.keys(update)).toEqual(['$setOnInsert'])
      expect(update.$setOnInsert).toHaveProperty(EXPIRES_FIELD)
    })
  })

  describe('AT-243: an embedder completes the manual path', () => {
    it('stores the vector in the insert', async () => {
      const embedder = new WordEmbedder()
      const { store, collection } = setup({ store: { writable: true, embedder }, config: MANUAL_VECTOR })

      await store.add(CONTENT)

      expect(embedder.calls).toEqual([CONTENT])
      expect(insertOf(collection)[VECTOR_FIELD]).toEqual([1.01, 1.01, 0.01, 0.01])
    })

    it.each([
      [['vector', 'text'], 'vector'],
      [['hybrid', 'vector', 'text'], 'hybrid'],
    ] as Array<[ResolvedSearchType[], ResolvedSearchType]>)(
      'embeds a plain string for the tiers %j and answers from %s',
      async (tiers, tier) => {
        const embedder = new WordEmbedder()
        const built = setup({ store: { embedder }, config: MANUAL_VECTOR })
        const collection = prepared(built, { tiers })

        const found = await built.store.search('dark')

        expect(embedder.calls).toEqual(['dark'])
        expect(metadataOf(found[0]!)._searchType).toBe(tier)
        expect(JSON.stringify(stagesOf(collection))).toContain('[1.01,0.01,0.01,0.01]')
      }
    )

    it('embeds nothing on a text-only store', async () => {
      const embedder = new WordEmbedder()
      const built = setup({ store: { embedder }, config: MANUAL_VECTOR })
      prepared(built, { tiers: ['text'] })

      await built.store.search('dark')

      expect(embedder.calls).toEqual([])
    })

    it('uses a caller vector as given', async () => {
      const embedder = new WordEmbedder()
      const built = setup({ store: { embedder }, config: MANUAL_VECTOR })
      prepared(built, { tiers: ['vector', 'text'] })

      await built.store.search({ vector: QUERY_VECTOR })

      expect(embedder.calls).toEqual([])
    })
  })

  describe('AT-242: the first search waits for a build', () => {
    it('waits for the build and answers from the tier that came up', async () => {
      const { store, collection } = withoutFusion()
      reporting(collection, 'PENDING', 'vector_index', 'text_index')
      await store.initialize()
      expect(tiers(store)).toEqual([])
      collection.setSearchIndexStatus('vector_index', 'READY')
      collection.setSearchIndexStatus('text_index', 'READY')
      collection.searchResults = [{ _id: 'abc', content: 'dark mode', score: 0.9 }]

      const found = await store.search({ text: 'dark' })

      expect(tiers(store)).toEqual(['vector', 'text'])
      expect(found.map((entry) => metadataOf(entry)._searchType)).toEqual(['vector'])
      expect(store['_waitedForATier']).toBe(true)
    })

    it('fails the search when the build never finishes, and only the first search waits', async () => {
      vi.useFakeTimers()
      const { store, collection } = withoutFusion({ config: { indexReadyTimeout: 1 } })
      reporting(collection, 'PENDING', 'vector_index', 'text_index')
      await store.initialize()

      const first = rejectionOf(store.search({ text: 'dark' }))
      await vi.advanceTimersByTimeAsync(1500)
      const error = await first
      const reads = collection.searchIndexReads
      const second = await rejectionOf(store.search({ text: 'dark' }))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('was ready')
      expect(second.message).toContain('was ready')
      expect(collection.searchIndexReads).toBe(reads)
    })

    it('shares one wait between searches that arrive during it', async () => {
      const { store, collection } = withoutFusion()
      reporting(collection, 'PENDING', 'vector_index', 'text_index')
      await store.initialize()
      collection.setSearchIndexStatus('vector_index', 'READY')
      collection.setSearchIndexStatus('text_index', 'READY')
      collection.searchResults = [{ _id: 'abc', content: 'dark mode', score: 0.9 }]
      const reads = collection.searchIndexReads

      const found = await Promise.all([store.search({ text: 'dark' }), store.search({ text: 'dark' })])

      expect(found.map((entries) => entries.length)).toEqual([1, 1])
      // Two reads for the wait and two for the retry that follows it; a second wait would double this.
      expect(collection.searchIndexReads - reads).toBe(4)
    })
  })

  describe('AT-080, AT-014: a driver error names the operation and the namespace, and nothing else', () => {
    afterEach(() => close({ database: 'appdb', connectionString: LEAKY_URI }))

    const VERBS = {
      add: 'adding a memory to',
      search: 'searching',
      delete: 'deleting a memory from',
      deleteAll: 'deleting every memory in',
    } as const

    it.each(Object.keys(VERBS) as Array<keyof typeof VERBS>)(
      'wraps an unwrapped driver error out of %s with the verb, the namespace and the cause',
      async (call) => {
        const logger = new RecordingLogger()
        const store = new MongoDBMemoryStore({
          name: 'facts',
          config: { database: 'appdb', connectionString: LEAKY_URI, logger },
          writable: true,
        })
        const collection = ConstructedMongoClient.built[0]!.db('appdb').collection('memory')
        const failure = serverError(8, 'pretend failure, carrying no credentials')
        prepared({ store, collection, client: ConstructedMongoClient.built[0]!, logger }, { failure })

        const error = await rejectionOf(
          call === 'add'
            ? store.add(CONTENT)
            : call === 'search'
              ? store.search(CONTENT)
              : call === 'delete'
                ? store.delete(new ObjectId().toHexString())
                : store.deleteAll()
        )

        expect(error).toBeInstanceOf(StorageError)
        expect(error.message).toContain(`${VERBS[call]} appdb.memory failed`)
        expect(error.cause).toBe(failure)
        expect(error.message).not.toContain(CONTENT)
        for (const rendered of [error.message, inspect(error, { depth: 4 }), inspect(store, { depth: 5 })]) {
          expect(rendered).not.toContain('SUPERSECRET')
        }
      }
    )
  })

  describe('AT-010, AT-011: close releases the pool this package built and never an injected client', () => {
    it('closes the client it built, once, and a later operation opens a fresh pool', async () => {
      const connection = { database: 'appdb', connectionString: uri() }
      const store = new MongoDBMemoryStore({ name: 'facts', config: connection })
      const built = ConstructedMongoClient.built[0]!

      await store.close()
      await store.close()

      expect(built.closeCount).toBe(1)
      await store.initialize()
      expect(ConstructedMongoClient.built).toHaveLength(2)
      await close(connection)
    })

    it('never closes an injected client', async () => {
      const { store, client } = setup()
      await store.initialize()

      await store.close()

      expect(client.closeCount).toBe(0)
    })
  })

  describe('AT-202, AT-205: each operation records one span with counts and tiers, never content or scope', () => {
    it('records add with the duplicate flag, false then true', async () => {
      const { store } = setup({ store: { writable: true, scope: 'tenant-a' } })

      await store.add(CONTENT)
      await store.add(CONTENT)

      const spans = spansNamed(exporter, 'strands_mongodb.memory.add')
      expect(spans.map((span) => span.attributes['strands_mongodb.duplicate'])).toEqual([false, true])
      expect(spans[0]!.attributes['strands_mongodb.store_name']).toBe('facts')
      for (const span of spans) {
        expect(JSON.stringify(span.attributes)).not.toContain('tenant-a')
        expect(JSON.stringify(span.attributes)).not.toContain(CONTENT)
      }
    })

    it('records search with the requested type, the tier that ran and the result count', async () => {
      const built = setup({ store: { scope: 'tenant-a' } })
      prepared(built, {
        tiers: ['hybrid', 'vector', 'text'],
        documents: [{ _id: 'abc', content: CONTENT, score: 0.9 }],
      })

      await built.store.search('dark mode')

      const span = oneSpan(exporter, 'strands_mongodb.memory.search')
      expect(span.attributes['strands_mongodb.search.requested']).toBe('auto')
      expect(span.attributes['strands_mongodb.search.tier']).toBe('hybrid')
      expect(span.attributes['strands_mongodb.result_count']).toBe(1)
      expect(JSON.stringify(span.attributes)).not.toContain('dark mode')
      expect(JSON.stringify(span.attributes)).not.toContain('tenant-a')
    })

    it('records delete and delete_all with the deleted count', async () => {
      const built = setup({ store: { writable: true } })
      prepared(built).deletedCount = 3

      await built.store.delete(new ObjectId().toHexString())
      await built.store.deleteAll()

      expect(oneSpan(exporter, 'strands_mongodb.memory.delete').attributes['strands_mongodb.deleted_count']).toBe(3)
      expect(oneSpan(exporter, 'strands_mongodb.memory.delete_all').attributes['strands_mongodb.deleted_count']).toBe(3)
    })

    it('marks a refusal before the network as the error the caller sees', async () => {
      await rejectionOf(setup().store.add(CONTENT))

      const span = oneSpan(exporter, 'strands_mongodb.memory.add')
      expect(span.status.code).toBe(SpanStatusCode.ERROR)
      expect(span.status.message).toBe('TypeError')
    })
  })
})
