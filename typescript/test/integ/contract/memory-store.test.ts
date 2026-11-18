import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import {
  Agent,
  type BaseModelConfig,
  type Logger,
  MemoryManager,
  Message,
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  type ModelStreamEvent,
  SessionManager,
  StorageError,
  TextBlock,
} from '@strands-agents/sdk'
import { Collection, type Db, type Document, MongoClient, MongoServerError, ObjectId } from 'mongodb'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { close, resolve } from '../../../src/client.js'
import { ensure } from '../../../src/ensure-indexes.js'
import { EXPIRES_FIELD, memorySearchSpecs } from '../../../src/index-specs.js'
import { searchSupport } from '../../../src/probes.js'
import { MongoDBMemoryStore, UNSCOPED } from '../../../src/memory-store.js'
import type { SearchTiers } from '../../../src/search-tiers.js'
import { MongoDBStorage } from '../../../src/storage.js'
import type { MongoDBConfig, MongoDBMemoryStoreConfig, ResolvedSearchType } from '../../../src/types.js'
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

const CONTENT = 'the user prefers dark mode'

// How long the server's TTL monitor gets to sweep a document stamped to expire at once; its cycle is 60 s by default.
const TTL_SWEEP_BUDGET_MS = 150_000

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The smallest `Model` the SDK allows: one text block and a stop, so an `Agent` can complete a turn with no provider.
class OneLineModel extends Model<BaseModelConfig> {
  private _config: BaseModelConfig = { modelId: 'one-line' }

  updateConfig(config: BaseModelConfig): void {
    this._config = config
  }

  getConfig(): BaseModelConfig {
    return this._config
  }

  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' })
    yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' })
    yield new ModelContentBlockDeltaEvent({
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'textDelta', text: 'noted' },
    })
    yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' })
    yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
  }
}

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

function errorOf(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
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

// The one private this file reads: which tiers a store resolved is not part of its public surface.
function tiersOf(store: MongoDBMemoryStore): SearchTiers {
  return store['_tiers']
}

interface Built {
  store: MongoDBMemoryStore
  logger: RecordingLogger
  name: string
  config: MongoDBConfig
}

// Initializes an `auto` store and waits for every index it can build, so its tier set is final rather than build-order dependent.
async function settled(built: Built, db: Db): Promise<readonly ResolvedSearchType[]> {
  const { store, config, name, logger } = built
  await store.initialize()
  if (!resolve(config).capabilities?.search) return tiersOf(store).prepared
  const collection = db.collection(name)
  for (const spec of memorySearchSpecs(config)) {
    // A refused index, such as an autoEmbed one on a deployment with no model, raises at once and stays out.
    try {
      await ensure(collection, { search: [spec], create: true, timeout: 180, logger })
    } catch (error) {
      if (!(error instanceof StorageError)) throw error
    }
  }
  await tiersOf(store).retry(collection)
  return tiersOf(store).prepared
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
  ): Built {
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
      config,
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

  it('AT-045a, AT-053a, AT-065: initialize twice creates the ordinary indexes once, and warns once where there is no search', async () => {
    const { store: facts, logger, name, config } = store('ordinary')

    await facts.initialize()
    await facts.initialize()

    const indexes = (await db.collection(name).listIndexes().toArray()).map((index) => String(index.name))
    expect(indexes.sort()).toEqual([...ORDINARY_INDEXES].sort())
    const capabilities = resolve(config).capabilities
    expect(capabilities).toBeDefined()
    const warnings = logger.lines('warn').filter((line) => line.includes('event=no_search_setup'))
    if (capabilities!.search) {
      expect(warnings).toEqual([])
    } else {
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(`error code ${capabilities!.noSearchCode}`)
      expect(warnings[0]).toContain('Atlas')
      expect(tiersOf(facts).prepared).toEqual([])
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
    const built = store('implications')

    const tiers = await settled(built, db)

    const capabilities = resolve(built.config).capabilities!
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
    const built = store('manual', { connection: MANUAL_VECTOR })
    const { name } = built

    const tiers = await settled(built, db)

    const capabilities = resolve(built.config).capabilities!
    if (capabilities.search && capabilities.rankFusion) {
      expect(tiers).toEqual(['hybrid', 'vector', 'text'])
      const statuses = Object.fromEntries(
        (await db.collection(name).listSearchIndexes().toArray()).map((index: Document) => [index.name, index.status])
      )
      expect(statuses).toEqual({ vector_index: 'READY', text_index: 'READY' })
    } else {
      expect(tiers).not.toContain('hybrid')
    }
  })

  it('AT-185: a plain-string query resolves to hybrid only where hybrid is on offer, and to no tier at all without search', async () => {
    const built = store('plain_string')

    const tiers = await settled(built, db)

    const capabilities = resolve(built.config).capabilities!
    const pick = (): string => tiersOf(built.store).pick('dark mode', undefined).tier
    if (tiers.includes('hybrid')) {
      expect(pick()).toBe('hybrid')
    } else if (tiers.length > 0) {
      expect(pick()).not.toBe('hybrid')
    } else {
      const error = errorOf(pick)
      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain(`server error code ${capabilities.noSearchCode}`)
    }
  })

  it('AT-185: an explicit hybrid store gets the tier or an error, never a substitute', async () => {
    const reference = store('hybrid_reference', { connection: MANUAL_VECTOR })
    const { store: hybrid } = store('hybrid', {
      connection: { ...MANUAL_VECTOR, searchType: 'hybrid', indexReadyTimeout: 180 },
    })

    const tiers = await settled(reference, db)
    const capabilities = resolve(reference.config).capabilities!

    if (tiers.includes('hybrid')) {
      await hybrid.initialize()
      expect(tiersOf(hybrid).prepared).toEqual(['hybrid'])
    } else if (capabilities.search) {
      const error = await rejectionOf(hybrid.initialize())
      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toMatch(/hybrid|index/)
      expect(tiersOf(hybrid).prepared).toEqual([])
    } else {
      await hybrid.initialize()
      expect(tiersOf(hybrid).prepared).toEqual([])
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

      expect(await db.collection(name).listIndexes().toArray()).toHaveLength(ORDINARY_INDEXES.length)
      expect(probes.length).toBeLessThanOrEqual(1)
      if (!resolve(config).capabilities!.search) expect(probes).toEqual([])
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
    await expect(facts.initialize()).rejects.toBeInstanceOf(StorageError)
  })

  it('AT-192: an absent collection is verified once the indexes have created it', async () => {
    const { store: facts, name, config } = store('absent')
    expect(await db.listCollections({ name }).toArray()).toEqual([])

    await facts.initialize()

    expect(resolve(config).binaryKeys.has(`${DATABASE}.${name}`)).toBe(true)
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

  it('AT-042, AT-043: add stores the same content once, the second call reporting the first id and leaving created_at alone', async () => {
    const { store: facts, name } = store('dedup', { store: { writable: true, scope: 'tenant-a' } })

    const first = await facts.add(CONTENT)
    const before = (await db.collection(name).findOne({}))!.created_at as Date
    const second = await facts.add(CONTENT)

    expect(first).toEqual({ ids: [expect.stringMatching(/^[0-9a-f]{24}$/)], inserted: 1, duplicates: 0 })
    expect(second).toEqual({ ids: first.ids, inserted: 0, duplicates: 1 })
    expect(await db.collection(name).countDocuments({})).toBe(1)
    expect((await db.collection(name).findOne({}))!.created_at).toEqual(before)
  })

  it('AT-043: a lost insert race is reported as the duplicate of the winner', async () => {
    const { store: facts, name } = store('race', { store: { writable: true, scope: 'tenant-a' } })
    const first = await facts.add(CONTENT)
    const updateOne = vi
      .spyOn(Collection.prototype, 'updateOne')
      .mockRejectedValueOnce(
        new MongoServerError({ message: 'E11000 duplicate key error collection: injected', code: 11000 })
      )

    const second = await facts.add(CONTENT)

    expect(updateOne).toHaveBeenCalledTimes(1)
    expect(second).toEqual({ ids: first.ids, inserted: 0, duplicates: 1 })
    expect(await db.collection(name).countDocuments({})).toBe(1)
  })

  it('AT-043: ten concurrent adds of one fact store one document', async () => {
    const { store: facts, name } = store('concurrent', { store: { writable: true, scope: 'tenant-a' } })

    const results = await Promise.all(Array.from({ length: 10 }, () => facts.add(CONTENT)))

    expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1)
    expect(results.reduce((sum, result) => sum + result.duplicates, 0)).toBe(9)
    expect(new Set(results.flatMap((result) => result.ids)).size).toBe(1)
    expect(await db.collection(name).countDocuments({})).toBe(1)
  })

  it('AT-046, AT-048a: the stored document carries the scope the store stamps, never one from metadata or the filter', async () => {
    const { store: scoped, name, config } = store('stamps', { store: { writable: true, scope: 'tenant-a' } })
    const filtered = new MongoDBMemoryStore({
      name: 'filtered',
      config,
      collection: name,
      writable: true,
      scope: 'tenant-a',
      filter: { scope: 'tenant-b' },
    })
    const unscoped = new MongoDBMemoryStore({
      name: 'nobody',
      config,
      collection: name,
      writable: true,
    })

    await scoped.add(CONTENT, { scope: 'tenant-b', _scope: 'tenant-b' })
    await filtered.add('a fact')
    await unscoped.add('a fact from a store nobody scoped')

    const document = (await db.collection(name).findOne({ store_name: 'facts' }))!
    expect(document.scope).toBe('tenant-a')
    expect(document.content).toBe(CONTENT)
    expect(document.content_hash).toBe(sha256(CONTENT))
    expect(document.created_at).toBeInstanceOf(Date)
    expect(document.metadata).toEqual({ scope: 'tenant-b', _scope: 'tenant-b' })
    expect(await db.collection(name).countDocuments({ scope: 'tenant-b' })).toBe(0)
    expect((await db.collection(name).findOne({ store_name: 'filtered' }))!.scope).toBe('tenant-a')
    expect(unscoped.scope).toBe(UNSCOPED)
    expect((await db.collection(name).findOne({ store_name: 'nobody' }))!.scope).toBe('__unscoped__')
  })

  it('AT-047b: the same fact in two scopes is two documents', async () => {
    const { store: first, name, config } = store('two_scopes', { store: { writable: true, scope: 'tenant-a' } })
    const second = new MongoDBMemoryStore({
      name: 'facts',
      config,
      collection: name,
      writable: true,
      scope: 'tenant-b',
    })

    const a = await first.add(CONTENT)
    const b = await second.add(CONTENT)

    expect([a.inserted, b.inserted]).toEqual([1, 1])
    expect(a.ids).not.toEqual(b.ids)
    expect(await db.collection(name).countDocuments({ scope: 'tenant-a' })).toBe(1)
    expect(await db.collection(name).countDocuments({ scope: 'tenant-b' })).toBe(1)
  })

  it('AT-085: delete and deleteAll reach only this store, in one collection shared with a sibling and another scope', async () => {
    const { store: mine, name, config } = store('deletes', { store: { writable: true, scope: 'tenant-a' } })
    const sibling = new MongoDBMemoryStore({
      name: 'notes',
      config,
      collection: name,
      writable: true,
      scope: 'tenant-a',
    })
    const elsewhere = new MongoDBMemoryStore({
      name: 'facts',
      config,
      collection: name,
      writable: true,
      scope: 'tenant-b',
    })
    const first = await mine.add(CONTENT)
    await mine.add('the user works in emea')
    const theirs = await sibling.add(CONTENT)
    const far = await elsewhere.add(CONTENT)
    const collection = db.collection(name)

    expect(await mine.delete(first.ids[0]!)).toBe(1)
    expect(await mine.delete(first.ids[0]!)).toBe(0)
    expect(await mine.delete(theirs.ids[0]!)).toBe(0)
    expect(await mine.delete(far.ids[0]!)).toBe(0)
    expect(await mine.delete(new ObjectId().toHexString())).toBe(0)
    expect(await collection.countDocuments({})).toBe(3)

    await mine.add(CONTENT)
    expect(await mine.deleteAll()).toBe(2)
    expect(await collection.countDocuments({ store_name: 'facts', scope: 'tenant-a' })).toBe(0)
    expect(await collection.countDocuments({ store_name: 'notes' })).toBe(1)
    expect(await collection.countDocuments({ scope: 'tenant-b' })).toBe(1)
  })

  it('AT-053c: search on a deployment without Atlas Search throws naming the code and what to connect to', async () => {
    const { store: auto, name } = store('nosearch_auto', { store: { writable: true } })
    const { store: vector } = store('nosearch_vector', { connection: { ...MANUAL_VECTOR, searchType: 'vector' } })
    await auto.initialize()
    const support = await searchSupport(db.collection(name))

    if (support.available) {
      expect(await vector.search({ vector: [0, 0, 0, 1] })).toEqual([])
      return
    }
    expect((await auto.add(CONTENT)).inserted).toBe(1)
    for (const facts of [auto, vector]) {
      const error = await rejectionOf(facts.search('dark mode'))
      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain(`server error code ${support.code}`)
      expect(error.message).toContain('Atlas')
      expect(error.message).not.toContain('createSearchIndexes')
      expect(error.message).not.toContain('NOT READY')
    }
  })

  it('AT-152: a memory written with ttlSeconds 0 is gone after the sweep, with no index call by the caller', async () => {
    await client
      .db('admin')
      .command({ setParameter: 1, ttlMonitorSleepSecs: 1 })
      .catch(() => undefined)
    const { store: facts, name } = store('ttl', { store: { writable: true, scope: 'tenant-a', ttlSeconds: 0 } })
    const collection = db.collection(name)

    expect((await facts.add('this memory is written to be forgotten')).inserted).toBe(1)

    const stamped = await collection.findOne({ scope: 'tenant-a' })
    expect(stamped?.[EXPIRES_FIELD]).toBeInstanceOf(Date)
    const deadline = Date.now() + TTL_SWEEP_BUDGET_MS
    while ((await collection.countDocuments({ scope: 'tenant-a' })) > 0 && Date.now() < deadline) await sleep(1000)
    expect(await collection.countDocuments({ scope: 'tenant-a' })).toBe(0)
  })

  it('AT-014: add and search on a wrong password fail without rendering it', async () => {
    const config: MongoDBConfig = {
      database: DATABASE,
      connectionString: withPassword(tierUri('contract')!),
      clientOptions: { serverSelectionTimeoutMS: 5000 },
    }
    configs.push(config)
    const facts = new MongoDBMemoryStore({ name: 'facts', config, collection: fresh('leaky_ops'), writable: true })

    for (const pending of [facts.add('a fact'), facts.search('dark mode')]) {
      const error = await rejectionOf(pending)
      expect(error).toBeInstanceOf(StorageError)
      for (const rendered of [error.message, inspect(error, { depth: 4 })]) expect(rendered).not.toContain(SECRET)
    }
  })

  it('AT-014: the succeeding path renders no password at debug, with an injected client beside a leaky string', async () => {
    const injected = new MongoClient(tierUri('contract')!)
    const logger = new RecordingLogger()
    const config: MongoDBConfig = {
      database: DATABASE,
      client: injected,
      connectionString: withPassword(tierUri('contract')!),
      logger,
    }
    const facts = new MongoDBMemoryStore({ name: 'facts', config, collection: fresh('leaky_debug'), writable: true })
    const connection = resolve(config)

    try {
      await facts.initialize()
      await facts.add(CONTENT)
      facts.getTools()
    } finally {
      await facts.close()
      await injected.close()
    }

    for (const rendered of [
      ...logger.records.map(([, line]) => line),
      inspect(facts, { depth: 5 }),
      inspect(connection, { depth: 5 }),
    ]) {
      expect(rendered).not.toContain(SECRET)
    }
  })

  it('AT-052a, AT-044b: a MemoryManager over a writable store adds only its own two tools and initializes the store through the Agent', async () => {
    const { store: facts, name } = store('manager', { store: { writable: true } })
    const manager = new MemoryManager({ stores: [facts], addToolConfig: true })
    const agent = new Agent({ model: new OneLineModel(), memoryManager: manager, printer: false })

    await agent.initialize()

    expect(await db.collection(name).listIndexes().toArray()).toHaveLength(ORDINARY_INDEXES.length)
    expect(manager.getTools().map((tool) => tool.name)).toEqual(['search_memory', 'add_memory'])
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual(['add_memory', 'search_memory'])
  })
})

describeTier('contract', 'session manager wiring through MongoDBStorage', () => {
  const run = randomUUID().slice(0, 8)
  const created: string[] = []
  let client: MongoClient
  let db: Db
  let config: MongoDBConfig

  function fresh(label: string): string {
    const name = `session_${label}_${run}`
    created.push(name)
    return name
  }

  // The layout `SnapshotStorageAdapter` writes under the `session` namespace the manager applies to raw storage.
  function snapshotsPrefix(sessionId: string, agentId: string): string {
    return `${sessionId}/scopes/agent/${agentId}/snapshots/`
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

  it('AT-027: a uuid7 snapshot set the SDK generates lists chronologically', async () => {
    const storage = new MongoDBStorage(config, { collection: fresh('uuid7') }).namespace('session')
    const manager = new SessionManager({ sessionId: 's1', storage })
    const agent = new Agent({ id: 'a1', model: new OneLineModel(), printer: false })
    const prefix = `${snapshotsPrefix('s1', 'a1')}immutable_history/`
    const written: string[] = []

    for (let index = 0; index < 25; index += 1) {
      await manager.saveSnapshot({ target: agent, isLatest: false })
      const keys = await storage.list(prefix)
      written.push(...keys.filter((key) => !written.includes(key)))
    }

    expect(written).toHaveLength(25)
    expect(await storage.list(prefix)).toEqual(written)
    expect(await manager.listSnapshotIds({ target: agent })).toEqual(
      written.map((key) => /snapshot_([\w-]+)\.json$/.exec(key)![1])
    )
  })

  it('AT-081: the snapshots directory round-trips on the keys the SDK builds, scoped once whichever storage it is handed', async () => {
    const name = fresh('layout')
    const raw = new MongoDBStorage(config, { collection: name })
    const scoped = raw.namespace('session')
    const latest = `${snapshotsPrefix('s1', 'a1')}snapshot_latest.json`
    const viaRaw = new SessionManager({ sessionId: 's1', storage: raw })
    const viaScoped = new SessionManager({ sessionId: 's1', storage: scoped })
    const agent = new Agent({ id: 'a1', model: new OneLineModel(), printer: false })

    await viaRaw.saveSnapshot({ target: agent, isLatest: true })
    const first = await scoped.read(latest)
    agent.messages.push(new Message({ role: 'user', content: [new TextBlock('hello again')] }))
    await viaScoped.saveSnapshot({ target: agent, isLatest: true })
    const second = await scoped.read(latest)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first).not.toEqual(second)
    expect(Buffer.from(second!).toString('utf8')).toContain('hello again')
    expect(await db.collection(name).findOne({ _id: `session/${latest}` } as Document)).not.toBeNull()
    expect(await db.collection(name).countDocuments({})).toBe(1)

    for (let index = 0; index < 3; index += 1) await viaScoped.saveSnapshot({ target: agent, isLatest: false })
    const found = await scoped.list(snapshotsPrefix('s1', 'a1'))
    expect(found).toHaveLength(4)
    expect(found.slice(0, 3).every((key) => key.includes('/immutable_history/snapshot_'))).toBe(true)
    expect(found[3]).toBe(latest)

    const restored = new Agent({ id: 'a1', model: new OneLineModel(), printer: false })
    expect(await viaScoped.restoreSnapshot({ target: restored })).toBe(true)
    expect(restored.messages.map((message) => message.toJSON())).toEqual(
      agent.messages.map((message) => message.toJSON())
    )
  })

  it('AT-081: an Agent saves its session through MongoDBStorage and a second Agent restores it', async () => {
    const name = fresh('agent')
    const sessionId = `s_${run}`
    const first = new Agent({
      id: 'a1',
      model: new OneLineModel(),
      storage: new MongoDBStorage(config, { collection: name }),
      sessionManager: new SessionManager({ sessionId }),
      printer: false,
    })

    const result = await first.invoke('hello')
    expect(String(result)).toContain('noted')
    expect(first.messages).toHaveLength(2)

    const second = new Agent({
      id: 'a1',
      model: new OneLineModel(),
      storage: new MongoDBStorage(config, { collection: name }),
      sessionManager: new SessionManager({ sessionId }),
      printer: false,
    })
    await second.initialize()

    expect(second.messages.map((message) => message.toJSON())).toEqual(
      first.messages.map((message) => message.toJSON())
    )
    expect(await db.collection(name).countDocuments({})).toBe(1)
    expect((await db.collection(name).findOne({}))!._id).toBe(
      `session/${snapshotsPrefix(sessionId, 'a1')}snapshot_latest.json`
    )
  })
})
