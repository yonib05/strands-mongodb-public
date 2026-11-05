import type { AttributeValue } from '@opentelemetry/api'
import { type Logger, StorageError } from '@strands-agents/sdk'
import type { Embedder } from '@strands-agents/sdk/storage/search'
import {
  type Collection,
  type CollectionInfo,
  type Document,
  type IndexDescription,
  MongoServerError,
  type SearchIndexDescription,
} from 'mongodb'
import { BAKED_IN_FILTER_FIELDS } from './filter.js'
import { logFields } from './logging.js'
import { annotate, type Attribute, open, type OpenSpan, span } from './telemetry.js'
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

// Server code for a namespace that does not exist. Not an error when reading indexes.
const COLLECTION_ABSENT = 26

// Server code for a `create` that lost a race with another creator.
const NAMESPACE_EXISTS = 48

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

/** What {@link searchSupport} found. `code` is set only when `available` is `false`. */
export interface SearchSupport {
  /** Whether the deployment runs Atlas Search. */
  available: boolean
  /** The server error code that said it does not, so a message can name the one this server sent. */
  code?: number
}

/** What `listCollections` says about one collection's default collation. */
export interface CollationReport {
  /** Whether the server reported the collection at all. */
  exists: boolean
  /** The reported collation locale. Absent for an absent collection and for one without a collation. */
  locale?: string
}

/** A search index exists but did not report `READY` within the timeout. */
export class SearchIndexNotReady extends StorageError {}

/** What {@link ensure} is asked to bring about. */
export interface EnsureOptions {
  /** Ordinary and TTL indexes, from {@link storageSpecs} or {@link memorySpecs}. */
  ordinary?: IndexSpec[]
  /** Atlas Search indexes, from {@link memorySearchSpecs}. */
  search?: SearchIndexSpec[]
  /** Whether missing indexes may be created. `false` verifies, and still waits for a build someone else started. */
  create: boolean
  /** Seconds to wait for search builds, in total across all of them. `0` reads each status once. */
  timeout: number
  /** Receives the `creating_indexes`, `creating_search_index` and `search_index_status` events. */
  logger: Logger
  /** Ends a wait for a build early, within one poll round, when the caller no longer needs its outcome. */
  signal?: AbortSignal | undefined
}

type Attributes = Partial<Record<Attribute, AttributeValue>>
type Probe = 'search' | 'rank_fusion' | 'collation'

/**
 * Reports whether this deployment can run Atlas Search at all. `buildInfo` cannot tell, so this lists search indexes.
 *
 * @param collection - The collection whose deployment to probe. Need not exist
 * @param _logger - Unused; the probe logs nothing and keeps the signature the other index calls have
 * @returns `available: false` with the code only for a code in {@link SEARCH_UNSUPPORTED_CODES}
 * @throws StorageError if the call fails for any other reason, so a bad password does not read as "no search"
 */
export function searchSupport(collection: Collection, _logger: Logger): Promise<SearchSupport> {
  return span('strands_mongodb.indexes.probe', probeAttributes(collection, 'search'), async () => {
    try {
      await collection.listSearchIndexes().toArray()
    } catch (error) {
      const code = serverCode(error)
      if (code !== undefined && SEARCH_UNSUPPORTED_CODES.has(code)) return { available: false, code }
      // Code 26 (absent collection) still means the call worked, so search is available.
      if (code !== COLLECTION_ABSENT) {
        throw failure(`probing Atlas Search support on ${namespaceOf(collection)}`, error)
      }
    }
    return { available: true }
  })
}

/**
 * Reports whether the collection exists and what default collation it carries. The server does not store a simple one.
 *
 * @param collection - The collection to ask about. Need not exist
 * @param _logger - Unused; the probe logs nothing and keeps the signature the other index calls have
 * @returns `exists: false` for an absent collection; `exists: true` with no locale for an uncollated one
 * @throws StorageError if `listCollections` fails
 */
export function readCollation(collection: Collection, _logger: Logger): Promise<CollationReport> {
  return span('strands_mongodb.indexes.probe', probeAttributes(collection, 'collation'), async () => {
    const found = await guard(
      collection.db.listCollections<CollectionInfo>({ name: collection.collectionName }).toArray(),
      `reading the collation of ${namespaceOf(collection)}`
    )
    const first = found[0]
    if (first === undefined) return { exists: false }
    const locale: unknown = first.options?.collation?.locale
    return typeof locale === 'string' ? { exists: true, locale } : { exists: true }
  })
}

/**
 * Refuses a collection whose default collation is not binary. Keys live in `_id`, so a folding collation lets one
 * namespace read another's documents.
 *
 * @param collection - The collection about to be operated on
 * @param logger - Passed to {@link readCollation}
 * @returns `true` if the collection exists and compares strings byte by byte; `false` if it does not exist yet
 * @throws StorageError naming the locale if the collation is not `simple`, or if reading it fails
 */
export async function requireBinaryComparison(collection: Collection, logger: Logger): Promise<boolean> {
  const report = await readCollation(collection, logger)
  if (report.locale === undefined || report.locale === SIMPLE_LOCALE) return report.exists
  const name = collection.collectionName
  throw new StorageError(
    `strands_mongodb: the collection ${namespaceOf(collection)} was created with the collation '${report.locale}', and this package cannot store keys in a collection whose string comparison is not binary. Keys live in '_id': a read is an equality match on it, a prefix listing is a range over it, and a namespace is part of it, so a collation that folds case or accents lets one namespace read and delete another's documents, and makes two keys differing only in case collide on the unique '_id' index. A collation cannot be changed in place. Point this store at a collection created without one (the 'collection' argument), or recreate this one with db.createCollection(${JSON.stringify(name)}) and no collation, or with {collation: {locale: '${SIMPLE_LOCALE}'}}, which is binary comparison stated explicitly.`
  )
}

/**
 * Reports whether this deployment can run `$rankFusion`, a `mongod` stage, from `buildInfo`'s `versionArray`.
 * Every failure reads as `false`: a wrong `false` costs ranking quality, a wrong `true` fails every search.
 *
 * @param collection - Any collection on the deployment. Need not exist
 * @param _logger - Unused; the probe logs nothing and keeps the signature the other index calls have
 * @returns `true` if the server reports major version {@link RANK_FUSION_MIN_MAJOR} or later
 */
export function rankFusionSupport(collection: Collection, _logger: Logger): Promise<boolean> {
  return span('strands_mongodb.indexes.probe', probeAttributes(collection, 'rank_fusion'), async () => {
    let buildInfo: Document
    try {
      buildInfo = await collection.db.command({ buildInfo: 1 })
    } catch {
      return false
    }
    const version: unknown = buildInfo.versionArray
    const major: unknown = Array.isArray(version) ? version[0] : undefined
    return typeof major === 'number' && Number.isInteger(major) && major >= RANK_FUSION_MIN_MAJOR
  })
}

// Ordinary indexes match on their key list, since the server rejects a second index over the same keys whatever
// it is called; search indexes match by name. Nothing here drops or alters an existing index: a conflict is reported
// with the commands that resolve it, because the index may be serving queries this package knows nothing about.

/**
 * Brings a collection's indexes to the declared state, or explains what is stopping that. Safe to call on every
 * `initialize()`: when everything is in place it costs one read for the ordinary indexes plus one per search index.
 *
 * @param collection - The collection to index. Its `db` creates the collection before a search index is created
 * @param options - The specs, whether to create, the wait budget and the logger
 * @throws StorageError if an existing index conflicts with a declared one, a search build has failed, something is
 * missing and `create` is `false`, or a driver call fails; {@link SearchIndexNotReady} if a build outlives `timeout`
 */
export function ensure(collection: Collection, options: EnsureOptions): Promise<void> {
  const { ordinary = [], search = [], create, timeout, logger, signal } = options
  const attributes: Attributes = {
    ...namespaceAttributes(collection),
    'strands_mongodb.indexes.mode': create ? 'ensure' : 'verify',
  }
  // Mutated by the helpers, so the span still gets the count when one of them throws part way.
  const created = { count: 0 }
  return span('strands_mongodb.indexes.ensure', attributes, async () => {
    try {
      if (ordinary.length > 0) await ensureOrdinary(collection, ordinary, { create, created, logger })
      if (search.length > 0) await ensureSearch(collection, search, { create, timeout, created, logger, signal })
    } finally {
      annotate('strands_mongodb.indexes.created', created.count, logger)
    }
  })
}

function namespaceOf(collection: Collection): string {
  return `${collection.dbName}.${collection.collectionName}`
}

function namespaceAttributes(collection: Collection): Attributes {
  return { 'strands_mongodb.database': collection.dbName, 'strands_mongodb.collection': collection.collectionName }
}

function probeAttributes(collection: Collection, probe: Probe): Attributes {
  return { ...namespaceAttributes(collection), 'strands_mongodb.indexes.probe': probe }
}

function serverCode(error: unknown): number | undefined {
  return error instanceof MongoServerError && typeof error.code === 'number' ? error.code : undefined
}

function failure(what: string, error: unknown): StorageError {
  const reason = error instanceof Error ? error.message : String(error)
  return new StorageError(`strands_mongodb: ${what} failed: ${reason}`, { cause: error })
}

async function guard<T>(work: Promise<T>, what: string): Promise<T> {
  try {
    return await work
  } catch (error) {
    throw failure(what, error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue(a[key], b[key]))
}

function render(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

function keyListOf(found: Document): string {
  return JSON.stringify(isRecord(found.key) ? Object.entries(found.key) : [])
}

interface Progress {
  create: boolean
  created: { count: number }
  logger: Logger
}

async function ensureOrdinary(collection: Collection, specs: IndexSpec[], progress: Progress): Promise<void> {
  const namespace = namespaceOf(collection)
  const name = collection.collectionName
  const present = await readIndexes(collection, namespace)

  const missing: IndexSpec[] = []
  for (const spec of specs) {
    const keys = JSON.stringify(spec.keys)
    // Several indexes can share a key list (identity is keys plus collation), so every one of them is checked.
    const matches = present.filter((found) => keyListOf(found) === keys)
    if (matches.length === 0) missing.push(spec)
    else checkMatches(name, namespace, spec, matches)
  }

  if (missing.length === 0) return
  if (!progress.create) throw new StorageError(missingOrdinaryMessage(name, namespace, missing))

  const names = missing.map((spec) => spec.name).join(', ')
  progress.logger.info(
    `strands_mongodb: creating ${missing.length} index(es) on ${namespace}: ${names} | ${logFields('creating_indexes', { namespace })}`
  )
  // One call for all of them. The server tolerates concurrent identical creates.
  await guard(collection.createIndexes(missing.map((spec) => spec.toDescription())), `creating indexes on ${namespace}`)
  progress.created.count += missing.length
}

// Code 26 on a collection that does not exist yet: pymongo hides it, the Node driver does not.
async function readIndexes(collection: Collection, namespace: string): Promise<Document[]> {
  try {
    return await collection.listIndexes().toArray()
  } catch (error) {
    if (serverCode(error) === COLLECTION_ABSENT) return []
    throw failure(`reading indexes on ${namespace}`, error)
  }
}

// The locale of a reported collation that does not compare byte for byte. The server does not store a simple one.
function foldingLocale(found: Document): string | undefined {
  const collation: unknown = found.collation
  if (!isRecord(collation)) return undefined
  const locale = String(collation.locale)
  return locale === SIMPLE_LOCALE ? undefined : locale
}

// A unique index under a folding collation is refused wherever it appears; otherwise one usable match is enough.
function checkMatches(collectionName: string, namespace: string, spec: IndexSpec, matches: Document[]): void {
  if (!spec.dateOnly) {
    for (const found of matches) {
      const locale = foldingLocale(found)
      if (locale !== undefined && found.unique) {
        throw new StorageError(foldedConstraintMessage(collectionName, namespace, spec, String(found.name), locale))
      }
    }
  }
  const refusals = matches.map(
    (found) =>
      collationRefusal(collectionName, namespace, spec, found) ?? optionRefusal(collectionName, namespace, spec, found)
  )
  if (refusals.includes(undefined)) return
  throw new StorageError(refusals[0]!)
}

function remedy(collectionName: string, spec: IndexSpec, foundName: string): string {
  return `${dropIndexCommand(collectionName, foundName)}\n${spec.creationCommand(collectionName)}\n`
}

function foldedConstraintMessage(
  collectionName: string,
  namespace: string,
  spec: IndexSpec,
  foundName: string,
  locale: string
): string {
  return (
    `strands_mongodb: the index '${foundName}' on ${namespace} covers the keys ${render(spec.keys)} that '${spec.name}' needs, it is unique, and it was created with the collation '${locale}'. The server enforces that uniqueness on the folded values, so two records differing only in the case of those keys collide as one, and it goes on enforcing it whether or not a correctly collated index sits beside it, because an index's identity here is its keys and its collation together and the server keeps both indexes. This package queries and deduplicates with byte-for-byte comparison, so it cannot see that rule and cannot report it. Dropping this index is not this package's decision to make: it may be serving queries nothing here knows about. To resolve it, drop it, and create the declared index if it is not already there:\n` +
    remedy(collectionName, spec, foundName)
  )
}

function collationRefusal(
  collectionName: string,
  namespace: string,
  spec: IndexSpec,
  found: Document
): string | undefined {
  if (spec.dateOnly) return undefined
  const locale = foldingLocale(found)
  if (locale === undefined) return undefined
  const foundName = String(found.name)
  return (
    `strands_mongodb: the index '${foundName}' on ${namespace} covers the keys ${render(spec.keys)} that '${spec.name}' needs, but it was created with the collation '${locale}' and this package needs one that compares strings byte for byte. An index that folds case makes the rule it enforces the folded rule, which for '${spec.name}' means two records differing only in case collide as one, and a query that compares exactly cannot use it at all. The server would let a second index be created over these keys under a different collation, but that does not help: both would exist and both would be enforced. Dropping this one is not this package's decision to make: it may be serving queries nothing here knows about. To resolve it, drop the existing index and let the next call recreate it:\n` +
    remedy(collectionName, spec, foundName)
  )
}

// Only options this package sets are compared; `v`, `background`, `hidden` and anything else are ignored.
function optionRefusal(
  collectionName: string,
  namespace: string,
  spec: IndexSpec,
  found: Document
): string | undefined {
  for (const [option, wanted] of Object.entries(spec.options)) {
    if (option in found && sameValue(found[option], wanted)) continue
    const actual = option in found ? render(found[option]) : 'absent'
    const foundName = String(found.name)
    return (
      `strands_mongodb: the index '${foundName}' on ${namespace} covers the keys ${render(spec.keys)} that '${spec.name}' needs, but its ${option} is ${actual} and this package needs ${render(wanted)}. Creating a second index over the same keys under the same collation is rejected by the server whatever it is named, and dropping this one is not this package's decision to make: it may be serving queries nothing here knows about. To resolve it, drop the existing index and let the next call recreate it:\n` +
      remedy(collectionName, spec, foundName)
    )
  }
  return undefined
}

function missingOrdinaryMessage(collectionName: string, namespace: string, missing: IndexSpec[]): string {
  const commands = missing.map((spec) => spec.creationCommand(collectionName)).join('\n')
  const names = missing.map((spec) => spec.name).join(', ')
  return `strands_mongodb: ${missing.length} required index(es) are absent from ${namespace} and ensureIndexes is false, so nothing was created. Run these against the database as somebody holding the rights to, then call initialize() again:\n${commands}\nAbsent: ${names}.`
}

async function ensureSearch(
  collection: Collection,
  specs: SearchIndexSpec[],
  progress: Progress & { timeout: number; signal?: AbortSignal | undefined }
): Promise<void> {
  const namespace = namespaceOf(collection)
  const name = collection.collectionName

  const missing: SearchIndexSpec[] = []
  const waiting: SearchIndexSpec[] = []
  for (const spec of specs) {
    const document = await readSearchIndex(collection, spec.name, namespace)
    if (document === undefined) {
      missing.push(spec)
      continue
    }
    const state = readiness(statusOf(document, ''))
    if (state === 'failed') throw new StorageError(failedMessage(name, namespace, spec, document))
    checkDefinition(name, namespace, spec, document)
    if (state !== 'ready') waiting.push(spec)
  }

  if (missing.length > 0) {
    if (!progress.create) throw new StorageError(missingSearchMessage(name, namespace, missing))
    // `createSearchIndexes` on a missing collection fails with code 26, unlike `createIndexes`.
    await createCollection(collection, namespace)
    for (const spec of missing) {
      progress.logger.info(
        `strands_mongodb: creating ${spec.type} index '${spec.name}' on ${namespace} | ${logFields('creating_search_index', { namespace })}`
      )
      await guard(
        collection.createSearchIndex(spec.toDescription()),
        `creating search index '${spec.name}' on ${namespace}`
      )
      progress.created.count += 1
    }
    waiting.push(...missing)
  }

  if (waiting.length === 0) return
  const stuck = await waitUntilReady(collection, waiting, namespace, progress, progress.logger)
  if (stuck.length === 0) return
  throw new SearchIndexNotReady(
    `strands_mongodb: waited ${progress.timeout}s for ${stuck.length} search index(es) on ${namespace} to report READY and they did not: ${stuck.join(', ')}. BUILDING at this point means a build slower than the timeout. A store with a named searchType can call initialize() again to keep waiting; under 'auto' the store answers from its other tiers and tries this one again later. Any other status is worth reading directly with db.${name}.getSearchIndexes().`
  )
}

async function readSearchIndex(collection: Collection, name: string, namespace: string): Promise<Document | undefined> {
  try {
    const documents: Document[] = await collection.listSearchIndexes(name).toArray()
    return documents[0]
  } catch (error) {
    // Code 26: an absent collection has no indexes. `$listSearchIndexes` does not hide this the way `listIndexes` does.
    if (serverCode(error) === COLLECTION_ABSENT) return undefined
    throw failure(`reading search index '${name}' on ${namespace}`, error)
  }
}

function statusOf(document: Document, fallback: string): string {
  const status: unknown = document.status
  return typeof status === 'string' ? status : fallback
}

async function createCollection(collection: Collection, namespace: string): Promise<void> {
  try {
    await collection.db.createCollection(collection.collectionName)
  } catch (error) {
    // A lost race arrives as code 48, the outcome a check-then-act would have predicted.
    if (serverCode(error) === NAMESPACE_EXISTS) return
    throw failure(`creating the collection ${namespace}`, error)
  }
}

// Containment rather than equality: mongot rewrites a `search` index's `latestDefinition`.
function checkDefinition(collectionName: string, namespace: string, spec: SearchIndexSpec, document: Document): void {
  const definition: unknown = document.latestDefinition
  if (definition === undefined || definition === null) return
  const gap = definitionGap(spec.definition, definition)
  if (gap === undefined) return
  throw new StorageError(
    `strands_mongodb: the ${spec.type} index '${spec.name}' on ${namespace} already exists and its definition does not cover the one this package needs: ${gap}. Reported: ${render(definition)}. A search index cannot be redefined in place, and dropping it discards a build somebody may be querying, so the remedy is left here rather than taken:\n${spec.dropCommand(collectionName)}\n${spec.creationCommand(collectionName)}\n`
  )
}

function definitionGap(wanted: unknown, found: unknown, path = 'definition'): string | undefined {
  if (Array.isArray(wanted)) {
    // mongot collapses a one-element list into the object it held.
    if (wanted.length === 1 && isRecord(found)) return definitionGap(wanted[0], found, path)
    if (!Array.isArray(found))
      return `${path} is ${render(found)} where this package declared the list ${render(wanted)}`
    for (const entry of wanted) {
      if (!found.some((candidate) => definitionGap(entry, candidate, path) === undefined)) {
        return `${path} declares ${render(entry)} and nothing reported at ${path} covers it`
      }
    }
    return undefined
  }
  if (isRecord(wanted)) {
    if (!isRecord(found)) return `${path} is ${render(found)} where this package declared the object ${render(wanted)}`
    for (const [key, value] of Object.entries(wanted)) {
      if (!(key in found)) return `${path}.${key} is absent, and this package declared ${render(value)}`
      const gap = definitionGap(value, found[key], `${path}.${key}`)
      if (gap !== undefined) return gap
    }
    return undefined
  }
  return wanted === found ? undefined : `${path} is ${render(found)} where this package declared ${render(wanted)}`
}

// Reported rather than recreated: the same definition over a failed build is accepted but does not restart it.
function failedMessage(collectionName: string, namespace: string, spec: SearchIndexSpec, document: Document): string {
  const detail = render(document.statusDetail ?? [])
  return `strands_mongodb: the ${spec.type} index '${spec.name}' on ${namespace} reports status FAILED, so searches against it return nothing rather than an error. The server's detail: ${detail}. A failed build does not restart when the same definition is issued again, so it has to be dropped and recreated:\n${spec.dropCommand(collectionName)}\n${spec.creationCommand(collectionName)}\n`
}

function missingSearchMessage(collectionName: string, namespace: string, missing: SearchIndexSpec[]): string {
  const commands = missing.map((spec) => spec.creationCommand(collectionName)).join('\n')
  const names = missing.map((spec) => spec.name).join(', ')
  return `strands_mongodb: ${missing.length} required search index(es) are absent from ${namespace} and ensureIndexes is false, so nothing was created. A search against an absent index returns no results rather than an error, so this is reported instead of ignored. Run these, wait for each to report status READY, then call initialize() again:\n${commands}\nAbsent: ${names}.`
}

interface Waiting {
  spec: SearchIndexSpec
  span: OpenSpan
  last?: string
}

// Every pending index is read each round, so a failure surfaces within one interval whatever its siblings are
// doing. One span per index, opened before its first read and ended by the read that settles it. A timeout is the
// wait's outcome; the error belongs to `ensure`. An abort is checked once per round, so it too lands within one.
async function waitUntilReady(
  collection: Collection,
  specs: SearchIndexSpec[],
  namespace: string,
  budget: { timeout: number; signal?: AbortSignal | undefined },
  logger: Logger
): Promise<string[]> {
  const { timeout, signal } = budget
  const deadline = Date.now() + timeout * 1000
  const pending: Waiting[] = specs.map((spec) => ({
    spec,
    span: open('strands_mongodb.indexes.wait', namespaceAttributes(collection)),
  }))
  try {
    for (;;) {
      if (signal?.aborted) throw abandoned(pending, namespace, signal)
      for (const entry of [...pending]) {
        let ready: boolean
        try {
          ready = await readStatus(collection, entry, namespace, logger)
        } catch (error) {
          settle(pending, entry).fail(error)
          throw error
        }
        if (ready) {
          const ended = settle(pending, entry)
          ended.set('strands_mongodb.indexes.outcome', 'ready')
          ended.end()
        }
      }
      if (pending.length === 0) return []
      if (Date.now() >= deadline) {
        return pending.splice(0).map((entry) => {
          entry.span.set('strands_mongodb.indexes.outcome', 'timed_out')
          entry.span.end()
          return `${entry.spec.name} is ${entry.last}`
        })
      }
      await sleep(POLL_INTERVAL_SECONDS * 1000, signal)
    }
  } finally {
    // Abandoned because a sibling failed or the caller aborted: ended with no outcome, as Python's single span is on an error.
    for (const entry of pending) entry.span.end()
  }
}

function abandoned(pending: Waiting[], namespace: string, signal: AbortSignal): StorageError {
  const names = pending.map((entry) => entry.spec.name).join(', ')
  return new StorageError(
    `strands_mongodb: the wait for ${pending.length} search index(es) on ${namespace} to report READY was abandoned before they did: ${names}. The caller no longer needed the outcome; the builds themselves continue on the server.`,
    { cause: signal.reason }
  )
}

function settle(pending: Waiting[], entry: Waiting): OpenSpan {
  pending.splice(pending.indexOf(entry), 1)
  return entry.span
}

// Reads one index once: `true` when READY with a covering definition, `false` while building.
async function readStatus(collection: Collection, entry: Waiting, namespace: string, logger: Logger): Promise<boolean> {
  const { spec } = entry
  const document = await readSearchIndex(collection, spec.name, namespace)
  // A vanished index reads as building: someone else dropped it, and recreating it would race whoever did.
  const status = document === undefined ? 'absent' : statusOf(document, 'unreported')
  if (status !== entry.last) {
    logger.info(
      `strands_mongodb: search index '${spec.name}' on ${namespace} is ${status} | ${logFields('search_index_status', { namespace })}`
    )
    entry.last = status
  }
  const state = readiness(status)
  if (state === 'failed') {
    throw new StorageError(failedMessage(collection.collectionName, namespace, spec, document ?? {}))
  }
  if (state !== 'ready') return false
  // Rechecked here: the index may have been recreated during the wait, and one this call created was never read.
  checkDefinition(collection.collectionName, namespace, spec, document ?? {})
  return true
}

// Resolves early on abort, so the caller's next check sees it within the round rather than after the full interval.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}
