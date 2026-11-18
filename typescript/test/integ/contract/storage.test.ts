import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { StorageError } from '@strands-agents/sdk'
import { Binary, type Db, type Document, MongoClient } from 'mongodb'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { close, resolve } from '../../../src/client.js'
import { EXPIRES_FIELD } from '../../../src/index-specs.js'
import { tokenize } from '../../../src/keys.js'
import { MAX_DOCUMENT_BYTES, MongoDBStorage } from '../../../src/storage.js'
import type { MongoDBConfig } from '../../../src/types.js'
import { tierUri } from '../../env.js'
import { describeTier } from '../../tiers.js'

const DATABASE = 'strands_mongodb_contract'
const FOLDING = { locale: 'en', strength: 2 }

const KEYS = [
  'notes/dark-mode-toggle.md',
  'notes/toggle-dark.md',
  'notes/café-münchen.md',
  'notes/日本語.md',
  'sessions/s1/state.json',
]

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text))
}

async function rejectionOf(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

// The SDK's `tokenOverlapScore` over the key alone, which is what the aggregation computes.
function expectedRanking(query: string, keys: string[]): Array<[string, number]> {
  const tokens = tokenize(query)
  return keys
    .map((key): [string, number] => [key, [...tokenize(key)].filter((token) => tokens.has(token)).length])
    .filter(([, score]) => score > 0)
    .sort(([keyA, scoreA], [keyB, scoreB]) => scoreB - scoreA || (keyA < keyB ? -1 : 1))
}

describeTier('contract', 'storage', () => {
  const run = randomUUID().slice(0, 8)
  const created: string[] = []
  let client: MongoClient
  let db: Db
  let config: MongoDBConfig

  // A collection name unique to this run, dropped afterwards.
  function fresh(label: string): string {
    const name = `storage_${label}_${run}`
    created.push(name)
    return name
  }

  function store(label: string, options: { ttlSeconds?: number } = {}): MongoDBStorage {
    return new MongoDBStorage(config, { collection: fresh(label), ...options })
  }

  beforeAll(() => {
    client = new MongoClient(tierUri('contract')!)
    db = client.db(DATABASE)
    config = { database: DATABASE, connectionString: tierUri('contract')! }
  })

  afterAll(async () => {
    await close(config)
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

  it('AT-020, AT-021, AT-023, AT-024: writes, reads and deletes round trip, empty payload and astral key included', async () => {
    const storage = store('roundtrip')

    await storage.write('a/b', bytes('first'))
    await storage.write('a/b', bytes('second'))
    await storage.write('a/empty', new Uint8Array(0))
    await storage.write('a/😀', bytes('smile'))
    const every = new Uint8Array(256).map((_, index) => index)
    await storage.write('a/bytes', every)

    expect(await storage.read('a/b')).toEqual(bytes('second'))
    expect(await storage.read('a/empty')).toEqual(new Uint8Array(0))
    expect((await storage.read('a/empty'))?.constructor).toBe(Uint8Array)
    expect(await storage.read('a/😀')).toEqual(bytes('smile'))
    expect(await storage.read('a/bytes')).toEqual(every)
    expect(await storage.read('never/written')).toBeNull()
    expect(await storage.list('a/😀')).toEqual(['a/😀'])

    await storage.delete('never/written')
    await storage.delete('a/b')
    await storage.delete('a/b')

    expect(await storage.read('a/b')).toBeNull()
    expect(await storage.list('')).toEqual(['a/bytes', 'a/empty', 'a/😀'])
  })

  it('reads a payload stored under another binary subtype as a Uint8Array', async () => {
    const storage = store('subtype')
    const name = created.at(-1)!
    await db
      .collection(name)
      .replaceOne({ _id: 'a/b' } as Document, { data: new Binary(bytes('payload'), 2) }, { upsert: true })

    const found = await storage.read('a/b')

    expect(found?.constructor).toBe(Uint8Array)
    expect(found).toEqual(bytes('payload'))
  })

  it('AT-025, AT-026, AT-027, AT-028: lists full keys in byte order, under a prefix or all of them', async () => {
    const storage = store('list')
    const keys = ['a/10', 'a/2', 'a/B', 'a/a', 'a/é', 'a/Z', 'b/one', 'sessions-archive/abc']
    for (const key of keys) await storage.write(key, bytes('payload'))

    expect(await storage.list('')).toEqual([...keys].sort())
    expect(await storage.list('a/')).toEqual(['a/10', 'a/2', 'a/B', 'a/Z', 'a/a', 'a/é'])
    expect(await storage.list('sessions/')).toEqual([])
  })

  it('AT-027: lists by code point, a key holding U+FFFF before one holding U+1F600', async () => {
    const storage = store('codepoints')
    await storage.write('a/\u{1f600}', bytes('astral'))
    await storage.write('a/\uffff', bytes('bmp'))

    expect(await storage.list('a/')).toEqual(['a/\uffff', 'a/\u{1f600}'])
  })

  it('AT-025, AT-031: list and deletePrefix take a string prefix, so user1 also reaches user10', async () => {
    const storage = store('stringprefix')
    for (const key of ['user1/a', 'user10/a', 'user2/a']) await storage.write(key, bytes('payload'))

    expect(await storage.list('user1')).toEqual(['user1/a', 'user10/a'])
    expect(await storage.list('user1/')).toEqual(['user1/a'])
    expect(await storage.deletePrefix('user1')).toBe(2)
    expect(await storage.deletePrefix('')).toBe(1)
    expect(await storage.list('')).toEqual([])
  })

  it('AT-030, AT-229: a namespaced store prefixes writes, strips them from list, scores without its prefix and cannot see a sibling', async () => {
    const storage = store('namespace')
    const name = created.at(-1)!
    const scoped = storage.namespace('tenant-a')

    await scoped.write('sessions/abc', bytes('a'))
    await storage.namespace('tenant-ab').write('sessions/abc', bytes('ab'))

    const stored = await db.collection(name).find({}).sort({ _id: 1 }).toArray()
    expect(stored.map((doc) => doc._id)).toEqual(['tenant-a/sessions/abc', 'tenant-ab/sessions/abc'])
    expect(await scoped.list('')).toEqual(['sessions/abc'])
    expect(await scoped.read('sessions/abc')).toEqual(bytes('a'))
    expect(await scoped.search('tenant')).toEqual([])
    expect(await scoped.search('abc')).toEqual([{ key: 'sessions/abc', score: 1 }])
    expect(await scoped.deletePrefix('')).toBe(1)
    expect(await storage.list('')).toEqual(['tenant-ab/sessions/abc'])
  })

  it('AT-031: deletePrefix removes a range and returns the count, zero for no match', async () => {
    const storage = store('deleteprefix')
    for (const key of ['a/one', 'a/two', 'a/three', 'b/four']) await storage.write(key, bytes('payload'))

    expect(await storage.deletePrefix('a/')).toBe(3)
    expect(await storage.list('')).toEqual(['b/four'])
    expect(await storage.deletePrefix('a/')).toBe(0)
  })

  it('AT-032b, AT-032d, AT-033: the server ranks by token overlap exactly as the SDK would, ties by key', async () => {
    const storage = store('search')
    for (const key of KEYS) await storage.write(key, new Uint8Array(400).fill(0x78))
    await storage.write('Sessions/Agent-1/State.json', bytes('x'))
    await storage.write('notes/one.md', bytes('needle'))
    const keys = [...KEYS, 'Sessions/Agent-1/State.json', 'notes/one.md']

    for (const query of ['dark mode toggle', 'münchen café', '日本語', 'state json', 'toggle', 'nothing at all here']) {
      const found = await storage.search(query)
      expect(found.map((result) => [result.key, result.score])).toEqual(expectedRanking(query, keys))
      expect(found.every((result) => result.data === undefined)).toBe(true)
    }
    expect((await storage.search('dark mode')).map((result) => result.key)).toEqual([
      'notes/dark-mode-toggle.md',
      'notes/toggle-dark.md',
    ])
    expect(await storage.search('sessions agent')).toEqual([
      { key: 'Sessions/Agent-1/State.json', score: 2 },
      { key: 'sessions/s1/state.json', score: 1 },
    ])
    expect(await storage.search('needle')).toEqual([])
  })

  it('AT-032b: the server lowercases ASCII only, so a key word holding a non-ASCII capital matches no query', async () => {
    const storage = store('asciilower')
    await storage.write('ÉCOLE/notes', bytes('payload'))
    await storage.write('école/lower', bytes('payload'))

    const [lowered] = await db
      .aggregate([{ $documents: [{}] }, { $project: { text: { $toLower: 'ÉCOLE' } } }])
      .toArray()
    expect(lowered?.text).toBe('École')
    expect(await storage.search('école')).toEqual([{ key: 'école/lower', score: 1 }])
    expect(await storage.search('École')).toEqual([{ key: 'école/lower', score: 1 }])
    expect(await storage.search('NOTES')).toEqual([{ key: 'ÉCOLE/notes', score: 1 }])
  })

  it('AT-032e: the search scan is covered by the _id index and fetches no documents, with or without a prefix', async () => {
    const monitored = new MongoClient(tierUri('contract')!, { monitorCommands: true })
    const sent: Document[] = []
    monitored.on('commandStarted', (event) => {
      if (event.commandName === 'aggregate') sent.push(event.command)
    })
    const name = fresh('covered')
    const unprefixed = new MongoDBStorage({ database: DATABASE, client: monitored }, { collection: name })

    try {
      for (const storage of [unprefixed, unprefixed.namespace('tenant-a')]) {
        for (const key of KEYS) await storage.write(key, new Uint8Array(400).fill(0x78))
        await storage.search('dark mode')
      }

      expect(sent).toHaveLength(2)
      for (const { pipeline, hint } of sent) {
        const plan = JSON.stringify(
          await db.command({ explain: { aggregate: name, pipeline, hint, cursor: {} }, verbosity: 'executionStats' })
        )
        expect(plan.match(/"totalDocsExamined":\d+/g)).toEqual(['"totalDocsExamined":0'])
        expect(plan).toContain('IXSCAN')
        expect(plan).not.toContain('COLLSCAN')
      }
    } finally {
      await unprefixed.close()
      await monitored.close()
    }
  })

  it('AT-035, AT-121b: ensureIndexes creates the TTL index once, and a TTL store stamps the field it watches', async () => {
    const expiring = store('ttl', { ttlSeconds: 3600 })
    const name = created.at(-1)!
    const plain = new MongoDBStorage(config, { collection: name })

    await expiring.ensureIndexes()
    await expiring.ensureIndexes()
    await expiring.write('with-ttl', bytes('payload'))
    await plain.write('without-ttl', bytes('payload'))

    const indexes = await db.collection(name).listIndexes().toArray()
    const ttl = indexes.find((index) => index.name === 'strands_expires_at_ttl')
    expect(ttl?.key).toEqual({ [EXPIRES_FIELD]: 1 })
    expect(ttl?.expireAfterSeconds).toBe(0)
    expect(
      indexes.filter((index) => JSON.stringify(index.key) === JSON.stringify({ [EXPIRES_FIELD]: 1 }))
    ).toHaveLength(1)
    const withTtl = await db.collection(name).findOne({ _id: 'with-ttl' } as Document)
    expect(withTtl?.[EXPIRES_FIELD]).toBeInstanceOf(Date)
    const withoutTtl = await db.collection(name).findOne({ _id: 'without-ttl' } as Document)
    expect(withoutTtl).not.toBeNull()
    expect(EXPIRES_FIELD in withoutTtl!).toBe(false)
  })

  it('AT-176: a case-folding collection is refused before anything is written', async () => {
    const name = fresh('folded')
    await db.createCollection(name, { collation: FOLDING })
    const storage = new MongoDBStorage(config, { collection: name })

    const error = await rejectionOf(storage.write('k', bytes('v')))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('collation')
    expect(error.message).toContain("'en'")
    expect(await db.collection(name).countDocuments()).toBe(0)
  })

  it('AT-192: an absent collection is asked about again until the first write creates it', async () => {
    const storage = store('absent')
    const target = `${DATABASE}.${created.at(-1)!}`

    expect(await storage.read('absent')).toBeNull()
    expect(resolve(config).binaryKeys.has(target)).toBe(false)

    await storage.write('k', bytes('v'))
    expect(await storage.read('k')).toEqual(bytes('v'))

    expect(resolve(config).binaryKeys.has(target)).toBe(true)
  })

  it('AT-029, AT-038b: an oversized payload is refused before the driver sees it, naming both sizes', async () => {
    const storage = store('oversized')
    const payload = new Uint8Array(MAX_DOCUMENT_BYTES + 1)

    const error = await rejectionOf(storage.write('a/b', payload))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain("'a/b'")
    expect(error.message).toContain(`${MAX_DOCUMENT_BYTES + 1 + 46 + 'a/b'.length} bytes`)
    expect(error.message).toContain(`${MAX_DOCUMENT_BYTES}-byte BSON limit`)
    expect(await storage.list('')).toEqual([])
    const hello = await db.command({ hello: 1 })
    expect(hello.maxBsonObjectSize).toBe(MAX_DOCUMENT_BYTES)
  })
})
