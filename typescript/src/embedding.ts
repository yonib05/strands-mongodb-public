import type { Embedder } from '@strands-agents/sdk/storage/search'

/**
 * Tells whether a value is what a vector index reads: a plain array of finite numbers.
 *
 * @param value - A vector from an embedder or a query
 * @returns `false` for a typed array, which the driver stores as a subdocument, and for any non-finite element
 */
export function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(Number.isFinite)
}

/**
 * Embeds `text` and checks the vector. The server silently leaves one of the wrong shape or length out of the index.
 *
 * @param embedder - What embeds the text
 * @param text - The text to embed
 * @param options - The length the index declares, and the name of the setting that declared it
 * @returns The embedding
 * @throws TypeError if the vector is not a plain array of finite numbers
 * @throws RangeError if the vector's length is not `dimensions`
 */
export async function embed(
  embedder: Embedder,
  text: string,
  options: { dimensions: number; setting: string }
): Promise<number[]> {
  const { dimensions, setting } = options
  const vector: unknown = await embedder.embed(text)
  if (!isVector(vector)) {
    throw new TypeError(
      `strands_mongodb: the embedder returned ${Object.prototype.toString.call(vector)} where '${setting}' needs a plain array of ${dimensions} finite numbers. Return a number[], such as Array.from() of a typed array.`
    )
  }
  if (vector.length !== dimensions) {
    throw new RangeError(
      `strands_mongodb: the embedder returned a ${vector.length}-dimension vector and '${setting}' is ${dimensions}. Set '${setting}' to the length the embedding model produces.`
    )
  }
  return vector
}
