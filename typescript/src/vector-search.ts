import { TextDecoder } from 'node:util'
import type { Embedder, SearchStrategy, StorageSearchResult } from '@strands-agents/sdk/storage/search'
import { Binary, type Document } from 'mongodb'
import { requireEmbedder, requireNumber, requireObject, requireOneOf, requireString } from './checks.js'
import { embed } from './embedding.js'
import { MAX_DIMENSIONS, SearchIndexSpec, SIMILARITIES, VECTOR_FIELD } from './index-specs.js'
import { candidateCount, SCORE_FIELD, VECTOR_SCORE_META } from './pipeline.js'
import { type MongoDBStorage, payloadBytes } from './storage.js'
import { DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_OVERSAMPLING_FACTOR, type VectorSimilarity } from './types.js'

/** Vector index name when none is given. Distinct from the memory store's `vector_index`. */
export const DEFAULT_STORAGE_VECTOR_INDEX_NAME = 'storage_vector_index'

// Holds every `/`-terminated ancestor of a document's `_id`, because `$vectorSearch` cannot filter on an `_id` range.
const PREFIXES_FIELD = 'prefixes'

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

// `a/` and `a/b/` for `a/b/c`.
function prefixesOf(documentId: string): string[] {
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
   * @throws TypeError if `options` is not an object, `embedder` has no `embed` method, `similarity` is not one the
   * server supports, or `indexName` is not a string
   */
  constructor(options: MongoDBVectorSearchStrategyOptions) {
    requireObject('options', options)
    const { embedder, dimensions, similarity, indexName = DEFAULT_STORAGE_VECTOR_INDEX_NAME } = options
    const { maxResults = DEFAULT_MAX_SEARCH_RESULTS, oversamplingFactor = DEFAULT_OVERSAMPLING_FACTOR } = options
    requireEmbedder(embedder)
    requireNumber('dimensions', dimensions, { min: 1, max: MAX_DIMENSIONS, integer: true })
    requireOneOf('similarity', similarity, SIMILARITIES)
    requireString('indexName', indexName)
    this._embedder = embedder
    this._dimensions = dimensions
    this._similarity = similarity
    this._indexName = indexName
    this._maxResults = maxResults
    this._numCandidates = candidateCount(maxResults, oversamplingFactor, 'maxResults')
  }

  /**
   * Returns the vector index this strategy searches, for `MongoDBStorage.ensureIndexes`.
   *
   * @returns A `vectorSearch` index over `embedding` with `prefixes` declared filterable
   * @internal
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
   * Embeds `data` and stores the vector on the document `storage.write` just replaced. Skips empty and non-UTF-8 data.
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
   * @throws StorageError if a matched document holds no binary payload
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
      const id = String(document._id)
      return {
        key: id.slice(prefix.length),
        score: Number(document[SCORE_FIELD] ?? 0),
        data: payloadBytes(document.data, id),
      }
    })
  }

  private _embed(text: string): Promise<number[]> {
    return embed(this._embedder, text, { dimensions: this._dimensions, setting: 'dimensions' })
  }
}
