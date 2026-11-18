import { type Logger, StorageError } from '@strands-agents/sdk'
import type { Collection, Document } from 'mongodb'
import { COLLECTION_ABSENT, failure, guard, namespaceOf, serverCode } from './driver-errors.js'
import { dropIndexCommand, type IndexSpec, type SearchIndexSpec, SIMPLE_LOCALE } from './index-specs.js'
import { logFields } from './logging.js'
import { annotate, namespaceAttributes, open, type OpenSpan, span, type SpanEnd } from './telemetry.js'

const POLL_INTERVAL_MS = 500

// Server code for a `create` that lost a race with another creator.
const NAMESPACE_EXISTS = 48

/** A search index exists but did not report `READY` within the timeout. */
export class SearchIndexNotReady extends StorageError {}

// The caller aborted the wait. Not exported: `ensure` ends its span unset for it, then rethrows it.
class WaitAbandoned extends StorageError {}

/** What {@link ensure} is asked to bring about. */
export interface EnsureOptions {
  /** Ordinary and TTL indexes. */
  ordinary?: IndexSpec[]
  /** Atlas Search indexes. */
  search?: SearchIndexSpec[]
  /** Whether missing indexes may be created. `false` verifies, and still waits for a build someone else started. */
  create: boolean
  /** Seconds to wait for search builds, in total across all of them. The default, `0`, reads each status once. */
  timeout?: number
  /** Receives the `creating_indexes`, `creating_search_index` and `search_index_status` events. */
  logger: Logger
  /** Ends the search index work early, within one poll round, when the caller no longer needs its outcome. */
  signal?: AbortSignal | undefined
}

/**
 * Brings a collection's indexes to the declared state. Never drops or alters an index: a conflict is reported.
 *
 * @param collection - The collection to index. Its `db` creates the collection before a search index is created
 * @param options - The specs, whether to create, the wait budget and the logger
 * @throws StorageError if an existing index conflicts, a search build failed, an index is missing and `create` is
 * `false`, a driver call fails, or `signal` aborts
 * @throws SearchIndexNotReady if a build outlives `timeout`
 */
export async function ensure(collection: Collection, options: EnsureOptions): Promise<void> {
  const { ordinary = [], search = [], create, timeout = 0, logger, signal } = options
  const attributes = {
    ...namespaceAttributes(collection),
    'strands_mongodb.indexes.mode': create ? 'ensure' : 'verify',
  }
  // Returned and rethrown outside the span, so the caller's lost interest is not recorded as an error.
  const abandoned = await span('strands_mongodb.indexes.ensure', attributes, async () => {
    let created = 0
    try {
      if (ordinary.length > 0) created += await ensureOrdinary(collection, ordinary, create, logger)
      if (search.length > 0) {
        checkAborted(collection, search, signal)
        const { missing, building } = await readSearchIndexes(collection, search)
        if (missing.length > 0) {
          if (!create) throw absent(collection, missing)
          // `createSearchIndexes` on a missing collection fails with code 26, unlike `createIndexes`.
          await createCollection(collection)
        }
        for (const spec of missing) {
          await createSearchIndex(collection, spec, logger)
          created += 1
        }
        await waitUntilReady(collection, [...building, ...missing], { timeout, logger, signal })
      }
      return undefined
    } catch (error) {
      if (!(error instanceof WaitAbandoned)) throw error
      annotate('strands_mongodb.indexes.outcome', 'abandoned')
      return error
    } finally {
      annotate('strands_mongodb.indexes.created', created)
    }
  })
  if (abandoned !== undefined) throw abandoned
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value)
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

function absent(collection: Collection, missing: Array<IndexSpec | SearchIndexSpec>): StorageError {
  const names = missing.map((spec) => spec.name).join(', ')
  const commands = missing.map((spec) => spec.creationCommand(collection.collectionName)).join('\n')
  return new StorageError(
    `strands_mongodb: ${missing.length} required index(es) are absent from ${namespaceOf(collection)} and ensureIndexes is false: ${names}. Run these, then retry once any search index reports READY:\n${commands}`
  )
}

// Ordinary indexes match on their key list: the server rejects a second index over the same keys and collation.
async function ensureOrdinary(
  collection: Collection,
  specs: IndexSpec[],
  create: boolean,
  logger: Logger
): Promise<number> {
  const namespace = namespaceOf(collection)
  const present = await readIndexes(collection)

  const missing: IndexSpec[] = []
  for (const spec of specs) {
    const keys = JSON.stringify(spec.keys)
    const matches = present.filter(
      (found) => JSON.stringify(isRecord(found.key) ? Object.entries(found.key) : []) === keys
    )
    if (matches.length === 0) missing.push(spec)
    else checkMatches(collection, spec, matches)
  }

  if (missing.length === 0) return 0
  if (!create) throw absent(collection, missing)

  const names = missing.map((spec) => spec.name).join(', ')
  logger.info(
    `strands_mongodb: creating ${missing.length} index(es) on ${namespace}: ${names} | ${logFields('creating_indexes', { namespace })}`
  )
  // One call for all of them. The server tolerates concurrent identical creates.
  await guard(collection.createIndexes(missing.map((spec) => spec.toDescription())), `creating indexes on ${namespace}`)
  return missing.length
}

// `listIndexes` on a collection that does not exist yet fails with code 26 in the Node driver.
async function readIndexes(collection: Collection): Promise<Document[]> {
  try {
    return await collection.listIndexes().toArray()
  } catch (error) {
    if (serverCode(error) === COLLECTION_ABSENT) return []
    throw failure(`reading indexes on ${namespaceOf(collection)}`, error)
  }
}

// The locale of a reported collation that does not compare byte for byte. The server does not store a simple one.
function foldingLocale(found: Document): string | undefined {
  const collation: unknown = found.collation
  if (!isRecord(collation)) return undefined
  const locale = String(collation.locale)
  return locale === SIMPLE_LOCALE ? undefined : locale
}

// Several indexes can share a key list, since identity is keys plus collation. One usable match is enough, but a
// unique index under a folding collation is refused wherever it appears: the server enforces it regardless.
function checkMatches(collection: Collection, spec: IndexSpec, matches: Document[]): void {
  let usable = false
  let refusal: StorageError | undefined
  for (const found of matches) {
    const locale = spec.dateOnly ? undefined : foldingLocale(found)
    if (locale !== undefined && found.unique) {
      throw conflict(collection, spec, found, `is unique under the case-folding collation '${locale}'`)
    }
    const reason =
      locale === undefined
        ? optionMismatch(spec, found)
        : `has the collation '${locale}' where byte-for-byte comparison is needed`
    if (reason === undefined) usable = true
    else refusal ??= conflict(collection, spec, found, reason)
  }
  if (!usable && refusal !== undefined) throw refusal
}

// Only options the spec sets are compared; `v`, `background`, `hidden` and anything else are ignored.
function optionMismatch(spec: IndexSpec, found: Document): string | undefined {
  for (const [option, wanted] of Object.entries(spec.options)) {
    if (option in found && sameValue(found[option], wanted)) continue
    const actual = option in found ? render(found[option]) : 'absent'
    return `has ${option} ${actual} where ${render(wanted)} is needed`
  }
  return undefined
}

function conflict(collection: Collection, spec: IndexSpec, found: Document, reason: string): StorageError {
  const name = collection.collectionName
  const foundName = String(found.name)
  return new StorageError(
    `strands_mongodb: the index '${foundName}' on ${namespaceOf(collection)} covers the keys of '${spec.name}' but ${reason}. Drop it, then create '${spec.name}' if it is absent:\n${dropIndexCommand(name, foundName)}\n${spec.creationCommand(name)}`
  )
}

function searchConflict(collection: Collection, spec: SearchIndexSpec, reason: string): StorageError {
  const name = collection.collectionName
  return new StorageError(
    `strands_mongodb: the ${spec.type} index '${spec.name}' on ${namespaceOf(collection)} ${reason}. Drop and recreate it:\n${spec.dropCommand(name)}\n${spec.creationCommand(name)}`
  )
}

// Reported rather than recreated: the same definition over a failed build is accepted but does not restart it.
function failedBuild(collection: Collection, spec: SearchIndexSpec, document: Document): StorageError {
  return searchConflict(collection, spec, `reports status FAILED with detail ${render(document.statusDetail ?? [])}`)
}

type Readiness = 'ready' | 'building' | 'failed'

// Unknown statuses read as building, never ready.
function readiness(status: string): Readiness {
  if (status === 'READY') return 'ready'
  if (status === 'FAILED') return 'failed'
  return 'building'
}

function statusOf(document: Document, fallback: string): string {
  const status: unknown = document.status
  return typeof status === 'string' ? status : fallback
}

// Search indexes match by name.
async function readSearchIndexes(
  collection: Collection,
  specs: SearchIndexSpec[]
): Promise<{ missing: SearchIndexSpec[]; building: SearchIndexSpec[] }> {
  const missing: SearchIndexSpec[] = []
  const building: SearchIndexSpec[] = []
  for (const spec of specs) {
    const document = await readSearchIndex(collection, spec.name)
    if (document === undefined) {
      missing.push(spec)
      continue
    }
    const state = readiness(statusOf(document, ''))
    if (state === 'failed') throw failedBuild(collection, spec, document)
    checkDefinition(collection, spec, document)
    if (state !== 'ready') building.push(spec)
  }
  return { missing, building }
}

async function readSearchIndex(collection: Collection, name: string): Promise<Document | undefined> {
  try {
    const documents: Document[] = await collection.listSearchIndexes(name).toArray()
    return documents[0]
  } catch (error) {
    // `$listSearchIndexes` does not hide an absent collection the way `listIndexes` does in other drivers.
    if (serverCode(error) === COLLECTION_ABSENT) return undefined
    throw failure(`reading search index '${name}' on ${namespaceOf(collection)}`, error)
  }
}

async function createCollection(collection: Collection): Promise<void> {
  try {
    await collection.db.createCollection(collection.collectionName)
  } catch (error) {
    if (serverCode(error) === NAMESPACE_EXISTS) return
    throw failure(`creating the collection ${namespaceOf(collection)}`, error)
  }
}

async function createSearchIndex(collection: Collection, spec: SearchIndexSpec, logger: Logger): Promise<void> {
  const namespace = namespaceOf(collection)
  logger.info(
    `strands_mongodb: creating ${spec.type} index '${spec.name}' on ${namespace} | ${logFields('creating_search_index', { namespace })}`
  )
  await guard(
    collection.createSearchIndex(spec.toDescription()),
    `creating search index '${spec.name}' on ${namespace}`
  )
}

// Containment rather than equality: mongot rewrites a `search` index's `latestDefinition`.
function checkDefinition(collection: Collection, spec: SearchIndexSpec, document: Document): void {
  const definition: unknown = document.latestDefinition
  if (definition === undefined || definition === null) return
  const gap = definitionGap(spec.definition, definition)
  if (gap !== undefined) throw searchConflict(collection, spec, `does not cover its declared definition: ${gap}`)
}

function definitionGap(wanted: unknown, found: unknown, path = 'definition'): string | undefined {
  if (Array.isArray(wanted)) {
    // mongot collapses a one-element list into the object it held.
    if (wanted.length === 1 && isRecord(found)) return definitionGap(wanted[0], found, path)
    if (!Array.isArray(found)) return `${path} is ${render(found)}, declared as the list ${render(wanted)}`
    for (const entry of wanted) {
      if (!found.some((candidate) => definitionGap(entry, candidate, path) === undefined)) {
        return `nothing at ${path} covers the declared ${render(entry)}`
      }
    }
    return undefined
  }
  if (isRecord(wanted)) {
    if (!isRecord(found)) return `${path} is ${render(found)}, declared as the object ${render(wanted)}`
    for (const [key, value] of Object.entries(wanted)) {
      if (!(key in found)) return `${path}.${key} is absent, declared as ${render(value)}`
      const gap = definitionGap(value, found[key], `${path}.${key}`)
      if (gap !== undefined) return gap
    }
    return undefined
  }
  return wanted === found ? undefined : `${path} is ${render(found)}, declared as ${render(wanted)}`
}

function checkAborted(collection: Collection, specs: SearchIndexSpec[], signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const names = specs.map((spec) => spec.name).join(', ')
  throw new WaitAbandoned(
    `strands_mongodb: the wait for search index(es) ${names} on ${namespaceOf(collection)} was abandoned by the caller. Any build continues on the server.`,
    { cause: signal.reason }
  )
}

interface Wait {
  spec: SearchIndexSpec
  span: OpenSpan
  status?: string
}

// Every pending index is read each round, so a failure or an abort surfaces within one interval.
async function waitUntilReady(
  collection: Collection,
  specs: SearchIndexSpec[],
  options: { timeout: number; logger: Logger; signal: AbortSignal | undefined }
): Promise<void> {
  const { timeout, logger, signal } = options
  const deadline = Date.now() + timeout * 1000
  const attributes = namespaceAttributes(collection)
  let pending: Wait[] = specs.map((spec) => ({ spec, span: open('strands_mongodb.indexes.wait', attributes) }))
  // How the spans still open end: with no outcome when a sibling's failure or an abort cuts them short.
  let end: SpanEnd = {}
  const settle = (wait: Wait, result: SpanEnd): void => {
    wait.span.end(result)
    pending = pending.filter((other) => other !== wait)
  }
  try {
    for (;;) {
      checkAborted(
        collection,
        pending.map((wait) => wait.spec),
        signal
      )
      for (const wait of pending) {
        const ready = await isReady(collection, wait, logger).catch((error: unknown) => {
          settle(wait, { error })
          throw error
        })
        // Ended here, so a ready index's span does not run on while its siblings build.
        if (ready) settle(wait, { attributes: { 'strands_mongodb.indexes.outcome': 'ready' } })
      }
      if (pending.length === 0) return
      if (Date.now() >= deadline) {
        end = { attributes: { 'strands_mongodb.indexes.outcome': 'timed_out' } }
        const stuck = pending.map((wait) => `${wait.spec.name} is ${wait.status}`).join(', ')
        throw new SearchIndexNotReady(
          `strands_mongodb: waited ${timeout}s for ${pending.length} search index(es) on ${namespaceOf(collection)} to report READY: ${stuck}. Retry to keep waiting, or read the status with db.${collection.collectionName}.getSearchIndexes().`
        )
      }
      await sleep(POLL_INTERVAL_MS, signal)
    }
  } finally {
    for (const wait of pending) wait.span.end(end)
  }
}

async function isReady(collection: Collection, wait: Wait, logger: Logger): Promise<boolean> {
  const { spec } = wait
  const namespace = namespaceOf(collection)
  const document = await readSearchIndex(collection, spec.name)
  // A vanished index reads as building: someone else dropped it, and recreating it would race whoever did.
  const status = document === undefined ? 'absent' : statusOf(document, 'unreported')
  if (status !== wait.status) {
    logger.info(
      `strands_mongodb: search index '${spec.name}' on ${namespace} is ${status} | ${logFields('search_index_status', { namespace })}`
    )
    wait.status = status
  }
  const state = readiness(status)
  if (state === 'failed') throw failedBuild(collection, spec, document ?? {})
  if (state !== 'ready') return false
  // Rechecked here: the index may have been recreated during the wait, and one this call created was never read.
  checkDefinition(collection, spec, document ?? {})
  return true
}

// Resolves early on abort, so the next round's check sees it without waiting out the interval.
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
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
