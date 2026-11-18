import { randomUUID } from 'node:crypto'
import { StorageError } from '@strands-agents/sdk'
import { type Collection, type Db, type Document, MongoClient, type MongoServerError } from 'mongodb'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ensure } from '../../../src/ensure-indexes.js'
import { memorySearchSpecs, type SearchIndexSpec } from '../../../src/index-specs.js'
import { defaultLogger } from '../../../src/logging.js'
import type { MongoDBConfig } from '../../../src/types.js'
import { tierUri } from '../../env.js'
import { describeTier } from '../../tiers.js'
import { rejectionOf } from '../../../src/__fixtures__/errors.js'

// The manual-vector path: an `autoEmbed` index is rejected at creation on atlas-local (PARITY.md section 4).
const MANUAL: MongoDBConfig = { database: 'unused', embeddingDimensions: 4, similarity: 'cosine' }
const TIMEOUT_SECONDS = 120

async function listed(collection: Collection): Promise<Document[]> {
  return collection.listSearchIndexes().toArray()
}

describeTier('integration', 'indexes', () => {
  const run = randomUUID().slice(0, 8)
  const created: string[] = []
  let client: MongoClient
  let db: Db

  function fresh(label: string): Collection {
    const name = `indexes_${label}_${run}`
    created.push(name)
    return db.collection(name)
  }

  function search(collection: Collection, specs: SearchIndexSpec[], create = true): Promise<void> {
    return ensure(collection, { search: specs, create, timeout: TIMEOUT_SECONDS, logger: defaultLogger })
  }

  beforeAll(() => {
    client = new MongoClient(tierUri('integration')!)
    db = client.db('strands_mongodb_integration')
  })

  afterAll(async () => {
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

  it('AT-062c, AT-068: creates the collection and the search indexes, which reach READY', async () => {
    const collection = fresh('ready')
    const specs = memorySearchSpecs(MANUAL)

    await search(collection, specs)

    const indexes = await listed(collection)
    expect(Object.fromEntries(indexes.map((index) => [index.name, index.status]))).toEqual({
      vector_index: 'READY',
      text_index: 'READY',
    })
    for (const index of indexes) {
      expect(Object.keys(index)).toEqual(
        expect.arrayContaining(['name', 'type', 'status', 'queryable', 'latestDefinition'])
      )
    }
    // A vectorSearch definition round-trips unchanged; the text one may come back rewritten and is covered below.
    expect(indexes.find((index) => index.name === 'vector_index')?.latestDefinition).toEqual(specs[0]!.definition)
  })

  it('AT-062c: a second ensure and a verify over READY indexes create nothing', async () => {
    const collection = fresh('warm')
    const specs = memorySearchSpecs(MANUAL)
    await search(collection, specs)
    const before = (await listed(collection)).map((index) => [index.name, index.latestVersion])

    await search(collection, specs)
    await search(collection, specs, false)

    expect(before).toHaveLength(specs.length)
    expect((await listed(collection)).map((index) => [index.name, index.latestVersion])).toEqual(before)
  })

  it('AT-062a: verify-only reports a missing search index with its command and leaves the collection alone', async () => {
    const collection = fresh('verify')
    const specs = memorySearchSpecs(MANUAL)

    const error = await rejectionOf(search(collection, specs, false))

    expect(error).toBeInstanceOf(StorageError)
    for (const spec of specs) expect(error.message).toContain(spec.creationCommand(collection.collectionName))
    expect(await db.listCollections({ name: collection.collectionName }).toArray()).toEqual([])
  })

  it('AT-068: createSearchIndexes needs the collection to exist, unlike createIndexes', async () => {
    const ghost = fresh('ghost')

    const error = await rejectionOf(ghost.createSearchIndex(memorySearchSpecs(MANUAL)[0]!.toDescription()))

    expect((error as MongoServerError).code).toBe(26)
  })

  it('AT-062b: an index caught building is waited out rather than reported missing or ready', async (context) => {
    const spec = memorySearchSpecs(MANUAL)[0]!
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const collection = fresh(`building_${attempt}`)
      await db.createCollection(collection.collectionName)
      await collection.createSearchIndex(spec.toDescription())
      const [observed] = await collection.listSearchIndexes(spec.name).toArray()
      const status = String((observed as Document | undefined)?.status)
      if (observed !== undefined && status !== 'READY') {
        expect(status).not.toBe('FAILED')
        await search(collection, [spec], false)
        return
      }
    }
    context.skip('the vector index reached READY before the first read on all 3 attempts')
  })

  it('PARITY.md section 4: an autoEmbed index fails at creation with code 8, and the error names the namespace', async () => {
    const collection = fresh('autoembed')
    const spec = memorySearchSpecs({ database: 'd' })[0]!

    const error = await rejectionOf(search(collection, [spec]))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain(
      `strands_mongodb: creating search index 'vector_index' on ${collection.dbName}.${collection.collectionName} failed`
    )
    expect((error.cause as MongoServerError).code).toBe(8)
  })
})
