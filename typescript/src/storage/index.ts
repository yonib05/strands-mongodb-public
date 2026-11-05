/**
 * MongoDB implementation of the Strands Agents SDK `Storage` interface.
 *
 * @packageDocumentation
 */

export { MAX_DOCUMENT_BYTES, MAX_KEY_BYTES, MongoDBStorage, type MongoDBStorageOptions } from '../storage.js'
export type { MongoDBConfig } from '../types.js'
export {
  DEFAULT_STORAGE_VECTOR_INDEX_NAME,
  MongoDBVectorSearchStrategy,
  type MongoDBVectorSearchStrategyOptions,
} from '../vector-search.js'
