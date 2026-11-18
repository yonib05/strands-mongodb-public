import type { Embedder } from '@strands-agents/sdk/storage/search'

/**
 * Embeds `text` and checks the length. The server silently leaves a wrong-length written vector out of the index.
 *
 * @param embedder - What embeds the text
 * @param text - The text to embed
 * @param options - The length the index declares, and the name of the setting that declared it
 * @returns The embedding
 * @throws RangeError if the vector's length is not `dimensions`
 */
export async function embed(
  embedder: Embedder,
  text: string,
  options: { dimensions: number; setting: string }
): Promise<number[]> {
  const { dimensions, setting } = options
  const vector = await embedder.embed(text)
  if (vector.length !== dimensions) {
    throw new RangeError(
      `strands_mongodb: the embedder returned a ${vector.length}-dimension vector and '${setting}' is ${dimensions}. Set '${setting}' to the length the embedding model produces.`
    )
  }
  return vector
}
