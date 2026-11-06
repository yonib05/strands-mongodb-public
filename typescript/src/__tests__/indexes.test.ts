import { SpanStatusCode } from '@opentelemetry/api'
import { type Logger, StorageError } from '@strands-agents/sdk'
import type { Embedder } from '@strands-agents/sdk/storage/search'
import { type Collection, type Document, type IndexDescription, MongoServerError } from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import commands from '../__fixtures__/commands.json' with { type: 'json' }
import { FakeCollection } from '../__fixtures__/fake-mongo.js'
import specFixtures from '../__fixtures__/index-specs.json' with { type: 'json' }
import { oneSpan, recordSpans, spansNamed } from '../__fixtures__/spans.js'
import { BAKED_IN_FILTER_FIELDS } from '../filter.js'
import {
  checkTtl,
  declaredFilterFields,
  DEFAULT_EMBEDDING_MODEL,
  dropIndexCommand,
  embed,
  ensure,
  type IndexSpec,
  memorySearchSpecs,
  memorySpecs,
  POLL_INTERVAL_SECONDS,
  rankFusionSupport,
  readCollation,
  readiness,
  READY_TIMEOUT_SECONDS,
  requireBinaryComparison,
  SearchIndexNotReady,
  SearchIndexSpec,
  searchSupport,
  storageSpecs,
  textIndexDefinition,
  vectorIndexDefinition,
  vectorMode,
} from '../indexes.js'
import type { MongoDBConfig, VectorMode, VectorSimilarity } from '../types.js'

const MEMORY_ROWS = ['3', '4', '7']
const FOLDING = { locale: 'en', strength: 2 }
const exporter = recordSpans()

afterEach(() => vi.useRealTimers())

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** A server error carrying a code, as the driver raises one. */
function serverError(code: number, message = 'probed'): MongoServerError {
  return new MongoServerError({ message, code })
}

function fakeCollection(name = 'memory'): FakeCollection {
  return new FakeCollection('testdb', name)
}

function driver(fake: FakeCollection): Collection {
  return fake as unknown as Collection
}

async function rejectionOf(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
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
  for (let i = 0; i < times; i += 1) await vi.advanceTimersByTimeAsync(POLL_INTERVAL_SECONDS * 1000)
}

function errorOf(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected an error')
}

function filterPaths(definition: Document): string[] {
  return (definition.fields as Document[]).filter((field) => field.type === 'filter').map((field) => field.path)
}

function byKeys(...keys: Array<[string, 1 | -1]>): IndexSpec {
  const spec = memorySpecs().find((candidate) => JSON.stringify(candidate.keys) === JSON.stringify(keys))
  if (spec === undefined) throw new Error(`no memory index declared over ${JSON.stringify(keys)}`)
  return spec
}

function commandBody(command: string): Document {
  const body = /^db\.runCommand\((.*)\)$/s.exec(command)
  if (body?.[1] === undefined) throw new Error(command)
  return JSON.parse(body[1]) as Document
}

function expectEquivalent(actual: string | undefined, fixture: string): void {
  expect(actual?.startsWith('db.runCommand(')).toBe(true)
  expect(actual?.endsWith(')')).toBe(true)
  expect(commandBody(actual ?? '')).toEqual(commandBody(fixture))
}

function fixtureMode(mode: {
  autoEmbed: boolean
  model: string | null
  dimensions: number | null
  similarity: string | null
}): VectorMode {
  return mode.autoEmbed
    ? { autoEmbed: true, model: mode.model ?? '' }
    : { autoEmbed: false, dimensions: mode.dimensions ?? 0, similarity: mode.similarity as VectorSimilarity }
}

function fixtureConfig(config: Record<string, unknown>): MongoDBConfig {
  return {
    database: config.database as string,
    connectionString: config.connection_string as string,
    ...(config.embedding_model !== undefined && { embeddingModel: config.embedding_model as string }),
    ...(config.embedding_dimensions !== undefined && { embeddingDimensions: config.embedding_dimensions as number }),
    ...(config.similarity !== undefined && { similarity: config.similarity as VectorSimilarity }),
    ...(config.filter_fields !== undefined && { filterFields: config.filter_fields as string[] }),
  }
}

describe('indexes', () => {
  describe('AT-067 vectorMode', () => {
    it('resolves an empty config to AutoEmbeddings with the documented default', () => {
      expect(vectorMode({ database: 'd' })).toEqual({ autoEmbed: true, model: DEFAULT_EMBEDDING_MODEL })
    })

    it('defaults to the model the community package ships', () => {
      expect(DEFAULT_EMBEDDING_MODEL).toBe('voyage-4-lite')
    })

    it('selects AutoEmbeddings with an explicit model', () => {
      expect(vectorMode({ database: 'd', embeddingModel: 'voyage-3-large' })).toEqual({
        autoEmbed: true,
        model: 'voyage-3-large',
      })
    })

    it('selects the manual path from dimensions and similarity', () => {
      expect(vectorMode({ database: 'd', embeddingDimensions: 1024, similarity: 'cosine' })).toEqual({
        autoEmbed: false,
        dimensions: 1024,
        similarity: 'cosine',
      })
    })

    it('rejects dimensions without similarity and names the missing key', () => {
      const error = errorOf(() => vectorMode({ database: 'd', embeddingDimensions: 1024 }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toMatch(/^strands_mongodb: /)
      expect(error.message).toContain("'similarity'")
    })

    it('rejects similarity without dimensions', () => {
      const error = errorOf(() => vectorMode({ database: 'd', similarity: 'cosine' }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'embeddingDimensions'")
    })

    it('rejects both paths rather than picking one', () => {
      const error = errorOf(() =>
        vectorMode({ database: 'd', embeddingModel: 'voyage-3-large', embeddingDimensions: 1024, similarity: 'cosine' })
      )

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain('embeddingModel')
      expect(error.message).toContain('embeddingDimensions')
      expect(error.message).toContain('similarity')
    })

    it('names only the manual key that is actually set when both paths are selected', () => {
      const error = errorOf(() => vectorMode({ database: 'd', embeddingModel: 'm', similarity: 'cosine' }))

      expect(error.message).toContain('similarity')
      expect(error.message).not.toContain('embeddingDimensions')
    })

    it.each(['cosine', 'dotProduct', 'euclidean'] as const)(
      'accepts the similarity Atlas accepts: %s',
      (similarity) => {
        expect(vectorMode({ database: 'd', embeddingDimensions: 8, similarity })).toMatchObject({ similarity })
      }
    )

    it('rejects an unknown similarity here rather than at the server', () => {
      const config = { database: 'd', embeddingDimensions: 8, similarity: 'l2' } as unknown as MongoDBConfig
      const error = errorOf(() => vectorMode(config))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'l2'")
      expect(error.message).toContain('cosine')
    })

    it.each([0, -1, 8193])('rejects dimensions outside the Atlas bounds: %d', (dimensions) => {
      const error = errorOf(() => vectorMode({ database: 'd', embeddingDimensions: dimensions, similarity: 'cosine' }))

      expect(error).toBeInstanceOf(RangeError)
      expect(error.message).toContain('[1..8192]')
      expect(error.message).toContain(String(dimensions))
    })
  })

  describe('checkTtl', () => {
    it.each([undefined, 0, 60])('accepts %s', (ttlSeconds) => {
      expect(() => checkTtl(ttlSeconds)).not.toThrow()
    })

    it('rejects a negative lifetime and names the key', () => {
      const error = errorOf(() => checkTtl(-1))

      expect(error).toBeInstanceOf(RangeError)
      expect(error.message).toMatch(/^strands_mongodb: 'ttlSeconds' is -1/)
    })
  })

  describe('AT-071 vectorIndexDefinition', () => {
    it('matches the confirmed AutoEmbeddings wire shape', () => {
      const definition = vectorIndexDefinition(vectorMode({ database: 'd' }))

      expect(definition.fields[0]).toEqual({
        type: 'autoEmbed',
        path: 'content',
        model: 'voyage-4-lite',
        modality: 'text',
      })
    })

    it('carries dimensions and similarity on the manual path', () => {
      const definition = vectorIndexDefinition(
        vectorMode({ database: 'd', embeddingDimensions: 4, similarity: 'euclidean' }),
        { vectorField: 'embedding' }
      )

      expect(definition.fields[0]).toEqual({
        type: 'vector',
        path: 'embedding',
        numDimensions: 4,
        similarity: 'euclidean',
      })
    })

    it('honours custom text and vector fields', () => {
      expect(vectorIndexDefinition(vectorMode({ database: 'd' }), { textField: 'body' }).fields[0].path).toBe('body')
      expect(
        vectorIndexDefinition({ autoEmbed: false, dimensions: 2, similarity: 'cosine' }, { vectorField: 'v' }).fields[0]
          .path
      ).toBe('v')
    })

    it('never emits the placeholder dimension count', () => {
      for (const config of [{ database: 'd' }, { database: 'd', embeddingModel: 'm' }]) {
        const definition = vectorIndexDefinition(vectorMode(config))

        expect((definition.fields as Document[]).every((field) => field.numDimensions !== -1)).toBe(true)
      }
    })

    it('always declares scope and store_name filterable', () => {
      expect(filterPaths(vectorIndexDefinition(vectorMode({ database: 'd' })))).toEqual(['scope', 'store_name'])
    })

    it('appends caller filter fields after the baked-in two', () => {
      const definition = vectorIndexDefinition(vectorMode({ database: 'd' }), {
        filterFields: ['metadata.tier', 'owner'],
      })

      expect(filterPaths(definition)).toEqual(['scope', 'store_name', 'metadata.tier', 'owner'])
    })

    it('declares a caller field that duplicates a baked-in one once', () => {
      const definition = vectorIndexDefinition(vectorMode({ database: 'd' }), { filterFields: ['scope', 'owner'] })

      expect(filterPaths(definition)).toEqual(['scope', 'store_name', 'owner'])
    })

    it('exposes the declared paths without rebuilding the definition', () => {
      expect(declaredFilterFields(['owner'])).toEqual(['scope', 'store_name', 'owner'])
    })

    it('drops duplicates within the caller fields too', () => {
      expect(declaredFilterFields(['owner', 'owner', 'store_name'])).toEqual(['scope', 'store_name', 'owner'])
    })

    it('agrees with the filter module on the baked-in pair', () => {
      expect(declaredFilterFields([]).slice(0, 2)).toEqual([...BAKED_IN_FILTER_FIELDS])
    })
  })

  describe('textIndexDefinition', () => {
    it('maps the content field as a string and nothing else', () => {
      expect(textIndexDefinition()).toEqual({ mappings: { dynamic: false, fields: { content: [{ type: 'string' }] } } })
    })

    it('turns dynamic mapping off', () => {
      expect(textIndexDefinition().mappings.dynamic).toBe(false)
    })

    it('maps a custom text field', () => {
      expect(Object.keys(textIndexDefinition({ textField: 'body' }).mappings.fields)).toEqual(['body'])
    })
  })

  describe('the ordinary index inventory', () => {
    it('declares exactly the TTL index on the storage surface', () => {
      const specs = storageSpecs()

      expect(specs.map((spec) => spec.keys)).toEqual([[['expires_at', 1]]])
      expect(specs[0]?.options).toEqual({ expireAfterSeconds: 0 })
    })

    it('declares three ordinary indexes on the memory surface', () => {
      expect(memorySpecs()).toHaveLength(MEMORY_ROWS.length)
    })

    it('gives the dedup index the options it exists for', () => {
      const spec = byKeys(['scope', 1], ['store_name', 1], ['content_hash', 1])

      expect(spec.options).toEqual({ unique: true, partialFilterExpression: { content_hash: { $exists: true } } })
    })

    it('makes the dedup index partial so documents without a hash do not collide', () => {
      const spec = byKeys(['scope', 1], ['store_name', 1], ['content_hash', 1])

      expect(spec.options.partialFilterExpression).toEqual({ content_hash: { $exists: true } })
    })

    it('sorts the recency index by created_at descending', () => {
      expect(byKeys(['scope', 1], ['store_name', 1], ['created_at', -1]).options).toEqual({})
    })

    it('declares the memory TTL index unconditionally', () => {
      expect(byKeys(['expires_at', 1]).options).toEqual({ expireAfterSeconds: 0 })
    })

    it('takes no arguments, so the inventory cannot vary by caller', () => {
      expect(storageSpecs()).toEqual(storageSpecs())
      expect(memorySpecs()).toEqual(memorySpecs())
    })

    it('prefixes every name with the package name', () => {
      for (const spec of [...storageSpecs(), ...memorySpecs()]) {
        expect(spec.name.startsWith('strands_')).toBe(true)
      }
    })

    it('marks only the TTL index as date-only', () => {
      expect(memorySpecs().map((spec) => spec.dateOnly)).toEqual([false, false, true])
      expect(storageSpecs()[0]?.dateOnly).toBe(true)
    })

    it('describes itself to the driver with the keys in order', () => {
      const description = byKeys(['scope', 1], ['store_name', 1], ['created_at', -1]).toDescription()

      expect(description).toEqual({
        key: { scope: 1, store_name: 1, created_at: -1 },
        name: 'strands_scope_store_created_at',
      })
      expect(Object.keys(description.key)).toEqual(['scope', 'store_name', 'created_at'])
    })

    it('carries every option into the driver description', () => {
      expect(byKeys(['expires_at', 1]).toDescription()).toEqual({
        key: { expires_at: 1 },
        name: 'strands_expires_at_ttl',
        expireAfterSeconds: 0,
      })
    })
  })

  describe('the search index inventory', () => {
    it('declares both search indexes', () => {
      expect(memorySearchSpecs({ database: 'd' }).map((spec) => spec.type)).toEqual(['vectorSearch', 'search'])
    })

    it('defaults to the reference implementation names', () => {
      expect(memorySearchSpecs({ database: 'd' }).map((spec) => spec.name)).toEqual(['vector_index', 'text_index'])
    })

    it('lets configured names override the defaults', () => {
      const specs = memorySearchSpecs({ database: 'd', vectorIndexName: 'v', textIndexName: 't' })

      expect(specs.map((spec) => spec.name)).toEqual(['v', 't'])
    })

    it('passes the config filter fields into the vector definition', () => {
      const [vector] = memorySearchSpecs({ database: 'd', filterFields: ['owner'] })

      expect(filterPaths(vector?.definition ?? {})).toEqual(['scope', 'store_name', 'owner'])
    })

    it('rejects a conflicting vector config here too', () => {
      const error = errorOf(() => memorySearchSpecs({ database: 'd', embeddingModel: 'm', embeddingDimensions: 4 }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain('embeddingDimensions')
    })

    it('describes itself to the driver', () => {
      const spec = new SearchIndexSpec({ name: 'n', definition: { a: 1 }, type: 'search' })

      expect(spec.toDescription()).toEqual({ name: 'n', definition: { a: 1 }, type: 'search' })
    })
  })

  describe('AT-061 the commands handed to an operator', () => {
    it('renders the server command the driver sends for an ordinary index', () => {
      const command = storageSpecs()[0]?.creationCommand('storage') ?? ''

      expect(command.startsWith('db.runCommand(')).toBe(true)
      expect(commandBody(command)).toMatchObject({
        createIndexes: 'storage',
        indexes: [{ key: { expires_at: 1 }, expireAfterSeconds: 0 }],
      })
    })

    it('names the ordinary index it creates', () => {
      const spec = storageSpecs()[0]

      expect(spec?.creationCommand('storage')).toContain(spec?.name)
    })

    it('uses the search variant of the command for a search index', () => {
      const command = memorySearchSpecs({ database: 'd' })[0]?.creationCommand('memory') ?? ''
      const body = commandBody(command)

      expect(body.createSearchIndexes).toBe('memory')
      expect(body.indexes[0].type).toBe('vectorSearch')
      expect(body.indexes[0].definition.fields[0].type).toBe('autoEmbed')
    })

    it('renders valid JSON inside every call', () => {
      for (const command of [
        memorySpecs()[0]?.creationCommand('memory') ?? '',
        memorySearchSpecs({ database: 'd' })[1]?.creationCommand('memory') ?? '',
      ]) {
        expect(() => commandBody(command)).not.toThrow()
      }
    })

    it('keeps a hostile index name inside its string', () => {
      const name = 'x"}); db.dropDatabase(); ({"a":"\\'
      const spec = new SearchIndexSpec({ name, definition: {}, type: 'search' })

      expect(commandBody(dropIndexCommand('memory', name)).index).toBe(name)
      expect(commandBody(spec.dropCommand('memory')).name).toBe(name)
    })
  })

  describe('readiness', () => {
    it('reads READY as ready', () => {
      expect(readiness('READY')).toBe('ready')
    })

    it('reads FAILED as failed', () => {
      expect(readiness('FAILED')).toBe('failed')
    })

    it.each(['PENDING', 'BUILDING', 'STAGED', 'SOMETHING_NEW', ''])('reads %j as building', (status) => {
      expect(readiness(status)).toBe('building')
    })
  })

  describe('embed', () => {
    const embedder = (vector: number[]): Embedder => ({ embed: async () => vector }) as Embedder

    it('returns a vector of the declared length', async () => {
      await expect(
        embed(embedder([1, 2, 3]), 'tea', { dimensions: 3, setting: 'embeddingDimensions' })
      ).resolves.toEqual([1, 2, 3])
    })

    it('rejects a vector of the wrong length and names the setting', async () => {
      const result = embed(embedder([1, 2]), 'tea', { dimensions: 3, setting: 'embeddingDimensions' })

      await expect(result).rejects.toBeInstanceOf(RangeError)
      await expect(result).rejects.toThrow(
        "strands_mongodb: the embedder returned a 2-dimension vector and 'embeddingDimensions' is 3."
      )
    })
  })

  describe('fixture parity with the Python package', () => {
    describe('index specs', () => {
      it.each([
        ['storage_specs', storageSpecs],
        ['memory_specs', memorySpecs],
      ] as const)('%s', (key, specs) => {
        const actual = specs().map(({ name, keys, options, dateOnly }) => ({ name, keys, options, dateOnly }))

        expect(actual).toEqual(specFixtures[key])
      })

      it.each(specFixtures.vector_index_definition)('$name', ({ input, definition }) => {
        expect(vectorIndexDefinition(fixtureMode(input.mode), { filterFields: input.filterFields })).toEqual(definition)
      })

      it('text_index_definition', () => {
        expect(textIndexDefinition()).toEqual(specFixtures.text_index_definition)
      })
    })

    describe('commands', () => {
      it.each([
        ...commands.storage_specs.map((entry) => ['storage_specs', entry.name, storageSpecs, entry] as const),
        ...commands.memory_specs.map((entry) => ['memory_specs', entry.name, memorySpecs, entry] as const),
      ])('%s %s', (_surface, _name, specs, entry) => {
        const spec = specs().find((candidate) => candidate.name === entry.name)

        expectEquivalent(spec?.creationCommand(entry.collection), entry.creation_command)
        expectEquivalent(dropIndexCommand(entry.collection, entry.name), entry.drop_command)
      })

      it.each([
        ...commands.storage_specs.map((entry) => ['storage_specs', entry.name, storageSpecs, entry] as const),
        ...commands.memory_specs.map((entry) => ['memory_specs', entry.name, memorySpecs, entry] as const),
      ])('%s %s keeps the compound key order', (_surface, _name, specs, entry) => {
        const spec = specs().find((candidate) => candidate.name === entry.name)
        const order = Object.keys(commandBody(entry.creation_command).indexes[0].key)

        expect(Object.keys(commandBody(spec?.creationCommand(entry.collection) ?? '').indexes[0].key)).toEqual(order)
        expect(Object.keys(spec?.toDescription().key ?? {})).toEqual(order)
      })

      it.each(commands.memory_search_specs)('memory_search_specs $name', (entry) => {
        const type = entry.name.split('/').at(-1)
        const spec = memorySearchSpecs(fixtureConfig(entry.input.config)).find((candidate) => candidate.type === type)

        expectEquivalent(spec?.creationCommand(entry.collection), entry.creation_command)
        expectEquivalent(spec?.dropCommand(entry.collection), entry.drop_command)
      })
    })
  })

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
        expect(created.mock.calls[0]?.[0]).toHaveLength(MEMORY_ROWS.length)
        expect(userIndexes(collection)).toHaveLength(MEMORY_ROWS.length)
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

        expect(error.message).toContain('its expireAfterSeconds is 3600 and this package needs 0')
      })

      it('reports an absent option as absent', async () => {
        const collection = withIndexes(existing('someone_elses', [['expires_at', 1]]))

        const error = await rejectionOf(ensureOrdinary(collection, storageSpecs()))

        expect(error.message).toContain('its expireAfterSeconds is absent and this package needs 0')
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
        expect(error.message.match(/createIndexes/g)).toHaveLength(MEMORY_ROWS.length)
        for (const spec of memorySpecs()) expect(error.message).toContain(spec.creationCommand('memory'))
      })

      it('verify-only passes when everything is present', async () => {
        const collection = fakeCollection()
        await ensureOrdinary(collection, memorySpecs())

        await ensureOrdinary(collection, memorySpecs(), false)

        expect(userIndexes(collection)).toHaveLength(MEMORY_ROWS.length)
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
        await ensureOrdinary(matched({ locale: 'simple' }), [dedupSpec()])
      })

      it('accepts an index reporting no collation at all', async () => {
        await ensureOrdinary(matched(), [dedupSpec()])
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

        await ensureOrdinary(collection, [dedup])
      })

      it('accepts a folding index enforcing nothing beside a correct one', async () => {
        const dedup = dedupSpec()
        const collection = withIndexes(
          existing(dedup.name, dedup.keys, dedup.options),
          existing('theirs', dedup.keys, { collation: FOLDING })
        )

        await ensureOrdinary(collection, [dedup])
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
        collection.db.createCollectionError = new Error('socket timed out')

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
        expect(error.message).toContain('named searchType')
        expect(error.message).toContain("'auto'")
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
        ['an object reported where one was declared', textSpec(), { mappings: 'dynamic' }, 'declared the object'],
        ['a list reported as a scalar', vectorSpec(), { fields: 'everything' }, 'declared the list'],
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

      it('AT-125: keeps the measured default timeout and the reference poll interval', () => {
        expect(READY_TIMEOUT_SECONDS).toBe(300)
        expect(POLL_INTERVAL_SECONDS).toBe(0.5)
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
        collection.failListSearchIndexes(new Error('socket timed out'))

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
        await pending
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

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_SECONDS * 1000 - 1)

        expect(settled).toBe(true)
        expect((await pending).message).toContain('abandoned')
        expect(collection.searchIndexReads).toBe(2)
      })

      it('reads at most once for a signal that is already aborted, and still ends its spans', async () => {
        const collection = fakeCollection()
        collection.addSearchIndex(textSpec().toDescription(), 'PENDING')

        const error = await rejectionOf(
          ensureSearch(collection, [textSpec()], { timeout: 60, signal: AbortSignal.abort() })
        )

        expect(error).toBeInstanceOf(StorageError)
        expect(error.message).toContain('abandoned')
        expect(collection.searchIndexReads).toBe(1)
        expect(oneSpan(exporter, 'strands_mongodb.indexes.wait').attributes).not.toHaveProperty(
          'strands_mongodb.indexes.outcome'
        )
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

  describe('AT-053d: searchSupport', () => {
    it('reports a deployment that lists its search indexes as available, with no code', async () => {
      await expect(searchSupport(driver(fakeCollection()), silentLogger())).resolves.toEqual({ available: true })
    })

    it.each([31082, 115, 6047401])('degrades on code %i and reports it', async (code) => {
      const collection = fakeCollection()
      collection.failListSearchIndexes(serverError(code, 'no search here'))

      await expect(searchSupport(driver(collection), silentLogger())).resolves.toEqual({ available: false, code })
    })

    it.each([13, 59])('raises on code %i rather than reading it as no search', async (code) => {
      const collection = fakeCollection()
      collection.failListSearchIndexes(serverError(code, 'refused'))

      const error = await rejectionOf(searchSupport(driver(collection), silentLogger()))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('probing Atlas Search support on testdb.memory failed')
    })

    it('still answers for a collection that does not exist (code 26)', async () => {
      const collection = fakeCollection()
      collection.failListSearchIndexes(serverError(26, 'ns does not exist'))

      await expect(searchSupport(driver(collection), silentLogger())).resolves.toEqual({ available: true })
    })

    it('raises on a probe that never reached the server, with the cause chained', async () => {
      const collection = fakeCollection()
      const thrown = new Error('socket timed out')
      collection.failListSearchIndexes(thrown)

      const error = await rejectionOf(searchSupport(driver(collection), silentLogger()))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.cause).toBe(thrown)
    })
  })

  describe('AT-145: rankFusionSupport', () => {
    it.each([
      [[6, 0, 28, 0], false],
      [[7, 0, 12, 0], false],
      [[8, 0, 0, 0], true],
      [[8, 0, 23, 0], true],
      [[8, 2, 1, 0], true],
      [[9, 0, 0, 0], true],
    ])('decides on the major version of %j', async (versionArray, expected) => {
      const collection = fakeCollection()
      collection.db.buildInfo = { version: versionArray.slice(0, 3).join('.'), versionArray }

      await expect(rankFusionSupport(driver(collection), silentLogger())).resolves.toBe(expected)
    })

    it('reads buildInfo once per call', async () => {
      const collection = fakeCollection()

      await rankFusionSupport(driver(collection), silentLogger())

      expect(collection.db.commandCalls).toEqual([{ buildInfo: 1 }])
    })

    it.each([
      {},
      { versionArray: [] },
      { versionArray: ['8', 0, 0, 0] },
      { versionArray: null },
      { versionArray: [true] },
    ])('reads %j as unsupported', async (buildInfo) => {
      const collection = fakeCollection()
      collection.db.buildInfo = buildInfo

      await expect(rankFusionSupport(driver(collection), silentLogger())).resolves.toBe(false)
    })

    it('degrades rather than raising when buildInfo fails', async () => {
      const collection = fakeCollection()
      collection.db.commandError = serverError(13, 'not authorized')

      await expect(rankFusionSupport(driver(collection), silentLogger())).resolves.toBe(false)
    })
  })

  describe('AT-176, AT-192: readCollation and requireBinaryComparison', () => {
    it('reports an absent collection as not there', async () => {
      await expect(readCollation(driver(fakeCollection()), silentLogger())).resolves.toEqual({ exists: false })
    })

    it('reports an uncollated collection as present with no locale', async () => {
      const collection = fakeCollection()
      collection.setCollation(undefined)

      await expect(readCollation(driver(collection), silentLogger())).resolves.toEqual({ exists: true })
    })

    it('reports the locale the collection was created with', async () => {
      const collection = fakeCollection()
      collection.setCollation(FOLDING)

      await expect(readCollation(driver(collection), silentLogger())).resolves.toEqual({ exists: true, locale: 'en' })
    })

    it('wraps a failed listCollections in a StorageError', async () => {
      const collection = fakeCollection()
      const thrown = serverError(13, 'not authorized')
      vi.spyOn(collection.db, 'listCollections').mockReturnValue({ toArray: () => Promise.reject(thrown) })

      const error = await rejectionOf(readCollation(driver(collection), silentLogger()))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('reading the collation of testdb.memory failed')
      expect(error.cause).toBe(thrown)
    })

    it('declines to verify an absent collection and verifies a present one', async () => {
      const absent = fakeCollection()
      const present = fakeCollection()
      present.setCollation(undefined)
      const simple = fakeCollection()
      simple.setCollation({ locale: 'simple' })

      await expect(requireBinaryComparison(driver(absent), silentLogger())).resolves.toBe(false)
      await expect(requireBinaryComparison(driver(present), silentLogger())).resolves.toBe(true)
      await expect(requireBinaryComparison(driver(simple), silentLogger())).resolves.toBe(true)
    })

    it('refuses a folding collation, naming the locale, the namespace and the remedy', async () => {
      const collection = fakeCollection()
      collection.setCollation(FOLDING)

      const error = await rejectionOf(requireBinaryComparison(driver(collection), silentLogger()))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toMatch(
        /^strands_mongodb: the collection testdb.memory was created with the collation 'en'/
      )
      expect(error.message).toContain('db.createCollection("memory")')
      expect(error.message).toContain("{collation: {locale: 'simple'}}")
    })
  })

  describe('AT-204: each probe is a span naming what it probed', () => {
    it('records search, rank_fusion and collation probes under the namespace', async () => {
      const collection = fakeCollection()
      const logger = silentLogger()

      await searchSupport(driver(collection), logger)
      await rankFusionSupport(driver(collection), logger)
      await readCollation(driver(collection), logger)

      const probes = spansNamed(exporter, 'strands_mongodb.indexes.probe')
      expect(probes.map((probe) => probe.attributes['strands_mongodb.indexes.probe'])).toEqual([
        'search',
        'rank_fusion',
        'collation',
      ])
      for (const probe of probes) {
        expect(probe.attributes['strands_mongodb.database']).toBe('testdb')
        expect(probe.attributes['strands_mongodb.collection']).toBe('memory')
      }
    })
  })
})
