import { SpanStatusCode } from '@opentelemetry/api'
import { StorageError } from '@strands-agents/sdk'
import { type Collection, MongoServerError } from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeCollection } from '../__fixtures__/fake-mongo.js'
import { recordSpans, spansNamed } from '../__fixtures__/spans.js'
import type { Capabilities } from '../client.js'
import { memorySearchSpecs } from '../index-specs.js'
import { SearchTiers, type SearchTiersOptions, TIER_RETRY_MAX_SECONDS, TIER_RETRY_SECONDS } from '../search-tiers.js'
import type { VectorMode } from '../types.js'
import { errorOf, rejectionOf } from '../__fixtures__/errors.js'
import { type Level, RecordingLogger } from '../__fixtures__/logger.js'

const exporter = recordSpans()

const NAMESPACE = 'appdb.memory'
const AUTO_EMBED: VectorMode = { autoEmbed: true, model: 'voyage-4-lite' }
const MANUAL: VectorMode = { autoEmbed: false, dimensions: 4, similarity: 'cosine' }
const FUSING: Capabilities = { search: true, rankFusion: true }
const NOT_FUSING: Capabilities = { search: true, rankFusion: false }
const NO_SEARCH: Capabilities = { search: false, noSearchCode: 31082, rankFusion: false }
const QUERY_VECTOR = [1, 0, 0, 0]

const [VECTOR_SPEC, TEXT_SPEC] = memorySearchSpecs({ database: 'appdb' })
const SPECS = { vector_index: VECTOR_SPEC, text_index: TEXT_SPEC }

interface Setup {
  tiers: SearchTiers
  fake: FakeCollection
  collection: Collection
  logger: RecordingLogger
}

function setup(options: Partial<SearchTiersOptions> = {}): Setup {
  const fake = new FakeCollection('appdb', 'memory')
  const logger = new RecordingLogger()
  const tiers = new SearchTiers({
    namespace: NAMESPACE,
    searchType: 'auto',
    mode: AUTO_EMBED,
    specs: { vector: VECTOR_SPEC, text: TEXT_SPEC },
    create: true,
    timeout: 300,
    bound: undefined,
    logger,
    ...options,
  })
  return { tiers, fake, collection: fake as unknown as Collection, logger }
}

// Puts search indexes in place as the server would report them, so `ensure` reads them rather than creating them.
function reporting(fake: FakeCollection, status: 'PENDING' | 'FAILED', ...names: Array<keyof typeof SPECS>): void {
  for (const name of names) fake.addSearchIndex(SPECS[name].toDescription(), status)
}

function created(fake: FakeCollection): string[] {
  return fake.createdSearchIndexes.map((index) => String(index.name))
}

// The `(level, event, tier)` of every skipped-tier line, in order.
function skipped(logger: RecordingLogger): Array<[Level, string, string]> {
  return logger.records.flatMap(([level, line]): Array<[Level, string, string]> => {
    const event = /event=(tier_building|tier_unavailable)/.exec(line)
    return event ? [[level, event[1]!, /tier=(\w+)/.exec(line)?.[1] ?? '']] : []
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SearchTiers', () => {
  it('pins the retry constants', () => {
    expect(TIER_RETRY_SECONDS).toBe(60)
    expect(TIER_RETRY_MAX_SECONDS).toBe(3600)
  })

  describe('AT-078: which tiers prepare brings up', () => {
    it('creates both indexes vector first under auto and prefers the vector tier', async () => {
      const { tiers, fake, collection } = setup()

      await tiers.prepare(collection, NOT_FUSING)

      expect(created(fake)).toEqual(['vector_index', 'text_index'])
      expect(tiers.prepared).toEqual(['vector', 'text'])
      expect(tiers.retryDue).toBe(false)
    })

    it.each(['vector', 'text'] as const)('creates only its own index for the named type %s', async (searchType) => {
      const { tiers, fake, collection } = setup({ searchType })

      await tiers.prepare(collection, FUSING)

      expect(created(fake)).toEqual([`${searchType}_index`])
      expect(tiers.prepared).toEqual([searchType])
    })

    it('creates nothing when create is false, and reports the missing index', async () => {
      const { tiers, fake, collection } = setup({ searchType: 'text', create: false })

      const error = await rejectionOf(tiers.prepare(collection, FUSING))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('text_index')
      expect(created(fake)).toEqual([])
    })

    it("fails a named type whose own tier failed, saying what refused and not naming 'auto'", async () => {
      const { tiers, fake, collection } = setup({ searchType: 'vector' })
      reporting(fake, 'FAILED', 'vector_index')

      const error = await rejectionOf(tiers.prepare(collection, NOT_FUSING))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain("'vector_index'")
      expect(error.message).toContain('FAILED')
      expect(error.message).not.toContain("'auto'")
      expect(tiers.prepared).toEqual([])
    })

    it('warns per tier then throws when auto has every tier refused, chaining the last reason', async () => {
      const { tiers, fake, collection, logger } = setup()
      reporting(fake, 'FAILED', 'vector_index', 'text_index')

      const error = await rejectionOf(tiers.prepare(collection, NOT_FUSING))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain("'auto'")
      expect(error.message).toContain(NAMESPACE)
      expect(error.cause).toBeInstanceOf(StorageError)
      expect((error.cause as Error).message).toContain("'text_index'")
      expect(skipped(logger)).toEqual([
        ['warn', 'tier_unavailable', 'vector'],
        ['warn', 'tier_unavailable', 'text'],
      ])
    })

    it('AT-166: carries the reason the tier was refused on the skipped-tier line', async () => {
      const { tiers, fake, collection, logger } = setup()
      reporting(fake, 'FAILED', 'vector_index', 'text_index')

      await rejectionOf(tiers.prepare(collection, NOT_FUSING))

      const [line] = logger.lines('warn')
      expect(line).toContain(`the vector search tier is not available on ${NAMESPACE}`)
      expect(line).toContain("the vectorSearch index 'vector_index'")
      expect(line).toContain('FAILED')
      expect(line).toMatch(/\| event=tier_unavailable, namespace=appdb\.memory, tier=vector$/)
    })

    it('warns that answers became lexical when auto lands on text', async () => {
      const { tiers, fake, collection, logger } = setup()
      reporting(fake, 'FAILED', 'vector_index')

      await tiers.prepare(collection, NOT_FUSING)

      expect(tiers.prepared).toEqual(['text'])
      const below = logger.lines('warn').filter((line) => line.includes('event=below_vector'))
      expect(below).toHaveLength(1)
      expect(below[0]).toContain(`the vector tier is not available on ${NAMESPACE}`)
      expect(below[0]).toMatch(/\| event=below_vector, namespace=appdb\.memory, tier=text$/)
    })

    it('warns below vector once, not once per retry', async () => {
      vi.useFakeTimers()
      const { tiers, fake, collection, logger } = setup()
      reporting(fake, 'FAILED', 'vector_index')
      await tiers.prepare(collection, NOT_FUSING)

      vi.advanceTimersByTime(TIER_RETRY_SECONDS * 1000)
      expect(tiers.retryDue).toBe(true)
      await tiers.retry(collection)

      expect(logger.lines('warn').filter((line) => line.includes('event=below_vector'))).toHaveLength(1)
    })

    it('reads nothing and schedules no retry where the deployment has no search', async () => {
      vi.useFakeTimers()
      const { tiers, fake, collection } = setup()

      await tiers.prepare(collection, NO_SEARCH)
      vi.advanceTimersByTime(TIER_RETRY_MAX_SECONDS * 1000)

      expect(tiers.prepared).toEqual([])
      expect(tiers.retryDue).toBe(false)
      expect(fake.searchIndexReads).toBe(0)
    })
  })

  describe('AT-242: auto does not wait for a build', () => {
    it('prepares no tier while every tier is still building, logging each at info after one status read', async () => {
      const { tiers, fake, collection, logger } = setup({ timeout: 7 })
      reporting(fake, 'PENDING', 'vector_index', 'text_index')

      await tiers.prepare(collection, NOT_FUSING)

      expect(tiers.prepared).toEqual([])
      expect(fake.searchIndexReads).toBe(4)
      expect(skipped(logger)).toEqual([
        ['info', 'tier_building', 'vector'],
        ['info', 'tier_building', 'text'],
      ])
      expect(logger.lines('info').at(-1)).toMatch(/\| event=tier_building, namespace=appdb\.memory, tier=text$/)
      expect(logger.lines('warn')).toEqual([])
    })

    it('waits the timeout for a named tier', async () => {
      vi.useFakeTimers()
      const { tiers, fake, collection } = setup({ searchType: 'text', timeout: 1 })
      reporting(fake, 'PENDING', 'text_index')

      const settled = rejectionOf(tiers.prepare(collection, NOT_FUSING))
      await vi.advanceTimersByTimeAsync(1500)

      expect((await settled).message).toContain('waited 1s')
    })

    it('schedules a retry that is not due until the delay has passed', async () => {
      vi.useFakeTimers()
      const { tiers, fake, collection } = setup()
      reporting(fake, 'PENDING', 'vector_index', 'text_index')
      await tiers.prepare(collection, NOT_FUSING)

      vi.advanceTimersByTime(TIER_RETRY_SECONDS * 1000 - 1)
      expect(tiers.retryDue).toBe(false)
      vi.advanceTimersByTime(1)
      expect(tiers.retryDue).toBe(true)
    })

    it('picks up the finished build on a retry and clears the schedule', async () => {
      vi.useFakeTimers()
      const { tiers, fake, collection } = setup()
      reporting(fake, 'PENDING', 'vector_index', 'text_index')
      await tiers.prepare(collection, NOT_FUSING)

      fake.setSearchIndexStatus('vector_index', 'READY')
      fake.setSearchIndexStatus('text_index', 'READY')
      vi.advanceTimersByTime(TIER_RETRY_SECONDS * 1000)
      await tiers.retry(collection)

      expect(tiers.prepared).toEqual(['vector', 'text'])
      vi.advanceTimersByTime(TIER_RETRY_MAX_SECONDS * 1000)
      expect(tiers.retryDue).toBe(false)
    })

    it('offers hybrid once a retry finds both tiers on a deployment with the stage', async () => {
      const { tiers, fake, collection, logger } = setup()
      reporting(fake, 'PENDING', 'vector_index')
      await tiers.prepare(collection, FUSING)
      expect(tiers.prepared).toEqual(['text'])
      expect(skipped(logger)).toEqual([['info', 'tier_building', 'vector']])

      fake.setSearchIndexStatus('vector_index', 'READY')
      await tiers.retry(collection)

      expect(tiers.prepared).toEqual(['hybrid', 'vector', 'text'])
      expect(tiers.retryDue).toBe(false)
    })

    it('doubles the delay after a retry that still finds the tier missing, up to the ceiling', async () => {
      vi.useFakeTimers()
      const { tiers, fake, collection } = setup()
      reporting(fake, 'PENDING', 'vector_index')
      await tiers.prepare(collection, NOT_FUSING)
      vi.advanceTimersByTime(TIER_RETRY_SECONDS * 1000)

      for (const delay of [120, 240, 480, 960, 1920, 3600, 3600]) {
        await tiers.retry(collection)
        vi.advanceTimersByTime(delay * 1000 - 1)
        expect(tiers.retryDue).toBe(false)
        vi.advanceTimersByTime(1)
        expect(tiers.retryDue).toBe(true)
      }
      expect(tiers.prepared).toEqual(['text'])
    })

    it('keeps the tiers it has and doubles the delay when a retry fails outright', async () => {
      vi.useFakeTimers()
      const { tiers, fake, collection, logger } = setup()
      reporting(fake, 'PENDING', 'vector_index')
      await tiers.prepare(collection, NOT_FUSING)

      const outage = new MongoServerError({ message: 'mongot unreachable', code: 125 })
      fake.failListSearchIndexes(outage, outage)
      await tiers.retry(collection)

      expect(tiers.prepared).toEqual(['text'])
      expect(logger.lines('warn').filter((line) => line.includes('mongot unreachable'))).toHaveLength(2)
      vi.advanceTimersByTime(2 * TIER_RETRY_SECONDS * 1000 - 1)
      expect(tiers.retryDue).toBe(false)
      vi.advanceTimersByTime(1)
      expect(tiers.retryDue).toBe(true)
    })

    it('still warns a refused tier while a building one stays at info', async () => {
      const { tiers, fake, collection, logger } = setup()
      reporting(fake, 'FAILED', 'vector_index')
      reporting(fake, 'PENDING', 'text_index')

      await tiers.prepare(collection, NOT_FUSING)

      expect(tiers.prepared).toEqual([])
      expect(skipped(logger)).toEqual([
        ['warn', 'tier_unavailable', 'vector'],
        ['info', 'tier_building', 'text'],
      ])
    })
  })

  describe('AT-242: the first wait for a tier', () => {
    it('waits for the build beside a refusal and resolves to the tier that came up', async () => {
      const { tiers, fake, collection } = setup()
      reporting(fake, 'FAILED', 'vector_index')
      reporting(fake, 'PENDING', 'text_index')
      await tiers.prepare(collection, NOT_FUSING)

      fake.setSearchIndexStatus('text_index', 'READY')
      await tiers.waitForFirst(collection)

      expect(tiers.prepared).toEqual(['text'])
    })

    it('does not hold a ready tier behind one still building, and stops waiting on the loser', async () => {
      vi.useFakeTimers()
      const { tiers, fake, collection, logger } = setup({ timeout: 60 })
      reporting(fake, 'PENDING', 'vector_index', 'text_index')
      await tiers.prepare(collection, NOT_FUSING)
      logger.records.length = 0

      fake.setSearchIndexStatus('text_index', 'READY')
      await tiers.waitForFirst(collection)
      const reads = fake.searchIndexReads
      await vi.advanceTimersByTimeAsync(10_000)

      expect(tiers.prepared).toEqual(['text'])
      expect(skipped(logger)).toEqual([['info', 'tier_building', 'vector']])
      expect(fake.searchIndexReads).toBe(reads)
      const outcomes = spansNamed(exporter, 'strands_mongodb.indexes.wait').map(
        (span) => span.attributes['strands_mongodb.indexes.outcome']
      )
      // Two timed-out reads from prepare, the retry's one, and the loser's abandoned wait; text was READY on its cold read.
      expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1)
      expect(outcomes).toHaveLength(4)
    })

    it("ends the loser's ensure span abandoned rather than in error once the first tier is ready", async () => {
      vi.useFakeTimers()
      const { tiers, fake, collection } = setup({ timeout: 60 })
      reporting(fake, 'PENDING', 'vector_index', 'text_index')
      await tiers.prepare(collection, NOT_FUSING)
      exporter.reset()

      fake.setSearchIndexStatus('text_index', 'READY')
      await tiers.waitForFirst(collection)

      const abandoned = spansNamed(exporter, 'strands_mongodb.indexes.ensure').filter(
        (span) => span.attributes['strands_mongodb.indexes.outcome'] === 'abandoned'
      )
      expect(abandoned).toHaveLength(1)
      expect(abandoned[0]?.status.code).toBe(SpanStatusCode.UNSET)
      expect(abandoned[0]?.attributes).not.toHaveProperty('error.type')
    })

    it('warns each tier when the wait runs out, and does not wait a second time', async () => {
      vi.useFakeTimers()
      const { tiers, fake, collection, logger } = setup({ timeout: 1 })
      reporting(fake, 'PENDING', 'vector_index', 'text_index')
      await tiers.prepare(collection, NOT_FUSING)
      logger.records.length = 0

      const wait = tiers.waitForFirst(collection)
      await vi.advanceTimersByTimeAsync(1500)
      await wait
      const reads = fake.searchIndexReads
      await tiers.waitForFirst(collection)

      expect(tiers.prepared).toEqual([])
      expect(skipped(logger)).toEqual([
        ['warn', 'tier_unavailable', 'vector'],
        ['warn', 'tier_unavailable', 'text'],
      ])
      expect(fake.searchIndexReads).toBe(reads)
    })

    it('shares one wait between callers that arrive during it', async () => {
      const { tiers, fake, collection } = setup()
      reporting(fake, 'PENDING', 'vector_index', 'text_index')
      await tiers.prepare(collection, NOT_FUSING)
      fake.setSearchIndexStatus('vector_index', 'READY')
      fake.setSearchIndexStatus('text_index', 'READY')
      const reads = fake.searchIndexReads

      await Promise.all([tiers.waitForFirst(collection), tiers.waitForFirst(collection)])

      // Two reads for the wait and two for the retry that follows it; a second wait would double this.
      expect(fake.searchIndexReads - reads).toBe(4)
    })

    it('passes a failure to every caller of the wait, and the next call waits again', async () => {
      const { tiers, fake, collection, logger } = setup()
      reporting(fake, 'PENDING', 'vector_index', 'text_index')
      await tiers.prepare(collection, NOT_FUSING)
      const failure = new Error('programming error')
      const { info } = logger
      logger.info = () => {
        throw failure
      }

      const [first, second] = await Promise.all([
        rejectionOf(tiers.waitForFirst(collection)),
        rejectionOf(tiers.waitForFirst(collection)),
      ])
      logger.info = info
      fake.setSearchIndexStatus('text_index', 'READY')
      await tiers.waitForFirst(collection)

      expect(first).toBe(failure)
      expect(second).toBe(failure)
      expect(tiers.prepared).toEqual(['text'])
    })

    it.each([
      ['a tier is already prepared', NOT_FUSING],
      ['the deployment has no search', NO_SEARCH],
    ])('does not wait when %s', async (_, capabilities) => {
      const { tiers, fake, collection } = setup()
      await tiers.prepare(collection, capabilities)
      const reads = fake.searchIndexReads

      await tiers.waitForFirst(collection)

      expect(fake.searchIndexReads).toBe(reads)
    })
  })

  describe('AT-146, AT-147: the hybrid tier is a statement about two others', () => {
    it('prefers fusion under auto where the deployment and both tiers allow it', async () => {
      const { tiers, fake, collection } = setup()

      await tiers.prepare(collection, FUSING)

      expect(created(fake)).toEqual(['vector_index', 'text_index'])
      expect(tiers.prepared).toEqual(['hybrid', 'vector', 'text'])
    })

    it('creates both indexes for an explicit hybrid type and keeps only that tier', async () => {
      const { tiers, fake, collection } = setup({ searchType: 'hybrid' })

      await tiers.prepare(collection, FUSING)

      expect(created(fake)).toEqual(['vector_index', 'text_index'])
      expect(tiers.prepared).toEqual(['hybrid'])
    })

    it('fails an explicit hybrid type with one tier refused', async () => {
      const { tiers, fake, collection } = setup({ searchType: 'hybrid' })
      reporting(fake, 'FAILED', 'vector_index')

      const error = await rejectionOf(tiers.prepare(collection, FUSING))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain("'vector_index'")
    })

    it('fails an explicit hybrid type on a deployment without the stage', async () => {
      const { tiers, collection } = setup({ searchType: 'hybrid' })

      const error = await rejectionOf(tiers.prepare(collection, NOT_FUSING))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain("'searchType' is 'hybrid'")
      expect(error.message).toContain(NAMESPACE)
      expect(error.message).toContain('$rankFusion')
    })

    it('skips fusion under auto where only one tier came up, without mentioning a bound', async () => {
      const { tiers, fake, collection, logger } = setup({ bound: { name: 'minScore', value: 0.7 } })
      reporting(fake, 'FAILED', 'text_index')

      await tiers.prepare(collection, FUSING)

      expect(tiers.prepared).toEqual(['vector'])
      expect(logger.lines('warn').some((line) => line.includes('event=bound_declined_fusion'))).toBe(false)
    })
  })

  describe('AT-148, AT-149: a score bound keeps auto off the hybrid tier', () => {
    it.each([
      ['minScore', 0.7],
      ['maxScore', 0.2],
    ] as const)('resolves to vector and says why when %s is set', async (name, value) => {
      const { tiers, collection, logger } = setup({ bound: { name, value } })

      await tiers.prepare(collection, FUSING)

      expect(tiers.prepared).toEqual(['vector', 'text'])
      const [line] = logger.lines('warn')
      expect(line).toContain(NAMESPACE)
      expect(line).toContain(`'${name}' is set to ${value}`)
      expect(line).toContain("'searchType' to 'hybrid'")
      expect(line).toMatch(/\| event=bound_declined_fusion, namespace=appdb\.memory, tier=hybrid$/)
    })

    it('leaves the bound to the fused scale for an explicit hybrid type, without a warning', async () => {
      const { tiers, collection, logger } = setup({ searchType: 'hybrid', bound: { name: 'minScore', value: 0.01 } })

      await tiers.prepare(collection, FUSING)

      expect(tiers.prepared).toEqual(['hybrid'])
      expect(logger.lines('warn')).toEqual([])
    })

    it('logs nothing about the bound where the deployment could not run hybrid anyway', async () => {
      const { tiers, collection, logger } = setup({ bound: { name: 'minScore', value: 0.7 } })

      await tiers.prepare(collection, NOT_FUSING)

      expect(tiers.prepared).toEqual(['vector', 'text'])
      expect(logger.lines('warn')).toEqual([])
    })
  })

  describe('AT-078, AT-147: pick answers with the first prepared tier the query fits', () => {
    it('falls past hybrid to the tier a one-key query fits on the manual path', async () => {
      const { tiers, collection } = setup({ mode: MANUAL })
      await tiers.prepare(collection, FUSING)

      expect(tiers.pick('dark mode', undefined)).toEqual({ tier: 'text', text: 'dark mode' })
      expect(tiers.pick(undefined, QUERY_VECTOR)).toEqual({ tier: 'vector', text: undefined, vector: QUERY_VECTOR })
      expect(tiers.pick('dark mode', QUERY_VECTOR)).toEqual({ tier: 'hybrid', text: 'dark mode', vector: QUERY_VECTOR })
    })

    it('answers a text query from hybrid, then vector, on the AutoEmbeddings path', async () => {
      const fusing = setup()
      await fusing.tiers.prepare(fusing.collection, FUSING)
      const single = setup()
      await single.tiers.prepare(single.collection, NOT_FUSING)

      expect(fusing.tiers.pick('dark mode', undefined).tier).toBe('hybrid')
      expect(single.tiers.pick('dark mode', undefined)).toEqual({
        tier: 'vector',
        text: 'dark mode',
        vector: undefined,
      })
    })

    it('names the build, not a missing search process, when search exists and no tier is ready', async () => {
      const { tiers, fake, collection } = setup()
      reporting(fake, 'PENDING', 'vector_index', 'text_index')
      await tiers.prepare(collection, NOT_FUSING)

      const error = errorOf(() => tiers.pick('dark mode', undefined))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain("'auto'")
      expect(error.message).toContain(NAMESPACE)
      expect(error.message).not.toContain('Atlas Search')
    })

    it('AT-053c: names the code the probe reported where the deployment cannot search', async () => {
      const { tiers, collection } = setup()
      await tiers.prepare(collection, NO_SEARCH)

      const error = errorOf(() => tiers.pick('dark mode', undefined))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain(NAMESPACE)
      expect(error.message).toContain('Atlas Search')
      expect(error.message).toContain('server error code 31082')
    })

    it('says there is no probe result before prepare has run', () => {
      const error = errorOf(() => setup().tiers.pick('dark mode', undefined))

      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain('no probe result')
    })

    it('names the key to add when a manual-vector tier gets only text', async () => {
      const { tiers, collection } = setup({ mode: MANUAL, searchType: 'vector' })
      await tiers.prepare(collection, FUSING)

      const error = errorOf(() => tiers.pick('dark mode', undefined))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain(NAMESPACE)
      expect(error.message).toContain("'vector'")
      expect(error.message).toContain("'embeddingDimensions'")
    })

    it('names the text key when a text tier gets only a vector', async () => {
      const { tiers, collection } = setup({ searchType: 'text' })
      await tiers.prepare(collection, FUSING)

      const error = errorOf(() => tiers.pick(undefined, QUERY_VECTOR))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("'text'")
      expect(error.message).toContain('AutoEmbeddings')
    })

    it('AT-157: throws rather than answering from one key when both are set and nothing fuses them', async () => {
      const { tiers, collection } = setup({ mode: MANUAL })
      await tiers.prepare(collection, NOT_FUSING)

      const error = errorOf(() => tiers.pick('dark mode', QUERY_VECTOR))

      expect(error).toBeInstanceOf(TypeError)
      expect(error.message).toContain("both 'text' and 'vector'")
      expect(error.message).toContain('vector, text')
    })
  })
})
