import { Buffer } from 'node:buffer'
import { inspect } from 'node:util'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { StorageError } from '@strands-agents/sdk'
import {
  KeywordSearchStrategy,
  type SearchStrategy,
  type StorageSearchResult,
} from '@strands-agents/sdk/storage/search'
import {
  Binary,
  BSON,
  type Document,
  type MongoClient,
  MongoNetworkTimeoutError,
  MongoTopologyClosedError,
} from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConstructedMongoClient, FakeCollection, FakeMongoClient, freshUri } from '../__fixtures__/fake-mongo.js'
import { oneSpan, recordSpans, spansNamed } from '../__fixtures__/spans.js'
import { close } from '../client.js'
import { SearchIndexNotReady } from '../ensure-indexes.js'
import { EXPIRES_FIELD, READY_TIMEOUT_SECONDS, SearchIndexSpec } from '../index-specs.js'
import { NAMESPACED, successor } from '../keys.js'
import { MAX_DOCUMENT_BYTES, MAX_KEY_BYTES, MongoDBStorage, type MongoDBStorageOptions } from '../storage.js'
import type { MongoDBConfig } from '../types.js'
import { errorOf, rejectionOf } from '../__fixtures__/errors.js'

vi.mock('mongodb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('mongodb')>()),
  MongoClient: (await import('../__fixtures__/fake-mongo.js')).ConstructedMongoClient,
}))

const exporter = recordSpans()

// A URI whose password must not appear in any message or rendering this module produces.
const LEAKY_URI = 'mongodb://appuser:SUPERSECRET@db.example.com:27017/appdb'

// Reported the way `listCollections` resolves a case-folding collation.
const CASE_INSENSITIVE = {
  locale: 'en',
  caseLevel: false,
  caseFirst: 'off',
  strength: 2,
  numericOrdering: false,
  alternate: 'non-ignorable',
  maxVariable: 'punct',
  normalization: false,
  backwards: false,
  version: '57.1',
}

const WORD = '[\\p{L}\\p{N}_]+'

// Bytes a document costs besides its key and payload, pinned by AT-038a against the encoder.
const DOCUMENT_OVERHEAD_BYTES = 46

const PAYLOAD = new Uint8Array(Buffer.from('payload'))

interface Setup {
  storage: MongoDBStorage
  collection: FakeCollection
  client: FakeMongoClient
}

function setup(options: MongoDBStorageOptions = {}, config: Partial<MongoDBConfig> = {}): Setup {
  const client = new FakeMongoClient()
  const storage = new MongoDBStorage(
    { database: 'appdb', client: client as unknown as MongoClient, ...config },
    options
  )
  const collection = client.db('appdb').collection(options.collection ?? 'storage')
  return { storage, collection, client }
}

function networkFailure(message = 'socket timed out'): MongoNetworkTimeoutError {
  return new MongoNetworkTimeoutError(message)
}

function failing(options: MongoDBStorageOptions = {}, config: Partial<MongoDBConfig> = {}): Setup {
  const built = setup(options, config)
  built.collection.failure = networkFailure()
  return built
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text))
}

function stored(_id: string, payload: Uint8Array = PAYLOAD): Document {
  return { _id, data: new Binary(payload), updated_at: new Date() }
}

function seed(collection: FakeCollection, ...keys: string[]): void {
  collection.docs.push(...keys.map((key) => stored(key)))
}

function ids(collection: FakeCollection): string[] {
  return collection.docs.map((doc) => String(doc._id))
}

function document(collection: FakeCollection, _id: string): Document {
  const found = collection.docs.find((doc) => doc._id === _id)
  expect(found).toBeDefined()
  return found!
}

function filterOf(collection: FakeCollection, index = 0): Document {
  return collection.calls[index]!.args[0] as Document
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)])
  }
  return []
}

function stringLists(value: unknown): string[][] {
  if (Array.isArray(value)) {
    const own = value.length > 0 && value.every((item) => typeof item === 'string') ? [value as string[]] : []
    return [...own, ...value.flatMap(stringLists)]
  }
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringLists)
  return []
}

function stagesOf(collection: FakeCollection): string[] {
  return pipelineOf(collection).map((stage) => Object.keys(stage)[0]!)
}

function pipelineOf(collection: FakeCollection): Document[] {
  const call = collection.calls.find((candidate) => candidate.method === 'aggregate')
  expect(call).toBeDefined()
  return call!.args[0] as Document[]
}

type Operation = 'write' | 'read' | 'delete' | 'list' | 'search' | 'deletePrefix' | 'ensureIndexes'

// Every public method that touches the key space, with arguments enough to reach its first round trip.
const KEY_OPERATIONS: Record<Operation, (storage: MongoDBStorage) => Promise<unknown>> = {
  write: (storage) => storage.write('k', bytes('v')),
  read: (storage) => storage.read('k'),
  delete: (storage) => storage.delete('k'),
  list: (storage) => storage.list(''),
  search: (storage) => storage.search('q'),
  deletePrefix: (storage) => storage.deletePrefix(''),
  ensureIndexes: (storage) => storage.ensureIndexes(),
}

const CONTRACT_CALLS = ['write', 'read', 'delete', 'list', 'deletePrefix', 'search'] as const

function call(storage: MongoDBStorage, operation: (typeof CONTRACT_CALLS)[number], key = 'a/b'): Promise<unknown> {
  return operation === 'write' ? storage.write(key, PAYLOAD) : storage[operation](key)
}

class RecordingStrategy implements SearchStrategy<MongoDBStorage> {
  readonly indexed: Array<{ storage: MongoDBStorage; key: string; data: Uint8Array }> = []
  readonly searched: Array<{ storage: MongoDBStorage; query: string }> = []

  constructor(
    private readonly results: StorageSearchResult[] = [],
    private readonly error: Error | undefined = undefined
  ) {}

  async index(storage: MongoDBStorage, key: string, data: Uint8Array): Promise<void> {
    this.indexed.push({ storage, key, data })
    if (this.error !== undefined) throw this.error
  }

  async search(storage: MongoDBStorage, query: string): Promise<StorageSearchResult[]> {
    this.searched.push({ storage, query })
    if (this.error !== undefined) throw this.error
    return this.results
  }
}

class IndexedStrategy extends RecordingStrategy {
  indexSpec(): SearchIndexSpec {
    return new SearchIndexSpec({
      name: 'vector_index',
      definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: 4, similarity: 'cosine' }] },
      type: 'vectorSearch',
    })
  }
}

afterEach(() => {
  vi.useRealTimers()
  ConstructedMongoClient.built.length = 0
})

describe('MongoDBStorage', () => {
  describe('AT-034, AT-044c: the Storage interface is satisfied structurally', () => {
    it('has no forSandbox, so the context offloader degrades instead of breaking', () => {
      expect('forSandbox' in setup().storage).toBe(false)
    })
  })

  describe('construction', () => {
    it('throws a TypeError for a config with no database, before anything else is read', () => {
      const error = errorOf(() => new MongoDBStorage({ ttlSeconds: -1 } as unknown as MongoDBConfig))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'database'")
    })

    it('throws a RangeError for a negative ttlSeconds, before the connection is resolved', () => {
      expect(() => new MongoDBStorage({ database: 'appdb' }, { ttlSeconds: -1 })).toThrow(RangeError)
    })

    it('throws a StorageError for a prefix with a .. segment, before the connection is resolved', () => {
      expect(() => new MongoDBStorage({ database: 'appdb' }, { prefix: 'a/../b' })).toThrow(StorageError)
    })

    it('throws a TypeError when neither client nor connectionString is set', () => {
      expect(() => new MongoDBStorage({ database: 'appdb' })).toThrow(TypeError)
    })

    it('accepts 0 as a lifetime and undefined as no lifetime', () => {
      expect(() => setup({ ttlSeconds: 0 })).not.toThrow()
      expect(() => setup({ ttlSeconds: undefined })).not.toThrow()
    })

    it('defaults the collection to storage and the prefix to empty', () => {
      const { storage, client } = setup()

      expect(storage.prefix).toBe('')
      expect([...client.collections.keys()]).toEqual(['appdb.storage'])
    })
  })

  describe('AT-030, AT-039: namespace returns an instance marked as already scoped', () => {
    it('marks the scoped instance with the SDK sentinel', () => {
      const scoped = setup().storage.namespace('tenant-a')

      expect(NAMESPACED in scoped).toBe(true)
      expect(scoped[NAMESPACED]).toBe(true)
    })

    it('leaves an unscoped instance unmarked', () => {
      expect(NAMESPACED in setup().storage).toBe(false)
    })

    it('returns a MongoDBStorage rather than a wrapper, so deletePrefix stays reachable', () => {
      const scoped = setup().storage.namespace('tenant-a')

      expect(scoped).toBeInstanceOf(MongoDBStorage)
    })

    it('appends on nesting rather than replacing', () => {
      expect(setup().storage.namespace('tenant-a').namespace('sessions').prefix).toBe('tenant-a/sessions/')
    })

    it('keeps the collection and the TTL', async () => {
      const { storage, collection } = setup({ collection: 'transcripts', ttlSeconds: 60 })

      await storage.namespace('tenant-a').write('k', PAYLOAD)

      expect(document(collection, 'tenant-a/k')[EXPIRES_FIELD]).toBeInstanceOf(Date)
    })

    it('shares the connection, building no second client', async () => {
      const config = { database: 'appdb', connectionString: freshUri() }
      const storage = new MongoDBStorage(config)

      storage.namespace('tenant-a')

      expect(ConstructedMongoClient.built).toHaveLength(1)
      await close(config)
    })

    it.each(['tenant-a', 'tenant-a/', '/tenant-a', 'tenant-a//'])('normalizes %j to one trailing slash', (prefix) => {
      expect(setup().storage.namespace(prefix).prefix).toBe('tenant-a/')
      expect(setup({ prefix }).storage.prefix).toBe('tenant-a/')
    })
  })

  describe('AT-018: keys are normalized before they become ids', () => {
    it.each(['a//b', '/a/b', 'a/b/', '//a//b//'])('writes %j under the id a/b', async (key) => {
      const { storage, collection } = setup()

      await storage.write(key, PAYLOAD)

      expect(ids(collection)).toEqual(['a/b'])
    })

    it('reads back whatever spelling wrote it', async () => {
      const { storage } = setup()

      await storage.write('a//b', PAYLOAD)

      expect(await storage.read('/a/b/')).toEqual(PAYLOAD)
    })

    it.each(['', '/', '//'])('rejects the empty key %j before any call is issued', async (key) => {
      const { storage, collection } = setup()

      const error = await rejectionOf(storage.write(key, PAYLOAD))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('empty')
      expect(collection.calls).toEqual([])
    })

    it.each(['a/../b', '..', '../a'])('rejects the .. segment in %j', async (key) => {
      const error = await rejectionOf(setup().storage.write(key, PAYLOAD))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('..')
    })

    it.each(['read', 'delete'] as const)('normalizes on %s too', async (method) => {
      const { storage, collection } = setup()
      seed(collection, 'a/b')

      await storage[method]('a//b')

      expect(filterOf(collection)).toEqual({ _id: 'a/b' })
    })

    it('prepends the namespace prefix after normalization', async () => {
      const { storage, collection } = setup({ prefix: 'tenant-a' })

      await storage.write('/sessions//abc', PAYLOAD)

      expect(ids(collection)).toEqual(['tenant-a/sessions/abc'])
    })
  })

  describe('AT-019: list and deletePrefix normalize their argument as a prefix', () => {
    it.each([
      ['a//b', 'a/b'],
      ['/a/b', 'a/b'],
      ['a/b/', 'a/b/'],
    ])('uses the normalized form of %j, %j, as the lower bound', async (query, expected) => {
      const { storage, collection } = setup()

      await storage.list(query)

      expect((filterOf(collection)._id as Document).$gte).toBe(expected)
    })

    it('treats an empty prefix as an unbounded query rather than an error', async () => {
      const { storage, collection } = setup()
      seed(collection, 'a', 'b')

      expect(await storage.list('')).toEqual(['a', 'b'])
      expect(filterOf(collection)).toEqual({})
    })

    it('rejects a .. segment in a prefix before any call', async () => {
      const { storage, collection } = setup()

      const error = await rejectionOf(storage.list('a/../b'))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('..')
      expect(collection.calls).toEqual([])
    })

    it('normalizes deletePrefix the same way', async () => {
      const { storage, collection } = setup()

      await storage.deletePrefix('//a//')

      expect(collection.namesCalled).toEqual(['deleteMany'])
      expect((filterOf(collection)._id as Document).$gte).toBe('a/')
    })

    it('keeps a trailing slash significant', async () => {
      const { storage, collection } = setup()
      seed(collection, 'sessions/abc', 'sessions-archive/abc')

      expect(await storage.list('sessions/')).toEqual(['sessions/abc'])
    })

    it('bounds the range with the namespace prefix as well', async () => {
      const { storage, collection } = setup({ prefix: 'tenant-a' })

      await storage.list('sessions/')

      expect((filterOf(collection)._id as Document).$gte).toBe('tenant-a/sessions/')
    })
  })

  describe('AT-026b: the range bound is an encodable successor', () => {
    it.each(['a', 'session/', 'ké', '퟿', 'a\u{10ffff}', '\u{10ffff}', 'a/😀'])(
      'emits a filter for %j that the BSON encoder accepts',
      async (prefix) => {
        const { storage, collection } = setup()

        await storage.list(prefix)

        expect(() => BSON.serialize(filterOf(collection))).not.toThrow()
      }
    )

    it('skips the surrogate block', async () => {
      const { storage, collection } = setup()

      await storage.list('퟿')

      expect((filterOf(collection)._id as Document).$lt).toBe('')
    })

    it('drops the upper bound for a prefix of the maximum code point', async () => {
      const { storage, collection } = setup()

      await storage.list('\u{10ffff}')

      expect(filterOf(collection)).toEqual({ _id: { $gte: '\u{10ffff}' } })
    })

    it('shortens the bound on a carry past the maximum', async () => {
      const { storage, collection } = setup()

      await storage.list('a\u{10ffff}')

      expect((filterOf(collection)._id as Document).$lt).toBe('b')
    })

    it('bounds an astral key with its successor, so a/😀 round-trips and lists', async () => {
      const { storage, collection } = setup()
      seed(collection, 'a/😁', 'a/z')

      await storage.write('a/😀', PAYLOAD)
      await storage.write('a/😀/nested', PAYLOAD)

      expect(await storage.read('a/😀')).toEqual(PAYLOAD)
      expect(await storage.list('a/😀')).toEqual(['a/😀', 'a/😀/nested'])
      expect(filterOf(collection, collection.calls.length - 1)).toEqual({
        _id: { $gte: 'a/😀', $lt: successor('a/😀') },
      })
      expect(await storage.list('a/')).toEqual(['a/z', 'a/😀', 'a/😀/nested', 'a/😁'])
    })

    it('lists in code point order, a high BMP character before an astral one', async () => {
      const { storage, collection } = setup()
      seed(collection, 'a/😀', 'a/\uff5e')

      expect(await storage.list('a/')).toEqual(['a/\uff5e', 'a/😀'])
    })
  })

  describe('AT-020, AT-035: the calls and the document match', () => {
    it('writes with one upserting replaceOne', async () => {
      const { storage, collection } = setup()

      await storage.write('a/b', PAYLOAD)

      expect(collection.namesCalled).toEqual(['replaceOne'])
      expect(filterOf(collection)).toEqual({ _id: 'a/b' })
      expect(collection.calls[0]!.args[2]).toEqual({ upsert: true })
    })

    it('carries the payload as a Binary and a Date timestamp', async () => {
      const { storage, collection } = setup()

      await storage.write('a/b', PAYLOAD)

      const written = document(collection, 'a/b')
      expect(written.data).toBeInstanceOf(Binary)
      expect(new Uint8Array((written.data as Binary).buffer)).toEqual(PAYLOAD)
      expect(written.updated_at).toBeInstanceOf(Date)
    })

    it('wraps the payload without copying it', async () => {
      const { storage, collection } = setup()
      const payload = new Uint8Array([1, 2, 3])

      await storage.write('a/b', payload)

      const sent = (collection.calls[0]!.args[1] as Document).data as Binary
      expect(sent.buffer.buffer).toBe(payload.buffer)
    })

    it('writes no expiry field without a TTL', async () => {
      const { storage, collection } = setup()

      await storage.write('a/b', PAYLOAD)

      expect(EXPIRES_FIELD in document(collection, 'a/b')).toBe(false)
    })

    it('writes no expiry field when ttlSeconds is explicitly undefined', async () => {
      const { storage, collection } = setup({ ttlSeconds: undefined })

      await storage.write('a/b', PAYLOAD)

      expect(EXPIRES_FIELD in document(collection, 'a/b')).toBe(false)
    })

    it('writes the field the TTL index watches when a TTL is set', async () => {
      const { storage, collection } = setup({ ttlSeconds: 60 })

      await storage.write('a/b', PAYLOAD)

      expect(document(collection, 'a/b')[EXPIRES_FIELD]).toBeInstanceOf(Date)
    })

    it('writes the expiry field for a TTL of 0', async () => {
      const { storage, collection } = setup({ ttlSeconds: 0 })

      await storage.write('a/b', PAYLOAD)

      const written = document(collection, 'a/b')
      expect((written[EXPIRES_FIELD] as Date).getTime()).toBe((written.updated_at as Date).getTime())
    })

    it('sets the expiry the TTL ahead of the timestamp', async () => {
      const { storage, collection } = setup({ ttlSeconds: 60 })

      await storage.write('a/b', PAYLOAD)

      const written = document(collection, 'a/b')
      expect((written[EXPIRES_FIELD] as Date).getTime() - (written.updated_at as Date).getTime()).toBe(60_000)
    })

    it('reads the payload back as a Uint8Array, not a Binary or a Buffer', async () => {
      const { storage } = setup()
      await storage.write('a/b', PAYLOAD)

      const found = await storage.read('a/b')

      expect(found?.constructor).toBe(Uint8Array)
      expect(found).toEqual(PAYLOAD)
    })

    it('reads a Binary written from a Buffer and an empty payload back as equal Uint8Arrays', async () => {
      const { storage, collection } = setup()
      collection.docs.push(stored('from-buffer', Buffer.from('payload')), stored('empty', new Uint8Array(0)))

      const fromBuffer = await storage.read('from-buffer')
      const empty = await storage.read('empty')

      expect(fromBuffer?.constructor).toBe(Uint8Array)
      expect(fromBuffer).toEqual(bytes('payload'))
      expect(empty?.constructor).toBe(Uint8Array)
      expect(empty).toEqual(new Uint8Array(0))
      expect(empty).not.toBeNull()
    })

    it('reads a payload stored under another binary subtype', async () => {
      const { storage, collection } = setup()
      collection.docs.push({ _id: 'a/b', data: new Binary(Buffer.from('payload'), 2) })

      expect(await storage.read('a/b')).toEqual(bytes('payload'))
    })

    it('reads a payload a promoteBuffers client decoded to a Buffer', async () => {
      const { storage, collection } = setup()
      collection.docs.push({ _id: 'a/b', data: Buffer.from('payload') })

      const found = await storage.read('a/b')

      expect(found?.constructor).toBe(Uint8Array)
      expect(found).toEqual(bytes('payload'))
    })

    it('round-trips an empty payload through write', async () => {
      const { storage } = setup()

      await storage.write('a/b', new Uint8Array(0))

      expect(await storage.read('a/b')).toEqual(new Uint8Array(0))
    })

    it('reads a missing key as null with one findOne and no error', async () => {
      const { storage, collection } = setup()

      expect(await storage.read('a/b')).toBeNull()
      expect(collection.namesCalled).toEqual(['findOne'])
    })

    it('deletes with one deleteOne and ignores the count', async () => {
      const { storage, collection } = setup()

      await expect(storage.delete('a/b')).resolves.toBeUndefined()
      expect(collection.namesCalled).toEqual(['deleteOne'])
    })

    it('lists with an _id projection and an ascending _id sort', async () => {
      const { storage, collection } = setup()
      seed(collection, 'a/two', 'a/one')

      expect(await storage.list('a/')).toEqual(['a/one', 'a/two'])
      expect(collection.calls[0]!.args[1]).toEqual({ projection: { _id: 1 } })
    })

    it('strips the namespace prefix and keeps the query prefix', async () => {
      const { storage, collection } = setup({ prefix: 'tenant-a' })
      seed(collection, 'tenant-a/sessions/abc')

      expect(await storage.list('sessions/')).toEqual(['sessions/abc'])
    })

    it('deletes a prefix in one call and returns the count', async () => {
      const { storage, collection } = setup()
      seed(collection, 'a/one', 'a/two', 'b/three')

      expect(await storage.deletePrefix('a/')).toBe(2)
      expect(collection.namesCalled).toEqual(['deleteMany'])
      expect(ids(collection)).toEqual(['b/three'])
    })
  })

  describe('AT-037: the key ceiling is 1024 UTF-8 bytes', () => {
    it('accepts a key at the ceiling', async () => {
      const { storage, collection } = setup()

      await storage.write('k'.repeat(1024), PAYLOAD)

      expect(collection.namesCalled).toEqual(['replaceOne'])
    })

    it('rejects a key one byte over before any call, naming both numbers', async () => {
      const { storage, collection } = setup()

      const error = await rejectionOf(storage.write('k'.repeat(1025), PAYLOAD))

      expect(error).toBeInstanceOf(StorageError)
      expect(collection.calls).toEqual([])
      expect(error.message).toContain('1025')
      expect(error.message).toContain('1024')
    })

    it('counts UTF-8 bytes and not characters', async () => {
      const { storage, collection } = setup()

      const error = await rejectionOf(storage.write('é'.repeat(600), PAYLOAD))

      expect(collection.calls).toEqual([])
      expect(error.message).toContain('1200')
    })

    it('counts the namespace prefix toward the ceiling', async () => {
      const { storage, collection } = setup({ prefix: 'tenant-a' })

      await expect(storage.write('k'.repeat(1020), PAYLOAD)).rejects.toBeInstanceOf(StorageError)
      expect(collection.calls).toEqual([])
    })

    it('shortens the key in the message instead of quoting all of it', async () => {
      const { storage } = setup()

      const error = await rejectionOf(storage.write('k'.repeat(1025), PAYLOAD))

      expect(error.message).not.toContain('k'.repeat(1025))
      expect(error.message).toContain('k'.repeat(60))
      expect(error.message).toContain('[+965 more]')
      expect(error.message.length).toBeLessThan(300)
    })

    it.each(['read', 'delete'] as const)('checks it on %s too', async (method) => {
      const { storage, collection } = setup()

      await expect(storage[method]('k'.repeat(1025))).rejects.toBeInstanceOf(StorageError)
      expect(collection.calls).toEqual([])
    })
  })

  describe('AT-038a, AT-029: the size preflight', () => {
    it.each([
      ['k', new Uint8Array(0), undefined],
      ['k', bytes('x'), undefined],
      ['ké', bytes('x'), undefined],
      ['k😀', bytes('x'), undefined],
      ['k'.repeat(1024), new Uint8Array(4 * 1024 * 1024).fill(0x79), undefined],
      ['k', new Uint8Array(0), 60],
      ['k'.repeat(1024), new Uint8Array(4 * 1024 * 1024).fill(0x79), 60],
    ])('sizes the document %j with %d bytes and ttl %s as the encoder does', async (key, payload, ttlSeconds) => {
      const { storage, collection } = setup({ ttlSeconds })

      await storage.write(key, payload)

      const sent = collection.calls[0]!.args[1] as Document
      const expires = ttlSeconds === undefined ? 0 : 20
      expect(BSON.calculateObjectSize(sent)).toBe(BSON.serialize(sent).length)
      expect(BSON.calculateObjectSize(sent)).toBe(
        DOCUMENT_OVERHEAD_BYTES + Buffer.byteLength(key) + payload.length + expires
      )
    })

    it('accepts a document at the ceiling', async () => {
      const { storage, collection } = setup()
      const payload = new Uint8Array(MAX_DOCUMENT_BYTES - DOCUMENT_OVERHEAD_BYTES - 'a/b'.length).fill(0x7a)

      await storage.write('a/b', payload)

      expect(BSON.calculateObjectSize(collection.calls[0]!.args[1] as Document)).toBe(MAX_DOCUMENT_BYTES)
    })

    it('rejects one byte over, naming the key, the size and the limit, before any call', async () => {
      const { storage, collection } = setup()
      const payload = new Uint8Array(MAX_DOCUMENT_BYTES - DOCUMENT_OVERHEAD_BYTES - 'a/b'.length + 1).fill(0x7a)

      const error = await rejectionOf(storage.write('a/b', payload))

      expect(error).toBeInstanceOf(StorageError)
      expect(collection.calls).toEqual([])
      expect(error.message).toContain('a/b')
      expect(error.message).toContain(String(MAX_DOCUMENT_BYTES + 1))
      expect(error.message).toContain(String(MAX_DOCUMENT_BYTES))
      expect(error.message).toContain('appdb.storage')
    })

    it('lowers the payload the ceiling allows when a TTL is set', async () => {
      const { storage, collection } = setup({ ttlSeconds: 60 })
      const payload = new Uint8Array(MAX_DOCUMENT_BYTES - DOCUMENT_OVERHEAD_BYTES - 'a/b'.length).fill(0x7a)

      await expect(storage.write('a/b', payload)).rejects.toBeInstanceOf(StorageError)
      expect(collection.calls).toEqual([])
    })

    it('pins the two ceilings to their numbers', () => {
      expect(MAX_DOCUMENT_BYTES).toBe(16 * 1024 * 1024)
      expect(MAX_KEY_BYTES).toBe(1024)
    })
  })

  describe('AT-022, AT-036: driver failures become StorageErrors', () => {
    it.each(CONTRACT_CALLS)('wraps a failure in %s with the cause attached', async (operation) => {
      const { storage, collection } = failing()

      const error = await rejectionOf(call(storage, operation))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.cause).toBe(collection.failure)
    })

    it('wraps a failure while the cursor drains too', async () => {
      const { storage, collection } = setup()
      seed(collection, 'a/one')
      collection.drainFailure = networkFailure()

      const error = await rejectionOf(storage.list('a/'))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.cause).toBe(collection.drainFailure)
    })

    it('names the operation, the key and the namespace', async () => {
      const { storage } = failing({ collection: 'transcripts' })

      const error = await rejectionOf(storage.read('a/b'))

      expect(error.message).toBe("strands_mongodb: reading 'a/b' in appdb.transcripts failed: socket timed out")
    })

    it('uses the sentence shape the rest of the package uses', async () => {
      const { storage } = failing()

      const error = await rejectionOf(storage.read('a/b'))

      expect(error.message.startsWith('strands_mongodb: ')).toBe(true)
      expect(error.message).toContain(' failed: socket timed out')
    })

    it('abbreviates the subject in the message', async () => {
      const { storage } = failing()

      const error = await rejectionOf(storage.list('k'.repeat(100)))

      expect(error.message).toContain(`listing '${'k'.repeat(60)}[+40 more]' in appdb.storage failed`)
    })

    it('does not swallow a non-driver error', async () => {
      const { storage, collection } = setup()
      collection.failure = new RangeError('bug in this package')

      await expect(storage.read('a/b')).rejects.toThrow(RangeError)
    })

    it('passes a StorageError thrown inside the body through unchanged', async () => {
      const { storage, collection } = setup()
      collection.failure = new StorageError('already wrapped')

      const error = await rejectionOf(storage.read('a/b'))

      expect(error).toBe(collection.failure)
    })
  })

  describe('AT-014: no storage method renders the password', () => {
    function leaky(): { storage: MongoDBStorage; collection: FakeCollection } {
      const storage = new MongoDBStorage({ database: 'appdb', connectionString: LEAKY_URI })
      const collection = ConstructedMongoClient.built[0]!.db('appdb').collection('storage')
      return { storage, collection }
    }

    afterEach(() => close({ database: 'appdb', connectionString: LEAKY_URI }))

    it.each(CONTRACT_CALLS)('renders no password from a wrapped driver failure in %s', async (operation) => {
      const { storage, collection } = leaky()
      collection.failure = networkFailure()

      const error = await rejectionOf(call(storage, operation))

      expect(error.message).not.toContain('SUPERSECRET')
      expect(inspect(error, { depth: 2 })).not.toContain('SUPERSECRET')
    })

    it('renders neither the password nor the host from the store or its namespaced view', () => {
      const { storage } = leaky()

      for (const rendered of [
        inspect(storage, { depth: 5 }),
        inspect(storage.namespace('tenant-a'), { depth: 5 }),
        JSON.stringify(storage),
        JSON.stringify(storage.namespace('tenant-a')),
      ]) {
        expect(rendered).not.toContain('SUPERSECRET')
        expect(rendered).not.toContain('db.example.com')
      }
    })

    it.each([
      ['k'.repeat(1025), bytes('x')],
      ['a/b', new Uint8Array(17 * 1024 * 1024)],
      ['', bytes('x')],
      ['a/../b', bytes('x')],
    ])('renders no password from the validation error for key %j', async (key, payload) => {
      const { storage } = leaky()

      const error = await rejectionOf(storage.write(key, payload))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).not.toContain('SUPERSECRET')
    })
  })

  describe('AT-032a, AT-032c: search is one aggregation', () => {
    it('issues one aggregate and no find', async () => {
      const { storage, collection } = setup()
      seed(collection, 'notes/dark.md')

      await storage.search('dark mode')

      expect(collection.namesCalled).toEqual(['aggregate'])
    })

    it('hints the _id index, so an unprefixed scan reads no payload', async () => {
      const { storage, collection } = setup()

      await storage.search('dark mode')

      expect(collection.calls[0]!.args[1]).toEqual({ hint: { _id: 1 } })
    })

    it('emits project, match, sort with no range match for an unnamespaced store', async () => {
      const { storage, collection } = setup()

      await storage.search('dark')

      expect(stagesOf(collection)).toEqual(['$project', '$match', '$sort'])
    })

    it('bounds the scan with the prefix range first for a namespaced store', async () => {
      const { storage, collection } = setup({ prefix: 'tenant-a' })

      await storage.search('dark')

      expect(stagesOf(collection)).toEqual(['$match', '$project', '$match', '$sort'])
      expect(pipelineOf(collection)[0]).toEqual({ $match: { _id: { $gte: 'tenant-a/', $lt: 'tenant-a0' } } })
    })

    it('AT-229: scores keys without the instance prefix, cut by code point', async () => {
      const { storage, collection } = setup({ prefix: 'tenant-😀' })

      await storage.search('dark')

      const project = pipelineOf(collection)[1]!.$project as Document
      const mapped = ((project.score as Document).$size as Document).$setIntersection as Document[]
      const tokenized = mapped[0]!.$map as Document
      expect((tokenized.input as Document).$regexFindAll).toEqual({
        input: { $toLower: { $substrCP: ['$_id', Array.from('tenant-😀/').length, { $strLenCP: '$_id' }] } },
        regex: WORD,
      })
      expect(tokenized.in).toBe('$$this.match')
    })

    it('uses the Unicode property class, never the ASCII-only backslash-w', async () => {
      const { storage, collection } = setup()

      await storage.search('dark')

      const found = strings(pipelineOf(collection))
      expect(found).toContain(WORD)
      expect(found.some((text) => text.includes('\\w'))).toBe(false)
    })

    it('lowercases, deduplicates and sorts the query tokens', async () => {
      const { storage, collection } = setup()

      await storage.search('Dark DARK mode')

      expect(stringLists(pipelineOf(collection))).toContainEqual(['dark', 'mode'])
    })

    it('keeps the SDK tokenizer semantics: stop words are tokens too', async () => {
      const { storage, collection } = setup()

      await storage.search('the dark')

      expect(stringLists(pipelineOf(collection))).toContainEqual(['dark', 'the'])
    })

    it('keeps only keys scoring above zero and breaks ties by key', async () => {
      const { storage, collection } = setup()

      await storage.search('dark')

      const pipeline = pipelineOf(collection)
      expect(pipeline.at(-2)).toEqual({ $match: { score: { $gt: 0 } } })
      expect(pipeline.at(-1)).toEqual({ $sort: { score: -1, _id: 1 } })
    })

    it('asks for no field that would end the covered scan', async () => {
      const { storage, collection } = setup()

      await storage.search('dark')

      const found = new Set(strings(pipelineOf(collection)))
      expect(found.has('$data')).toBe(false)
      expect(found.has('$_id')).toBe(true)
      expect(found.has('$$this.match')).toBe(true)
    })

    it.each(['', '   ', '!!! ---', '\n\t'])('answers %j from no round trip at all', async (query) => {
      const { storage, collection } = setup()
      seed(collection, 'notes/dark.md')

      expect(await storage.search(query)).toEqual([])
      expect(collection.namesCalled).toEqual([])
      expect(collection.db.listCollectionsCalls).toEqual([])
    })

    it('returns keys without the instance prefix', async () => {
      const { storage, collection } = setup({ prefix: 'tenant-a' })
      seed(collection, 'tenant-a/notes/dark.md', 'tenant-b/notes/dark.md')

      expect((await storage.search('dark')).map((result) => result.key)).toEqual(['notes/dark.md'])
    })

    it('returns a numeric score and leaves data unset', async () => {
      const { storage, collection } = setup()
      seed(collection, 'notes/dark.md')

      const [found] = await storage.search('dark')

      expect(found).toEqual({ key: 'notes/dark.md', score: 1 })
      expect('data' in found!).toBe(false)
    })

    it('ranks by token overlap with the key breaking ties', async () => {
      const { storage, collection } = setup()
      seed(collection, 'notes/toggle-dark.md', 'notes/dark-mode-toggle.md', 'notes/café-münchen.md', 'sessions/s1.json')

      const found = await storage.search('dark mode münchen')

      expect(found).toEqual([
        { key: 'notes/dark-mode-toggle.md', score: 2 },
        { key: 'notes/café-münchen.md', score: 1 },
        { key: 'notes/toggle-dark.md', score: 1 },
      ])
    })

    it('matches a mixed-case key against a lowercase query', async () => {
      const { storage, collection } = setup()
      seed(collection, 'Sessions/Agent-1/State.json')

      expect(await storage.search('sessions agent')).toEqual([{ key: 'Sessions/Agent-1/State.json', score: 2 }])
    })

    it('matches a non-ASCII capital case-sensitively, since the server lowercases ASCII only', async () => {
      const { storage, collection } = setup()
      seed(collection, 'notes/ÉCOLE.md')

      expect(await storage.search('école')).toEqual([])
      expect(await storage.search('NOTES')).toEqual([{ key: 'notes/ÉCOLE.md', score: 1 }])
    })

    it('turns a failing aggregation into a StorageError naming the query', async () => {
      const { storage } = failing()

      const error = await rejectionOf(storage.search('dark'))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message.startsWith("strands_mongodb: searching 'dark' in appdb.storage failed:")).toBe(true)
      expect(error.cause).toBeInstanceOf(MongoNetworkTimeoutError)
    })
  })

  describe('AT-236: a configured search strategy is called on write and search', () => {
    it('indexes the normalized relative key after the upsert', async () => {
      const strategy = new RecordingStrategy()
      const { storage, collection } = setup({ prefix: 'tenant-a', searchStrategy: strategy })

      await storage.write('/notes//one.md', bytes('text'))

      expect(collection.namesCalled.at(-1)).toBe('replaceOne')
      expect(strategy.indexed.map(({ key, data }) => [key, data])).toEqual([['notes/one.md', bytes('text')]])
      expect(strategy.indexed[0]!.storage).toBe(storage)
    })

    it('raises on an indexing failure and leaves the value written', async () => {
      const failure = new Error('embedder down')
      const { storage, collection } = setup({ searchStrategy: new RecordingStrategy([], failure) })

      const error = await rejectionOf(storage.write('k', bytes('v')))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toBe(
        "strands_mongodb: wrote 'k' in appdb.storage but indexing it for search failed: embedder down"
      )
      expect(error.cause).toBe(failure)
      expect(new Uint8Array((document(collection, 'k').data as Binary).buffer)).toEqual(bytes('v'))
    })

    it('only searches a strategy without index', async () => {
      const searchOnly: SearchStrategy<MongoDBStorage> = { search: async () => [] }
      const { storage, collection } = setup({ searchStrategy: searchOnly })

      await storage.write('k', bytes('v'))

      expect(collection.namesCalled).toEqual(['replaceOne'])
    })

    it('calls the strategy bound, so a class-based strategy keeps its this', async () => {
      class Bound implements SearchStrategy<MongoDBStorage> {
        readonly seen: string[] = []
        async index(_storage: MongoDBStorage, key: string): Promise<void> {
          this.seen.push(`index:${key}`)
        }
        async search(_storage: MongoDBStorage, query: string): Promise<StorageSearchResult[]> {
          this.seen.push(`search:${query}`)
          return []
        }
      }
      const strategy = new Bound()
      const { storage } = setup({ searchStrategy: strategy })

      await storage.write('k', bytes('v'))
      await storage.search('q')

      expect(strategy.seen).toEqual(['index:k', 'search:q'])
    })

    it('returns what the strategy returns without touching the collection', async () => {
      const answer = [{ key: 'k', score: 0.9, data: bytes('v') }]
      const strategy = new RecordingStrategy(answer)
      const { storage, collection } = setup({ searchStrategy: strategy })

      expect(await storage.search('query')).toBe(answer)
      expect(strategy.searched).toEqual([{ storage, query: 'query' }])
      expect(collection.namesCalled).toEqual([])
    })

    it('turns a strategy error into a StorageError with the cause attached', async () => {
      const failure = new Error('embedder down')
      const { storage } = setup({ searchStrategy: new RecordingStrategy([], failure) })

      const error = await rejectionOf(storage.search('query'))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('appdb.storage')
      expect(error.message).toContain('embedder down')
      expect(error.cause).toBe(failure)
    })

    it('passes a StorageError from the strategy through unchanged', async () => {
      const failure = new StorageError('strategy refused')
      const { storage } = setup({ searchStrategy: new RecordingStrategy([], failure) })

      expect(await rejectionOf(storage.search('query'))).toBe(failure)
    })

    it('wraps a driver error from the strategy as a search failure', async () => {
      const failure = networkFailure()
      const { storage } = setup({ searchStrategy: new RecordingStrategy([], failure) })

      const error = await rejectionOf(storage.search('query'))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toBe("strands_mongodb: searching 'query' in appdb.storage failed: socket timed out")
      expect(error.cause).toBe(failure)
    })

    it("lets the SDK's keyword strategy match a word found only in the payload", async () => {
      const { storage, collection } = setup({ searchStrategy: KeywordSearchStrategy })
      collection.docs.push(stored('memory/m/user-preferences.md', bytes('# User preferences\nprefers dark mode')))

      const found = await storage.search('dark mode')

      expect(found.map((result) => result.key)).toEqual(['memory/m/user-preferences.md'])
      expect(await setup().storage.search('dark mode')).toEqual([])
    })

    it('shares the strategy with namespace views', async () => {
      const strategy = new RecordingStrategy()
      const scoped = setup({ searchStrategy: strategy }).storage.namespace('memory')

      await scoped.search('q')

      expect(strategy.searched).toEqual([{ storage: scoped, query: 'q' }])
      expect(scoped.prefix).toBe('memory/')
    })
  })

  describe('AT-121, AT-123: ensureIndexes is explicit and idempotent', () => {
    it('leaves the TTL index the storage specs declare', async () => {
      const { storage, collection } = setup()

      await storage.ensureIndexes()

      const ttl = collection.indexes.find((index) => index.name === 'strands_expires_at_ttl')
      expect(ttl?.key).toEqual({ [EXPIRES_FIELD]: 1 })
      expect(ttl?.expireAfterSeconds).toBe(0)
    })

    it('creates nothing on a second call', async () => {
      const { storage, collection } = setup()

      await storage.ensureIndexes()
      await storage.ensureIndexes()

      expect(collection.namesCalled.filter((name) => name === 'createIndexes')).toHaveLength(1)
      expect(collection.namesCalled.filter((name) => name === 'listIndexes')).toHaveLength(2)
    })

    it('verifies rather than skips when ensureIndexes is false, naming the command that would fix it', async () => {
      const { storage, collection } = setup({}, { ensureIndexes: false })

      const error = await rejectionOf(storage.ensureIndexes())

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('strands_expires_at_ttl')
      expect(error.message).toContain('createIndexes')
      expect(collection.namesCalled).not.toContain('createIndexes')
    })

    it("creates the search index a strategy's indexSpec declares", async () => {
      const strategy = new IndexedStrategy()
      const { storage, collection } = setup({ searchStrategy: strategy })

      await storage.ensureIndexes()

      expect(collection.createdSearchIndexes).toEqual([strategy.indexSpec().toDescription()])
    })

    it('creates no search index for a strategy without indexSpec', async () => {
      const { storage, collection } = setup({ searchStrategy: new RecordingStrategy() })

      await storage.ensureIndexes()

      expect(collection.createdSearchIndexes).toEqual([])
    })
  })

  describe('AT-126: the index ready budget reaches ensure', () => {
    async function timedOut(storage: MongoDBStorage, seconds: number): Promise<Error> {
      vi.useFakeTimers()
      const pending = rejectionOf(storage.ensureIndexes())
      await vi.advanceTimersByTimeAsync(seconds * 1000)
      return pending
    }

    it('passes the configured budget', async () => {
      const { storage, collection } = setup({ searchStrategy: new IndexedStrategy() }, { indexReadyTimeout: 7 })
      collection.addSearchIndex(new IndexedStrategy().indexSpec().toDescription(), 'BUILDING')

      const error = await timedOut(storage, 7)

      expect(error).toBeInstanceOf(SearchIndexNotReady)
      expect(error.message).toContain('waited 7s')
    })

    it('resolves absence to the module default', async () => {
      const { storage, collection } = setup({ searchStrategy: new IndexedStrategy() })
      collection.addSearchIndex(new IndexedStrategy().indexSpec().toDescription(), 'BUILDING')

      const error = await timedOut(storage, READY_TIMEOUT_SECONDS)

      expect(error).toBeInstanceOf(SearchIndexNotReady)
      expect(error.message).toContain(`waited ${READY_TIMEOUT_SECONDS}s`)
    })
  })

  describe('AT-124: no ordinary operation touches an index', () => {
    it('neither reads nor creates an index across the six operations', async () => {
      const { storage, collection } = setup({ ttlSeconds: 60 })
      seed(collection, 'k')

      await storage.write('k', bytes('v'))
      await storage.read('k')
      await storage.delete('k')
      await storage.list('')
      await storage.search('v')
      await storage.deletePrefix('')

      expect(collection.namesCalled).not.toContain('listIndexes')
      expect(collection.namesCalled).not.toContain('createIndexes')
      expect(new Set(collection.namesCalled)).toEqual(
        new Set(['replaceOne', 'findOne', 'deleteOne', 'find', 'aggregate', 'deleteMany'])
      )
    })
  })

  describe('AT-176: a key space needs a collection that compares bytes', () => {
    function refusing(): Setup {
      const built = setup()
      built.collection.setCollation(CASE_INSENSITIVE)
      return built
    }

    it.each(Object.keys(KEY_OPERATIONS) as Operation[])(
      'refuses the collection on %s before any call',
      async (operation) => {
        const { storage, collection } = refusing()

        const error = await rejectionOf(KEY_OPERATIONS[operation](storage))

        expect(error).toBeInstanceOf(StorageError)
        expect(error.message).toContain('collation')
        expect(collection.calls).toEqual([])
      }
    )

    it('accepts a collection with no collation', async () => {
      const { storage, collection } = setup()
      collection.setCollation(undefined)

      await storage.write('k', bytes('v'))

      expect(await storage.read('k')).toEqual(bytes('v'))
    })

    it('accepts the simple locale', async () => {
      const { storage, collection } = setup()
      collection.setCollation({ locale: 'simple' })

      await storage.write('k', bytes('v'))

      expect(await storage.read('k')).toEqual(bytes('v'))
    })

    it('accepts a collection that does not exist yet', async () => {
      const { storage, collection } = setup()
      expect(collection.exists).toBe(false)

      await storage.write('k', bytes('v'))

      expect(await storage.read('k')).toEqual(bytes('v'))
    })

    it('asks once per collection, naming it', async () => {
      const { storage, collection } = setup()
      collection.setCollation(undefined)

      for (const operation of Object.values(KEY_OPERATIONS)) await operation(storage)

      expect(collection.db.listCollectionsCalls).toEqual([{ name: 'storage' }])
    })

    it('does not ask again for a second store on the same collection', async () => {
      const { storage, collection } = setup()
      collection.setCollation(undefined)

      await storage.read('k')
      await storage.namespace('tenant-a').read('k')

      expect(collection.db.listCollectionsCalls).toHaveLength(1)
    })

    it('says what is wrong and what to do', async () => {
      const { storage } = refusing()

      const error = await rejectionOf(storage.read('k'))

      expect(error.message).toContain('appdb.storage')
      expect(error.message).toContain("'en'")
      expect(error.message).toContain('simple')
    })

    it('still lets the store be closed', async () => {
      const { storage } = refusing()

      await expect(storage.read('k')).rejects.toBeInstanceOf(StorageError)
      await expect(storage.close()).resolves.toBeUndefined()
    })

    it('wraps a failing listCollections as a StorageError', async () => {
      const { storage, collection } = setup()
      collection.db.listCollectionsError = networkFailure()

      const error = await rejectionOf(storage.read('k'))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('reading the collation of appdb.storage failed')
    })
  })

  describe('AT-192: an absent collection is not a verified one', () => {
    it('asks about an absent collection again on the next operation', async () => {
      const { storage, collection } = setup()

      await storage.read('k')
      await storage.read('k')

      expect(collection.db.listCollectionsCalls).toHaveLength(2)
    })

    it('refuses a collection created case-insensitively after an absent read', async () => {
      const { storage, collection } = setup()
      await storage.read('k')

      collection.setCollation(CASE_INSENSITIVE)

      const error = await rejectionOf(storage.read('k'))
      expect(error.message).toContain("'en'")
    })

    it('still caches a collection that exists', async () => {
      const { storage, collection } = setup()
      collection.setCollation(undefined)

      await storage.read('k')
      await storage.read('k')

      expect(collection.db.listCollectionsCalls).toHaveLength(1)
    })

    it('closes the window with the first write, which creates the collection', async () => {
      const { storage, collection } = setup()

      await storage.read('k')
      expect(collection.db.listCollectionsCalls).toHaveLength(1)
      await storage.write('k', bytes('v'))

      await storage.read('k')
      await storage.read('k')
      expect(collection.db.listCollectionsCalls).toHaveLength(3)
    })
  })

  describe('close', () => {
    it('releases a constructed client once and leaves an injected one open', async () => {
      const constructed = new MongoDBStorage({ database: 'appdb', connectionString: freshUri() })
      const { storage, client } = setup()

      await constructed.close()
      await constructed.close()
      await storage.close()

      expect(ConstructedMongoClient.built[0]!.closeCount).toBe(1)
      expect(client.closeCount).toBe(0)
    })
  })

  describe('a client the driver closed after a failed first connection', () => {
    it('replaces the client it built and answers from the fresh one', async () => {
      const config = { database: 'appdb', connectionString: freshUri() }
      const storage = new MongoDBStorage(config)
      const dead = ConstructedMongoClient.built[0]!
      dead.db('appdb').collection('storage').failure = new MongoTopologyClosedError()

      await expect(storage.read('a/b')).resolves.toBeNull()

      expect(dead.closeCount).toBe(1)
      expect(ConstructedMongoClient.built).toHaveLength(2)
      await close(config)
    })

    it('replaces it when the closed topology surfaces inside a wrapped probe', async () => {
      const config = { database: 'appdb', connectionString: freshUri() }
      const storage = new MongoDBStorage(config)
      const dead = ConstructedMongoClient.built[0]!
      dead.db('appdb').collection('storage').db.listCollectionsError = new MongoTopologyClosedError()

      await storage.ensureIndexes()

      expect(dead.closeCount).toBe(1)
      expect(ConstructedMongoClient.built).toHaveLength(2)
      await close(config)
    })

    it('reports the failure of the fresh client, not the closed topology', async () => {
      const config = { database: 'appdb', connectionString: freshUri() }
      const storage = new MongoDBStorage(config)
      const dead = ConstructedMongoClient.built[0]!
      dead.db('appdb').collection('storage').failure = new MongoTopologyClosedError()
      vi.spyOn(FakeCollection.prototype, 'findOne').mockRejectedValueOnce(networkFailure('still unreachable'))

      const error = await rejectionOf(storage.read('a/b'))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('still unreachable')
      await close(config)
    })

    it('does not reopen a pool the caller closed while the operation ran', async () => {
      const config = { database: 'appdb', connectionString: freshUri() }
      const storage = new MongoDBStorage(config)
      const closed = new MongoTopologyClosedError()
      vi.spyOn(FakeCollection.prototype, 'findOne').mockImplementationOnce(async () => {
        await storage.close()
        throw closed
      })

      const error = await rejectionOf(storage.read('a/b'))

      expect(error.cause).toBe(closed)
      expect(ConstructedMongoClient.built).toHaveLength(1)
    })

    it('says an injected client is closed, since only its owner can reopen it', async () => {
      const { storage, collection, client } = setup()
      collection.failure = new MongoTopologyClosedError()

      const error = await rejectionOf(storage.read('a/b'))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('injected')
      expect(error.cause).toBe(collection.failure)
      expect(client.closeCount).toBe(0)
    })
  })

  describe('AT-202, AT-205: every operation records one span', () => {
    it('records one INTERNAL span per operation on its namespace, with no db.* key', async () => {
      const { storage, collection } = setup({ collection: 'sessions' })
      collection.setCollation(undefined)

      await storage.write('notes/a', bytes('x'))
      await storage.read('notes/a')
      await storage.list('notes/')
      await storage.search('dark mode')
      await storage.delete('notes/a')
      await storage.deletePrefix('notes/')
      await storage.ensureIndexes()

      const spans = exporter.getFinishedSpans().filter((span) => span.name.startsWith('strands_mongodb.storage.'))
      const operations = ['write', 'read', 'list', 'search', 'delete', 'delete_prefix', 'ensure_indexes']
      expect(spans.map((span) => span.name)).toEqual(operations.map((op) => `strands_mongodb.storage.${op}`))
      for (const span of spans) {
        expect(span.kind).toBe(SpanKind.INTERNAL)
        expect(span.attributes['strands_mongodb.database']).toBe('appdb')
        expect(span.attributes['strands_mongodb.collection']).toBe('sessions')
        expect(Object.keys(span.attributes).filter((key) => key.startsWith('db.'))).toEqual([])
      }
    })

    it('records each outcome as a count or a flag, never a key or a payload', async () => {
      const { storage } = setup()
      await storage.write('notes/a', bytes('x'))
      await storage.write('notes/b', bytes('y'))

      await storage.read('notes/a')
      await storage.read('notes/missing')
      await storage.list('notes/')
      await storage.search('notes')
      await storage.delete('notes/a')
      await storage.deletePrefix('notes/')

      const attribute = (name: string, key: string): unknown[] =>
        spansNamed(exporter, name).map((span) => span.attributes[key])
      expect(attribute('strands_mongodb.storage.read', 'strands_mongodb.found')).toEqual([true, false])
      expect(attribute('strands_mongodb.storage.list', 'strands_mongodb.result_count')).toEqual([2])
      expect(attribute('strands_mongodb.storage.search', 'strands_mongodb.result_count')).toEqual([2])
      expect(attribute('strands_mongodb.storage.delete', 'strands_mongodb.deleted_count')).toEqual([1])
      expect(attribute('strands_mongodb.storage.delete_prefix', 'strands_mongodb.deleted_count')).toEqual([1])
      const rendered = JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes))
      expect(rendered).not.toContain('notes')
    })

    it('records a driver failure as the StorageError the caller sees', async () => {
      const { storage } = failing()

      await expect(storage.read('notes/a')).rejects.toBeInstanceOf(StorageError)

      const span = oneSpan(exporter, 'strands_mongodb.storage.read')
      expect(span.status.code).toBe(SpanStatusCode.ERROR)
      expect(span.status.message).toBe('StorageError')
      expect(span.attributes['error.type']).toBe('StorageError')
    })

    it('parents both the collation probe and the ensure under ensure_indexes', async () => {
      await setup().storage.ensureIndexes()

      const operation = oneSpan(exporter, 'strands_mongodb.storage.ensure_indexes')
      const children = exporter
        .getFinishedSpans()
        .filter((span) => span.parentSpanContext?.spanId === operation.spanContext().spanId)
      expect(children.map((span) => span.name).sort()).toEqual([
        'strands_mongodb.indexes.ensure',
        'strands_mongodb.indexes.probe',
      ])
      const probe = children.find((span) => span.name === 'strands_mongodb.indexes.probe')
      expect(probe?.attributes['strands_mongodb.indexes.probe']).toBe('collation')
    })
  })
})
