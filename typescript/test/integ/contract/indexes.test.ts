import { randomUUID } from 'node:crypto'
import { StorageError } from '@strands-agents/sdk'
import { type Collection, type Db, type Document, MongoClient } from 'mongodb'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ensure } from '../../../src/ensure-indexes.js'
import { dropIndexCommand, memorySpecs, storageSpecs } from '../../../src/index-specs.js'
import { defaultLogger } from '../../../src/logging.js'
import { rankFusionSupport, requireBinaryComparison, searchSupport } from '../../../src/probes.js'
import { tierUri } from '../../env.js'
import { describeTier } from '../../tiers.js'
import { rejectionOf } from '../../../src/__fixtures__/errors.js'

const FOLDING = { locale: 'en', strength: 2 }

async function indexNames(collection: Collection): Promise<string[]> {
  return (await collection.listIndexes().toArray()).map((index) => String(index.name))
}

describeTier('contract', 'indexes', () => {
  const run = randomUUID().slice(0, 8)
  const created: string[] = []
  let client: MongoClient
  let db: Db

  // A collection name unique to this run, dropped afterwards.
  function fresh(label: string): Collection {
    const name = `indexes_${label}_${run}`
    created.push(name)
    return db.collection(name)
  }

  function ordinary(collection: Collection, specs = memorySpecs(), create = true): Promise<void> {
    return ensure(collection, { ordinary: specs, create, timeout: 0, logger: defaultLogger })
  }

  beforeAll(() => {
    client = new MongoClient(tierUri('contract')!)
    db = client.db('strands_mongodb_contract')
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

  it('AT-060: creates every declared index on a fresh collection, and later calls change nothing', async () => {
    const collection = fresh('roundtrip')

    await ordinary(collection)

    const before = await collection.listIndexes().toArray()
    const keys = before.map((index) => JSON.stringify(Object.entries(index.key as Document)))
    for (const spec of memorySpecs()) expect(keys).toContain(JSON.stringify(spec.keys))

    await ordinary(collection)
    await ordinary(collection, memorySpecs(), false)

    expect(await collection.listIndexes().toArray()).toEqual(before)
  })

  it('AT-061: verify-only creates nothing, not even the collection, and its commands create the indexes', async () => {
    const collection = fresh('verify')

    const error = await rejectionOf(ordinary(collection, memorySpecs(), false))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain(collection.collectionName)
    expect(await db.listCollections({ name: collection.collectionName }).toArray()).toEqual([])
    const commands = [...error.message.matchAll(/^db\.runCommand\((\{.*\})\)$/gm)].map((match) => JSON.parse(match[1]!))
    expect(commands).toHaveLength(memorySpecs().length)
    for (const command of commands) await db.command(command as Document)
    await ordinary(collection, memorySpecs(), false)
  })

  it('AT-063: accepts an index under a foreign name with our options and creates no second one', async () => {
    const collection = fresh('foreign')
    const spec = storageSpecs()[0]!
    await collection.createIndexes([
      { key: Object.fromEntries(spec.keys), name: 'their_own_ttl', expireAfterSeconds: 0 },
    ])

    await ordinary(collection, [spec])

    const names = await indexNames(collection)
    expect(names).toContain('their_own_ttl')
    expect(names).not.toContain(spec.name)
  })

  it('AT-064: refuses a TTL index with a different expiry, naming it and the drop command', async () => {
    const collection = fresh('mismatch')
    const spec = storageSpecs()[0]!
    await collection.createIndexes([{ key: Object.fromEntries(spec.keys), name: 'theirs', expireAfterSeconds: 3600 }])

    const error = await rejectionOf(ordinary(collection, [spec]))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('expireAfterSeconds')
    expect(error.message).toContain('3600')
    expect(error.message).toContain(dropIndexCommand(collection.collectionName, 'theirs'))
    expect(await indexNames(collection)).toEqual(['_id_', 'theirs'])
  })

  it('AT-193: refuses a folding unique index the server reports with its collation, creating nothing', async () => {
    const collection = fresh('folded')
    const dedup = memorySpecs().find((spec) => spec.options.unique === true)!
    await collection.createIndexes([
      { key: Object.fromEntries(dedup.keys), name: 'theirs', ...dedup.options, collation: FOLDING },
    ])
    const before = await collection.listIndexes().toArray()

    const error = await rejectionOf(ordinary(collection, [dedup]))

    expect(error.message).toContain("'en'")
    expect(error.message).toContain("'theirs'")
    expect(await collection.listIndexes().toArray()).toEqual(before)
  })

  it('AT-176, AT-192: reads the collation a collection was made with and refuses a non-simple one', async () => {
    const folded = fresh('collated')
    const plain = fresh('plain')
    const simple = fresh('simple')
    const absent = fresh('absent')
    await db.createCollection(folded.collectionName, { collation: { locale: 'en' } })
    await db.createCollection(plain.collectionName)
    await db.createCollection(simple.collectionName, { collation: { locale: 'simple' } })

    const error = await rejectionOf(requireBinaryComparison(folded))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain("'en'")
    expect(error.message).toContain(`${folded.dbName}.${folded.collectionName}`)
    expect(await requireBinaryComparison(plain)).toBe(true)
    // The server does not store a simple collation, so this reads as an uncollated collection.
    expect(await requireBinaryComparison(simple)).toBe(true)
    expect(await requireBinaryComparison(absent)).toBe(false)
  })

  it('AT-053d, AT-145: probes the deployment for Atlas Search and $rankFusion', async () => {
    const collection = fresh('probe')

    const support = await searchSupport(collection)
    const fusion = await rankFusionSupport(collection, defaultLogger)

    if (!support.available) expect([31082, 115, 6047401]).toContain(support.code)
    const { versionArray } = (await db.command({ buildInfo: 1 })) as { versionArray: number[] }
    expect(fusion).toBe(versionArray[0]! >= 8)
  })
})
