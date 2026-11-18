import type { JSONValue, Logger, MemoryStoreConfig } from '@strands-agents/sdk'
import type { Embedder } from '@strands-agents/sdk/storage/search'
import type { MongoClient, MongoClientOptions } from 'mongodb'

/** Search tiers a caller may ask for. `auto` picks the best available; `hybrid` needs MongoDB 8.0 or later. */
export type SearchType = 'auto' | 'vector' | 'text' | 'hybrid'

/** Distance metrics an Atlas vector index accepts, for the manual-vector path. Also checked at runtime. */
export type VectorSimilarity = 'cosine' | 'dotProduct' | 'euclidean'

/** Search tier that answered a query, reported in `_searchType`. `auto` can be requested but never answers. */
export type ResolvedSearchType = 'vector' | 'text' | 'hybrid'

/** Result ceiling when neither the call nor the store supplies one, matching the SDK's shipped stores. */
export const DEFAULT_MAX_SEARCH_RESULTS = 10

/** Multiplier turning a result limit into a `$vectorSearch` candidate count (`numCandidates`). */
export const DEFAULT_OVERSAMPLING_FACTOR = 10

const RESERVED = ['_relevanceScore', '_id', '_searchType', '_scope'] as const

/** Metadata keys set on every returned `MemoryEntry`. A colliding caller key loses, and the collision is logged. */
export const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set(RESERVED)

/** What `search` sets under the reserved keys: exactly one value for each. */
export type ReservedMetadata = Record<(typeof RESERVED)[number], JSONValue>

/**
 * Connection and deployment settings.
 *
 * @remarks
 * Stores share one client and pool when their configs hold the same `client` object, or equal `connectionString`
 * and `clientOptions`, even as separate config objects. `close()` on any of them closes that shared pool.
 */
export interface MongoDBConfig {
  /** Database holding this deployment's collections. The only required key. */
  readonly database: string
  /** An existing client to use. It is never closed, not even by `close()`. */
  readonly client?: MongoClient
  /** Used only when `client` is absent. Supplying neither throws. */
  readonly connectionString?: string
  /** Options for the client built from `connectionString`. Compared by value, except functions and class instances, such as an OIDC callback, which are compared by identity. */
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
  readonly filterFields?: readonly string[]
  /** Name of the Atlas Vector Search index. */
  readonly vectorIndexName?: string
  /** Name of the Atlas Search full-text index. */
  readonly textIndexName?: string
  /** Receives every log line. Defaults to `warn` and `error` on `console`, like the SDK. */
  readonly logger?: Logger
}

/** Configuration for a `MongoDBMemoryStore`. As in the SDK, `name` is required and `writable` defaults to `false`. */
export interface MongoDBMemoryStoreConfig extends MemoryStoreConfig {
  /** Connection to the deployment. Reuse one across stores that differ only by `scope`. */
  readonly config: MongoDBConfig
  /** Collection holding this store's documents. Defaults to `memory`. */
  readonly collection?: string
  /** Namespace stamped on every write and filtered on every read. Absent or `''` means the shared `__unscoped__` scope, never unfiltered. */
  readonly scope?: string
  /** Declared field paths mapped to the exact values they must equal, ANDed with the scope on search and delete. Operators are rejected. */
  readonly filter?: Record<string, unknown>
  /** Floor a result must meet. Fused hybrid scores use a different scale, so `auto` avoids hybrid when set. */
  readonly minScore?: number
  /** Ceiling a result must not exceed. Mutually exclusive with `minScore`; same scale caveat. */
  readonly maxScore?: number
  /** Lifetime in seconds from `created_at`, set on insert only. `0` expires at the next sweep; negative throws. */
  readonly ttlSeconds?: number | undefined
  /** Manual-vector path only: embeds memories on `add` and string queries on `search`. */
  readonly embedder?: Embedder
}

/** A search query in place of a plain string. Set `text` or `vector`, or both where the hybrid tier can fuse them. */
export interface MongoDBSearchQuery {
  /** Natural-language query. Embedded server-side on the AutoEmbeddings path. */
  readonly text?: string
  /** A pre-computed embedding, used directly. */
  readonly vector?: number[]
  /** Declared field paths mapped to the exact values they must equal, such as `{ 'metadata.tier': 'gold' }`. Operators are rejected. */
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

/** How the vector index gets its vectors: embedded by Atlas from `model`, or supplied by the caller. */
export type VectorMode =
  | { readonly autoEmbed: true; readonly model: string }
  | { readonly autoEmbed: false; readonly dimensions: number; readonly similarity: VectorSimilarity }
