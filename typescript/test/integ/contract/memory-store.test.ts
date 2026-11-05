import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { type Logger, StorageError } from '@strands-agents/sdk'
import { type Db, type Document, MongoClient } from 'mongodb'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { close } from '../../../src/client.js'
import { ensure } from '../../../src/indexes.js'
import { MongoDBMemoryStore } from '../../../src/memory-store.js'
import type { MongoDBConfig, MongoDBMemoryStoreConfig } from '../../../src/types.js'
import { tierUri } from '../../env.js'
import { describeTier } from '../../tiers.js'

const DATABASE = 'strands_mongodb_contract'
const FOLDING = { locale: 'en', strength: 2 }
const SECRET = 'SUPERSECRET'

// The manual-vector path builds on any deployment with a search process; the AutoEmbeddings one needs a model.
const MANUAL_VECTOR = { embeddingDimensions: 4, similarity: 'cosine' } as const

const ORDINARY_INDEXES = [
  '_id_',
  'strands_scope_store_content_hash_unique',
  'strands_scope_store_created_at',
  'strands_expires_at_ttl',
]

class RecordingLogger implements Logger {
  readonly records: Array<[string, string]> = []
  debug = (...args: unknown[]): void => this.record('debug', args)
  info = (...args: unknown[]): void => this.record('info', args)
  warn = (...args: unknown[]): void => this.record('warn', args)
  error = (...args: unknown[]): void => this.record('error', args)

  lines(level: string): string[] {
    return this.records.filter(([at]) => at === level).map(([, line]) => line)
  }

  private record(level: string, args: unknown[]): void {
    this.records.push([level, args.map(String).join(' ')])
  }
}

async function rejectionOf(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

// `uri` with `u:<secret>@` as its userinfo, replacing whatever was there.
function withPassword(uri: string, secret = SECRET): string {
  const [scheme, rest] = uri.split('://') as [string, string]
  const host = rest.includes('@') ? rest.slice(rest.indexOf('@') + 1) : rest
  return `${scheme}://u:${secret}@${host}`
}

// Initializes `store` and waits for every index it can build, so its tier set is final rather than build-order dependent.
async function settled(store: MongoDBMemoryStore): Promise<void> {
  await store.initialize()
  if (!store['_connection'].capabilities?.search) return
  for (const [, spec] of store['_specs']) {
    // A refused index, such as an autoEmbed one on a deployment with no model, raises at once and stays out.
    try {
      await ensure(store['_collection'](), {
        search: [spec],
        create: store['_ensureIndexes'],
        timeout: 180,
        logger: store['_logger'],
      })
    } catch (error) {
      if (!(error instanceof StorageError)) throw error
    }
  }
  await store['_retrySearchTiers']()
}

describeTier('contract', 'memory store', () => {
  const run = randomUUID().slice(0, 8)
  const created: string[] = []
  const configs: MongoDBConfig[] = []
  let client: MongoClient
  let db: Db

  // A collection name unique to this run, dropped afterwards.
  function fresh(label: string): string {
    const name = `memory_${label}_${run}`
    created.push(name)
    return name
  }

  function store(
    label: string,
    options: { connection?: Partial<MongoDBConfig>; store?: Partial<Omit<MongoDBMemoryStoreConfig, 'config'>> } = {}
  ): { store: MongoDBMemoryStore; logger: RecordingLogger; name: string } {
    const logger = new RecordingLogger()
    const config: MongoDBConfig = {
      database: DATABASE,
      connectionString: tierUri('contract')!,
      logger,
      ...options.connection,
    }
    configs.push(config)
    const name = fresh(label)
    return {
      store: new MongoDBMemoryStore({ name: 'facts', config, collection: name, ...options.store }),
      logger,
      name,
    }
  }

  beforeAll(() => {
    client = new MongoClient(tierUri('contract')!)
    db = client.db(DATABASE)
  })

  afterAll(async () => {
    await Promise.all(configs.map((config) => close(config)))
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

  it('AT-053a, AT-065: initialize creates the ordinary indexes, and warns once where there is no search', async () => {
    const { store: facts, logger, name } = store('ordinary')

    await facts.initialize()
    await facts.initialize()

    const indexes = (await db.collection(name).listIndexes().toArray()).map((index) => String(index.name))
    expect(indexes.sort()).toEqual([...ORDINARY_INDEXES].sort())
    const capabilities = facts['_connection'].capabilities
    expect(capabilities).toBeDefined()
    const warnings = logger.lines('warn').filter((line) => line.includes('event=no_search_setup'))
    if (capabilities!.search) {
      expect(warnings).toEqual([])
    } else {
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(`error code ${capabilities!.noSearchCode}`)
      expect(warnings[0]).toContain('Atlas')
      expect(facts['_tiers']).toEqual([])
      expect(
        await db
          .collection(name)
          .listSearchIndexes()
          .toArray()
          .catch(() => 'unsupported')
      ).toBe('unsupported')
    }
  })

  it('AT-185: the tier set agrees with what this deployment can do', async () => {
    const { store: facts } = store('implications')

    await settled(facts)

    const capabilities = facts['_connection'].capabilities!
    const tiers = facts['_tiers']
    expect(capabilities.search || !capabilities.rankFusion).toBe(true)
    if (!capabilities.search) expect(tiers).toEqual([])
    if (!capabilities.rankFusion) expect(tiers).not.toContain('hybrid')
    if (tiers.length > 0) expect(capabilities.search).toBe(true)
    if (tiers.includes('hybrid')) {
      expect(capabilities.rankFusion).toBe(true)
      expect(tiers).toEqual(['hybrid', 'vector', 'text'])
    }
    expect(tiers.length === 0 || tiers.at(-1) === 'text').toBe(true)
  })

  it('AT-185: a manual-vector store resolves the fusion wherever the deployment can run it', async () => {
    const { store: facts, name } = store('manual', { connection: MANUAL_VECTOR })

    await settled(facts)

    const capabilities = facts['_connection'].capabilities!
    if (capabilities.search && capabilities.rankFusion) {
      expect(facts['_tiers']).toEqual(['hybrid', 'vector', 'text'])
      const statuses = Object.fromEntries(
        (await db.collection(name).listSearchIndexes().toArray()).map((index: Document) => [index.name, index.status])
      )
      expect(statuses).toEqual({ vector_index: 'READY', text_index: 'READY' })
    } else {
      expect(facts['_tiers']).not.toContain('hybrid')
    }
  })

  it('AT-185: an explicit hybrid store gets the tier or an error, never a substitute', async () => {
    const { store: reference } = store('hybrid_reference', { connection: MANUAL_VECTOR })
    const { store: hybrid } = store('hybrid', {
      connection: { ...MANUAL_VECTOR, searchType: 'hybrid', indexReadyTimeout: 180 },
    })

    await settled(reference)
    const capabilities = reference['_connection'].capabilities!

    if (reference['_tiers'].includes('hybrid')) {
      await hybrid.initialize()
      expect(hybrid['_tiers']).toEqual(['hybrid'])
    } else if (capabilities.search) {
      const error = await rejectionOf(hybrid.initialize())
      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toMatch(/hybrid|index/)
      expect(hybrid['_tiers']).toEqual([])
    } else {
      await hybrid.initialize()
      expect(hybrid['_tiers']).toEqual([])
    }
  })

  it('AT-065: ten stores initializing at once share one client, one probe and one index set', async () => {
    const probes: string[] = []
    const injected = new MongoClient(tierUri('contract')!, { monitorCommands: true })
    injected.on('commandStarted', (event) => {
      if (event.commandName === 'buildInfo') probes.push(event.commandName)
    })
    const config: MongoDBConfig = { database: DATABASE, client: injected }
    const name = fresh('ten')
    const stores = Array.from(
      { length: 10 },
      (_, index) => new MongoDBMemoryStore({ name: `facts${index}`, config, collection: name })
    )

    try {
      await Promise.all(stores.map((each) => each.initialize()))

      expect(new Set(stores.map((each) => each['_connection'].client)).size).toBe(1)
      expect(await db.collection(name).listIndexes().toArray()).toHaveLength(ORDINARY_INDEXES.length)
      const capabilities = stores[0]!['_connection'].capabilities!
      expect(probes.length).toBeLessThanOrEqual(1)
      if (!capabilities.search) expect(probes).toEqual([])
      expect(stores.every((each) => each['_connection'].capabilities === capabilities)).toBe(true)
    } finally {
      await close(config)
      await injected.close()
    }
  })

  it('AT-176: a case-folding collection is refused before any index is created', async () => {
    const name = fresh('folded')
    await db.createCollection(name, { collation: FOLDING })
    const config: MongoDBConfig = { database: DATABASE, connectionString: tierUri('contract')! }
    configs.push(config)
    const facts = new MongoDBMemoryStore({ name: 'facts', config, collection: name })

    const error = await rejectionOf(facts.initialize())

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('collation')
    expect(error.message).toContain("'en'")
    expect(await db.collection(name).listIndexes().toArray()).toHaveLength(1)
    expect(facts['_initialized']).toBe(false)
  })

  it('AT-192: an absent collection is verified once the indexes have created it', async () => {
    const { store: facts, name } = store('absent')
    expect(await db.listCollections({ name }).toArray()).toEqual([])

    await facts.initialize()

    expect(facts['_connection'].binaryKeys.has(`${DATABASE}.${name}`)).toBe(true)
    expect(await db.listCollections({ name }).toArray()).toHaveLength(1)
  })

  it('AT-014: an authentication failure in initialize renders no password', async () => {
    const config: MongoDBConfig = {
      database: DATABASE,
      connectionString: withPassword(tierUri('contract')!),
      clientOptions: { serverSelectionTimeoutMS: 5000 },
    }
    configs.push(config)
    const facts = new MongoDBMemoryStore({ name: 'facts', config, collection: fresh('leaky') })

    const error = await rejectionOf(facts.initialize())

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('failed')
    for (const rendered of [
      error.message,
      inspect(error, { depth: 4 }),
      inspect(facts, { depth: 5 }),
      JSON.stringify(facts),
    ]) {
      expect(rendered).not.toContain(SECRET)
    }
  })
})
