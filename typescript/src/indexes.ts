import type { Embedder } from '@strands-agents/sdk/storage/search'
import type { Document, IndexDescription, SearchIndexDescription } from 'mongodb'
import { BAKED_IN_FILTER_FIELDS } from './filter.js'
import type { MongoDBConfig, VectorMode } from './types.js'

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

/** The three states of a search index build, each with a different remedy. */
export type Readiness = 'ready' | 'building' | 'failed'

/**
 * Rejects a negative lifetime, which would stamp an expiry in the past. `0` expires at the next sweep.
 *
 * @param ttlSeconds - The configured lifetime, or `undefined` for no expiry
 * @throws RangeError if `ttlSeconds` is below `0`
 */
export function checkTtl(ttlSeconds: number | undefined): void {
  if (ttlSeconds !== undefined && ttlSeconds < 0) {
    throw new RangeError(
      `strands_mongodb: 'ttlSeconds' is ${ttlSeconds}, and a lifetime cannot be negative. A negative value stamps an expiry in the past, so every write would be deleted on the next TTL sweep. Use 0 to expire at the next sweep, or leave it unset for no expiry.`
    )
  }
}

/**
 * Maps a search index's reported `status` onto a state. Unknown statuses read as building, never ready.
 *
 * @param status - The `status` field as the server reported it
 * @returns `ready` only for `READY`, `failed` only for `FAILED`, `building` otherwise
 */
export function readiness(status: string): Readiness {
  if (status === 'READY') return 'ready'
  if (status === 'FAILED') return 'failed'
  return 'building'
}

/**
 * Resolves the vector path from the config. Manual values are checked here because Atlas checks them only at creation.
 *
 * @param config - The connection configuration. Only the vector keys are read
 * @returns AutoEmbeddings with `DEFAULT_EMBEDDING_MODEL` when no vector key is set
 * @throws TypeError if both paths or only one manual key is set, or the similarity is unknown; RangeError if dimensions are out of bounds
 */
export function vectorMode(config: MongoDBConfig): VectorMode {
  const { embeddingModel: model, embeddingDimensions: dimensions, similarity } = config
  const similarities = SIMILARITIES.join(', ')

  if (model !== undefined && (dimensions !== undefined || similarity !== undefined)) {
    const also = [dimensions !== undefined && 'embeddingDimensions', similarity !== undefined && 'similarity']
      .filter(Boolean)
      .join(', ')
    throw new TypeError(
      `strands_mongodb: 'embeddingModel' selects the Atlas AutoEmbeddings path, where the deployment embeds the text, and ${also} selects the manual path, where you supply the vectors. They index different fields with different contents, so set one or the other. Remove 'embeddingModel' to embed client-side, or remove ${also} to let Atlas do it.`
    )
  }
  if (dimensions === undefined && similarity === undefined) {
    return { autoEmbed: true, model: model || DEFAULT_EMBEDDING_MODEL }
  }
  if (dimensions === undefined) {
    throw new TypeError(
      `strands_mongodb: 'similarity' is set but 'embeddingDimensions' is not, and a vector index cannot be created without the vector length. Set 'embeddingDimensions' to the length your embedding model produces, or remove 'similarity' to use Atlas AutoEmbeddings.`
    )
  }
  if (similarity === undefined) {
    throw new TypeError(
      `strands_mongodb: 'embeddingDimensions' is set but 'similarity' is not. There is no default: the right metric is a property of your embeddings, and the wrong one returns plausible neighbours that are the wrong neighbours. Set one of ${similarities}.`
    )
  }
  if (!(dimensions >= 1 && dimensions <= MAX_DIMENSIONS)) {
    throw new RangeError(
      `strands_mongodb: 'embeddingDimensions' is ${dimensions}, and Atlas requires a value within bounds [1..${MAX_DIMENSIONS}]. Set it to the length your embedding model produces.`
    )
  }
  if (!(SIMILARITIES as readonly string[]).includes(similarity)) {
    throw new TypeError(
      `strands_mongodb: 'similarity' is '${similarity}', which Atlas does not accept. Choose one of ${similarities}.`
    )
  }
  return { autoEmbed: false, dimensions, similarity }
}

/**
 * Lists every path the vector index declares filterable. Atlas rejects two `filter` entries on one path.
 *
 * @param extra - The config's `filterFields`
 * @returns `scope` and `store_name`, then the caller's fields in order, without duplicates
 */
export function declaredFilterFields(extra: Iterable<string>): string[] {
  return [...new Set([...BAKED_IN_FILTER_FIELDS, ...extra])]
}

/**
 * Builds the Atlas Vector Search index definition for the `memory` collection.
 *
 * @param mode - The resolved path, from {@link vectorMode}
 * @param options - Field names, and extra filter paths beyond `scope` and `store_name`
 * @returns A definition with the vector field first and every filter path after it
 */
export function vectorIndexDefinition(
  mode: VectorMode,
  options: { textField?: string; vectorField?: string; filterFields?: Iterable<string> } = {}
): Document {
  const { textField = CONTENT_FIELD, vectorField = VECTOR_FIELD, filterFields = [] } = options
  const first = mode.autoEmbed
    ? { type: 'autoEmbed', path: textField, model: mode.model, modality: 'text' }
    : { type: 'vector', path: vectorField, numDimensions: mode.dimensions, similarity: mode.similarity }
  return {
    fields: [first, ...declaredFilterFields(filterFields).map((path) => ({ type: 'filter', path }))],
  }
}

/**
 * Builds the Atlas Search full-text index definition. `dynamic: false` indexes only the text field.
 *
 * @param options - The field to map as a string
 * @returns The definition
 */
export function textIndexDefinition(options: { textField?: string } = {}): Document {
  const { textField = CONTENT_FIELD } = options
  return { mappings: { dynamic: false, fields: { [textField]: [{ type: 'string' }] } } }
}

function runCommand(command: Document): string {
  return `db.runCommand(${JSON.stringify(command)})`
}

/** One ordinary index: what to create, and what makes an existing index count as it. */
export class IndexSpec {
  /** Name used when creating the index. Never used to find one: the server's identity is keys plus collation. */
  readonly name: string
  /** The key list, in order, that existing indexes are matched on. */
  readonly keys: Array<[string, 1 | -1]>
  /** Every option this package asks for, and so every option compared against an existing index. */
  readonly options: Document
  /** Whether every key holds only BSON dates, so a collation cannot change how the index compares. */
  readonly dateOnly: boolean

  constructor(options: { name: string; keys: Array<[string, 1 | -1]>; options?: Document; dateOnly?: boolean }) {
    this.name = options.name
    this.keys = options.keys
    this.options = options.options ?? {}
    this.dateOnly = options.dateOnly ?? false
  }

  /**
   * Builds the driver's description of this index.
   *
   * @returns The keys in order, the name and every option
   */
  toDescription(): IndexDescription {
    return { key: Object.fromEntries(this.keys), name: this.name, ...this.options }
  }

  /**
   * Renders the raw `createIndexes` command for an operator to run.
   *
   * @param collectionName - Collection the index belongs on
   * @returns A single-line `db.runCommand(...)` whose argument is valid JSON
   */
  creationCommand(collectionName: string): string {
    return runCommand({ createIndexes: collectionName, indexes: [this.toDescription()] })
  }
}

/**
 * Renders the command that removes a conflicting ordinary index. Encoded, since the name comes from the deployment.
 *
 * @param collectionName - Collection the index sits on
 * @param indexName - Name the deployment reported for it
 * @returns A single-line `db.runCommand(...)` whose argument is valid JSON
 */
export function dropIndexCommand(collectionName: string, indexName: string): string {
  return runCommand({ dropIndexes: collectionName, index: indexName })
}

/** One Atlas Search index, `vectorSearch` or `search`, identified by its name. */
export class SearchIndexSpec {
  /** The index name, which for a search index is its identity. */
  readonly name: string
  /** The definition. An existing index must contain it. */
  readonly definition: Document
  /** The search index type. */
  readonly type: 'vectorSearch' | 'search'

  constructor(options: { name: string; definition: Document; type: 'vectorSearch' | 'search' }) {
    this.name = options.name
    this.definition = options.definition
    this.type = options.type
  }

  /**
   * Builds the driver's description of this index.
   *
   * @returns The name, the type and the definition
   */
  toDescription(): SearchIndexDescription {
    return { name: this.name, type: this.type, definition: this.definition }
  }

  /**
   * Renders the `createSearchIndexes` command for an operator to run.
   *
   * @param collectionName - Collection the index belongs on
   * @returns A single-line `db.runCommand(...)` whose argument is valid JSON
   */
  creationCommand(collectionName: string): string {
    return runCommand({ createSearchIndexes: collectionName, indexes: [this.toDescription()] })
  }

  /**
   * Renders the command that removes this search index.
   *
   * @param collectionName - Collection the index sits on
   * @returns A single-line `db.runCommand(...)` whose argument is valid JSON
   */
  dropCommand(collectionName: string): string {
    return runCommand({ dropSearchIndex: collectionName, name: this.name })
  }
}

// This package only writes `expires_at` as a BSON date, so a collation cannot change what this index compares.
function ttlSpec(): IndexSpec {
  return new IndexSpec({
    name: 'strands_expires_at_ttl',
    keys: [[EXPIRES_FIELD, 1]],
    options: { expireAfterSeconds: 0 },
    dateOnly: true,
  })
}

/**
 * Lists the ordinary indexes the `storage` collection needs. Keys live in `_id`, so only the TTL index remains.
 *
 * @returns One spec, the same for every store
 */
export function storageSpecs(): IndexSpec[] {
  return [ttlSpec()]
}

/**
 * Lists the ordinary indexes the `memory` collection needs. The TTL index is inert for documents without `expires_at`.
 *
 * @returns The unique partial dedup index, the recency index, and the TTL index
 */
export function memorySpecs(): IndexSpec[] {
  return [
    new IndexSpec({
      name: 'strands_scope_store_content_hash_unique',
      keys: [
        ['scope', 1],
        ['store_name', 1],
        ['content_hash', 1],
      ],
      // A unique index treats a missing field as `null`, so documents without a hash would collide.
      options: { unique: true, partialFilterExpression: { content_hash: { $exists: true } } },
    }),
    new IndexSpec({
      name: 'strands_scope_store_created_at',
      keys: [
        ['scope', 1],
        ['store_name', 1],
        ['created_at', -1],
      ],
    }),
    ttlSpec(),
  ]
}

/**
 * Lists the Atlas Search indexes the `memory` collection needs.
 *
 * @param config - The connection configuration
 * @returns The vector index first, then the full-text index
 * @throws Whatever {@link vectorMode} throws, unchanged
 */
export function memorySearchSpecs(config: MongoDBConfig): SearchIndexSpec[] {
  const mode = vectorMode(config)
  return [
    new SearchIndexSpec({
      name: config.vectorIndexName || DEFAULT_VECTOR_INDEX_NAME,
      definition: vectorIndexDefinition(mode, { filterFields: config.filterFields ?? [] }),
      type: 'vectorSearch',
    }),
    new SearchIndexSpec({
      name: config.textIndexName || DEFAULT_TEXT_INDEX_NAME,
      definition: textIndexDefinition(),
      type: 'search',
    }),
  ]
}

/**
 * Embeds `text` and checks the length. The server silently leaves a wrong-length written vector out of the index.
 *
 * @param embedder - What embeds the text
 * @param text - The text to embed
 * @param options - The length the index declares, and the name of the setting that declared it
 * @returns The vector
 * @throws RangeError if the vector's length is not `dimensions`
 */
export async function embed(
  embedder: Embedder,
  text: string,
  options: { dimensions: number; setting: string }
): Promise<number[]> {
  const { dimensions, setting } = options
  const vector = await embedder.embed(text)
  if (vector.length !== dimensions) {
    throw new RangeError(
      `strands_mongodb: the embedder returned a ${vector.length}-dimension vector and '${setting}' is ${dimensions}. Set '${setting}' to the length the embedding model produces.`
    )
  }
  return vector
}
