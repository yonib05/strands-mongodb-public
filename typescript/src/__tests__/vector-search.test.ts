import { Buffer } from 'node:buffer'
import { StorageError } from '@strands-agents/sdk'
import type { Embedder } from '@strands-agents/sdk/storage/search'
import { Binary as OtherBinary } from 'bson'
import { Binary, type Document, type MongoClient } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { type FakeCollection, FakeMongoClient } from '../__fixtures__/fake-mongo.js'
import { DEFAULT_VECTOR_INDEX_NAME, MAX_DIMENSIONS } from '../index-specs.js'
import { MongoDBStorage } from '../storage.js'
import {
  DEFAULT_STORAGE_VECTOR_INDEX_NAME,
  MongoDBVectorSearchStrategy,
  type MongoDBVectorSearchStrategyOptions,
} from '../vector-search.js'
import { errorOf } from '../__fixtures__/errors.js'

vi.mock('mongodb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('mongodb')>()),
  MongoClient: (await import('../__fixtures__/fake-mongo.js')).ConstructedMongoClient,
}))

const VOCABULARY = ['dark', 'mode', 'coffee', 'tea']

// One dimension per word in `VOCABULARY`, plus a floor so no vector is zero.
class BagOfWordsEmbedder implements Embedder {
  readonly calls: string[] = []

  constructor(readonly dimensions = VOCABULARY.length) {}

  async embed(text: string): Promise<number[]> {
    this.calls.push(text)
    const words = text.toLowerCase().split(/\s+/)
    const vector = VOCABULARY.map((word) => 0.01 + words.filter((each) => each === word).length)
    return [...vector, ...Array<number>(this.dimensions).fill(0.01)].slice(0, this.dimensions)
  }
}

function strategy(
  embedder: Embedder = new BagOfWordsEmbedder(),
  overrides: Partial<MongoDBVectorSearchStrategyOptions> = {}
): MongoDBVectorSearchStrategy {
  return new MongoDBVectorSearchStrategy({
    embedder,
    dimensions: VOCABULARY.length,
    similarity: 'cosine',
    ...overrides,
  })
}

function setup(
  searchStrategy: MongoDBVectorSearchStrategy,
  prefix?: string
): { storage: MongoDBStorage; collection: FakeCollection } {
  const client = new FakeMongoClient()
  const storage = new MongoDBStorage(
    { database: 'appdb', client: client as unknown as MongoClient },
    prefix === undefined ? { searchStrategy } : { searchStrategy, prefix }
  )
  return { storage, collection: client.db('appdb').collection('storage') }
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text))
}

function stored(collection: FakeCollection, _id: string): Document {
  const found = collection.docs.find((doc) => doc._id === _id)
  expect(found).toBeDefined()
  return found!
}

describe('MongoDBVectorSearchStrategy', () => {
  describe('untyped input is rejected at construction', () => {
    it.each([
      ['no embedder', { dimensions: 4, similarity: 'cosine' }],
      ['an embedder with no embed method', { embedder: {}, dimensions: 4, similarity: 'cosine' }],
    ])('throws a TypeError naming embedder for %s', (_kind, options) => {
      const error = errorOf(() => new MongoDBVectorSearchStrategy(options as MongoDBVectorSearchStrategyOptions))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'embedder'")
    })

    it.each([undefined, null])('throws a TypeError naming options when they are %s', (options) => {
      const error = errorOf(
        () => new MongoDBVectorSearchStrategy(options as unknown as MongoDBVectorSearchStrategyOptions)
      )

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'options'")
    })
  })

  describe('AT-237: every bound the server would enforce later is enforced at construction', () => {
    it.each([
      [{ dimensions: 0 }, RangeError, "'dimensions' is 0"],
      [{ dimensions: MAX_DIMENSIONS + 1 }, RangeError, `'dimensions' is ${MAX_DIMENSIONS + 1}`],
      [{ similarity: 'manhattan' }, TypeError, "'similarity' is 'manhattan'"],
      [{ dimensions: 1.5 }, RangeError, "'dimensions' is 1.5"],
      [{ maxResults: 0 }, RangeError, "'maxResults' is 0"],
      [{ maxResults: NaN }, RangeError, "'maxResults' is NaN"],
      [{ oversamplingFactor: 0 }, RangeError, "'oversamplingFactor' is 0"],
      [{ oversamplingFactor: NaN }, RangeError, "'oversamplingFactor' is NaN"],
      [{ oversamplingFactor: Infinity }, RangeError, "'oversamplingFactor' is Infinity"],
      [{ maxResults: 3, oversamplingFactor: 1.5 }, RangeError, 'numCandidates would be 4.5'],
      [{ maxResults: 101, oversamplingFactor: 100 }, RangeError, 'numCandidates would be 10100'],
    ])('rejects %o', (overrides, type, message) => {
      const error = errorOf(() => strategy(undefined, overrides as Partial<MongoDBVectorSearchStrategyOptions>))

      expect(error).toBeInstanceOf(type)
      expect(error.message.startsWith('strands_mongodb: ')).toBe(true)
      expect(error.message).toContain(message)
    })

    it('accepts the bounds themselves', () => {
      expect(() => strategy(new BagOfWordsEmbedder(1), { dimensions: 1 })).not.toThrow()
      expect(() => strategy(undefined, { dimensions: MAX_DIMENSIONS })).not.toThrow()
      expect(() => strategy(undefined, { maxResults: 100, oversamplingFactor: 100 })).not.toThrow()
    })

    it('declares the vector and the prefix filter in its index spec', () => {
      const spec = strategy(undefined, { dimensions: 4, similarity: 'euclidean', indexName: 'v' }).indexSpec()

      expect(spec.name).toBe('v')
      expect(spec.type).toBe('vectorSearch')
      expect(spec.definition).toEqual({
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: 4, similarity: 'euclidean' },
          { type: 'filter', path: 'prefixes' },
        ],
      })
    })

    it("defaults to an index name distinct from the memory store's", () => {
      expect(strategy().indexSpec().name).toBe(DEFAULT_STORAGE_VECTOR_INDEX_NAME)
      expect(DEFAULT_STORAGE_VECTOR_INDEX_NAME).not.toBe(DEFAULT_VECTOR_INDEX_NAME)
    })
  })

  describe('AT-238: write stores the vector on the document it just replaced', () => {
    it('sets the vector and every ancestor prefix, matching only the value just written', async () => {
      const { storage, collection } = setup(strategy(), 'tenant-a')

      await storage.write('notes/dark.md', bytes('dark mode'))

      expect(collection.namesCalled.slice(-2)).toEqual(['replaceOne', 'updateOne'])
      const [filter, update] = collection.calls.at(-1)!.args as [Document, Document]
      expect(filter).toEqual({ _id: 'tenant-a/notes/dark.md', data: new Binary(bytes('dark mode')) })
      expect(update).toEqual({
        $set: { embedding: [1.01, 1.01, 0.01, 0.01], prefixes: ['tenant-a/', 'tenant-a/notes/'] },
      })
      expect(stored(collection, 'tenant-a/notes/dark.md').embedding).toEqual([1.01, 1.01, 0.01, 0.01])
    })

    it("keeps a slower write's vector off a newer value", async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      class SlowForDark extends BagOfWordsEmbedder {
        override async embed(text: string): Promise<number[]> {
          if (text === 'dark') await gate
          return super.embed(text)
        }
      }
      const { storage, collection } = setup(strategy(new SlowForDark()))

      const slow = storage.write('k', bytes('dark'))
      await vi.waitFor(() => expect(collection.namesCalled).toContain('replaceOne'))
      await storage.write('k', bytes('tea'))
      release()
      await slow

      const document = stored(collection, 'k')
      expect(new Uint8Array((document.data as Binary).buffer)).toEqual(bytes('tea'))
      expect(document.embedding).toEqual(await new BagOfWordsEmbedder().embed('tea'))
    })

    it.each([
      ['empty', new Uint8Array()],
      ['non-UTF-8', new Uint8Array([0xff, 0xfe])],
    ])('stores an %s value without embedding it', async (_label, data) => {
      const embedder = new BagOfWordsEmbedder()
      const { storage, collection } = setup(strategy(embedder))

      await storage.write('k', data)

      expect(collection.namesCalled).not.toContain('updateOne')
      expect(embedder.calls).toEqual([])
      expect(new Uint8Array((stored(collection, 'k').data as Binary).buffer)).toEqual(data)
    })

    it('fails the write after storing the value when the vector has the wrong length', async () => {
      const { storage, collection } = setup(strategy(new BagOfWordsEmbedder(3)))

      const pending = storage.write('k', bytes('dark'))

      await expect(pending).rejects.toBeInstanceOf(StorageError)
      await expect(pending).rejects.toThrow('3-dimension vector')
      expect(stored(collection, 'k').data).toBeInstanceOf(Binary)
      expect(collection.namesCalled).not.toContain('updateOne')
    })

    it.each([
      ['k', []],
      ['a/k', ['a/']],
      ['a/b/c', ['a/', 'a/b/']],
    ])('stores every slash-terminated prefix of %s, shortest first', async (key, expected) => {
      const { storage, collection } = setup(strategy())

      await storage.write(key, bytes('dark'))

      expect(stored(collection, key).prefixes).toEqual(expected)
    })
  })

  describe('AT-239: one $vectorSearch aggregation, pre-filtered to the storage prefix', () => {
    it('sends no filter from an unprefixed storage', async () => {
      const { storage, collection } = setup(strategy(undefined, { maxResults: 3, oversamplingFactor: 5 }))
      collection.searchResults = [{ _id: 'notes/a', data: new Binary(bytes('dark')), score: 0.9 }]

      const found = await storage.search('dark')

      expect(collection.calls.filter((call) => call.method === 'aggregate').map((call) => call.args[0])).toEqual([
        [
          {
            $vectorSearch: {
              index: DEFAULT_STORAGE_VECTOR_INDEX_NAME,
              path: 'embedding',
              queryVector: [1.01, 0.01, 0.01, 0.01],
              numCandidates: 15,
              limit: 3,
            },
          },
          { $project: { data: 1, score: { $meta: 'vectorSearchScore' } } },
        ],
      ])
      expect(found).toEqual([{ key: 'notes/a', score: 0.9, data: bytes('dark') }])
    })

    it('filters a prefixed storage on its prefix and strips it from the keys', async () => {
      const { storage, collection } = setup(strategy(), 'tenant-a')
      collection.searchResults = [{ _id: 'tenant-a/notes/a', data: new Binary(bytes('x')), score: 1 }]

      const found = await storage.search('dark')

      const pipeline = collection.calls.find((call) => call.method === 'aggregate')!.args[0] as Document[]
      expect(pipeline[0]!.$vectorSearch.filter).toEqual({ prefixes: { $eq: 'tenant-a/' } })
      expect(found).toEqual([{ key: 'notes/a', score: 1, data: bytes('x') }])
    })

    it('scores a result without a score as zero', async () => {
      const { storage, collection } = setup(strategy())
      collection.searchResults = [{ _id: 'a', data: new Binary(bytes('x')) }]

      expect(await storage.search('dark')).toEqual([{ key: 'a', score: 0, data: bytes('x') }])
    })

    it('returns the bytes of a payload decoded by another copy of bson', async () => {
      const { storage, collection } = setup(strategy())
      collection.searchResults = [{ _id: 'a', data: new OtherBinary(bytes('x')), score: 1 }]

      expect(await storage.search('dark')).toEqual([{ key: 'a', score: 1, data: bytes('x') }])
    })

    it.each(['', '   '])('embeds and sends nothing for the blank query %j', async (query) => {
      const embedder = new BagOfWordsEmbedder()
      const { storage, collection } = setup(strategy(embedder))

      expect(await storage.search(query)).toEqual([])
      expect(embedder.calls).toEqual([])
      expect(collection.namesCalled).not.toContain('aggregate')
    })
  })

  describe('AT-240: ensureIndexes provisions the vector index alongside the ordinary ones', () => {
    it("creates the strategy's vector index", async () => {
      const configured = strategy(undefined, { indexName: 'v' })
      const { storage, collection } = setup(configured)

      await storage.ensureIndexes()

      expect(collection.createdSearchIndexes).toEqual([configured.indexSpec().toDescription()])
    })
  })
})
