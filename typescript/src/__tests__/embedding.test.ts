import type { Embedder } from '@strands-agents/sdk/storage/search'
import { describe, expect, it } from 'vitest'
import { embed } from '../embedding.js'

describe('embed', () => {
  const embedder = (vector: number[]): Embedder => ({ embed: async () => vector }) as Embedder

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
})
