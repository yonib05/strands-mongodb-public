import type { Document } from 'mongodb'
import { describe, expect, it } from 'vitest'
import commands from '../__fixtures__/commands.json' with { type: 'json' }
import specFixtures from '../__fixtures__/index-specs.json' with { type: 'json' }
import {
  BAKED_IN_FILTER_FIELDS,
  declaredFilterFields,
  DEFAULT_EMBEDDING_MODEL,
  dropIndexCommand,
  type IndexSpec,
  memorySearchSpecs,
  memorySpecs,
  READY_TIMEOUT_SECONDS,
  SearchIndexSpec,
  storageSpecs,
  textIndexDefinition,
  vectorIndexDefinition,
  vectorMode,
} from '../index-specs.js'
import type { MongoDBConfig, VectorMode, VectorSimilarity } from '../types.js'
import { errorOf } from '../__fixtures__/errors.js'

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

  it.each(['cosine', 'dotProduct', 'euclidean'] as const)('accepts the similarity Atlas accepts: %s', (similarity) => {
    expect(vectorMode({ database: 'd', embeddingDimensions: 8, similarity })).toMatchObject({ similarity })
  })

  it('rejects an unknown similarity here rather than at the server', () => {
    const config = { database: 'd', embeddingDimensions: 8, similarity: 'l2' } as unknown as MongoDBConfig
    const error = errorOf(() => vectorMode(config))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain("'l2'")
    expect(error.message).toContain('cosine')
  })

  it.each([0, -1, 8193, 1.5, NaN])(
    'rejects dimensions that are not an integer within the Atlas bounds: %d',
    (dimensions) => {
      const error = errorOf(() => vectorMode({ database: 'd', embeddingDimensions: dimensions, similarity: 'cosine' }))

      expect(error).toBeInstanceOf(RangeError)
      expect(error.message).toContain('1..8192')
      expect(error.message).toContain(String(dimensions))
    }
  )
})

describe('AT-125: the default readiness timeout', () => {
  it('is the measured 300 seconds', () => {
    expect(READY_TIMEOUT_SECONDS).toBe(300)
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
      vectorMode({ database: 'd', embeddingDimensions: 4, similarity: 'euclidean' })
    )

    expect(definition.fields[0]).toEqual({
      type: 'vector',
      path: 'embedding',
      numDimensions: 4,
      similarity: 'euclidean',
    })
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
    const definition = vectorIndexDefinition(vectorMode({ database: 'd' }), ['metadata.tier', 'owner'])

    expect(filterPaths(definition)).toEqual(['scope', 'store_name', 'metadata.tier', 'owner'])
  })

  it('declares a caller field that duplicates a baked-in one once', () => {
    const definition = vectorIndexDefinition(vectorMode({ database: 'd' }), ['scope', 'owner'])

    expect(filterPaths(definition)).toEqual(['scope', 'store_name', 'owner'])
  })

  it('exposes the declared paths without rebuilding the definition', () => {
    expect(declaredFilterFields(['owner'])).toEqual(['scope', 'store_name', 'owner'])
  })

  it('drops duplicates within the caller fields too', () => {
    expect(declaredFilterFields(['owner', 'owner', 'store_name'])).toEqual(['scope', 'store_name', 'owner'])
  })

  it('bakes in exactly the two fields the tenancy predicate filters on', () => {
    expect(BAKED_IN_FILTER_FIELDS).toEqual(['scope', 'store_name'])
    expect(declaredFilterFields([])).toEqual([...BAKED_IN_FILTER_FIELDS])
  })
})

describe('textIndexDefinition', () => {
  it('maps the content field as a string and nothing else', () => {
    expect(textIndexDefinition()).toEqual({ mappings: { dynamic: false, fields: { content: [{ type: 'string' }] } } })
  })

  it('turns dynamic mapping off', () => {
    expect(textIndexDefinition().mappings.dynamic).toBe(false)
  })
})

describe('the ordinary index inventory', () => {
  it('declares exactly the TTL index on the storage surface', () => {
    const specs = storageSpecs()

    expect(specs.map((spec) => spec.keys)).toEqual([[['expires_at', 1]]])
    expect(specs[0]?.options).toEqual({ expireAfterSeconds: 0 })
  })

  it('declares three ordinary indexes on the memory surface', () => {
    expect(memorySpecs()).toHaveLength(3)
  })

  it('gives the dedup index the options it exists for', () => {
    const spec = byKeys(['scope', 1], ['store_name', 1], ['content_hash', 1])

    expect(spec.options).toEqual({ unique: true, partialFilterExpression: { content_hash: { $exists: true } } })
  })

  it('sorts the recency index by created_at descending', () => {
    expect(byKeys(['scope', 1], ['store_name', 1], ['created_at', -1]).options).toEqual({})
  })

  it('declares the memory TTL index unconditionally', () => {
    expect(byKeys(['expires_at', 1]).options).toEqual({ expireAfterSeconds: 0 })
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
      expect(vectorIndexDefinition(fixtureMode(input.mode), input.filterFields)).toEqual(definition)
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
