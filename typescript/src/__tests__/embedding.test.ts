import type { Embedder } from '@strands-agents/sdk/storage/search'
import { describe, expect, it } from 'vitest'
import { embed } from '../embedding.js'

describe('embed', () => {
  const embedder = (vector: unknown): Embedder => ({ embed: async () => vector }) as Embedder

  it('returns a vector of the declared length', async () => {
    await expect(embed(embedder([1, 2, 3]), 'tea', { dimensions: 3, setting: 'embeddingDimensions' })).resolves.toEqual(
      [1, 2, 3]
    )
  })

  it('rejects a vector of the wrong length and names the setting', async () => {
    const result = embed(embedder([1, 2]), 'tea', { dimensions: 3, setting: 'embeddingDimensions' })

    await expect(result).rejects.toBeInstanceOf(RangeError)
    await expect(result).rejects.toThrow(
      "strands_mongodb: the embedder returned a 2-dimension vector and 'embeddingDimensions' is 3."
    )
  })

  it.each([
    ['a Float32Array, which the driver stores as a subdocument', new Float32Array([0.5, 0.25, 1])],
    ['a non-finite value', [0.5, NaN, 1]],
    ['a value that is not a number', [0.5, '0.25', 1]],
    ['no array at all', undefined],
  ])('rejects %s with a TypeError naming the setting', async (_kind, vector) => {
    const result = embed(embedder(vector), 'tea', { dimensions: 3, setting: 'embeddingDimensions' })

    await expect(result).rejects.toBeInstanceOf(TypeError)
    await expect(result).rejects.toThrow("'embeddingDimensions'")
  })
})
