import type { Document } from 'mongodb'
import { CONTENT_FIELD, MAX_NUM_CANDIDATES, VECTOR_FIELD } from './index-specs.js'
import { DEFAULT_OVERSAMPLING_FACTOR, type VectorMode } from './types.js'

/** Rank constant the server applies inside `$rankFusion`, never sent. A fused score is a sum of `1 / (rank + 60)`. */
export const RANK_FUSION_PENALTY = 60

/** `$meta` name for a `$vectorSearch` score. A crossed name can error or silently project no score. */
export const VECTOR_SCORE_META = 'vectorSearchScore'

/** `$meta` name for a `$rankFusion` score, which `$rankFusion` does not project on its own. */
export const FUSION_SCORE_META = 'score'

/** `$meta` name for a `$search` score. */
export const TEXT_SCORE_META = 'searchScore'

/** Field every tier projects its score into, so a reader does not branch on the tier. */
export const SCORE_FIELD = 'score'

/**
 * Derives `numCandidates` from a resolved limit and validates it.
 *
 * @param limit - Resolved result ceiling. Must be at least 1
 * @param oversamplingFactor - Multiplier turning the limit into a candidate pool. Must be at least 1
 * @returns `limit * oversamplingFactor`, within `[1..MAX_NUM_CANDIDATES]`
 * @throws RangeError if either number is below 1 or the product exceeds `MAX_NUM_CANDIDATES`
 */
export function candidateCount(limit: number, oversamplingFactor = DEFAULT_OVERSAMPLING_FACTOR): number {
  if (!(limit >= 1)) {
    throw new RangeError(`strands_mongodb: 'limit' is ${limit} and must be at least 1.`)
  }
  if (!(oversamplingFactor >= 1)) {
    throw new RangeError(`strands_mongodb: 'oversamplingFactor' is ${oversamplingFactor} and must be at least 1.`)
  }
  const candidates = limit * oversamplingFactor
  if (candidates > MAX_NUM_CANDIDATES) {
    throw new RangeError(
      `strands_mongodb: numCandidates would be ${candidates} (limit ${limit} times 'oversamplingFactor' ${oversamplingFactor}), outside the server's bounds [1..${MAX_NUM_CANDIDATES}]. Lower the limit or the factor.`
    )
  }
  return candidates
}

/**
 * Builds the vector tier: one `$vectorSearch`, plus the score projection unless `score` is `false`.
 *
 * @param options - Vector path, index, limit, exactly one query key, and an optional pre-filter
 * @returns The search stage, followed by the `$set` score projection when `score`
 * @throws TypeError if the query keys contradict `mode`
 * @throws RangeError if the candidate count is out of bounds
 */
export function vectorStages(options: {
  mode: VectorMode
  indexName: string
  limit: number
  queryText?: string | undefined
  queryVector?: number[] | undefined
  queryFilter?: Record<string, unknown> | undefined
  oversamplingFactor?: number | undefined
  score?: boolean
}): Document[] {
  const { mode, indexName, limit, queryText, queryVector, queryFilter, score = true } = options
  const { oversamplingFactor = DEFAULT_OVERSAMPLING_FACTOR } = options
  checkQueryShape(mode, queryText, queryVector)

  const numCandidates = candidateCount(limit, oversamplingFactor)

  const stage: Document = mode.autoEmbed
    ? { index: indexName, path: CONTENT_FIELD, query: { text: queryText }, model: mode.model, numCandidates, limit }
    : { index: indexName, path: VECTOR_FIELD, queryVector, numCandidates, limit }
  if (isFilter(queryFilter)) {
    stage.filter = { ...queryFilter }
  }
  const stages: Document[] = [{ $vectorSearch: stage }]
  return score ? [...stages, scoreStage(VECTOR_SCORE_META)] : stages
}

/**
 * Builds the full-text tier, ordered so a filtered query still returns its full count.
 *
 * @param options - Query text, index, limit, an optional post-filter, and whether to project the score
 * @returns `$search`, `$match` when filtered, `$set` when `score`, then `$limit`
 */
export function textStages(options: {
  queryText: string
  indexName: string
  limit: number
  queryFilter?: Record<string, unknown> | undefined
  score?: boolean
}): Document[] {
  const { queryText, indexName, limit, queryFilter, score = true } = options
  const stages: Document[] = [{ $search: { index: indexName, text: { query: queryText, path: CONTENT_FIELD } } }]
  // `$search` filtering is a post-filter, so `$match` must precede `$limit` or a filtered query returns too few.
  if (isFilter(queryFilter)) {
    stages.push({ $match: { ...queryFilter } })
  }
  if (score) {
    stages.push(scoreStage(TEXT_SCORE_META))
  }
  stages.push({ $limit: limit })
  return stages
}

/**
 * Builds the hybrid tier: one server-side `$rankFusion` (MongoDB 8.0+) over the vector and text pipelines.
 *
 * @param options - Vector path, both index names, query text, limit, and the vector tier's inputs
 * @returns `$rankFusion`, the `$set` projecting the fused score, then `$limit`
 * @throws Whatever {@link vectorStages} throws, unchanged
 */
export function hybridStages(options: {
  mode: VectorMode
  vectorIndexName: string
  textIndexName: string
  queryText: string
  limit: number
  queryVector?: number[] | undefined
  queryFilter?: Record<string, unknown> | undefined
  oversamplingFactor?: number | undefined
}): Document[] {
  const { mode, vectorIndexName, textIndexName, queryText, limit, queryVector, queryFilter, oversamplingFactor } =
    options
  // `$rankFusion` input pipelines may hold only selection stages, so neither carries a score projection.
  const vector = vectorStages({
    mode,
    indexName: vectorIndexName,
    limit,
    queryText: mode.autoEmbed ? queryText : undefined,
    queryVector,
    queryFilter,
    oversamplingFactor,
    score: false,
  })
  const text = textStages({ queryText, indexName: textIndexName, limit, queryFilter, score: false })
  // The fused list is the union of both branches, up to twice `limit`.
  return [{ $rankFusion: { input: { pipelines: { vector, text } } } }, scoreStage(FUSION_SCORE_META), { $limit: limit }]
}

/**
 * Rejects the two query shapes no tier can answer. Needs no vector mode, so it can run before tier choice.
 *
 * @param options - The query keys the caller set, and whether the config could fuse both
 * @throws TypeError if both keys are set where nothing can fuse them, or if neither is set
 */
export function checkQueryKeys(options: {
  queryText?: string | undefined
  queryVector?: number[] | undefined
  fusionPossible?: boolean
}): void {
  const { queryText, queryVector, fusionPossible = false } = options
  if (queryText !== undefined && queryVector !== undefined && !fusionPossible) {
    throw new TypeError(
      "strands_mongodb: the query sets both 'text' and 'vector', which only the hybrid tier on a manual-vector store can use. Set one of them."
    )
  }
  if (queryText === undefined && queryVector === undefined) {
    throw new TypeError("strands_mongodb: the query sets neither 'text' nor 'vector'. Set one of them.")
  }
}

function checkQueryShape(mode: VectorMode, queryText: string | undefined, queryVector: number[] | undefined): void {
  checkQueryKeys({ queryText, queryVector })
  if (mode.autoEmbed && queryVector !== undefined) {
    throw new TypeError(
      "strands_mongodb: the query sets 'vector', but this store uses Atlas AutoEmbeddings, whose index holds no caller-supplied embeddings. Query with 'text', or set 'embeddingDimensions' and 'similarity' and recreate the vector index."
    )
  }
  if (!mode.autoEmbed && queryText !== undefined) {
    throw new TypeError(
      "strands_mongodb: the query sets 'text', but 'embeddingDimensions' and 'similarity' select the manual-vector path, where nothing embeds the text. Set 'vector' to an embedding you computed, or remove both keys to use Atlas AutoEmbeddings."
    )
  }
}

function isFilter(queryFilter: Record<string, unknown> | undefined): queryFilter is Record<string, unknown> {
  return queryFilter !== undefined && Object.keys(queryFilter).length > 0
}

function scoreStage(meta: string): Document {
  return { $set: { [SCORE_FIELD]: { $meta: meta } } }
}
