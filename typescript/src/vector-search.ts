import { TextDecoder } from 'node:util'
import type { Embedder, SearchStrategy, StorageSearchResult } from '@strands-agents/sdk/storage/search'
import { Binary, type Document } from 'mongodb'
import { embed, MAX_DIMENSIONS, MAX_NUM_CANDIDATES, SearchIndexSpec, SIMILARITIES, VECTOR_FIELD } from './indexes.js'
import { SCORE_FIELD, VECTOR_SCORE_META } from './pipeline.js'
import type { MongoDBStorage } from './storage.js'
import { DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_OVERSAMPLING_FACTOR, type VectorSimilarity } from './types.js'

/** Vector index name when none is given. Distinct from the memory store's `vector_index`. */
export const DEFAULT_STORAGE_VECTOR_INDEX_NAME = 'storage_vector_index'

/** Every `/`-terminated ancestor of a document's `_id`. `$vectorSearch` cannot filter on an `_id` range. */
export const PREFIXES_FIELD = 'prefixes'

/** Options for {@link MongoDBVectorSearchStrategy}. */
export interface MongoDBVectorSearchStrategyOptions {
  /** Embeds stored values and queries. */
  embedder: Embedder
  /** Length of the vectors `embedder` returns, within `1..8192`. */
  dimensions: number
  /** How the index compares vectors. */
  similarity: VectorSimilarity
  /** Name of the Atlas Vector Search index on the storage's collection. */
  indexName?: string
  /** Most results one search returns. */
  maxResults?: number
  /** Multiplier turning `maxResults` into `numCandidates`. */
  oversamplingFactor?: number
}

/**
 * Lists every `/`-terminated prefix of `documentId`, shortest first.
 *
 * @param documentId - A prefixed `_id`
 * @returns `a/` and `a/b/` for `a/b/c`
 */
export function prefixesOf(documentId: string): string[] {
  const parts = documentId.split('/').slice(0, -1)
  return parts.map((_, depth) => `${parts.slice(0, depth + 1).join('/')}/`)
}

function decodeText(data: Uint8Array): string | undefined {
  if (data.length === 0) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch (error) {
    if (error instanceof TypeError) return undefined
    throw error
  }
}

/**
 * Vector search for {@link MongoDBStorage}, backed by Atlas Vector Search on the key's own document.
 *
 * @example
 * ```typescript
 * const storage = new MongoDBStorage(config, {
 *   collection: 'memory_files',
 *   searchStrategy: new MongoDBVectorSearchStrategy({ embedder, dimensions: 1024, similarity: 'cosine' }),
 * })
 * await storage.ensureIndexes()
 * ```
 */
export class MongoDBVectorSearchStrategy implements SearchStrategy<MongoDBStorage> {
  private readonly _embedder: Embedder
  private readonly _dimensions: number
  private readonly _similarity: VectorSimilarity
  private readonly _indexName: string
  private readonly _maxResults: number
  private readonly _numCandidates: number

  /**
   * Validates the options. Nothing connects until the first write or search.
   *
   * @param options - Embedder, vector shape, index name and result bounds
   * @throws RangeError if `dimensions`, `maxResults`, `oversamplingFactor` or their product is out of range
   * @throws TypeError if `similarity` is not one the server supports
   */
  constructor(options: MongoDBVectorSearchStrategyOptions) {
    const { embedder, dimensions, similarity, indexName = DEFAULT_STORAGE_VECTOR_INDEX_NAME } = options
    const { maxResults = DEFAULT_MAX_SEARCH_RESULTS, oversamplingFactor = DEFAULT_OVERSAMPLING_FACTOR } = options
    if (!(dimensions >= 1 && dimensions <= MAX_DIMENSIONS)) {
      throw new RangeError(`strands_mongodb: 'dimensions' is ${dimensions} and must be within 1..${MAX_DIMENSIONS}.`)
    }
    if (!(SIMILARITIES as readonly string[]).includes(similarity)) {
      throw new TypeError(
        `strands_mongodb: 'similarity' is '${String(similarity)}' and must be one of ${SIMILARITIES.join(', ')}.`
      )
    }
    if (maxResults < 1 || oversamplingFactor < 1) {
      throw new RangeError(
        `strands_mongodb: 'maxResults' (${maxResults}) and 'oversamplingFactor' (${oversamplingFactor}) must both be at least 1.`
      )
    }
    const numCandidates = maxResults * oversamplingFactor
    if (numCandidates > MAX_NUM_CANDIDATES) {
      throw new RangeError(
        `strands_mongodb: numCandidates would be ${numCandidates}, over the server's bound of ${MAX_NUM_CANDIDATES}. Lower 'maxResults' or 'oversamplingFactor'.`
      )
    }
    this._embedder = embedder
    this._dimensions = dimensions
    this._similarity = similarity
    this._indexName = indexName
    this._maxResults = maxResults
    this._numCandidates = numCandidates
  }

  /**
   * Returns the vector index this strategy searches, for `MongoDBStorage.ensureIndexes`.
   *
   * @returns A `vectorSearch` index over `embedding` with `prefixes` declared filterable
   */
  indexSpec(): SearchIndexSpec {
    return new SearchIndexSpec({
      name: this._indexName,
      definition: {
        fields: [
          { type: 'vector', path: VECTOR_FIELD, numDimensions: this._dimensions, similarity: this._similarity },
          { type: 'filter', path: PREFIXES_FIELD },
        ],
      },
      type: 'vectorSearch',
    })
  }

  /**
   * Embeds `data` and stores the vector on the document `storage.write` just replaced. Empty and non-UTF-8 data is skipped.
   *
   * @param storage - The storage the value was written to
   * @param key - The normalized key, relative to `storage`
   * @param data - The bytes written
   * @throws RangeError if the embedder returns a vector whose length is not `dimensions`
   */
  async index(storage: MongoDBStorage, key: string, data: Uint8Array): Promise<void> {
    const text = decodeText(data)
    if (text === undefined) return
    const vector = await this._embed(text)
    const documentId = `${storage.prefix}${key}`
    // Matching on `data` too keeps a slower write's vector off a newer value.
    const current: Document = { _id: documentId, data: new Binary(data) }
    await storage
      ._collection()
      .updateOne(current, { $set: { [VECTOR_FIELD]: vector, [PREFIXES_FIELD]: prefixesOf(documentId) } })
  }

  /**
   * Returns the stored values nearest `query`, under `storage`'s prefix only.
   *
   * @param storage - The storage to search
   * @param query - A natural-language string; a blank one returns `[]` without embedding
   * @returns Up to `maxResults` results, best first, with the stored bytes as `data`
   * @throws RangeError if the embedder returns a vector whose length is not `dimensions`
   */
  async search(storage: MongoDBStorage, query: string): Promise<StorageSearchResult[]> {
    if (!query.trim()) return []
    const stage: Document = {
      index: this._indexName,
      path: VECTOR_FIELD,
      queryVector: await this._embed(query),
      numCandidates: this._numCandidates,
      limit: this._maxResults,
    }
    const prefix = storage.prefix
    if (prefix) stage.filter = { [PREFIXES_FIELD]: { $eq: prefix } }
    const pipeline = [{ $vectorSearch: stage }, { $project: { data: 1, [SCORE_FIELD]: { $meta: VECTOR_SCORE_META } } }]
    const documents = await storage._collection().aggregate(pipeline).toArray()
    return documents.map((document) => {
      const data: unknown = document.data
      return {
        key: String(document._id).slice(prefix.length),
        score: Number(document[SCORE_FIELD] ?? 0),
        data: new Uint8Array(data instanceof Binary ? data.buffer : (data as Uint8Array)),
      }
    })
  }

  private _embed(text: string): Promise<number[]> {
    return embed(this._embedder, text, { dimensions: this._dimensions, setting: 'dimensions' })
  }
}
