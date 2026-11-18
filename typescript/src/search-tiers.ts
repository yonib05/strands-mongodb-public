import { type Logger, StorageError } from '@strands-agents/sdk'
import type { Collection } from 'mongodb'
import type { Capabilities } from './client.js'
import { ensure, SearchIndexNotReady } from './ensure-indexes.js'
import type { SearchIndexSpec } from './index-specs.js'
import { logFields } from './logging.js'
import { annotate } from './telemetry.js'
import type { ResolvedSearchType, SearchType, VectorMode } from './types.js'

/** Delay in seconds before a search tier skipped under `auto` is tried again, inside the first store call after it. */
export const TIER_RETRY_SECONDS = 60

/** Ceiling in seconds on that delay, which doubles after each retry that still finds the tier missing. */
export const TIER_RETRY_MAX_SECONDS = 3600

/** A configured score bound, which keeps `auto` off the hybrid tier because fused scores are on another scale. */
export interface ScoreBound {
  name: 'minScore' | 'maxScore'
  value: number
}

/** What a {@link SearchTiers} is built from. */
export interface SearchTiersOptions {
  /** The `db.coll` that messages and log lines name. */
  namespace: string
  searchType: SearchType
  mode: VectorMode
  specs: { vector: SearchIndexSpec; text: SearchIndexSpec }
  /** Whether a missing search index may be created. */
  create: boolean
  /** Seconds a named tier, and the first search under `auto`, waits for a build. */
  timeout: number
  bound: ScoreBound | undefined
  logger: Logger
}

/** The tier chosen for one query, with the query keys that tier reads. */
export type PickedTier =
  | { tier: 'hybrid'; text: string; vector: number[] | undefined }
  | { tier: 'vector'; text: string | undefined; vector: number[] | undefined }
  | { tier: 'text'; text: string }

/** Which search tiers of one memory store can answer, and when a skipped one is tried again. */
export class SearchTiers {
  // Vector first, the order `auto` falls back through. A named type keeps only its own tier; `hybrid` keeps both.
  private readonly _specs: Array<['vector' | 'text', SearchIndexSpec]>
  private _prepared: readonly ResolvedSearchType[] = []
  private _capabilities: Capabilities | undefined
  private _warnedBelowVector = false
  // Epoch milliseconds of the next retry of a skipped tier, or `undefined` when none is skipped.
  private _retryAt: number | undefined
  private _retryDelay = TIER_RETRY_SECONDS
  private _waited = false
  // The first search's wait for a build, shared by the searches that arrive during it.
  private _wait: Promise<void> | undefined

  constructor(private readonly _options: SearchTiersOptions) {
    const { searchType, specs } = _options
    const all: Array<['vector' | 'text', SearchIndexSpec]> = [
      ['vector', specs.vector],
      ['text', specs.text],
    ]
    this._specs = searchType === 'auto' || searchType === 'hybrid' ? all : all.filter(([tier]) => tier === searchType)
  }

  /** The tiers that can answer, in preference order. Empty after `prepare()` means none is ready or there is no Atlas Search. */
  get prepared(): readonly ResolvedSearchType[] {
    return this._prepared
  }

  /** Whether a tier skipped under `auto` is due for another try. */
  get retryDue(): boolean {
    return this._retryAt !== undefined && Date.now() >= this._retryAt
  }

  /**
   * Creates or verifies the search indexes once. `auto` reads each status without waiting; a named type waits.
   *
   * @param collection - The store's collection
   * @param capabilities - What the deployment's probe reported
   * @throws StorageError if a named tier cannot be prepared, or under `auto` every tier is refused
   */
  async prepare(collection: Collection, capabilities: Capabilities): Promise<void> {
    this._capabilities = capabilities
    if (!capabilities.search) return
    const timeout = this._options.searchType === 'auto' ? 0 : this._options.timeout
    this._prepared = await this._ensure(collection, { timeout })
    if (this._missingATier()) this._retryAt = Date.now() + this._retryDelay * 1000
  }

  /**
   * Tries the skipped tiers again. A retry that fails, or still finds one missing, keeps the tiers and doubles the delay.
   *
   * @param collection - The store's collection
   */
  retry(collection: Collection): Promise<void> {
    return this._retry(collection, { afterTimeout: false })
  }

  /**
   * Waits for the first tier to finish building, once: only while no tier is prepared and none has been waited for.
   *
   * @param collection - The store's collection
   */
  async waitForFirst(collection: Collection): Promise<void> {
    if (this._prepared.length > 0 || this._capabilities?.search !== true || this._waited) return
    this._wait ??= this._waitForTheFirstReady(collection).finally(() => {
      this._wait = undefined
    })
    await this._wait
  }

  /**
   * Chooses the first prepared tier, in preference order, that fits the query's keys.
   *
   * @param text - The query's `text`, if set
   * @param vector - The query's `vector`, if set or embedded
   * @returns The tier and the keys it reads
   * @throws TypeError if no prepared tier fits the keys
   * @throws StorageError if no tier is prepared
   */
  pick(text: string | undefined, vector: number[] | undefined): PickedTier {
    const { namespace, mode } = this._options
    const prepared = this._prepared
    if (text !== undefined && vector !== undefined && !prepared.includes('hybrid')) {
      // Thrown rather than answered from one tier, which would silently ignore one of the two keys.
      throw new TypeError(
        `strands_mongodb: this query sets both 'text' and 'vector', which only the hybrid tier reads, and the hybrid tier is not available on ${namespace}. The tiers that are: ${prepared.join(', ') || 'none'}. Drop one of the two keys to use one of them, or see the initialization log for why the fused tier was not offered.`
      )
    }

    if (prepared.length === 0) {
      const capabilities = this._capabilities
      if (capabilities === undefined || !capabilities.search) {
        // A phrase rather than a bare code, because with no cached probe there is no code to name.
        const code = capabilities?.noSearchCode
        const evidence = code === undefined ? 'no probe result cached' : `server error code ${code}`
        throw new StorageError(
          `strands_mongodb: cannot search ${namespace} because this deployment does not run Atlas Search. Its capability probe came back with ${evidence}, and this package has no tier that answers without a search process, so there is nothing to fall back to. Writes still work, which is why initialize() only warned. Point 'connectionString' at MongoDB Atlas, or at a local Atlas deployment started with 'atlas deployments setup --type local'.`
        )
      }
      throw new StorageError(
        `strands_mongodb: 'searchType' is 'auto' and no search tier on ${namespace} was ready within 'indexReadyTimeout', so no query can be answered yet. Each tier's status is logged above. The tiers are retried with backoff, and searches raise until one is ready.`
      )
    }

    // The key the vector tier reads: AutoEmbeddings embeds `text`, the manual path takes `vector`.
    const vectorKey = mode.autoEmbed ? text : vector
    for (const tier of prepared) {
      // Hybrid needs `text` for `$search` and the vector path's own key, which with AutoEmbeddings is `text` again.
      if (tier === 'hybrid' && text !== undefined && vectorKey !== undefined) return { tier, text, vector }
      if (tier === 'text' && text !== undefined) return { tier, text }
      if (tier === 'vector' && vectorKey !== undefined) return { tier, text, vector }
    }

    const [needed, because] = mode.autoEmbed
      ? ["'text'", 'the deployment embeds it on the Atlas AutoEmbeddings path']
      : ["'vector'", "'embeddingDimensions' and 'similarity' select the manual-vector path"]
    throw new TypeError(
      `strands_mongodb: this query cannot be answered by any search tier prepared on ${namespace}, which is: ${prepared.join(', ')}. The text tier needs 'text' on the query. The vector tier needs ${needed}, because ${because}. Supply that key, or set 'searchType' to a tier this query fits.`
    )
  }

  // Runs under the connection lock from `initialize()` and outside it after the first-search wait. Each run assigns
  // its result after its last await, so an overlap costs at most one extra doubling of the delay.
  private async _retry(collection: Collection, options: { afterTimeout: boolean }): Promise<void> {
    let tiers: ResolvedSearchType[] | undefined
    try {
      tiers = await this._ensure(collection, { timeout: 0, ...options })
    } catch (error) {
      if (!(error instanceof StorageError)) throw error
    }
    if (tiers !== undefined) this._prepared = tiers
    if (tiers === undefined || this._missingATier()) {
      this._retryDelay = Math.min(this._retryDelay * 2, TIER_RETRY_MAX_SECONDS)
      this._retryAt = Date.now() + this._retryDelay * 1000
    } else {
      this._retryAt = undefined
    }
    annotate('strands_mongodb.search.tiers', this._prepared.join(','))
  }

  // Every tier is waited on together, so a quick text build is not held behind a slow vector one. The losers are
  // aborted once the first is ready, as Python cancels them, so no poll outlives the caller's interest.
  private async _waitForTheFirstReady(collection: Collection): Promise<void> {
    const { create, timeout, logger } = this._options
    const losers = new AbortController()
    const waits = this._specs.map(([, spec]) =>
      ensure(collection, { search: [spec], create, timeout, logger, signal: losers.signal })
    )
    const ready = await Promise.any(waits).then(
      () => true,
      () => false
    )
    losers.abort()
    await this._retry(collection, { afterTimeout: !ready })
    this._waited = true
  }

  // Whether `auto` skipped a configured tier, which is the only case a retry is for.
  private _missingATier(): boolean {
    return this._options.searchType === 'auto' && this._specs.some(([tier]) => !this._prepared.includes(tier))
  }

  // One `ensure` per tier, so a failing vector index does not stop the text index from being created.
  private async _ensure(
    collection: Collection,
    options: { timeout: number; afterTimeout?: boolean }
  ): Promise<ResolvedSearchType[]> {
    const { namespace, searchType, create, logger } = this._options
    const { timeout, afterTimeout = false } = options
    const available: ResolvedSearchType[] = []
    let refused: StorageError | undefined
    let building = false
    for (const [tier, spec] of this._specs) {
      try {
        await ensure(collection, { search: [spec], create, timeout, logger })
      } catch (error) {
        // A named `searchType` has nothing to fall through to: answering from another tier would change what matches.
        if (!(error instanceof StorageError) || searchType !== 'auto') throw error
        this._logSkipped(tier, error, afterTimeout)
        refused = error
        building ||= error instanceof SearchIndexNotReady
        continue
      }
      available.push(tier)
    }

    if (available.length === 0 && building) return []
    if (available.length === 0) {
      // Chained to the last failure so the reason reaches callers who do not log at `warn`.
      throw new StorageError(
        `strands_mongodb: 'searchType' is 'auto' and no search tier could be prepared on ${namespace}, so no query can be answered. The last tier's failure is chained to this one and every tier's is logged above, each with the server's own reason.`,
        { cause: refused }
      )
    }

    if (this._hybridIsAvailable(available)) {
      // Under `auto` the single tiers stay as fallbacks for queries that set only one key.
      if (searchType === 'hybrid') return ['hybrid']
      available.unshift('hybrid')
    } else if (searchType === 'hybrid') {
      throw new StorageError(
        `strands_mongodb: 'searchType' is 'hybrid' but ${namespace} cannot run it. The hybrid tier is a $rankFusion over the vector and text pipelines, and that stage needs MongoDB 8.0 or later. Upgrade the deployment, or set 'searchType' to 'auto' to let this store resolve to the tiers it does have.`
      )
    }

    if (searchType === 'auto' && available[0] === 'text' && !this._warnedBelowVector) {
      this._warnedBelowVector = true
      logger.warn(
        `strands_mongodb: 'searchType' is 'auto' and the vector tier is not available on ${namespace}, so queries resolve to the text tier. Answers are lexical rather than semantic, which is a difference in what matches rather than only in ranking. | ${logFields('below_vector', { namespace, tier: 'text' })}`
      )
    }
    return available
  }

  // `info` for a build nobody has waited out yet, which is every fresh store, else `warn`.
  private _logSkipped(tier: ResolvedSearchType, error: StorageError, afterTimeout: boolean): void {
    const { namespace, logger } = this._options
    const message = `strands_mongodb: the ${tier} search tier is not available on ${namespace} and 'searchType' is 'auto', so it is skipped rather than fatal and any remaining tier answers queries instead. The '_searchType' key on every returned entry reports which one did. The server's own reason: ${error.message}`
    if (error instanceof SearchIndexNotReady && !afterTimeout) {
      logger.info(`${message} | ${logFields('tier_building', { namespace, tier })}`)
      return
    }
    logger.warn(`${message} | ${logFields('tier_unavailable', { namespace, tier })}`)
  }

  // Hybrid needs `$rankFusion`, both single tiers, and under `auto` no score bound: fused scores top out near
  // 0.033 while cosine scores land in roughly 0 to 1, so a bound meant for one would empty the other.
  private _hybridIsAvailable(available: ResolvedSearchType[]): boolean {
    const { namespace, searchType, bound, logger } = this._options
    if (this._capabilities?.rankFusion !== true || !available.includes('vector') || !available.includes('text')) {
      return false
    }
    // An explicit `hybrid` applies the bound on the fused scale, as documented, so it needs no warning.
    if (bound === undefined || searchType === 'hybrid') return true
    logger.warn(
      `strands_mongodb: 'searchType' is 'auto' and ${namespace} can run the hybrid tier, but '${bound.name}' is set to ${bound.value} and the two are on different scales, so queries resolve to the vector tier as they did before hybrid existed. Reciprocal rank fusion scores sum to about 0.033 at best, while cosine scores land in roughly 0 to 1. Remove the bound to get fused ranking, or set 'searchType' to 'hybrid' to keep the bound and have it applied on the fusion's scale. | ${logFields('bound_declined_fusion', { namespace, tier: 'hybrid' })}`
    )
    return false
  }
}
