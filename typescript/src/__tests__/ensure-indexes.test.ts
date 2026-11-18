import { SpanStatusCode } from '@opentelemetry/api'
import { type Logger, StorageError } from '@strands-agents/sdk'
import {
  type Collection,
  type Document,
  type IndexDescription,
  MongoNetworkTimeoutError,
  type MongoServerError,
} from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeCollection } from '../__fixtures__/fake-mongo.js'
import { oneSpan, recordSpans, spansNamed } from '../__fixtures__/spans.js'
import { ensure, SearchIndexNotReady } from '../ensure-indexes.js'
import {
  dropIndexCommand,
  type IndexSpec,
  memorySearchSpecs,
  memorySpecs,
  type SearchIndexSpec,
  storageSpecs,
} from '../index-specs.js'
import type { MongoDBConfig } from '../types.js'
import { rejectionOf, serverError } from '../__fixtures__/errors.js'

const FOLDING = { locale: 'en', strength: 2 }
const POLL_INTERVAL_MS = 500
const exporter = recordSpans()

afterEach(() => vi.useRealTimers())

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function fakeCollection(name = 'memory'): FakeCollection {
  return new FakeCollection('testdb', name)
}

function driver(fake: FakeCollection): Collection {
  return fake as unknown as Collection
}

/** One entry as `listIndexes` reports it, including the `v` nobody asked for. */
function existing(name: string, keys: Array<[string, 1 | -1]>, options: Document = {}): IndexDescription {
  return { v: 2, key: Object.fromEntries(keys), name, ...options } as IndexDescription
}

function withIndexes(...indexes: IndexDescription[]): FakeCollection {
  const collection = fakeCollection()
  collection.indexes.push(...indexes)
  return collection
}

function dedupSpec(): IndexSpec {
  return memorySpecs().find((spec) => spec.options.unique === true)!
}

function vectorSpec(config: MongoDBConfig = { database: 'd' }): SearchIndexSpec {
  return memorySearchSpecs(config)[0]!
}

function textSpec(): SearchIndexSpec {
  return memorySearchSpecs({ database: 'd' })[1]!
}

function ensureOrdinary(collection: FakeCollection, ordinary: IndexSpec[], create = true): Promise<void> {
  return ensure(driver(collection), { ordinary, create, timeout: 0, logger: silentLogger() })
}

function ensureSearch(
  collection: FakeCollection,
  search: SearchIndexSpec[],
  options: { create?: boolean; timeout?: number; logger?: Logger; signal?: AbortSignal } = {}
): Promise<void> {
  const { create = true, timeout = 5, logger = silentLogger(), signal } = options
  return ensure(driver(collection), { search, create, timeout, logger, signal })
}

function userIndexes(collection: FakeCollection): IndexDescription[] {
  return collection.indexes.filter((index) => index.name !== '_id_')
}

async function polls(times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
}

describe('ensure', () => {
  describe('AT-060, AT-061, AT-063, AT-064: ordinary indexes against a fake', () => {
    it('creates a missing index when creation is allowed', async () => {
      const collection = fakeCollection()

      await ensureOrdinary(collection, storageSpecs())

      expect(userIndexes(collection)).toHaveLength(1)
    })

    it('creates every missing index in one call', async () => {
      const collection = fakeCollection()
      const created = vi.spyOn(collection, 'createIndexes')

      await ensureOrdinary(collection, memorySpecs())

      expect(created).toHaveBeenCalledOnce()
      expect(created.mock.calls[0]?.[0]).toHaveLength(3)
      expect(userIndexes(collection)).toHaveLength(3)
    })

    it('leaves an index matching on keys and options alone', async () => {
      const collection = withIndexes(
        existing('whatever_they_called_it', [['expires_at', 1]], { expireAfterSeconds: 0 })
      )

      await ensureOrdinary(collection, storageSpecs())

      expect(userIndexes(collection)).toHaveLength(1)
    })

    it('matches on the key list rather than the name', async () => {
      const collection = withIndexes(existing('legacy_ttl', [['expires_at', 1]], { expireAfterSeconds: 0 }))

      await ensureOrdinary(collection, storageSpecs())

      expect(userIndexes(collection).map((index) => index.name)).toEqual(['legacy_ttl'])
    })

    it('AT-063: refuses a matching key list that lacks the option it exists for', async () => {
      const dedup = dedupSpec()
      const collection = withIndexes(existing('theirs', dedup.keys))

      const error = await rejectionOf(ensureOrdinary(collection, [dedup]))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toMatch(/^strands_mongodb: /)
      expect(error.message).toContain('unique')
      expect(error.message).toContain("'theirs'")
      expect(error.message).toContain('testdb.memory')
      expect(error.message).toContain(dropIndexCommand('memory', 'theirs'))
      expect(error.message).toContain(dedup.creationCommand('memory'))
      expect(userIndexes(collection)).toHaveLength(1)
    })

    it('AT-064: reports a differing TTL as a mismatch naming both values', async () => {
      const collection = withIndexes(
        existing('strands_expires_at_ttl', [['expires_at', 1]], { expireAfterSeconds: 3600 })
      )

      const error = await rejectionOf(ensureOrdinary(collection, storageSpecs()))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('expireAfterSeconds')
      expect(error.message).toContain('3600')
    })

    it('reports an absent option as absent', async () => {
      const collection = withIndexes(existing('someone_elses', [['expires_at', 1]]))

      const error = await rejectionOf(ensureOrdinary(collection, storageSpecs()))

      expect(error.message).toContain('expireAfterSeconds')
      expect(error.message).toContain('absent')
    })

    it('ignores server defaults it never asked for', async () => {
      const collection = withIndexes(
        existing('theirs', [['expires_at', 1]], { expireAfterSeconds: 0, background: true, hidden: false })
      )

      await ensureOrdinary(collection, storageSpecs())

      expect(userIndexes(collection)).toHaveLength(1)
    })

    it('compares a nested partial filter expression structurally', async () => {
      const dedup = dedupSpec()
      const collection = withIndexes(
        existing('theirs', dedup.keys, { unique: true, partialFilterExpression: { content_hash: { $exists: true } } })
      )

      await ensureOrdinary(collection, [dedup])

      expect(userIndexes(collection)).toHaveLength(1)
    })

    it('AT-061: verify-only creates nothing and names every missing index with its command', async () => {
      const collection = fakeCollection()

      const error = await rejectionOf(ensureOrdinary(collection, memorySpecs(), false))

      expect(error).toBeInstanceOf(StorageError)
      expect(userIndexes(collection)).toEqual([])
      expect(error.message).toContain('ensureIndexes is false')
      expect(error.message.match(/createIndexes/g)).toHaveLength(3)
      for (const spec of memorySpecs()) expect(error.message).toContain(spec.creationCommand('memory'))
    })

    it('verify-only passes when everything is present', async () => {
      const collection = fakeCollection()
      await ensureOrdinary(collection, memorySpecs())

      await ensureOrdinary(collection, memorySpecs(), false)

      expect(userIndexes(collection)).toHaveLength(3)
    })

    it('surfaces an unexpected driver error as a StorageError with the cause chained', async () => {
      const collection = fakeCollection()
      const thrown = serverError(13, 'not authorized')
      vi.spyOn(collection, 'createIndexes').mockRejectedValue(thrown)

      const error = await rejectionOf(ensureOrdinary(collection, storageSpecs()))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.cause).toBe(thrown)
      expect(error.message).toContain('creating indexes on testdb.memory failed')
      expect(error.message).toContain('not authorized')
    })

    it('reads a collection that does not exist yet (code 26) as having no indexes', async () => {
      const collection = fakeCollection()
      vi.spyOn(collection, 'listIndexes').mockReturnValue({
        toArray: () => Promise.reject(serverError(26, 'ns does not exist: testdb.memory')),
      })

      const error = await rejectionOf(ensureOrdinary(collection, storageSpecs(), false))

      expect(error.message).toContain(storageSpecs()[0]!.creationCommand('memory'))
    })

    it('surfaces a failed index read that is not code 26', async () => {
      const collection = fakeCollection()
      const thrown = serverError(13, 'not authorized')
      vi.spyOn(collection, 'listIndexes').mockReturnValue({ toArray: () => Promise.reject(thrown) })

      const error = await rejectionOf(ensureOrdinary(collection, storageSpecs()))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('reading indexes on testdb.memory failed')
      expect(error.cause).toBe(thrown)
    })

    it('reads nothing when there is nothing to ensure', async () => {
      const collection = fakeCollection()
      const read = vi.spyOn(collection, 'listIndexes')

      await ensure(driver(collection), { create: true, timeout: 0, logger: silentLogger() })

      expect(read).not.toHaveBeenCalled()
    })

    it('logs the creation with the event and the namespace', async () => {
      const collection = fakeCollection()
      const logger = silentLogger()

      await ensure(driver(collection), { ordinary: storageSpecs(), create: true, timeout: 0, logger })

      expect(logger.info).toHaveBeenCalledExactlyOnceWith(
        'strands_mongodb: creating 1 index(es) on testdb.memory: strands_expires_at_ttl | event=creating_indexes, namespace=testdb.memory'
      )
    })
  })

  describe('AT-193: a matched index whose collation folds case is refused', () => {
    function matched(collation?: Document): FakeCollection {
      const dedup = dedupSpec()
      return withIndexes(existing('theirs', dedup.keys, { ...dedup.options, ...(collation && { collation }) }))
    }

    it('refuses an index reporting a folding collation, naming the locale, the index and the remedy', async () => {
      const collection = matched(FOLDING)

      const error = await rejectionOf(ensureOrdinary(collection, [dedupSpec()]))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('collation')
      expect(error.message).toContain("'en'")
      expect(error.message).toContain("'theirs'")
      expect(error.message).toContain(dropIndexCommand('memory', 'theirs'))
      expect(userIndexes(collection)).toHaveLength(1)
    })

    it('accepts an index reporting a simple collation', async () => {
      await expect(ensureOrdinary(matched({ locale: 'simple' }), [dedupSpec()])).resolves.toBeUndefined()
    })

    it('accepts an index reporting no collation at all', async () => {
      await expect(ensureOrdinary(matched(), [dedupSpec()])).resolves.toBeUndefined()
    })
  })

  describe('AT-196: a folded constraint behind a correct index is still refused', () => {
    function both(foldingFirst: boolean): FakeCollection {
      const dedup = dedupSpec()
      const ours = existing(dedup.name, dedup.keys, dedup.options)
      const theirs = existing('folding_unique', dedup.keys, { ...dedup.options, collation: FOLDING })
      return withIndexes(...(foldingFirst ? [theirs, ours] : [ours, theirs]))
    }

    it.each([true, false])(
      'refuses the deployment whichever index was created first (folding first: %s)',
      async (first) => {
        const collection = both(first)

        const error = await rejectionOf(ensureOrdinary(collection, [dedupSpec()]))

        expect(error.message).toContain("'folding_unique'")
        expect(error.message).toContain("'en'")
        expect(error.message).toContain(dropIndexCommand('memory', 'folding_unique'))
        expect(userIndexes(collection)).toHaveLength(2)
      }
    )

    it('accepts a second binary index over the same keys', async () => {
      const dedup = dedupSpec()
      const collection = withIndexes(
        existing(dedup.name, dedup.keys, dedup.options),
        existing('theirs', dedup.keys, dedup.options)
      )

      await expect(ensureOrdinary(collection, [dedup])).resolves.toBeUndefined()
    })

    it('accepts a folding index enforcing nothing beside a correct one', async () => {
      const dedup = dedupSpec()
      const collection = withIndexes(
        existing(dedup.name, dedup.keys, dedup.options),
        existing('theirs', dedup.keys, { collation: FOLDING })
      )

      await expect(ensureOrdinary(collection, [dedup])).resolves.toBeUndefined()
    })

    it('still refuses a folding index enforcing nothing when it is alone', async () => {
      const dedup = dedupSpec()
      const collection = withIndexes(existing('theirs', dedup.keys, { collation: FOLDING }))

      await expect(ensureOrdinary(collection, [dedup])).rejects.toBeInstanceOf(StorageError)
    })
  })

  describe('AT-197: a date-only index is not held to a string rule', () => {
    it('accepts a collated TTL index', async () => {
      const spec = storageSpecs()[0]!
      const collection = withIndexes(existing(spec.name, spec.keys, { ...spec.options, collation: FOLDING }))

      await ensureOrdinary(collection, [spec])

      expect(userIndexes(collection)).toHaveLength(1)
    })

    it('accepts the whole memory index set over a collated TTL index', async () => {
      const specs = memorySpecs()
      const collection = withIndexes(
        ...specs.map((spec) =>
          existing(spec.name, spec.keys, { ...spec.options, ...(spec.dateOnly && { collation: FOLDING }) })
        )
      )

      await ensureOrdinary(collection, specs)

      expect(userIndexes(collection)).toHaveLength(specs.length)
    })

    it.each(['strands_scope_store_created_at', 'strands_scope_store_content_hash_unique'])(
      'does not exempt %s',
      async (name) => {
        const spec = memorySpecs().find((candidate) => candidate.name === name)!
        const collection = withIndexes(existing(spec.name, spec.keys, { ...spec.options, collation: FOLDING }))

        expect(spec.dateOnly).toBe(false)
        await expect(ensureOrdinary(collection, [spec])).rejects.toBeInstanceOf(StorageError)
      }
    )
  })

  describe('AT-062, AT-068, AT-069: search indexes against a fake', () => {
    it('creates a missing index after the collection, then reads it READY', async () => {
      const collection = fakeCollection()

      await ensureSearch(collection, [vectorSpec()])

      expect(collection.createdSearchIndexes).toHaveLength(1)
      expect(collection.db.createCollectionCalls).toEqual(['memory'])
    })

    it('logs each search index it creates', async () => {
      const collection = fakeCollection()
      const logger = silentLogger()

      await ensureSearch(collection, [vectorSpec()], { logger })

      expect(logger.info).toHaveBeenCalledWith(
        "strands_mongodb: creating vectorSearch index 'vector_index' on testdb.memory | event=creating_search_index, namespace=testdb.memory"
      )
    })

    it('tolerates a collection that already exists (code 48)', async () => {
      const collection = fakeCollection()
      collection.exists = true
      collection.db.createCollectionError = serverError(48, 'NamespaceExists')

      await ensureSearch(collection, [vectorSpec()])

      expect(collection.createdSearchIndexes).toHaveLength(1)
    })

    it('surfaces a collection creation failure that is not code 48', async () => {
      const collection = fakeCollection()
      collection.db.createCollectionError = serverError(13, 'not authorized')

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()]))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('creating the collection testdb.memory failed')
      expect(collection.createdSearchIndexes).toEqual([])
    })

    it('surfaces a collection creation that never reached the server', async () => {
      const collection = fakeCollection()
      collection.db.createCollectionError = new MongoNetworkTimeoutError('socket timed out')

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()]))

      expect(error.message).toContain('creating the collection')
      expect((error.cause as Error).message).toBe('socket timed out')
    })

    it('leaves a READY index alone and does not touch the collection', async () => {
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription())

      await ensureSearch(collection, [vectorSpec()])

      expect(collection.createdSearchIndexes).toEqual([])
      expect(collection.db.createCollectionCalls).toEqual([])
    })

    it.each(['PENDING', 'BUILDING', 'STAGED', 'SOMETHING_NEW'])('waits out %s as building', async (status) => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), status)

      const pending = ensureSearch(collection, [vectorSpec()])
      await polls(1)
      collection.setSearchIndexStatus('vector_index', 'READY')
      await polls(1)
      await pending

      expect(collection.createdSearchIndexes).toEqual([])
    })

    it('reports a FAILED build with its detail and the remedy', async () => {
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), 'FAILED')
      collection.searchIndexes.get('vector_index')!.statusDetail = [
        { hostname: 'mongot-0', mainIndex: { message: 'oom' } },
      ]

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()]))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('FAILED')
      expect(error.message).toContain('oom')
      expect(error.message).toContain(vectorSpec().dropCommand('memory'))
      expect(error.message).toContain(vectorSpec().creationCommand('memory'))
      expect(spansNamed(exporter, 'strands_mongodb.indexes.wait')).toEqual([])
    })

    it('raises on a build that fails partway through and marks the wait span as an error', async () => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), 'BUILDING')

      const pending = rejectionOf(ensureSearch(collection, [vectorSpec()], { create: false }))
      await polls(1)
      collection.setSearchIndexStatus('vector_index', 'FAILED')
      collection.searchIndexes.get('vector_index')!.statusDetail = [{ mainIndex: { message: 'disk full' } }]
      await polls(1)
      const error = await pending

      expect(error.message).toContain('disk full')
      const wait = oneSpan(exporter, 'strands_mongodb.indexes.wait')
      expect(wait.status.code).toBe(SpanStatusCode.ERROR)
      expect(wait.attributes).not.toHaveProperty('strands_mongodb.indexes.outcome')
      expect(oneSpan(exporter, 'strands_mongodb.indexes.ensure').status.code).toBe(SpanStatusCode.ERROR)
    })

    it('waits for an index dropped mid-build rather than recreating it', async () => {
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), 'BUILDING')
      const read = collection.listSearchIndexes.bind(collection)
      let reads = 0
      vi.spyOn(collection, 'listSearchIndexes').mockImplementation((name) => {
        reads += 1
        if (reads === 2) collection.setSearchIndexStatus('vector_index', undefined)
        return read(name)
      })

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()], { create: false, timeout: 0 }))

      expect(error).toBeInstanceOf(SearchIndexNotReady)
      expect(error.message).toContain('vector_index is absent')
      expect(collection.createdSearchIndexes).toEqual([])
    })

    it('AT-209: times out naming the last status, with the wait span timed_out and the ensure span in error', async () => {
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), 'BUILDING')

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()], { timeout: 0 }))

      expect(error).toBeInstanceOf(SearchIndexNotReady)
      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('waited 0s for 1 search index(es) on testdb.memory')
      expect(error.message).toContain('vector_index is BUILDING')
      const wait = oneSpan(exporter, 'strands_mongodb.indexes.wait')
      expect(wait.attributes['strands_mongodb.indexes.outcome']).toBe('timed_out')
      expect(wait.status.code).toBe(SpanStatusCode.UNSET)
      expect(oneSpan(exporter, 'strands_mongodb.indexes.ensure').status.code).toBe(SpanStatusCode.ERROR)
    })

    it('reports a present index with a different definition and creates nothing', async () => {
      const collection = fakeCollection()
      collection.addSearchIndex({
        ...vectorSpec().toDescription(),
        definition: { fields: [{ type: 'vector', path: 'other' }] },
      })

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()]))

      expect(error.message).toContain('does not cover')
      expect(error.message).toContain(vectorSpec().dropCommand('memory'))
      expect(error.message).toContain(vectorSpec().creationCommand('memory'))
      expect(collection.createdSearchIndexes).toEqual([])
    })

    it('matches an identical definition reported back by the server', async () => {
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription())

      await ensureSearch(collection, [vectorSpec()])

      expect(collection.createdSearchIndexes).toEqual([])
    })

    it('AT-069: matches the definition mongot rewrites for a text index', async () => {
      const collection = fakeCollection()
      collection.addSearchIndex({
        ...textSpec().toDescription(),
        definition: {
          mappings: {
            dynamic: false,
            fields: { content: { type: 'string', indexOptions: 'offsets', store: true, norms: 'include' } },
          },
        },
      })

      await ensureSearch(collection, [textSpec()])

      expect(collection.createdSearchIndexes).toEqual([])
    })

    it.each([
      [
        'a text index mapped over a different field',
        textSpec(),
        { mappings: { dynamic: false, fields: { text: { type: 'string' } } } },
        'content',
      ],
      [
        'a vector index with the wrong dimension count',
        vectorSpec({ database: 'd', embeddingDimensions: 1024, similarity: 'cosine' }),
        {
          fields: [
            { type: 'vector', path: 'embedding', numDimensions: 1536, similarity: 'cosine' },
            { type: 'filter', path: 'scope' },
            { type: 'filter', path: 'store_name' },
          ],
        },
        'numDimensions',
      ],
      [
        'a missing filter path',
        vectorSpec(),
        { fields: [vectorSpec().definition.fields[0], { type: 'filter', path: 'scope' }] },
        'store_name',
      ],
      [
        'dynamic mapping turned on',
        textSpec(),
        { mappings: { dynamic: true, fields: { content: { type: 'string' } } } },
        'dynamic',
      ],
      ['an object reported where one was declared', textSpec(), { mappings: 'dynamic' }, 'definition.mappings'],
      ['a list reported as a scalar', vectorSpec(), { fields: 'everything' }, 'definition.fields'],
    ] as const)('reports %s as a mismatch', async (_case, spec, reported, marker) => {
      const collection = fakeCollection()
      collection.addSearchIndex({ ...spec.toDescription(), definition: reported as Document })

      const error = await rejectionOf(ensureSearch(collection, [spec]))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain(marker)
      expect(error.message).toContain(spec.dropCommand('memory'))
    })

    it('accepts fields the server or another tool added', async () => {
      const collection = fakeCollection()
      collection.addSearchIndex({
        ...vectorSpec().toDescription(),
        definition: { fields: [...vectorSpec().definition.fields, { type: 'filter', path: 'their_own_field' }] },
      })

      await ensureSearch(collection, [vectorSpec()])

      expect(collection.createdSearchIndexes).toEqual([])
    })

    it('verify-only raises with the search creation command and leaves the collection alone', async () => {
      const collection = fakeCollection()

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()], { create: false }))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('ensureIndexes is false')
      expect(error.message).toContain(vectorSpec().creationCommand('memory'))
      expect(collection.createdSearchIndexes).toEqual([])
      expect(collection.db.createCollectionCalls).toEqual([])
    })

    it('verify-only still waits for a build somebody else started', async () => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), 'BUILDING')

      const pending = ensureSearch(collection, [vectorSpec()], { create: false })
      await polls(2)
      collection.setSearchIndexStatus('vector_index', 'READY')
      await polls(1)
      await pending

      expect(collection.createdSearchIndexes).toEqual([])
    })

    it('AT-125: polls every half second', async () => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), 'BUILDING')

      const pending = ensureSearch(collection, [vectorSpec()], { create: false })
      await vi.advanceTimersByTimeAsync(499)
      expect(collection.searchIndexReads).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(collection.searchIndexReads).toBe(3)

      collection.setSearchIndexStatus('vector_index', 'READY')
      await polls(1)
      await pending
    })

    it('reads a missing collection (code 26) as no index and goes on to create it', async () => {
      const collection = fakeCollection()
      collection.failListSearchIndexes(serverError(26, 'ns does not exist: testdb.memory'))

      await ensureSearch(collection, [vectorSpec()])

      expect(collection.createdSearchIndexes).toHaveLength(1)
    })

    it('surfaces a read that fails for any other reason, naming the index', async () => {
      const collection = fakeCollection()
      collection.failListSearchIndexes(serverError(13, 'not authorized'))

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()]))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain("reading search index 'vector_index' on testdb.memory failed")
      expect(collection.createdSearchIndexes).toEqual([])
    })

    it('surfaces a read that never reached the server with the cause chained', async () => {
      const collection = fakeCollection()
      collection.failListSearchIndexes(new MongoNetworkTimeoutError('socket timed out'))

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()]))

      expect(error).toBeInstanceOf(StorageError)
      expect((error.cause as Error).message).toBe('socket timed out')
    })

    it('logs a status when it changes and not on every poll', async () => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      const logger = silentLogger()
      collection.addSearchIndex(vectorSpec().toDescription(), 'BUILDING')

      const pending = ensureSearch(collection, [vectorSpec()], { create: false, logger })
      await polls(2)
      collection.setSearchIndexStatus('vector_index', 'READY')
      await polls(1)
      await pending

      const lines = vi.mocked(logger.info).mock.calls.map((call) => String(call[0]))
      expect(lines.filter((line) => line.includes('is BUILDING'))).toEqual([
        "strands_mongodb: search index 'vector_index' on testdb.memory is BUILDING | event=search_index_status, namespace=testdb.memory",
      ])
      expect(lines.filter((line) => line.includes('is READY'))).toHaveLength(1)
    })
  })

  describe('AT-180: readiness is about the definition and not only the status', () => {
    const DRIFTED = {
      fields: [{ type: 'autoEmbed', path: 'content', model: 'voyage-3-lite', modality: 'text' }],
    }

    function building(): FakeCollection {
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), 'BUILDING')
      return collection
    }

    function drift(collection: FakeCollection, name = 'vector_index'): void {
      collection.searchIndexes.get(name)!.latestDefinition = DRIFTED
      collection.setSearchIndexStatus(name, 'READY')
    }

    it('refuses a definition that drifts during the build, with the cold-path remedy', async () => {
      vi.useFakeTimers()
      const collection = building()

      const pending = rejectionOf(ensureSearch(collection, [vectorSpec()], { create: false }))
      await polls(1)
      drift(collection)
      await polls(1)
      const error = await pending

      expect(error.message).toContain('voyage-4-lite')
      expect(error.message).toContain('does not cover')
      expect(error.message).toContain(vectorSpec().dropCommand('memory'))
      expect(error.message).toContain(vectorSpec().creationCommand('memory'))
    })

    it('checks an index this package created against what the server built', async () => {
      const collection = fakeCollection()
      vi.spyOn(collection, 'createSearchIndex').mockImplementation(async (description) => {
        collection.createdSearchIndexes.push(description)
        collection.addSearchIndex({ ...description, definition: DRIFTED })
        return description.name ?? ''
      })

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()]))

      expect(error.message).toContain('does not cover')
      expect(collection.createdSearchIndexes).toHaveLength(1)
    })

    it('reports a name another creator took between the read and the create, with the refusal as the cause', async () => {
      const collection = fakeCollection()
      vi.spyOn(collection.db, 'createCollection').mockImplementation(async () => {
        collection.exists = true
        collection.addSearchIndex({ ...vectorSpec().toDescription(), definition: DRIFTED })
      })

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()]))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('testdb.memory')
      expect((error.cause as MongoServerError).code).toBe(68)
    })

    it('accepts a build whose definition still covers, reading nothing the poll was not already reading', async () => {
      const collection = building()
      const read = collection.listSearchIndexes.bind(collection)
      vi.spyOn(collection, 'listSearchIndexes').mockImplementation((name) => {
        if (collection.searchIndexReads === 1) collection.setSearchIndexStatus('vector_index', 'READY')
        return read(name)
      })

      await ensureSearch(collection, [vectorSpec()], { create: false })

      // The cold read found BUILDING and the first poll found READY: no extra read for the recheck.
      expect(collection.searchIndexReads).toBe(2)
    })

    it('does not treat a report without a definition as a gap', async () => {
      vi.useFakeTimers()
      const collection = building()
      delete collection.searchIndexes.get('vector_index')!.latestDefinition

      const pending = ensureSearch(collection, [vectorSpec()], { create: false })
      await polls(1)
      collection.setSearchIndexStatus('vector_index', 'READY')
      await polls(1)
      await expect(pending).resolves.toBeUndefined()
    })

    it('names the drifted index beside a clean one', async () => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription())
      collection.addSearchIndex(textSpec().toDescription(), 'BUILDING')

      const pending = rejectionOf(ensureSearch(collection, [vectorSpec(), textSpec()], { create: false }))
      await polls(1)
      collection.searchIndexes.get('text_index')!.latestDefinition = { mappings: { dynamic: true } }
      collection.setSearchIndexStatus('text_index', 'READY')
      await polls(1)
      const error = await pending

      expect(error.message).toContain('text_index')
      expect(error.message).not.toContain('vector_index')
    })
  })

  describe('AT-204: ensure and wait spans', () => {
    it('records its mode and how many it created, under the namespace', async () => {
      const collection = fakeCollection()

      await ensureOrdinary(collection, storageSpecs())
      await ensureOrdinary(collection, storageSpecs(), false)

      const [created, verified] = spansNamed(exporter, 'strands_mongodb.indexes.ensure')
      expect(created?.attributes).toEqual({
        'strands_mongodb.database': 'testdb',
        'strands_mongodb.collection': 'memory',
        'strands_mongodb.indexes.mode': 'ensure',
        'strands_mongodb.indexes.created': 1,
      })
      expect(verified?.attributes).toMatchObject({
        'strands_mongodb.indexes.mode': 'verify',
        'strands_mongodb.indexes.created': 0,
      })
    })

    it('waits in one span per index however many polls it takes', async () => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), 'BUILDING')

      const pending = ensureSearch(collection, [vectorSpec()], { create: false })
      await polls(3)
      collection.setSearchIndexStatus('vector_index', 'READY')
      await polls(1)
      await pending

      const wait = oneSpan(exporter, 'strands_mongodb.indexes.wait')
      expect(wait.attributes).toEqual({
        'strands_mongodb.database': 'testdb',
        'strands_mongodb.collection': 'memory',
        'strands_mongodb.indexes.outcome': 'ready',
      })
      expect(wait.status.code).toBe(SpanStatusCode.UNSET)
      expect(wait.parentSpanContext?.spanId).toBe(
        oneSpan(exporter, 'strands_mongodb.indexes.ensure').spanContext().spanId
      )
    })

    it('AT-209: times out two indexes under one deadline, naming both, with both wait spans timed_out', async () => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), 'BUILDING')
      collection.addSearchIndex(textSpec().toDescription(), 'PENDING')

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec(), textSpec()], { timeout: 0 }))

      expect(error).toBeInstanceOf(SearchIndexNotReady)
      expect(error.message).toContain('2 search index(es)')
      expect(error.message).toContain('vector_index is BUILDING')
      expect(error.message).toContain('text_index is PENDING')
      // Each index was read on the cold pass and once more in the single poll round.
      expect(collection.searchIndexReads).toBe(4)
      const waits = spansNamed(exporter, 'strands_mongodb.indexes.wait')
      expect(waits.map((wait) => wait.attributes['strands_mongodb.indexes.outcome'])).toEqual([
        'timed_out',
        'timed_out',
      ])
      expect(waits.map((wait) => wait.status.code)).toEqual([SpanStatusCode.UNSET, SpanStatusCode.UNSET])
      expect(oneSpan(exporter, 'strands_mongodb.indexes.ensure').status.code).toBe(SpanStatusCode.ERROR)
    })

    it('surfaces a sibling that fails on the first poll within one round, abandoning the other without an outcome', async () => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      collection.addSearchIndex(vectorSpec().toDescription(), 'BUILDING')
      collection.addSearchIndex(textSpec().toDescription(), 'BUILDING')
      const read = collection.listSearchIndexes.bind(collection)
      vi.spyOn(collection, 'listSearchIndexes').mockImplementation((name) => {
        // Two cold reads, then the first poll round: the text index fails on its first polled read.
        if (collection.searchIndexReads === 3) collection.setSearchIndexStatus('text_index', 'FAILED')
        return read(name)
      })

      // Awaited without advancing the fake clock: a wait that only noticed after the deadline would hang here.
      const error = await rejectionOf(ensureSearch(collection, [vectorSpec(), textSpec()], { timeout: 300 }))

      expect(error).not.toBeInstanceOf(SearchIndexNotReady)
      expect(error.message).toContain("'text_index'")
      expect(error.message).toContain('FAILED')
      const waits = spansNamed(exporter, 'strands_mongodb.indexes.wait')
      expect(waits).toHaveLength(2)
      const failed = waits.filter((wait) => wait.status.code === SpanStatusCode.ERROR)
      const abandoned = waits.filter((wait) => wait.status.code === SpanStatusCode.UNSET)
      expect(failed).toHaveLength(1)
      expect(abandoned).toHaveLength(1)
      // The vector index was abandoned because its sibling failed, so its span ends with no outcome at all.
      expect(abandoned[0]?.attributes).not.toHaveProperty('strands_mongodb.indexes.outcome')
      expect(oneSpan(exporter, 'strands_mongodb.indexes.ensure').status.code).toBe(SpanStatusCode.ERROR)
    })

    it('stops reading within one round when the caller aborts, ending the wait span with no outcome', async () => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      collection.addSearchIndex(textSpec().toDescription(), 'PENDING')
      const losers = new AbortController()
      const settled = rejectionOf(ensureSearch(collection, [textSpec()], { timeout: 60, signal: losers.signal }))
      await polls(1)
      const reads = collection.searchIndexReads
      expect(reads).toBeGreaterThan(1)

      const reason = new Error('another tier came up first')
      losers.abort(reason)
      const error = await settled
      await polls(10)

      expect(error).toBeInstanceOf(StorageError)
      expect(error).not.toBeInstanceOf(SearchIndexNotReady)
      expect(error.message).toContain('abandoned')
      expect(error.message).toContain('text_index')
      expect(error.cause).toBe(reason)
      expect(collection.searchIndexReads).toBe(reads)
      const wait = oneSpan(exporter, 'strands_mongodb.indexes.wait')
      expect(wait.status.code).toBe(SpanStatusCode.UNSET)
      expect(wait.attributes).not.toHaveProperty('strands_mongodb.indexes.outcome')
      const ensured = oneSpan(exporter, 'strands_mongodb.indexes.ensure')
      expect(ensured.status.code).toBe(SpanStatusCode.UNSET)
      expect(ensured.attributes['strands_mongodb.indexes.outcome']).toBe('abandoned')
      expect(ensured.attributes).not.toHaveProperty('error.type')
    })

    it('does not add a round for an abort that lands while a read is in flight', async () => {
      vi.useFakeTimers()
      const collection = fakeCollection()
      collection.addSearchIndex(textSpec().toDescription(), 'PENDING')
      const losers = new AbortController()
      const read = collection.listSearchIndexes.bind(collection)
      vi.spyOn(collection, 'listSearchIndexes').mockImplementation((name) => {
        // The cold read, then the first polled one, which the abort lands during.
        if (collection.searchIndexReads === 1) losers.abort()
        return read(name)
      })
      let settled = false
      const pending = rejectionOf(ensureSearch(collection, [textSpec()], { timeout: 60, signal: losers.signal }))
      void pending.finally(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1)

      expect(settled).toBe(true)
      expect((await pending).message).toContain('abandoned')
      expect(collection.searchIndexReads).toBe(2)
    })

    it('neither reads nor creates a search index for a signal that is already aborted', async () => {
      const collection = fakeCollection()

      const error = await rejectionOf(
        ensureSearch(collection, [textSpec()], { timeout: 60, signal: AbortSignal.abort() })
      )

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('text_index')
      expect(collection.searchIndexReads).toBe(0)
      expect(collection.createdSearchIndexes).toEqual([])
      expect(spansNamed(exporter, 'strands_mongodb.indexes.wait')).toEqual([])
      expect(oneSpan(exporter, 'strands_mongodb.indexes.ensure').attributes['strands_mongodb.indexes.outcome']).toBe(
        'abandoned'
      )
    })

    it('counts an index it created before the wait for it timed out', async () => {
      const collection = fakeCollection()
      vi.spyOn(collection, 'createSearchIndex').mockImplementation(async (description) => {
        collection.addSearchIndex(description, 'BUILDING')
        return description.name ?? ''
      })

      const error = await rejectionOf(ensureSearch(collection, [vectorSpec()], { timeout: 0 }))

      expect(error).toBeInstanceOf(SearchIndexNotReady)
      expect(oneSpan(exporter, 'strands_mongodb.indexes.ensure').attributes['strands_mongodb.indexes.created']).toBe(1)
    })

    it('marks a failing ensure as an error carrying the count so far', async () => {
      const collection = fakeCollection()
      collection.addSearchIndex(textSpec().toDescription(), 'FAILED')

      await rejectionOf(ensureSearch(collection, [vectorSpec(), textSpec()]))

      const span = oneSpan(exporter, 'strands_mongodb.indexes.ensure')
      expect(span.status.code).toBe(SpanStatusCode.ERROR)
      expect(span.attributes['strands_mongodb.indexes.created']).toBe(0)
    })
  })
})
