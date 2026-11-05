/**
 * MongoDB storage and memory backends for the Strands Agents SDK.
 *
 * @packageDocumentation
 */

export {
  DEFAULT_COLLECTION,
  MongoDBMemoryStore,
  TIER_RETRY_MAX_SECONDS,
  TIER_RETRY_SECONDS,
  UNSCOPED,
} from './memory-store.js'
export { MAX_DOCUMENT_BYTES, MAX_KEY_BYTES, MongoDBStorage, type MongoDBStorageOptions } from './storage.js'
export {
  DEFAULT_STORAGE_VECTOR_INDEX_NAME,
  MongoDBVectorSearchStrategy,
  type MongoDBVectorSearchStrategyOptions,
} from './vector-search.js'
