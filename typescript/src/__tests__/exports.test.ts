import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as Memory from '../memory/index.js'
import type * as Root from '../index.js'
import type * as Storage from '../storage/index.js'
import type * as StorageModule from '../storage.js'
import type * as Types from '../types.js'
import type * as VectorSearch from '../vector-search.js'

const ROOT_VALUES = [
  'DEFAULT_COLLECTION',
  'DEFAULT_EMBEDDING_MODEL',
  'DEFAULT_MAX_SEARCH_RESULTS',
  'DEFAULT_OVERSAMPLING_FACTOR',
  'DEFAULT_STORAGE_VECTOR_INDEX_NAME',
  'DEFAULT_TEXT_INDEX_NAME',
  'DEFAULT_VECTOR_INDEX_NAME',
  'MAX_DIMENSIONS',
  'MAX_DOCUMENT_BYTES',
  'MAX_KEY_BYTES',
  'MAX_NUM_CANDIDATES',
  'MongoDBMemoryStore',
  'MongoDBStorage',
  'MongoDBVectorSearchStrategy',
  'RANK_FUSION_PENALTY',
  'READY_TIMEOUT_SECONDS',
  'RESERVED_METADATA_KEYS',
  'TIER_RETRY_MAX_SECONDS',
  'TIER_RETRY_SECONDS',
  'UNSCOPED',
]

const STORAGE_VALUES = [
  'DEFAULT_STORAGE_VECTOR_INDEX_NAME',
  'MAX_DOCUMENT_BYTES',
  'MAX_KEY_BYTES',
  'MongoDBStorage',
  'MongoDBVectorSearchStrategy',
]

const MEMORY_VALUES = [
  'DEFAULT_COLLECTION',
  'DEFAULT_MAX_SEARCH_RESULTS',
  'DEFAULT_OVERSAMPLING_FACTOR',
  'MongoDBMemoryStore',
  'RESERVED_METADATA_KEYS',
  'TIER_RETRY_MAX_SECONDS',
  'TIER_RETRY_SECONDS',
  'UNSCOPED',
]

describe('public surface', () => {
  describe('strands-mongodb', () => {
    it('exports exactly the public runtime values', async () => {
      expect(Object.keys(await import('../index.js')).sort()).toEqual(ROOT_VALUES)
    })

    it('exports the public types', () => {
      expectTypeOf<Root.MongoDBConfig>().toEqualTypeOf<Types.MongoDBConfig>()
      expectTypeOf<Root.MongoDBMemoryStoreConfig>().toEqualTypeOf<Types.MongoDBMemoryStoreConfig>()
      expectTypeOf<Root.MongoDBSearchQuery>().toEqualTypeOf<Types.MongoDBSearchQuery>()
      expectTypeOf<Root.MongoDBAddResult>().toEqualTypeOf<Types.MongoDBAddResult>()
      expectTypeOf<Root.SearchType>().toEqualTypeOf<Types.SearchType>()
      expectTypeOf<Root.VectorSimilarity>().toEqualTypeOf<Types.VectorSimilarity>()
      expectTypeOf<Root.ResolvedSearchType>().toEqualTypeOf<Types.ResolvedSearchType>()
      expectTypeOf<Root.MongoDBStorageOptions>().toEqualTypeOf<StorageModule.MongoDBStorageOptions>()
      expectTypeOf<Root.MongoDBVectorSearchStrategyOptions>().toEqualTypeOf<VectorSearch.MongoDBVectorSearchStrategyOptions>()
    })

    it('keeps the internal types private', () => {
      // @ts-expect-error VectorMode is internal
      expectTypeOf<Root.VectorMode>().toBeUnknown()
    })
  })

  describe('strands-mongodb/storage', () => {
    it('exports exactly the storage runtime values', async () => {
      expect(Object.keys(await import('../storage/index.js')).sort()).toEqual(STORAGE_VALUES)
    })

    it('exports the storage types', () => {
      expectTypeOf<Storage.MongoDBConfig>().toEqualTypeOf<Types.MongoDBConfig>()
      expectTypeOf<Storage.MongoDBStorageOptions>().toEqualTypeOf<StorageModule.MongoDBStorageOptions>()
      expectTypeOf<Storage.MongoDBVectorSearchStrategyOptions>().toEqualTypeOf<VectorSearch.MongoDBVectorSearchStrategyOptions>()
    })
  })

  describe('strands-mongodb/memory', () => {
    it('exports exactly the memory runtime values', async () => {
      expect(Object.keys(await import('../memory/index.js')).sort()).toEqual(MEMORY_VALUES)
    })

    it('exports the memory types', () => {
      expectTypeOf<Memory.MongoDBConfig>().toEqualTypeOf<Types.MongoDBConfig>()
      expectTypeOf<Memory.MongoDBMemoryStoreConfig>().toEqualTypeOf<Types.MongoDBMemoryStoreConfig>()
      expectTypeOf<Memory.MongoDBSearchQuery>().toEqualTypeOf<Types.MongoDBSearchQuery>()
      expectTypeOf<Memory.MongoDBAddResult>().toEqualTypeOf<Types.MongoDBAddResult>()
      expectTypeOf<Memory.SearchType>().toEqualTypeOf<Types.SearchType>()
      expectTypeOf<Memory.VectorSimilarity>().toEqualTypeOf<Types.VectorSimilarity>()
      expectTypeOf<Memory.ResolvedSearchType>().toEqualTypeOf<Types.ResolvedSearchType>()
    })
  })
})
