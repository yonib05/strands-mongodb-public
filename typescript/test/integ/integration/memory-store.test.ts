import { createHash, randomUUID } from 'node:crypto'
import { type MemoryEntry, StorageError } from '@strands-agents/sdk'
import type { Embedder } from '@strands-agents/sdk/storage/search'
import { type Collection, type Db, type Document, MongoClient, type MongoServerError } from 'mongodb'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { type Capabilities, close } from '../../../src/client.js'
import { ensure } from '../../../src/ensure-indexes.js'
import { CONTENT_FIELD, DEFAULT_VECTOR_INDEX_NAME, memorySearchSpecs, VECTOR_FIELD } from '../../../src/index-specs.js'
import { MongoDBMemoryStore, UNSCOPED } from '../../../src/memory-store.js'
import { RANK_FUSION_PENALTY, VECTOR_SCORE_META } from '../../../src/pipeline.js'
import {
  type MongoDBConfig,
  type MongoDBMemoryStoreConfig,
  type MongoDBSearchQuery,
  RESERVED_METADATA_KEYS,
  type VectorSimilarity,
} from '../../../src/types.js'
import { tierUri } from '../../env.js'
import { capabilitiesOf } from '../deployment.js'
import { describeTier } from '../../tiers.js'
import { rejectionOf } from '../../../src/__fixtures__/errors.js'
import { RecordingLogger } from '../../../src/__fixtures__/logger.js'
import { recordSpans, reportedTiers } from '../../../src/__fixtures__/spans.js'

const DATABASE = 'strands_mongodb_integration'
const TIMEOUT_SECONDS = 180

// The manual-vector path: an `autoEmbed` index is rejected at creation on atlas-local (PARITY.md section 4).
const MANUAL_VECTOR = { embeddingDimensions: 4, similarity: 'cosine' } as const

// The query for every vector-tier test, aligned with the seeded vectors on the first axis.
const QUERY_VECTOR = [1, 0, 0, 0]

// The query for every text-tier test. Present in every seeded document, so ranking is not the claim.
const QUERY_TEXT = 'dark mode'

const CONTENT = 'the user prefers dark mode'

const NO_RANK_FUSION = 'this deployment has no $rankFusion'

// How long a write is waited on before it counts as never having become searchable, polling twice a second.
const SEARCHABLE_BUDGET_MS = 180_000

// Four documents shaped so reciprocal rank fusion ranks one that neither tier ranks first (see the Python corpus).
const FUSION_CORPUS: Record<string, number[]> = {
  'the user prefers a dim interface at night': [1, 0, 0, 0],
  'dark mode': [0.9, 0.44, 0, 0],
  'dark mode is the setting the user prefers': [0.7, 0.71, 0, 0],
  'dark mode dark mode dark mode, in dark mode': [0.2, 0.98, 0, 0],
}

// The paraphrase holds neither query term, so the text tier can never return it.
const FUSION_TEXT_MATCHES = Object.keys(FUSION_CORPUS).filter((content) => content.includes(QUERY_TEXT)).length

const METRIC_QUERY = [1, 0, 0, 0]

// Six vectors chosen so the three metrics disagree: cosine ties the second and third, dotProduct puts the third first, euclidean last.
const METRIC_CORPUS: Record<string, number[]> = {
  'on the axis, a tenth of the way out': [0.1, 0, 0, 0],
  'half a unit, off the axis': [0.3, 0.4, 0, 0],
  'the same direction as the last one, ten times as long': [3, 4, 0, 0],
  'unit length, spread over every dimension': [0.5, 0.5, 0.5, 0.5],
  'square to the query, in a dimension of its own': [0, 0, 1, 0],
  'off to one side and behind': [-0.6, 0.8, 0, 0],
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function metadataOf(entry: MemoryEntry): Record<string, unknown> {
  expect(entry.metadata).toBeDefined()
  return entry.metadata!
}

function contents(entries: MemoryEntry[]): string[] {
  return entries.map((entry) => entry.content)
}

// A three-dimension embedder over `dark`, `mode` and `coffee`, so an expected neighbour is readable off the vector.
class WordEmbedder implements Embedder {
  readonly calls: string[] = []

  async embed(text: string): Promise<number[]> {
    this.calls.push(text)
    const words = text.toLowerCase().split(/\s+/)
    return ['dark', 'mode', 'coffee'].map((word) => 0.01 + words.filter((w) => w === word).length)
  }
}

// Searches until mongot has the corpus: `READY` means the index exists, not that every document has reached it.
async function answered(
  store: MongoDBMemoryStore,
  query: string | MongoDBSearchQuery,
  expected = 1
): Promise<MemoryEntry[]> {
  const deadline = Date.now() + SEARCHABLE_BUDGET_MS
  for (;;) {
    const results = await store.search(query)
    if (results.length >= expected || Date.now() >= deadline) return results
    await sleep(500)
  }
}

// Writes vector-bearing documents in the shape `add` writes, since no `MemoryStore` method takes a vector.
async function seedVectors(
  collection: Collection,
  placement: { scope: string; storeName: string },
  facts: Record<string, number[]>
): Promise<void> {
  const now = new Date()
  await collection.insertMany(
    Object.entries(facts).map(([content, vector]) => ({
      [CONTENT_FIELD]: content,
      [VECTOR_FIELD]: vector,
      scope: placement.scope,
      store_name: placement.storeName,
      content_hash: sha256(content),
      created_at: now,
    }))
  )
}

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0)
}

// This metric's own nearness, higher being nearer; the negated squared distance for euclidean so one comparison reads the same.
function similarity(metric: VectorSimilarity, vector: number[]): number {
  if (metric === 'cosine')
    return dot(vector, METRIC_QUERY) / Math.sqrt(dot(vector, vector) * dot(METRIC_QUERY, METRIC_QUERY))
  if (metric === 'dotProduct') return dot(vector, METRIC_QUERY)
  return -vector.reduce((sum, value, index) => sum + (value - METRIC_QUERY[index]!) ** 2, 0)
}

// The score atlas-local was measured to compute: `(1 + cosine) / 2`, `(1 + dot) / 2`, `1 / (1 + squared distance)`.
function expectedScore(metric: VectorSimilarity, vector: number[]): number {
  const near = similarity(metric, vector)
  return metric === 'euclidean' ? 1 / (1 - near) : (1 + near) / 2
}

// Ranks contents the way `$rankFusion` does from the orders each tier returned; an absent document scores zero from that tier.
function fuse(...orders: string[][]): string[] {
  const scores = new Map<string, number>()
  for (const order of orders) {
    order.forEach((content, index) =>
      scores.set(content, (scores.get(content) ?? 0) + 1 / (RANK_FUSION_PENALTY + index + 1))
    )
  }
  return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)! || (a < b ? -1 : 1))
}

const exporter = recordSpans()

describeTier('integration', 'memory store', () => {
  const run = randomUUID().slice(0, 8)
  const created: string[] = []
  const configs: MongoDBConfig[] = []
  // What each store was built from, for the helpers that need its connection or collection.
  const builds = new Map<MongoDBMemoryStore, { config: MongoDBConfig; name: string }>()
  let client: MongoClient
  let db: Db
  let capabilities: Capabilities

  function register(config: MongoDBConfig, name: string, options: Partial<MongoDBMemoryStoreConfig> = {}) {
    configs.push(config)
    const built = new MongoDBMemoryStore({ name: 'facts', config, collection: name, ...options })
    builds.set(built, { config, name })
    return built
  }

  // Builds every index the deployment can before the store initializes, so the tier set it reports is final rather
  // than build-order dependent.
  async function settled(store: MongoDBMemoryStore): Promise<string[]> {
    const { config, name } = builds.get(store)!
    const collection = db.collection(name)
    for (const spec of memorySearchSpecs(config)) {
      try {
        await ensure(collection, { search: [spec], create: true, timeout: TIMEOUT_SECONDS, logger: config.logger! })
      } catch (error) {
        if (!(error instanceof StorageError)) throw error
      }
    }
    await store.initialize()
    return reportedTiers(exporter)
  }

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
    const name = fresh(label)
    return { store: register(config, name, options.store), logger, name }
  }

  async function statuses(name: string): Promise<Record<string, string>> {
    return Object.fromEntries(
      (await db.collection(name).listSearchIndexes().toArray()).map((index: Document) => [index.name, index.status])
    )
  }

  beforeAll(async () => {
    client = new MongoClient(tierUri('integration')!)
    db = client.db(DATABASE)
    capabilities = await capabilitiesOf(db)
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
    const atOnce = reportedTiers(exporter)
    const tiers = await settled(sibling(facts, name))

    expect(capabilities.search).toBe(true)
    expect(tiers).toEqual(capabilities.rankFusion ? ['hybrid', 'vector', 'text'] : ['vector', 'text'])
    expect(await statuses(name)).toEqual({ vector_index: 'READY', text_index: 'READY' })
    expect(logger.lines('warn')).toEqual([])
    // Whatever `initialize()` found at once was a subset, logged at info: it never waited for a build.
    expect(tiers).toEqual(expect.arrayContaining(atOnce))
    expect(logger.lines('info').filter((line) => line.includes('event=tier_building'))).toHaveLength(
      2 - atOnce.filter((tier) => tier !== 'hybrid').length
    )
  })

  it('AT-242: the first search waits until a tier is ready and then answers', async () => {
    // The default config, whose vector index atlas-local refuses: only the text tier can come up, so the wait
    // cannot end on a tier this text query does not fit.
    const { store: facts } = store('wait')

    await facts.initialize()
    await expect(facts.search(QUERY_TEXT)).resolves.toEqual([])

    expect(reportedTiers(exporter).length).toBeGreaterThan(0)
  })

  it('AT-053c, AT-147: an AutoEmbeddings auto store skips the vector tier with the server reason and answers from text', async () => {
    const { store: facts, logger, name } = store('autoembed_auto')

    await facts.initialize()
    const unavailable = logger.lines('warn').filter((line) => line.includes('event=tier_unavailable'))
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]).toContain(`namespace=${DATABASE}.${name}`)
    expect(unavailable[0]).toContain('not registered')
    expect(unavailable[0]).toMatch(/tier=vector$/)

    expect(await settled(sibling(facts, name))).toEqual(['text'])
    expect(await statuses(name)).toEqual({ text_index: 'READY' })
    const below = logger.lines('warn').filter((line) => line.includes('event=below_vector'))
    expect(below).toHaveLength(1)
    expect(below[0]).toMatch(/tier=text$/)
  })

  it('AT-078: a named vector tier on the AutoEmbeddings path fails with the server reason, creating no tier', async () => {
    const { store: facts, name } = store('autoembed_vector', { connection: { searchType: 'vector' } })

    const error = await rejectionOf(facts.initialize())

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain("'vector_index'")
    expect((error.cause as MongoServerError).code).toBe(8)
    expect(await statuses(name)).toEqual({})
  })

  it('AT-078: a named text tier waits for its own index and creates no other', async () => {
    const { store: facts, name } = store('autoembed_text', { connection: { searchType: 'text' } })

    await facts.initialize()

    expect(reportedTiers(exporter)).toEqual(['text'])
    expect(await statuses(name)).toEqual({ text_index: 'READY' })
  })

  it('AT-147: an explicit hybrid store is fused on the manual path and refused on the AutoEmbeddings one', async () => {
    const { store: manual } = store('manual_hybrid', { connection: { ...MANUAL_VECTOR, searchType: 'hybrid' } })
    const { store: auto } = store('autoembed_hybrid', { connection: { searchType: 'hybrid' } })

    const refusal = await rejectionOf(auto.initialize())
    expect(refusal).toBeInstanceOf(StorageError)
    expect(refusal.message).toContain("'vector_index'")

    if (capabilities.rankFusion) {
      await manual.initialize()
      expect(reportedTiers(exporter)).toEqual(['hybrid'])
    } else {
      const error = await rejectionOf(manual.initialize())
      expect(error.message).toContain('$rankFusion')
    }
  })

  it('AT-148: a score bound under auto declines the fusion on a deployment that offers it', async (context) => {
    if (!capabilities.rankFusion) context.skip(NO_RANK_FUSION)
    const { store: facts, logger } = store('bound', { connection: MANUAL_VECTOR, store: { minScore: 0.7 } })

    const tiers = await settled(facts)

    expect(tiers).toEqual(['vector', 'text'])
    const declined = logger.lines('warn').filter((line) => line.includes('event=bound_declined_fusion'))
    expect(declined.length).toBeGreaterThanOrEqual(1)
    expect(declined[0]).toContain("'minScore' is set to 0.7")
  })

  function sibling(
    reference: MongoDBMemoryStore,
    name: string,
    options: { connection?: Partial<MongoDBConfig>; store?: Partial<Omit<MongoDBMemoryStoreConfig, 'config'>> } = {}
  ): MongoDBMemoryStore {
    return register({ ...builds.get(reference)!.config, ...options.connection }, name, options.store)
  }

  it('AT-243, AT-054: with an embedder, a memory added as text is found by a text query on the vector tier', async () => {
    const embedder = new WordEmbedder()
    const { store: facts } = store('embedder_vector', {
      connection: { embeddingDimensions: 3, similarity: 'cosine', searchType: 'vector' },
      store: { writable: true, scope: 'tenant-a', embedder },
    })

    await facts.add(CONTENT)
    await facts.add('the user drinks coffee')
    const byText = await answered(facts, QUERY_TEXT, 2)
    const byVector = await answered(facts, { vector: [1.01, 1.01, 0.01] }, 2)

    expect(contents(byText)).toEqual([CONTENT, 'the user drinks coffee'])
    expect(contents(byVector)).toEqual(contents(byText))
    expect(byText.map((entry) => metadataOf(entry)._searchType)).toEqual(['vector', 'vector'])
    expect(embedder.calls.slice(0, 2)).toEqual([CONTENT, 'the user drinks coffee'])
    expect(embedder.calls.slice(2).every((text) => text === QUERY_TEXT)).toBe(true)
  })

  it('AT-054: a text store answers a text query from the text tier and embeds nothing for it', async () => {
    const embedder = new WordEmbedder()
    const { store: facts } = store('embedder_text', {
      connection: { embeddingDimensions: 3, similarity: 'cosine', searchType: 'text' },
      store: { writable: true, scope: 'tenant-a', embedder },
    })

    await facts.add(CONTENT)
    const found = await answered(facts, QUERY_TEXT)

    expect(contents(found)).toEqual([CONTENT])
    expect(metadataOf(found[0]!)._searchType).toBe('text')
    expect(embedder.calls).toEqual([CONTENT])
  })

  it('AT-157, AT-243: a hybrid store fuses text with a caller vector, or with the vector its embedder computes', async (context) => {
    if (!capabilities.rankFusion) context.skip(NO_RANK_FUSION)
    const embedder = new WordEmbedder()
    const { store: facts } = store('embedder_hybrid', {
      connection: { embeddingDimensions: 3, similarity: 'cosine', searchType: 'hybrid' },
      store: { writable: true, scope: 'tenant-a', embedder },
    })

    await facts.add(CONTENT)
    await facts.add('the user drinks coffee')
    const explicit = await answered(facts, { text: QUERY_TEXT, vector: [1.01, 1.01, 0.01] }, 2)
    const plain = await answered(facts, QUERY_TEXT, 2)

    for (const found of [explicit, plain]) {
      expect(contents(found)).toEqual([CONTENT, 'the user drinks coffee'])
      expect(found.map((entry) => metadataOf(entry)._searchType)).toEqual(['hybrid', 'hybrid'])
      const best = metadataOf(found[0]!)._relevanceScore as number
      expect(best).toBeGreaterThan(0)
      expect(best).toBeLessThanOrEqual(2 / (RANK_FUSION_PENALTY + 1))
    }
  })

  it('AT-040: a search hands back entries carrying the four reserved keys and the caller metadata', async () => {
    const { store: facts } = store('hands_back', { store: { writable: true, scope: 'tenant-a' } })

    await facts.add(CONTENT, { source: 'chat' })
    for (const fact of ['dark mode is preferred', 'dark mode at night']) await facts.add(fact)
    const results = await answered(facts, QUERY_TEXT, 3)

    expect(results).toHaveLength(3)
    const entry = results.find((candidate) => candidate.content === CONTENT)!
    expect(entry.storeName).toBe('facts')
    const metadata = metadataOf(entry)
    expect(metadata._id).toMatch(/^[0-9a-f]{24}$/)
    expect(metadata._scope).toBe('tenant-a')
    expect(['vector', 'text', 'hybrid']).toContain(metadata._searchType)
    expect(typeof metadata._relevanceScore).toBe('number')
    expect(metadata.source).toBe('chat')
    for (const each of results) {
      expect([...RESERVED_METADATA_KEYS].every((key) => key in metadataOf(each))).toBe(true)
    }
  })

  it('AT-041: the result limit is the query limit, then the search option, then maxSearchResults, and below 1 is a RangeError', async () => {
    const { store: facts, name } = store('limits', {
      store: { writable: true, scope: 'tenant-a', maxSearchResults: 2 },
    })
    for (const fact of ['dark mode one', 'dark mode two', 'dark mode three', 'dark mode four']) await facts.add(fact)

    expect(await answered(facts, { text: QUERY_TEXT, limit: 4 }, 4)).toHaveLength(4)
    expect(await facts.search(QUERY_TEXT)).toHaveLength(2)
    expect(await facts.search(QUERY_TEXT, { maxSearchResults: 3 })).toHaveLength(3)
    expect(await facts.search({ text: QUERY_TEXT, limit: 1 }, { maxSearchResults: 3 })).toHaveLength(1)
    await expect(facts.search(QUERY_TEXT, { maxSearchResults: 0 })).rejects.toBeInstanceOf(RangeError)
    expect(() => sibling(facts, name, { store: { maxSearchResults: 0 } })).toThrow(RangeError)
  })

  it('two clients initializing one fresh collection at once leave one index, and a loser of the creation race succeeds when asked again', async () => {
    const name = fresh('race')
    const clients = [new MongoClient(tierUri('integration')!), new MongoClient(tierUri('integration')!)]
    const stores = clients.map((each) =>
      register({ database: DATABASE, client: each, searchType: 'text', indexReadyTimeout: TIMEOUT_SECONDS }, name)
    )

    try {
      const outcomes = await Promise.allSettled(stores.map((each) => each.initialize()))

      // The server answers the second of two concurrent createSearchIndexes with code 2, "duplicate index names".
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') continue
        expect(outcome.reason).toBeInstanceOf(StorageError)
        expect((outcome.reason as Error).message).toContain(`${DATABASE}.${name}`)
        expect(((outcome.reason as Error).cause as MongoServerError).code).toBe(2)
      }
      expect(outcomes.map((outcome) => outcome.status)).toContain('fulfilled')
      await Promise.all(stores.map((each) => each.initialize()))
      expect(await statuses(name)).toEqual({ text_index: 'READY' })
    } finally {
      await Promise.all(clients.map((each) => each.close()))
    }
  })

  it('AT-045b: a store nobody initialized answers its first search', async () => {
    const { store: facts, name } = store('lazy', { store: { writable: true, scope: 'tenant-a' } })

    await facts.add(CONTENT)
    const results = await answered(facts, QUERY_TEXT)

    expect(contents(results)).toEqual([CONTENT])
    expect(await db.collection(name).listSearchIndexes().toArray()).not.toEqual([])
  })

  it('AT-242: concurrent first searches on a fresh store share one wait and all answer', async () => {
    const { store: facts } = store('shared_wait', { store: { writable: true, scope: 'tenant-a' } })
    await facts.add(CONTENT)

    let results = await Promise.all(Array.from({ length: 5 }, () => facts.search(QUERY_TEXT)))
    const deadline = Date.now() + SEARCHABLE_BUDGET_MS
    while (!results.every((found) => found.length > 0) && Date.now() < deadline) {
      await sleep(500)
      results = await Promise.all(Array.from({ length: 5 }, () => facts.search(QUERY_TEXT)))
    }

    expect(results.map(contents)).toEqual(Array.from({ length: 5 }, () => [CONTENT]))
  })

  it('AT-047a: the text tier never returns the document of another scope', async () => {
    const { store: a, name } = store('scope_text', {
      connection: { searchType: 'text' },
      store: { writable: true, scope: 'tenant-a' },
    })
    const b = sibling(a, name, { store: { writable: true, scope: 'tenant-b' } })

    await a.add('dark mode for tenant a')
    await b.add('dark mode for tenant b')

    for (const [facts, expected] of [
      [a, 'dark mode for tenant a'],
      [b, 'dark mode for tenant b'],
    ] as const) {
      const results = await answered(facts, QUERY_TEXT)
      expect(contents(results)).toEqual([expected])
      expect(metadataOf(results[0]!)._scope).toBe(facts.scope)
    }
  })

  it('AT-047a: the vector tier never returns the document of another scope, even a closer one', async () => {
    const { store: facts, name } = store('scope_vector', {
      connection: { ...MANUAL_VECTOR, searchType: 'vector' },
      store: { scope: 'tenant-a' },
    })
    const collection = db.collection(name)
    await seedVectors(
      collection,
      { scope: 'tenant-a', storeName: 'facts' },
      { 'dark mode for tenant a': [0.9, 0.1, 0, 0] }
    )
    await seedVectors(collection, { scope: 'tenant-b', storeName: 'facts' }, { 'dark mode for tenant b': QUERY_VECTOR })

    const results = await answered(facts, { vector: QUERY_VECTOR, limit: 10 })

    expect(contents(results)).toEqual(['dark mode for tenant a'])
    expect(metadataOf(results[0]!)._searchType).toBe('vector')
  })

  it('AT-048b: an unscoped store reads the sentinel scope and nothing else', async () => {
    const { store: unscoped, name } = store('sentinel', { store: { writable: true } })
    const scoped = sibling(unscoped, name, { store: { writable: true, scope: 'tenant-b' } })

    await unscoped.add('dark mode with no tenant')
    await scoped.add('dark mode for tenant b')

    const results = await answered(unscoped, QUERY_TEXT)
    expect(contents(results)).toEqual(['dark mode with no tenant'])
    expect(metadataOf(results[0]!)._scope).toBe(UNSCOPED)
    expect(contents(await answered(scoped, QUERY_TEXT))).toEqual(['dark mode for tenant b'])
  })

  it('AT-053b, AT-054: the shipped default answers from the text tier where the vector index cannot build', async (context) => {
    const { store: facts, logger } = store('shipped_default', { store: { writable: true, scope: 'tenant-a' } })

    await facts.add(CONTENT)
    const results = await answered(facts, QUERY_TEXT)

    expect(contents(results)).toEqual([CONTENT])
    const tier = metadataOf(results[0]!)._searchType
    if (tier !== 'text') context.skip('this deployment built the AutoEmbeddings vector index, so nothing fell back')
    expect(tier).toBe('text')
    const warnings = logger.lines('warn').join(' ')
    expect(warnings).toContain('tier=vector')
  })

  it('AT-059b: a bound above the lowest score drops exactly that result, and says so at debug', async () => {
    const { store: writer, name } = store('bound_drops', { store: { writable: true, scope: 'tenant-a', minScore: 0 } })
    await writer.add('dark mode dark mode dark mode')
    await writer.add(`dark mode once, then padding ${Array.from({ length: 60 }, (_, n) => `word${n}`).join(' ')}`)
    const unbounded = await answered(writer, QUERY_TEXT, 2)
    expect(unbounded).toHaveLength(2)
    const measured = unbounded
      .map((entry): [number, string] => [metadataOf(entry)._relevanceScore as number, entry.content])
      .sort(([a], [b]) => a - b)
    const [[lowest], [highest, top]] = measured as [[number, string], [number, string]]
    expect(lowest).toBeLessThan(highest)
    const bound = (lowest + highest) / 2
    const logger = new RecordingLogger()
    const bounded = sibling(writer, name, { connection: { logger }, store: { scope: 'tenant-a', minScore: bound } })

    const results = await answered(bounded, QUERY_TEXT)

    expect(contents(results)).toEqual([top])
    const kept = metadataOf(results[0]!)._relevanceScore as number
    expect(kept).toBeGreaterThanOrEqual(bound)
    expect(Math.abs(kept - highest)).toBeLessThan(1e-3)
    const applied = logger.lines('debug').filter((line) => line.includes('event=score_bound_applied'))
    expect(applied.length).toBeGreaterThanOrEqual(1)
    expect(applied.at(-1)).toContain(`minScore ${bound}`)
    expect(applied.at(-1)).toContain('1 of 2')
    expect(applied.at(-1)).toContain(`namespace=${DATABASE}.${name}`)
  })

  it('AT-143: the fused order is reciprocal rank fusion of the two tiers it composed', async (context) => {
    if (!capabilities.rankFusion) context.skip(NO_RANK_FUSION)
    const { store: vector, name } = store('fusion', {
      connection: { ...MANUAL_VECTOR, searchType: 'vector' },
      store: { scope: 'tenant-a' },
    })
    const text = sibling(vector, name, { connection: { searchType: 'text' }, store: { scope: 'tenant-a' } })
    const hybrid = sibling(vector, name, { connection: { searchType: 'hybrid' }, store: { scope: 'tenant-a' } })
    await seedVectors(db.collection(name), { scope: 'tenant-a', storeName: 'facts' }, FUSION_CORPUS)
    await hybrid.initialize()
    const size = Object.keys(FUSION_CORPUS).length

    const byVector = contents(await answered(vector, { vector: QUERY_VECTOR, limit: size }, size))
    const byText = contents(await answered(text, { text: QUERY_TEXT, limit: size }, FUSION_TEXT_MATCHES))
    const fused = await answered(hybrid, { text: QUERY_TEXT, vector: QUERY_VECTOR, limit: size }, size)
    const fusedOrder = contents(fused)

    expect(metadataOf(fused[0]!)._searchType).toBe('hybrid')
    expect(fusedOrder).toEqual(fuse(byVector, byText))
    expect([byVector[0], byText[0]]).not.toContain(fusedOrder[0])
    const score = metadataOf(fused[0]!)._relevanceScore as number
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(2 / (RANK_FUSION_PENALTY + 1))
  })

  it.each(['cosine', 'dotProduct', 'euclidean'] as const)(
    'AT-188: the %s metric scores a similarity the deployment formula predicts, nearest first',
    async (metric) => {
      const { store: facts, name } = store(`metric_${metric}`, {
        connection: { ...MANUAL_VECTOR, similarity: metric, searchType: 'vector' },
        store: { scope: 'tenant-a' },
      })
      await seedVectors(db.collection(name), { scope: 'tenant-a', storeName: 'facts' }, METRIC_CORPUS)
      const size = Object.keys(METRIC_CORPUS).length

      const results = await answered(facts, { vector: METRIC_QUERY, limit: 10 }, size)

      expect(results).toHaveLength(size)
      const scores = results.map((entry) => metadataOf(entry)._relevanceScore as number)
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
      expect(scores.every((score) => score > 0)).toBe(true)
      const nearness = results.map((entry) => similarity(metric, METRIC_CORPUS[entry.content]!))
      expect(nearness).toEqual([...nearness].sort((a, b) => b - a))
      const ranked = Object.keys(METRIC_CORPUS).sort(
        (a, b) => similarity(metric, METRIC_CORPUS[b]!) - similarity(metric, METRIC_CORPUS[a]!)
      )
      expect(results[0]!.content).toBe(ranked[0])
      expect(results.at(-1)!.content).toBe(ranked.at(-1))
      for (const entry of results) {
        const expected = expectedScore(metric, METRIC_CORPUS[entry.content]!)
        expect(Math.abs((metadataOf(entry)._relevanceScore as number) - expected) / expected).toBeLessThan(1e-6)
      }
    }
  )

  it('AT-188: the reported euclidean score is the one the server projected, unscaled', async () => {
    const { store: facts, name } = store('metric_passthrough', {
      connection: { ...MANUAL_VECTOR, similarity: 'euclidean', searchType: 'vector' },
      store: { scope: 'tenant-a' },
    })
    await seedVectors(db.collection(name), { scope: 'tenant-a', storeName: 'facts' }, METRIC_CORPUS)
    const size = Object.keys(METRIC_CORPUS).length

    const reported = Object.fromEntries(
      (await answered(facts, { vector: METRIC_QUERY, limit: 10 }, size)).map((entry) => [
        entry.content,
        metadataOf(entry)._relevanceScore,
      ])
    )
    const projected = Object.fromEntries(
      (
        await db
          .collection(name)
          .aggregate([
            {
              $vectorSearch: {
                index: DEFAULT_VECTOR_INDEX_NAME,
                path: VECTOR_FIELD,
                queryVector: METRIC_QUERY,
                numCandidates: 100,
                limit: size,
              },
            },
            { $set: { projected: { $meta: VECTOR_SCORE_META } } },
            { $project: { [CONTENT_FIELD]: 1, projected: 1, _id: 0 } },
          ])
          .toArray()
      ).map((document) => [String(document[CONTENT_FIELD]), Number(document.projected)])
    )

    expect(Object.keys(projected)).toHaveLength(size)
    expect(reported).toEqual(projected)
  })
})
