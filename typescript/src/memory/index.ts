/**
 * MongoDB Atlas implementation of the Strands Agents SDK `MemoryStore` interface.
 *
 * @packageDocumentation
 */

export { DEFAULT_COLLECTION, MongoDBMemoryStore, UNSCOPED } from '../memory-store.js'
export { TIER_RETRY_MAX_SECONDS, TIER_RETRY_SECONDS } from '../search-tiers.js'
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
} from '../types.js'
