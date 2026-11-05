import type { MemoryStoreConfig } from '@strands-agents/sdk'
import { describe, expect, expectTypeOf, it } from 'vitest'
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
  type TextEmbedder,
  type VectorMode,
  type VectorSimilarity,
} from '../types.js'

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

  it('AT-056a adds the eight documented MongoDB keys', () => {
    expectTypeOf<Exclude<keyof MongoDBMemoryStoreConfig, keyof MemoryStoreConfig>>().toEqualTypeOf<
      'config' | 'collection' | 'scope' | 'filter' | 'minScore' | 'maxScore' | 'ttlSeconds' | 'embedder'
    >()
  })

  it('AT-056a requires name and config', () => {
    // @ts-expect-error name is missing
    const noName: MongoDBMemoryStoreConfig = { config: { database: 'agents' } }
    // @ts-expect-error config is missing
    const noConfig: MongoDBMemoryStoreConfig = { name: 'facts' }
    const complete: MongoDBMemoryStoreConfig = {
      name: 'facts',
      maxSearchResults: 5,
      config: { database: 'agents', connectionString: 'mongodb://localhost' },
      scope: 'user:1',
    }
    expect([noName, noConfig, complete]).toHaveLength(3)
  })

  it('accepts any object with an async embed as the embedder', () => {
    expectTypeOf<NonNullable<MongoDBMemoryStoreConfig['embedder']>>().toEqualTypeOf<TextEmbedder>()
    expectTypeOf<TextEmbedder['embed']>().toEqualTypeOf<(text: string) => Promise<number[]>>()
  })
})

describe('MongoDBConfig', () => {
  it('AT-056b declares the fourteen documented keys', () => {
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
    const minimal: MongoDBConfig = { database: 'agents' }
    // @ts-expect-error database is missing
    const noDatabase: MongoDBConfig = { connectionString: 'mongodb://localhost' }
    expect([minimal, noDatabase]).toHaveLength(2)
  })

  it('AT-056b rejects a misspelled optional key and a string dimension count', () => {
    // @ts-expect-error ensureIndex is not a key
    const misspelled: MongoDBConfig = { database: 'agents', ensureIndex: true }
    // @ts-expect-error embeddingDimensions is a number
    const wrong: MongoDBConfig = { database: 'agents', embeddingDimensions: '1024' }
    const manual: MongoDBConfig = { database: 'agents', embeddingDimensions: 1024, similarity: 'cosine' }
    expect([misspelled, wrong, manual]).toHaveLength(3)
  })
})

describe('search tier vocabulary', () => {
  it('AT-056d AT-141 accepts the four tiers that run', () => {
    expectTypeOf<SearchType>().toEqualTypeOf<'auto' | 'vector' | 'text' | 'hybrid'>()
  })

  it('AT-056d AT-141 reports the three tiers that can answer', () => {
    expectTypeOf<ResolvedSearchType>().toEqualTypeOf<'vector' | 'text' | 'hybrid'>()
  })

  it('AT-056d differs by auto alone', () => {
    expectTypeOf<Exclude<SearchType, ResolvedSearchType>>().toEqualTypeOf<'auto'>()
    expectTypeOf<ResolvedSearchType>().toExtend<SearchType>()
  })

  it('AT-142 accepts hybrid and rejects regex at the config site', () => {
    const hybrid: MongoDBConfig = { database: 'agents', searchType: 'hybrid' }
    // @ts-expect-error regex does not run
    const regex: MongoDBConfig = { database: 'agents', searchType: 'regex' }
    expect([hybrid, regex]).toHaveLength(2)
  })

  it('names the three Atlas similarity metrics', () => {
    expectTypeOf<VectorSimilarity>().toEqualTypeOf<'cosine' | 'dotProduct' | 'euclidean'>()
  })
})

describe('MongoDBSearchQuery', () => {
  it('AT-056e declares the five query keys, every one optional', () => {
    expectTypeOf<keyof MongoDBSearchQuery>().toEqualTypeOf<
      'text' | 'vector' | 'filter' | 'limit' | 'oversamplingFactor'
    >()
    expectTypeOf<Partial<MongoDBSearchQuery>>().toEqualTypeOf<MongoDBSearchQuery>()
  })

  it('AT-056e accepts a vector-only query', () => {
    const query: MongoDBSearchQuery = { vector: [0.1, 0.2], limit: 5 }
    expect(query.vector).toEqual([0.1, 0.2])
  })
})

describe('VectorMode', () => {
  it('requires autoEmbed alone', () => {
    expectTypeOf<{ autoEmbed: true }>().toExtend<VectorMode>()
    expectTypeOf<NonNullable<VectorMode['similarity']>>().toEqualTypeOf<VectorSimilarity>()
  })
})

describe('shared constants', () => {
  it('AT-056f reserves the four camelCase metadata keys', () => {
    expect(RESERVED_METADATA_KEYS).toEqual(new Set(['_relevanceScore', '_id', '_searchType', '_scope']))
  })

  it('AT-056f defaults to 10 results, matching the shipped stores', () => {
    expect(DEFAULT_MAX_SEARCH_RESULTS).toBe(10)
  })

  it('AT-056f defaults to an oversampling factor of 10', () => {
    expect(DEFAULT_OVERSAMPLING_FACTOR).toBe(10)
  })
})
