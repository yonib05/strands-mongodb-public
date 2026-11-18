import type { Document } from 'mongodb'
import { describe, expect, it } from 'vitest'
import fixtures from '../__fixtures__/pipeline-stages.json' with { type: 'json' }
import { CONTENT_FIELD, DEFAULT_EMBEDDING_MODEL, MAX_NUM_CANDIDATES, VECTOR_FIELD } from '../index-specs.js'
import {
  candidateCount,
  checkQueryKeys,
  FUSION_SCORE_META,
  hybridStages,
  RANK_FUSION_PENALTY,
  SCORE_FIELD,
  TEXT_SCORE_META,
  textStages,
  VECTOR_SCORE_META,
  vectorStages,
} from '../pipeline.js'
import { DEFAULT_OVERSAMPLING_FACTOR, type VectorMode, type VectorSimilarity } from '../types.js'
import { errorOf } from '../__fixtures__/errors.js'

const AUTO_EMBED_MODE: VectorMode = { autoEmbed: true, model: DEFAULT_EMBEDDING_MODEL }
const MANUAL_MODE: VectorMode = { autoEmbed: false, dimensions: 4, similarity: 'cosine' }
const VECTOR = [1.0, 0.0, 0.0, 0.0]

function names(stages: Document[]): string[] {
  return stages.map((stage) => Object.keys(stage)[0] ?? '')
}

interface FixtureMode {
  autoEmbed: boolean
  model: string | null
  dimensions: number | null
  similarity: string | null
}

interface FixtureInput {
  mode?: FixtureMode
  indexName?: string
  vectorIndexName?: string
  textIndexName?: string
  limit: number
  queryText?: string | null
  queryVector?: number[] | null
  queryFilter: Record<string, unknown> | null
  oversamplingFactor?: number
  score?: boolean
}

interface FixtureEntry {
  name: string
  input: FixtureInput
  stages: Document[]
}

function toMode(mode: FixtureMode): VectorMode {
  return mode.autoEmbed
    ? { autoEmbed: true, model: mode.model as string }
    : { autoEmbed: false, dimensions: mode.dimensions as number, similarity: mode.similarity as VectorSimilarity }
}

function present<T>(value: T | null | undefined): { value: T } | Record<string, never> {
  return value === null || value === undefined ? {} : { value }
}

function build(entry: FixtureEntry): Document[] {
  const { input } = entry
  const text = present(input.queryText)
  const vector = present(input.queryVector)
  const filter = present(input.queryFilter)
  const shared = {
    limit: input.limit,
    ...('value' in text && { queryText: text.value }),
    ...('value' in vector && { queryVector: vector.value }),
    ...('value' in filter && { queryFilter: filter.value }),
  }
  const kind = entry.name.split('/')[0]
  if (kind === 'text_stages') {
    return textStages({
      ...shared,
      queryText: input.queryText as string,
      indexName: input.indexName as string,
      score: input.score as boolean,
    })
  }
  const mode = toMode(input.mode as FixtureMode)
  const factor = input.oversamplingFactor as number
  if (kind === 'vector_stages') {
    return vectorStages({
      ...shared,
      mode,
      indexName: input.indexName as string,
      oversamplingFactor: factor,
      score: input.score as boolean,
    })
  }
  return hybridStages({
    ...shared,
    mode,
    queryText: input.queryText as string,
    vectorIndexName: input.vectorIndexName as string,
    textIndexName: input.textIndexName as string,
    oversamplingFactor: factor,
  })
}

describe('python fixtures', () => {
  const entries = fixtures as FixtureEntry[]

  it('covers all 84 entries', () => {
    expect(entries).toHaveLength(84)
  })

  it.each(entries.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(build(entry)).toEqual(entry.stages)
  })
})

describe('constants', () => {
  it('keeps the three $meta names distinct', () => {
    expect(new Set([VECTOR_SCORE_META, TEXT_SCORE_META, FUSION_SCORE_META]).size).toBe(3)
  })

  it('matches the server rank constant and the projected field', () => {
    expect(RANK_FUSION_PENALTY).toBe(60)
    expect(SCORE_FIELD).toBe('score')
  })
})

describe('candidateCount', () => {
  describe('AT-072 derivation', () => {
    it.each([
      [1, 10, 10],
      [5, 10, 50],
      [10, 10, 100],
      [10, 1, 10],
      [100, 100, 10000],
    ])('AT-072 is the product of limit %i and factor %i', (limit, factor, expected) => {
      expect(candidateCount(limit, factor)).toBe(expected)
    })

    it('scales with the limit', () => {
      expect(candidateCount(20, 10)).toBe(2 * candidateCount(10, 10))
    })

    it('defaults the factor to DEFAULT_OVERSAMPLING_FACTOR', () => {
      expect(candidateCount(7)).toBe(7 * DEFAULT_OVERSAMPLING_FACTOR)
    })

    it('accepts the ceiling itself', () => {
      expect(candidateCount(1000, 10)).toBe(MAX_NUM_CANDIDATES)
    })
  })

  describe('AT-072 bounds', () => {
    it.each([
      [1001, 10],
      [10001, 1],
      [100, 101],
      [1, 10001],
    ])('AT-072 rejects limit %i times factor %i above the ceiling', (limit, factor) => {
      const error = errorOf(() => candidateCount(limit, factor))

      expect(error).toBeInstanceOf(RangeError)
      expect(error.message).toMatch(/^strands_mongodb: /)
      expect(error.message).toContain('numCandidates')
      expect(error.message).toContain(String(limit * factor))
      expect(error.message).toContain('oversamplingFactor')
    })

    it.each([0, -1, NaN])('rejects a factor of %d', (factor) => {
      const error = errorOf(() => candidateCount(5, factor))

      expect(error).toBeInstanceOf(RangeError)
      expect(error.message).toContain('oversamplingFactor')
    })

    it.each([0, -1, NaN])('rejects a limit of %d', (limit) => {
      const error = errorOf(() => candidateCount(limit, 10))

      expect(error).toBeInstanceOf(RangeError)
      expect(error.message).toContain('limit')
    })
  })
})

describe('vectorStages', () => {
  describe('AT-070 AutoEmbeddings query shape', () => {
    it('AT-070 matches the whole stage exactly', () => {
      const stages = vectorStages({
        mode: AUTO_EMBED_MODE,
        indexName: 'vector_index',
        limit: 5,
        queryText: 'dark mode',
      })

      expect(stages[0]).toEqual({
        $vectorSearch: {
          index: 'vector_index',
          path: CONTENT_FIELD,
          query: { text: 'dark mode' },
          numCandidates: 50,
          limit: 5,
          model: DEFAULT_EMBEDDING_MODEL,
        },
      })
    })

    it('sends the query as a nested document rather than a bare string', () => {
      const stage = vectorStages({ mode: AUTO_EMBED_MODE, indexName: 'i', limit: 1, queryText: 'q' })[0]?.$vectorSearch

      expect(stage.query).toEqual({ text: 'q' })
      expect(stage).not.toHaveProperty('queryVector')
      expect(stage.model).toBe(DEFAULT_EMBEDDING_MODEL)
    })

    it('carries a configured model into the stage', () => {
      const mode: VectorMode = { autoEmbed: true, model: 'voyage-3-large' }

      expect(vectorStages({ mode, indexName: 'i', limit: 1, queryText: 'q' })[0]?.$vectorSearch.model).toBe(
        'voyage-3-large'
      )
    })
  })

  describe('AT-070a builder and path follow the mode', () => {
    it('AT-070a sends a query vector over the vector field on the manual path', () => {
      const stages = vectorStages({ mode: MANUAL_MODE, indexName: 'vector_index', limit: 5, queryVector: VECTOR })

      expect(stages[0]).toEqual({
        $vectorSearch: { index: 'vector_index', path: VECTOR_FIELD, queryVector: VECTOR, numCandidates: 50, limit: 5 },
      })
    })

    it('carries no model and no text query on the manual path', () => {
      const stage = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR })[0]?.$vectorSearch

      expect(stage).not.toHaveProperty('model')
      expect(stage).not.toHaveProperty('query')
    })
  })

  describe('AT-070b returned pipelines', () => {
    it('AT-070b does not share state between calls', () => {
      const first = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR })
      first.push({ $count: 'n' })

      expect(names(vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR }))).toEqual([
        '$vectorSearch',
        '$set',
      ])
    })
  })

  describe('AT-070c score projection', () => {
    it('AT-070c projects the vector score', () => {
      const stages = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR })

      expect(stages[1]).toEqual({ $set: { score: { $meta: 'vectorSearchScore' } } })
      expect(stages).not.toContainEqual({ $set: { score: { $meta: 'searchScore' } } })
    })

    it('AT-144 keeps the score stage by default and drops only it when score is false', () => {
      const withScore = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR })
      const without = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR, score: false })

      expect(withScore.at(-1)).toEqual({ $set: { score: { $meta: 'vectorSearchScore' } } })
      expect(without).toEqual(withScore.slice(0, -1))
    })
  })

  describe('candidate count', () => {
    it('AT-072 uses the default factor', () => {
      const stage = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 7, queryVector: VECTOR })[0]?.$vectorSearch

      expect(stage.numCandidates).toBe(7 * DEFAULT_OVERSAMPLING_FACTOR)
    })

    it('rejects a product above the ceiling', () => {
      expect(() => vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1001, queryVector: VECTOR })).toThrow(
        RangeError
      )
    })
  })

  describe('filter placement', () => {
    it('puts the filter inside the stage', () => {
      const stages = vectorStages({
        mode: MANUAL_MODE,
        indexName: 'i',
        limit: 5,
        queryVector: VECTOR,
        queryFilter: { scope: 's' },
      })

      expect(stages[0]?.$vectorSearch.filter).toEqual({ scope: 's' })
    })

    it('omits an empty filter', () => {
      const stages = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 5, queryVector: VECTOR, queryFilter: {} })

      expect(stages[0]?.$vectorSearch).not.toHaveProperty('filter')
    })
  })

  describe('AT-074a query contradicting the mode', () => {
    it('AT-074a rejects text on the manual path, naming the keys', () => {
      const error = errorOf(() => vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 5, queryText: 'q' }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toMatch(/^strands_mongodb: /)
      expect(error.message).toContain('embeddingDimensions')
      expect(error.message).toContain("'text'")
    })

    it('AT-074a rejects vector on the AutoEmbeddings path, naming the keys', () => {
      const error = errorOf(() =>
        vectorStages({ mode: AUTO_EMBED_MODE, indexName: 'i', limit: 5, queryVector: VECTOR })
      )

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain('AutoEmbeddings')
      expect(error.message).toContain("'vector'")
    })

    it('rejects neither text nor vector', () => {
      expect(() => vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 5 })).toThrow(TypeError)
    })

    it.each([
      ['autoembed', AUTO_EMBED_MODE],
      ['manual', MANUAL_MODE],
    ] as const)('rejects both at once for being both on the %s path', (_name, mode) => {
      const error = errorOf(() => vectorStages({ mode, indexName: 'i', limit: 5, queryText: 'q', queryVector: VECTOR }))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("both 'text' and 'vector'")
    })
  })
})

describe('textStages', () => {
  describe('AT-073a stage order', () => {
    const filtered = (): Document[] =>
      textStages({ queryText: 'q', indexName: 'i', limit: 5, queryFilter: { scope: 's' } })

    it('AT-073a emits $search, $match, $set, $limit in that order', () => {
      expect(names(filtered())).toEqual(['$search', '$match', '$set', '$limit'])
    })

    it('puts the $limit last and after the $match', () => {
      const order = names(filtered())

      expect(order.indexOf('$limit')).toBe(order.length - 1)
      expect(order.indexOf('$limit')).toBeGreaterThan(order.indexOf('$match'))
    })

    it('bounds nothing before the $match', () => {
      const order = names(filtered())

      expect(order.slice(0, order.indexOf('$match'))).toEqual(['$search'])
    })

    it('omits the $match without a filter', () => {
      expect(names(textStages({ queryText: 'q', indexName: 'i', limit: 5 }))).toEqual(['$search', '$set', '$limit'])
    })

    it('names the index and the content field', () => {
      expect(textStages({ queryText: 'dark mode', indexName: 'text_index', limit: 5 })[0]).toEqual({
        $search: { index: 'text_index', text: { query: 'dark mode', path: CONTENT_FIELD } },
      })
    })
  })

  describe('filter placement', () => {
    it('puts the filter in a $match stage, not in $search', () => {
      const stages = textStages({ queryText: 'q', indexName: 'i', limit: 5, queryFilter: { scope: 's' } })

      expect(stages[1]).toEqual({ $match: { scope: 's' } })
      expect(stages[0]?.$search).not.toHaveProperty('filter')
    })
  })

  describe('AT-070c score projection', () => {
    it('AT-070c projects the search score and never the vector score', () => {
      const stages = textStages({ queryText: 'q', indexName: 'i', limit: 1 })

      expect(stages).toContainEqual({ $set: { score: { $meta: 'searchScore' } } })
      expect(stages).not.toContainEqual({ $set: { score: { $meta: 'vectorSearchScore' } } })
    })

    it('AT-144 drops only the score stage when score is false', () => {
      const withScore = textStages({ queryText: 'q', indexName: 'i', limit: 1 })
      const without = textStages({ queryText: 'q', indexName: 'i', limit: 1, score: false })

      expect(names(without)).toEqual(['$search', '$limit'])
      expect(without).toEqual(withScore.filter((stage) => !('$set' in stage)))
    })

    it('keeps the filter when the score goes', () => {
      const stages = textStages({ queryText: 'q', indexName: 'i', limit: 1, queryFilter: { scope: 's' }, score: false })

      expect(names(stages)).toEqual(['$search', '$match', '$limit'])
    })
  })

  describe('AT-070b returned pipelines', () => {
    it('AT-070b does not share state between calls', () => {
      textStages({ queryText: 'q', indexName: 'i', limit: 1 }).push({ $count: 'n' })

      expect(names(textStages({ queryText: 'q', indexName: 'i', limit: 1 }))).toEqual(['$search', '$set', '$limit'])
    })
  })
})

describe('hybridStages', () => {
  function hybrid(overrides: Partial<Parameters<typeof hybridStages>[0]> = {}): Document[] {
    return hybridStages({
      mode: MANUAL_MODE,
      vectorIndexName: 'vi',
      textIndexName: 'ti',
      queryText: 'q',
      queryVector: VECTOR,
      limit: 5,
      ...overrides,
    })
  }

  describe('AT-144 one native stage', () => {
    it('AT-144 is $rankFusion, the fused score projection, then $limit', () => {
      const stages = hybrid()

      expect(names(stages)).toEqual(['$rankFusion', '$set', '$limit'])
      expect(stages[1]).toEqual({ $set: { score: { $meta: 'score' } } })
    })

    it('AT-225 caps the fused list at the limit', () => {
      expect(hybrid({ limit: 7 }).at(-1)).toEqual({ $limit: 7 })
    })

    it('uses neither tier score name', () => {
      const serialized = JSON.stringify(hybrid())

      expect(serialized).not.toContain('vectorSearchScore')
      expect(serialized).not.toContain('searchScore')
    })

    it('names the two input pipelines', () => {
      expect(Object.keys(hybrid()[0]?.$rankFusion.input.pipelines).sort()).toEqual(['text', 'vector'])
    })

    it('projects the score outside the fusion and in neither input pipeline', () => {
      const stages = hybrid()
      const pipelines: Record<string, Document[]> = stages[0]?.$rankFusion.input.pipelines

      expect(names(stages)).toContain('$set')
      for (const branch of Object.values(pipelines)) {
        expect(names(branch)).not.toContain('$set')
      }
    })

    it('sends no $unionWith', () => {
      expect(JSON.stringify(hybrid())).not.toContain('$unionWith')
    })

    it('builds the input pipelines from the single-tier builders with score false', () => {
      const pipelines = hybrid({ queryFilter: { scope: 's' } })[0]?.$rankFusion.input.pipelines

      expect(pipelines.vector).toEqual(
        vectorStages({
          mode: MANUAL_MODE,
          indexName: 'vi',
          limit: 5,
          queryVector: VECTOR,
          queryFilter: { scope: 's' },
          score: false,
        })
      )
      expect(pipelines.text).toEqual(
        textStages({ queryText: 'q', indexName: 'ti', limit: 5, queryFilter: { scope: 's' }, score: false })
      )
    })
  })

  describe('validation', () => {
    it('still validates the vector candidate count', () => {
      const error = errorOf(() => hybrid({ limit: MAX_NUM_CANDIDATES }))

      expect(error).toBeInstanceOf(RangeError)
      expect(error.message).toContain('numCandidates')
    })

    it('rejects a query contradicting the mode', () => {
      expect(() => hybrid({ mode: AUTO_EMBED_MODE })).toThrow(TypeError)
    })
  })
})

describe('checkQueryKeys', () => {
  it('rejects both keys where nothing can fuse them', () => {
    const error = errorOf(() => checkQueryKeys({ queryText: 'q', queryVector: VECTOR }))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain("both 'text' and 'vector'")
  })

  it('accepts both keys when fusion is possible', () => {
    expect(() => checkQueryKeys({ queryText: 'q', queryVector: VECTOR, fusionPossible: true })).not.toThrow()
  })

  it('rejects neither key even when fusion is possible', () => {
    const error = errorOf(() => checkQueryKeys({ fusionPossible: true }))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain("neither 'text' nor 'vector'")
  })
})
