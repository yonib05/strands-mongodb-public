/** Document field holding the text a memory is about, indexed for vector and full-text search. */
export const CONTENT_FIELD = 'content'

/** Document field holding a caller-supplied embedding, on the manual-vector path only. */
export const VECTOR_FIELD = 'embedding'

/** Document field the TTL index watches. Documents without it never expire. */
export const EXPIRES_FIELD = 'expires_at'

/** Atlas embedding model used when the config names none. */
export const DEFAULT_EMBEDDING_MODEL = 'voyage-4-lite'

/** Default Atlas Vector Search index name. */
export const DEFAULT_VECTOR_INDEX_NAME = 'vector_index'

/** Default Atlas Search index name. */
export const DEFAULT_TEXT_INDEX_NAME = 'text_index'

/** Distance metrics an Atlas vector index accepts. Mirrors `VectorSimilarity` at runtime. */
export const SIMILARITIES = ['cosine', 'dotProduct', 'euclidean'] as const

/** Upper bound Atlas enforces on `numDimensions`; outside `[1..8192]` is server code 8. */
export const MAX_DIMENSIONS = 8192

/** The server's `numCandidates` ceiling; outside `[1..10000]` is server code 8. */
export const MAX_NUM_CANDIDATES = 10000

/** Default seconds to wait for a search index to report `READY`. Atlas builds have taken over 120 seconds. */
export const READY_TIMEOUT_SECONDS = 300

/** Delay between search index readiness reads, in seconds. */
export const POLL_INTERVAL_SECONDS = 0.5

/** First `mongod` major version with `$rankFusion` over `$vectorSearch` inputs: 8.0, not 8.1. */
export const RANK_FUSION_MIN_MAJOR = 8

/** Error codes from listing search indexes that mean the deployment has no Atlas Search. */
export const SEARCH_UNSUPPORTED_CODES: ReadonlySet<number> = new Set([31082, 115, 6047401])

/** The one collation locale that compares strings byte by byte. */
export const SIMPLE_LOCALE = 'simple'
