import { randomUUID } from 'node:crypto'
import { type Logger, StorageError } from '@strands-agents/sdk'
import { type Db, type Document, MongoClient, type MongoServerError } from 'mongodb'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { close } from '../../../src/client.js'
import { ensure } from '../../../src/indexes.js'
import { MongoDBMemoryStore } from '../../../src/memory-store.js'
import type { MongoDBConfig, MongoDBMemoryStoreConfig } from '../../../src/types.js'
import { tierUri } from '../../env.js'
import { describeTier } from '../../tiers.js'

const DATABASE = 'strands_mongodb_integration'
const TIMEOUT_SECONDS = 180

// The manual-vector path: an `autoEmbed` index is rejected at creation on atlas-local (PARITY.md section 4).
const MANUAL_VECTOR = { embeddingDimensions: 4, similarity: 'cosine' } as const

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

// Initializes `store` and waits for every index it can build, so its tier set is final rather than build-order dependent.
async function settled(store: MongoDBMemoryStore): Promise<void> {
  await store.initialize()
  for (const [, spec] of store['_specs']) {
    try {
      await ensure(store['_collection'](), {
        search: [spec],
        create: store['_ensureIndexes'],
        timeout: TIMEOUT_SECONDS,
        logger: store['_logger'],
      })
    } catch (error) {
      if (!(error instanceof StorageError)) throw error
    }
  }
  await store['_retrySearchTiers']()
}

describeTier('integration', 'memory store', () => {
  const run = randomUUID().slice(0, 8)
  const created: string[] = []
  const configs: MongoDBConfig[] = []
  let client: MongoClient
  let db: Db

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
      connectionString: tierUri('integration')!,
      indexReadyTimeout: TIMEOUT_SECONDS,
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

  async function statuses(name: string): Promise<Record<string, string>> {
    return Object.fromEntries(
      (await db.collection(name).listSearchIndexes().toArray()).map((index: Document) => [index.name, index.status])
    )
  }

  beforeAll(() => {
    client = new MongoClient(tierUri('integration')!)
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

  it('AT-078, AT-146: a manual-vector auto store brings both tiers up, hybrid first where the server runs the stage', async () => {
    const { store: facts, logger, name } = store('manual_auto', { connection: MANUAL_VECTOR })

    await facts.initialize()
    const atOnce = [...facts['_tiers']]
    await settled(facts)

    const capabilities = facts['_connection'].capabilities!
    expect(capabilities.search).toBe(true)
    expect(facts['_tiers']).toEqual(capabilities.rankFusion ? ['hybrid', 'vector', 'text'] : ['vector', 'text'])
    expect(await statuses(name)).toEqual({ vector_index: 'READY', text_index: 'READY' })
    expect(facts['_tierRetryAt']).toBeUndefined()
    expect(logger.lines('warn')).toEqual([])
    // Whatever `initialize()` found at once was a subset, logged at info: it never waited for a build.
    expect(facts['_tiers']).toEqual(expect.arrayContaining(atOnce))
    expect(logger.lines('info').filter((line) => line.includes('event=tier_building'))).toHaveLength(
      2 - atOnce.filter((tier) => tier !== 'hybrid').length
    )
  })

  it('AT-242: the first wait resolves once a tier is ready, without the connection lock', async () => {
    const { store: facts } = store('wait', { connection: MANUAL_VECTOR })

    await facts.initialize()
    await facts['_waitForATier']()

    expect(facts['_tiers'].length).toBeGreaterThan(0)
    expect(facts['_waitedForATier']).toBe(true)
    expect(facts['_tierWait']).toBeUndefined()
  })

  it('AT-053c, AT-147: an AutoEmbeddings auto store skips the vector tier with the server reason and answers from text', async () => {
    const { store: facts, logger, name } = store('autoembed_auto')

    await facts.initialize()
    const unavailable = logger.lines('warn').filter((line) => line.includes('event=tier_unavailable'))
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]).toContain(`the vector search tier is not available on ${DATABASE}.${name}`)
    expect(unavailable[0]).toContain('not registered')
    expect(unavailable[0]).toMatch(/tier=vector$/)
    expect(facts['_tierRetryAt']).toBeDefined()

    await settled(facts)

    expect(facts['_tiers']).toEqual(['text'])
    expect(await statuses(name)).toEqual({ text_index: 'READY' })
    const below = logger.lines('warn').filter((line) => line.includes('event=below_vector'))
    expect(below).toHaveLength(1)
    expect(below[0]).toContain('queries resolve to the text tier')
    expect(facts['_tierRetryAt']).toBeDefined()
  })

  it('AT-078: a named vector tier on the AutoEmbeddings path fails with the server reason, creating no tier', async () => {
    const { store: facts, name } = store('autoembed_vector', { connection: { searchType: 'vector' } })

    const error = await rejectionOf(facts.initialize())

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain("'vector_index'")
    expect((error.cause as MongoServerError).code).toBe(8)
    expect(facts['_initialized']).toBe(false)
    expect(facts['_tiers']).toEqual([])
    expect(await statuses(name)).toEqual({})
  })

  it('AT-078: a named text tier waits for its own index and creates no other', async () => {
    const { store: facts, name } = store('autoembed_text', { connection: { searchType: 'text' } })

    await facts.initialize()

    expect(facts['_tiers']).toEqual(['text'])
    expect(await statuses(name)).toEqual({ text_index: 'READY' })
    expect(facts['_tierRetryAt']).toBeUndefined()
  })

  it('AT-147: an explicit hybrid store is fused on the manual path and refused on the AutoEmbeddings one', async () => {
    const { store: manual } = store('manual_hybrid', { connection: { ...MANUAL_VECTOR, searchType: 'hybrid' } })
    const { store: auto } = store('autoembed_hybrid', { connection: { searchType: 'hybrid' } })

    const refusal = await rejectionOf(auto.initialize())
    expect(refusal).toBeInstanceOf(StorageError)
    expect(refusal.message).toContain("'vector_index'")

    if (manual['_connection'].capabilities?.rankFusion ?? true) {
      await manual.initialize()
      expect(manual['_tiers']).toEqual(['hybrid'])
    } else {
      const error = await rejectionOf(manual.initialize())
      expect(error.message).toContain('$rankFusion')
    }
  })

  it('AT-148: a score bound under auto declines the fusion on a deployment that offers it', async () => {
    const { store: facts, logger } = store('bound', { connection: MANUAL_VECTOR, store: { minScore: 0.7 } })

    await settled(facts)

    if (!facts['_connection'].capabilities!.rankFusion) return
    expect(facts['_tiers']).toEqual(['vector', 'text'])
    const declined = logger.lines('warn').filter((line) => line.includes('event=bound_declined_fusion'))
    expect(declined.length).toBeGreaterThanOrEqual(1)
    expect(declined[0]).toContain("'minScore' is set to 0.7")
  })
})
