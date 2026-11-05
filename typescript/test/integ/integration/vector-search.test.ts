import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { Embedder, StorageSearchResult } from '@strands-agents/sdk/storage/search'
import { MongoClient } from 'mongodb'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { close } from '../../../src/client.js'
import { MongoDBStorage } from '../../../src/storage.js'
import type { MongoDBConfig } from '../../../src/types.js'
import { MongoDBVectorSearchStrategy } from '../../../src/vector-search.js'
import { tierUri } from '../../env.js'
import { describeTier } from '../../tiers.js'

const DATABASE = 'strands_mongodb_integration'
const TIMEOUT_SECONDS = 180

// mongot indexes a write asynchronously, so one search can miss it.
const SEARCHABLE_BUDGET_MS = 180_000

// A three-dimension embedder over `dark`, `mode` and `coffee`, plus a floor so no vector is zero.
class WordEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const words = text.toLowerCase().split(/\s+/)
    return ['dark', 'mode', 'coffee'].map((word) => 0.01 + words.filter((each) => each === word).length)
  }
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function eventually(
  storage: MongoDBStorage,
  query: string,
  until: (found: StorageSearchResult[]) => boolean
): Promise<StorageSearchResult[]> {
  const deadline = Date.now() + SEARCHABLE_BUDGET_MS
  for (;;) {
    const found = await storage.search(query)
    if (until(found) || Date.now() >= deadline) return found
    await sleep(500)
  }
}

describeTier('integration', 'vector search strategy', () => {
  const run = randomUUID().slice(0, 8)
  const created: string[] = []
  const config: MongoDBConfig = {
    database: DATABASE,
    connectionString: tierUri('integration')!,
    indexReadyTimeout: TIMEOUT_SECONDS,
  }
  let client: MongoClient

  async function vectorStorage(label: string): Promise<MongoDBStorage> {
    const name = `storage_vector_${label}_${run}`
    created.push(name)
    const strategy = new MongoDBVectorSearchStrategy({
      embedder: new WordEmbedder(),
      dimensions: 3,
      similarity: 'cosine',
    })
    const storage = new MongoDBStorage(config, { collection: name, searchStrategy: strategy })
    await storage.write('seed', bytes('coffee'))
    await storage.ensureIndexes()
    await storage.delete('seed')
    return storage
  }

  beforeAll(() => {
    client = new MongoClient(tierUri('integration')!)
  })

  afterAll(async () => {
    await close(config)
    const db = client.db(DATABASE)
    await Promise.all(
      created.map((name) =>
        db
          .collection(name)
          .drop()
          .catch(() => false)
      )
    )
    await client.close()
  })

  it('AT-241: ranks the nearest value first, with its payload', async () => {
    const storage = await vectorStorage('nearest')
    await storage.write('notes/ui.md', bytes('dark mode'))
    await storage.write('notes/drinks.md', bytes('coffee'))
    await storage.write('notes/mixed.md', bytes('dark coffee'))

    const found = await eventually(storage, 'dark mode', (results) => results.length === 3)

    expect(found.map((result) => result.key)).toEqual(['notes/ui.md', 'notes/mixed.md', 'notes/drinks.md'])
    expect(found[0]!.data).toEqual(bytes('dark mode'))
    expect(found[0]!.score).toBeGreaterThan(found[1]!.score)
    expect(found[1]!.score).toBeGreaterThan(found[2]!.score)
    expect(found[2]!.score).toBeGreaterThan(0)
  })

  it('AT-241: keeps a namespace inside its own prefix', async () => {
    const storage = await vectorStorage('namespace')
    const tenantA = storage.namespace('tenant-a')
    await tenantA.write('notes/ui.md', bytes('dark mode'))
    await storage.namespace('tenant-b').write('notes/ui.md', bytes('dark mode'))
    await eventually(storage, 'dark', (results) => results.length === 2)

    const found = await tenantA.search('dark')

    expect(found.map((result) => result.key)).toEqual(['notes/ui.md'])
  })

  it('AT-241: leaves no vector behind once a value is deleted or emptied', async () => {
    const storage = await vectorStorage('deleted')
    await storage.write('gone', bytes('dark'))
    await storage.write('emptied', bytes('dark'))
    await eventually(storage, 'dark', (results) => results.length === 2)

    await storage.delete('gone')
    await storage.write('emptied', new Uint8Array())

    expect(await eventually(storage, 'dark', (results) => results.length === 0)).toEqual([])
    const left = await client
      .db(DATABASE)
      .collection(created.at(-1)!)
      .find({ embedding: { $exists: true } })
      .toArray()
    expect(left).toEqual([])
  })
})
