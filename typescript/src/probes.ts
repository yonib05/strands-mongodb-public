import { type Logger, StorageError } from '@strands-agents/sdk'
import { type Collection, type CollectionInfo, type Document, MongoError } from 'mongodb'
import { COLLECTION_ABSENT, failure, guard, namespaceOf, serverCode } from './driver-errors.js'
import { SIMPLE_LOCALE } from './index-specs.js'
import { logFields } from './logging.js'
import { type Attributes, namespaceAttributes, span } from './telemetry.js'

// First `mongod` major version with `$rankFusion` over `$vectorSearch` inputs: 8.0, not 8.1.
const RANK_FUSION_MIN_MAJOR = 8

// Codes from listing search indexes that mean the deployment has no Atlas Search.
const SEARCH_UNSUPPORTED_CODES: ReadonlySet<number> = new Set([31082, 115, 6047401])

/** What {@link searchSupport} found. `code` is set only when `available` is `false`. */
export interface SearchSupport {
  /** Whether the deployment runs Atlas Search. */
  available: boolean
  /** The server error code that said it does not. */
  code?: number
}

function probeAttributes(collection: Collection, probe: 'search' | 'rank_fusion' | 'collation'): Attributes {
  return { ...namespaceAttributes(collection), 'strands_mongodb.indexes.probe': probe }
}

/**
 * Reports whether this deployment can run Atlas Search. `buildInfo` cannot tell, so this lists search indexes.
 *
 * @param collection - The collection whose deployment to probe. Need not exist
 * @returns `available: false` with the code only for a code that means no Atlas Search
 * @throws StorageError if the call fails for any other reason, so a bad password does not read as "no search"
 */
export function searchSupport(collection: Collection): Promise<SearchSupport> {
  return span('strands_mongodb.indexes.probe', probeAttributes(collection, 'search'), async () => {
    try {
      await collection.listSearchIndexes().toArray()
    } catch (error) {
      const code = serverCode(error)
      if (code !== undefined && SEARCH_UNSUPPORTED_CODES.has(code)) return { available: false, code }
      // An absent collection still means the call worked, so search is available.
      if (code !== COLLECTION_ABSENT) {
        throw failure(`probing Atlas Search support on ${namespaceOf(collection)}`, error)
      }
    }
    return { available: true }
  })
}

/**
 * Reports whether this deployment can run `$rankFusion`, a `mongod` stage, from `buildInfo`'s `versionArray`.
 *
 * @param collection - Any collection on the deployment. Need not exist
 * @param logger - Receives the `rank_fusion_probe_failed` event when `buildInfo` fails
 * @returns `true` for major version 8 or later; `false` on any driver failure, since a wrong `true` fails every search
 */
export function rankFusionSupport(collection: Collection, logger: Logger): Promise<boolean> {
  return span('strands_mongodb.indexes.probe', probeAttributes(collection, 'rank_fusion'), async () => {
    let buildInfo: Document
    try {
      buildInfo = await collection.db.command({ buildInfo: 1 })
    } catch (error) {
      if (!(error instanceof MongoError)) throw error
      const namespace = namespaceOf(collection)
      logger.debug(
        `strands_mongodb: buildInfo failed on ${namespace}, so $rankFusion is treated as unsupported: ${error.message} | ${logFields('rank_fusion_probe_failed', { namespace })}`
      )
      return false
    }
    const version: unknown = buildInfo.versionArray
    const major: unknown = Array.isArray(version) ? version[0] : undefined
    return typeof major === 'number' && Number.isInteger(major) && major >= RANK_FUSION_MIN_MAJOR
  })
}

/**
 * Refuses a collection whose default collation is not binary, which would let one namespace read another's keys.
 *
 * @param collection - The collection about to be operated on
 * @returns `true` if the collection compares strings byte by byte; `false` if it does not exist yet
 * @throws StorageError naming the locale if the collation is not `simple`, or if reading it fails
 */
export async function requireBinaryComparison(collection: Collection): Promise<boolean> {
  const { exists, locale } = await readCollation(collection)
  if (locale === undefined || locale === SIMPLE_LOCALE) return exists
  throw new StorageError(
    `strands_mongodb: the collection ${namespaceOf(collection)} has the default collation '${locale}', and keys need byte-for-byte comparison. Use a collection created without a collation, or with {collation: {locale: '${SIMPLE_LOCALE}'}}.`
  )
}

// The server does not store a simple collation, so an uncollated collection reports no locale.
function readCollation(collection: Collection): Promise<{ exists: boolean; locale?: string }> {
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
