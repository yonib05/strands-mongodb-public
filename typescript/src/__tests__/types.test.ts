import type { MemoryStoreConfig } from '@strands-agents/sdk'
import type { Embedder } from '@strands-agents/sdk/storage/search'
import { assertType, describe, expect, expectTypeOf, it } from 'vitest'
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_OVERSAMPLING_FACTOR,
  RESERVED_METADATA_KEYS,
  type MongoDBAddResult,
  type MongoDBConfig,
  type MongoDBMemoryStoreConfig,
  type MongoDBSearchQuery,
  type ResolvedSearchType,
  type SearchType,
  type VectorMode,
  type VectorSimilarity,
} from '../types.js'

// The `expectTypeOf` tests assert nothing at run time: `npm run type-check` is what enforces them.
describe('MongoDBAddResult', () => {
  it('AT-056 carries ids, inserted and duplicates, all required', () => {
    expectTypeOf<MongoDBAddResult>().toEqualTypeOf<{
      readonly ids: string[]
      readonly inserted: number
      readonly duplicates: number
    }>()
  })
})

describe('MongoDBMemoryStoreConfig', () => {
  it('AT-056a extends the SDK config', () => {
    expectTypeOf<MongoDBMemoryStoreConfig>().toExtend<MemoryStoreConfig>()
  })

  it('AT-056a adds the MongoDB-specific keys', () => {
    expectTypeOf<Exclude<keyof MongoDBMemoryStoreConfig, keyof MemoryStoreConfig>>().toEqualTypeOf<
      'config' | 'collection' | 'scope' | 'filter' | 'minScore' | 'maxScore' | 'ttlSeconds' | 'embedder'
    >()
  })

  it('AT-056a requires name and config', () => {
    // @ts-expect-error name is missing
    assertType<MongoDBMemoryStoreConfig>({ config: { database: 'agents' } })
    // @ts-expect-error config is missing
    assertType<MongoDBMemoryStoreConfig>({ name: 'facts' })
    assertType<MongoDBMemoryStoreConfig>({
      name: 'facts',
      maxSearchResults: 5,
      config: { database: 'agents', connectionString: 'mongodb://localhost' },
      scope: 'user:1',
    })
  })

  it("takes the SDK's Embedder as the embedder", () => {
    expectTypeOf<NonNullable<MongoDBMemoryStoreConfig['embedder']>>().toEqualTypeOf<Embedder>()
  })
})

describe('MongoDBConfig', () => {
  it('AT-056b declares the connection and deployment keys', () => {
    expectTypeOf<keyof MongoDBConfig>().toEqualTypeOf<
      | 'database'
      | 'client'
      | 'connectionString'
      | 'clientOptions'
      | 'ensureIndexes'
      | 'indexReadyTimeout'
      | 'searchType'
      | 'embeddingModel'
      | 'embeddingDimensions'
      | 'similarity'
      | 'filterFields'
      | 'vectorIndexName'
      | 'textIndexName'
      | 'logger'
    >()
  })

  it('AT-056b requires database and nothing else', () => {
    assertType<MongoDBConfig>({ database: 'agents' })
    // @ts-expect-error database is missing
    assertType<MongoDBConfig>({ connectionString: 'mongodb://localhost' })
  })

  it('AT-056b rejects a misspelled optional key and a string dimension count', () => {
    // @ts-expect-error ensureIndex is not a key
    assertType<MongoDBConfig>({ database: 'agents', ensureIndex: true })
    // @ts-expect-error embeddingDimensions is a number
    assertType<MongoDBConfig>({ database: 'agents', embeddingDimensions: '1024' })
    assertType<MongoDBConfig>({ database: 'agents', embeddingDimensions: 1024, similarity: 'cosine' })
  })
})

describe('search tier vocabulary', () => {
  it('AT-056d AT-141 accepts the four tiers that run', () => {
    expectTypeOf<SearchType>().toEqualTypeOf<'auto' | 'vector' | 'text' | 'hybrid'>()
  })

  it('AT-056d AT-141 reports the three tiers that can answer', () => {
    expectTypeOf<ResolvedSearchType>().toEqualTypeOf<'vector' | 'text' | 'hybrid'>()
  })

  it('AT-142 accepts hybrid and rejects regex at the config site', () => {
    assertType<MongoDBConfig>({ database: 'agents', searchType: 'hybrid' })
    // @ts-expect-error regex does not run
    assertType<MongoDBConfig>({ database: 'agents', searchType: 'regex' })
  })

  it('names the Atlas similarity metrics', () => {
    expectTypeOf<VectorSimilarity>().toEqualTypeOf<'cosine' | 'dotProduct' | 'euclidean'>()
  })
})

describe('MongoDBSearchQuery', () => {
  it('AT-056e declares the query keys, every one optional', () => {
    expectTypeOf<keyof MongoDBSearchQuery>().toEqualTypeOf<
      'text' | 'vector' | 'filter' | 'limit' | 'oversamplingFactor'
    >()
    expectTypeOf<Partial<MongoDBSearchQuery>>().toEqualTypeOf<MongoDBSearchQuery>()
  })
})

describe('VectorMode', () => {
  it('accepts an auto mode with a model and a manual mode with dimensions and similarity', () => {
    assertType<VectorMode>({ autoEmbed: true, model: 'voyage-4' })
    assertType<VectorMode>({ autoEmbed: false, dimensions: 1024, similarity: 'cosine' })
  })

  it('rejects a manual mode without similarity', () => {
    // @ts-expect-error similarity is required on the manual path
    assertType<VectorMode>({ autoEmbed: false, dimensions: 1024 })
  })

  it('rejects an auto mode with dimensions', () => {
    // @ts-expect-error dimensions belongs to the manual path
    assertType<VectorMode>({ autoEmbed: true, model: 'voyage-4', dimensions: 1024 })
  })
})

describe('shared constants', () => {
  it('AT-056f reserves the four camelCase metadata keys', () => {
    expect(RESERVED_METADATA_KEYS).toEqual(new Set(['_relevanceScore', '_id', '_searchType', '_scope']))
  })

  it('AT-056f defaults to 10 results and an oversampling factor of 10', () => {
    expect(DEFAULT_MAX_SEARCH_RESULTS).toBe(10)
    expect(DEFAULT_OVERSAMPLING_FACTOR).toBe(10)
  })
})
