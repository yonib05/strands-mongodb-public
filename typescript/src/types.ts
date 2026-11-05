import type { Logger, MemoryStoreConfig } from '@strands-agents/sdk'
import type { MongoClient, MongoClientOptions } from 'mongodb'

/**
 * Search tiers a caller may ask for. `auto` picks the best tier the deployment supports; `hybrid`
 * fuses vector and text and needs MongoDB 8.0 or later.
 */
export type SearchType = 'auto' | 'vector' | 'text' | 'hybrid'

/** Distance metrics an Atlas vector index accepts, for the manual-vector path. Also checked at runtime. */
export type VectorSimilarity = 'cosine' | 'dotProduct' | 'euclidean'

/** Search tier that answered a query, reported in `_searchType`. `auto` can be requested but never answers. */
export type ResolvedSearchType = 'vector' | 'text' | 'hybrid'

/** Result ceiling when neither the call nor the store supplies one, matching the SDK's shipped stores. */
export const DEFAULT_MAX_SEARCH_RESULTS = 10

/** Multiplier turning a result limit into a `$vectorSearch` candidate count (`numCandidates`). */
export const DEFAULT_OVERSAMPLING_FACTOR = 10

/**
 * Metadata keys set on every returned `MemoryEntry`. On a collision with caller metadata the
 * reserved value wins and the collision is logged.
 */
export const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set(['_relevanceScore', '_id', '_searchType', '_scope'])

/**
 * Connection and deployment settings. Each config owns one client and its pool, so pass the same
 * config to every store that should share a pool.
 */
export interface MongoDBConfig {
  /** Database holding this deployment's collections. The only required key. */
  readonly database: string
  /** An existing client to use. This package never closes it, not even in `close()`. */
  readonly client?: MongoClient
  /** Used only when `client` is absent. Supplying neither throws. */
  readonly connectionString?: string
  /** Extra options for the client this package constructs. Ignored when `client` is supplied. */
  readonly clientOptions?: MongoClientOptions
  /** Whether `initialize()` creates missing indexes. Defaults to `true`; `false` means verify only. */
  readonly ensureIndexes?: boolean
  /** Seconds to wait for each search tier's index to report `READY`. Defaults to 300. */
  readonly indexReadyTimeout?: number
  /** Tier to search with. Defaults to `auto`; a named tier that cannot be prepared throws instead of falling back. */
  readonly searchType?: SearchType
  /** Atlas embedding model for the AutoEmbeddings path. Mutually exclusive with the two manual-vector keys. */
  readonly embeddingModel?: string
  /** Length of the stored vectors on the manual path, where the caller embeds. Requires `similarity`. */
  readonly embeddingDimensions?: number
  /** Distance metric for the manual path. No default: the wrong metric returns plausible but wrong neighbours. */
  readonly similarity?: VectorSimilarity
  /** Extra document fields to declare filterable in the vector index. Adding one later means recreating it. */
  readonly filterFields?: string[]
  /** Name of the Atlas Vector Search index. */
  readonly vectorIndexName?: string
  /** Name of the Atlas Search full-text index. */
  readonly textIndexName?: string
  /** Receives this package's log calls. Defaults to `warn` and `error` on `console`, like the SDK. */
  readonly logger?: Logger
}

/** What this package needs from an embedder. The SDK's `Embedder` satisfies it. */
export interface TextEmbedder {
  /**
   * Embeds one text.
   *
   * @param text - The text to embed
   * @returns The embedding vector
   */
  embed(text: string): Promise<number[]>
}

/**
 * Full configuration for a `MongoDBMemoryStore`. Extends the SDK's `MemoryStoreConfig`, so `name`
 * stays required and `writable` defaults to `false`.
 */
export interface MongoDBMemoryStoreConfig extends MemoryStoreConfig {
  /** Connection to the deployment. Reuse one across stores that differ only by `scope`. */
  readonly config: MongoDBConfig
  /** Collection holding this store's documents. Defaults to `memory`. */
  readonly collection?: string
  /** Namespace stamped on every write and filtered on every read. Absent means a sentinel scope, never unfiltered. */
  readonly scope?: string
  /** Extra predicate ANDed with the scope on search and delete, so it can only narrow. */
  readonly filter?: Record<string, unknown>
  /** Floor a result must meet. Fused hybrid scores use a different scale, so `auto` avoids hybrid when set. */
  readonly minScore?: number
  /** Ceiling a result must not exceed. Mutually exclusive with `minScore`; same scale caveat. */
  readonly maxScore?: number
  /** Lifetime in seconds from `created_at`, set on insert only. `0` expires at the next sweep; negative throws. */
  readonly ttlSeconds?: number
  /** Manual-vector path only: embeds memories on `add` and string queries on `search`. */
  readonly embedder?: TextEmbedder
}

/**
 * A MongoDB-specific search query, in place of a plain string. Set `text` or `vector`; set both only
 * on a manual-vector store that can use the hybrid tier. Anything else throws at search time.
 */
export interface MongoDBSearchQuery {
  /** Natural-language query. Embedded server-side on the AutoEmbeddings path. */
  readonly text?: string
  /** A pre-computed embedding, used directly. */
  readonly vector?: number[]
  /** MQL predicate over declared filterable fields, validated before it reaches the server. */
  readonly filter?: Record<string, unknown>
  /** Result ceiling for this call, overriding the store's own. */
  readonly limit?: number
  /** Multiplier turning `limit` into a vector candidate count. Above 10000 candidates throws. */
  readonly oversamplingFactor?: number
}

/** Result returned by `MongoDBMemoryStore.add`. */
export interface MongoDBAddResult {
  /** Stringified `_id` of every document the call resolved to, inserted now or already present. */
  readonly ids: string[]
  /** How many documents the call created. */
  readonly inserted: number
  /** How many were already present. Extraction writes are at-least-once, so this explains a lower count. */
  readonly duplicates: number
}

/** How the vector index gets its vectors: embedded by Atlas, or supplied by the caller. */
export interface VectorMode {
  /** Whether Atlas embeds the text server-side. */
  readonly autoEmbed: boolean
  /** Atlas embedding model, on the AutoEmbeddings path. */
  readonly model?: string
  /** Vector length, on the manual path. */
  readonly dimensions?: number
  /** Distance metric, on the manual path. */
  readonly similarity?: VectorSimilarity
}
