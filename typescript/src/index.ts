/**
 * MongoDB storage and memory backends for the Strands Agents SDK.
 *
 * @packageDocumentation
 */

export {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_TEXT_INDEX_NAME,
  DEFAULT_VECTOR_INDEX_NAME,
  MAX_DIMENSIONS,
  MAX_NUM_CANDIDATES,
  READY_TIMEOUT_SECONDS,
} from './index-specs.js'
export { DEFAULT_COLLECTION, MongoDBMemoryStore, UNSCOPED } from './memory-store.js'
export { RANK_FUSION_PENALTY } from './pipeline.js'
export { TIER_RETRY_MAX_SECONDS, TIER_RETRY_SECONDS } from './search-tiers.js'
export { MAX_DOCUMENT_BYTES, MAX_KEY_BYTES, MongoDBStorage, type MongoDBStorageOptions } from './storage.js'
export {
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_OVERSAMPLING_FACTOR,
  RESERVED_METADATA_KEYS,
  type MongoDBAddResult,
  type MongoDBConfig,
  type MongoDBMemoryStoreConfig,
  type MongoDBSearchQuery,
  type ResolvedSearchType,
  type SearchType,
  type VectorSimilarity,
} from './types.js'
export {
  DEFAULT_STORAGE_VECTOR_INDEX_NAME,
  MongoDBVectorSearchStrategy,
  type MongoDBVectorSearchStrategyOptions,
} from './vector-search.js'
