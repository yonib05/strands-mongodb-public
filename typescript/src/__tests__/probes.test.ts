import { type Logger, StorageError } from '@strands-agents/sdk'
import type { Collection } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { FakeCollection } from '../__fixtures__/fake-mongo.js'
import { recordSpans, spansNamed } from '../__fixtures__/spans.js'
import { rankFusionSupport, requireBinaryComparison, searchSupport } from '../probes.js'
import { rejectionOf, serverError } from '../__fixtures__/errors.js'

const FOLDING = { locale: 'en', strength: 2 }
const exporter = recordSpans()

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** A server error carrying a code, as the driver raises one. */

function fakeCollection(name = 'memory'): FakeCollection {
  return new FakeCollection('testdb', name)
}

function driver(fake: FakeCollection): Collection {
  return fake as unknown as Collection
}

describe('AT-053d: searchSupport', () => {
  it('reports a deployment that lists its search indexes as available, with no code', async () => {
    await expect(searchSupport(driver(fakeCollection()))).resolves.toEqual({ available: true })
  })

  it.each([31082, 115, 6047401])('degrades on code %i and reports it', async (code) => {
    const collection = fakeCollection()
    collection.failListSearchIndexes(serverError(code, 'no search here'))

    await expect(searchSupport(driver(collection))).resolves.toEqual({ available: false, code })
  })

  it.each([13, 59])('raises on code %i rather than reading it as no search', async (code) => {
    const collection = fakeCollection()
    collection.failListSearchIndexes(serverError(code, 'refused'))

    const error = await rejectionOf(searchSupport(driver(collection)))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('probing Atlas Search support on testdb.memory failed')
  })

  it('still answers for a collection that does not exist (code 26)', async () => {
    const collection = fakeCollection()
    collection.failListSearchIndexes(serverError(26, 'ns does not exist'))

    await expect(searchSupport(driver(collection))).resolves.toEqual({ available: true })
  })

  it('raises on a probe that never reached the server, with the cause chained', async () => {
    const collection = fakeCollection()
    const thrown = new Error('socket timed out')
    collection.failListSearchIndexes(thrown)

    const error = await rejectionOf(searchSupport(driver(collection)))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.cause).toBe(thrown)
  })
})

describe('AT-145: rankFusionSupport', () => {
  it.each([
    [[6, 0, 28, 0], false],
    [[7, 0, 12, 0], false],
    [[8, 0, 0, 0], true],
    [[8, 0, 23, 0], true],
    [[8, 2, 1, 0], true],
    [[9, 0, 0, 0], true],
  ])('decides on the major version of %j', async (versionArray, expected) => {
    const collection = fakeCollection()
    collection.db.buildInfo = { version: versionArray.slice(0, 3).join('.'), versionArray }

    await expect(rankFusionSupport(driver(collection), silentLogger())).resolves.toBe(expected)
  })

  it('reads buildInfo once per call', async () => {
    const collection = fakeCollection()

    await rankFusionSupport(driver(collection), silentLogger())

    expect(collection.db.commandCalls).toEqual([{ buildInfo: 1 }])
  })

  it.each([
    {},
    { versionArray: [] },
    { versionArray: ['8', 0, 0, 0] },
    { versionArray: null },
    { versionArray: [true] },
  ])('reads %j as unsupported', async (buildInfo) => {
    const collection = fakeCollection()
    collection.db.buildInfo = buildInfo

    await expect(rankFusionSupport(driver(collection), silentLogger())).resolves.toBe(false)
  })

  it('degrades rather than raising when buildInfo fails, and says why at debug', async () => {
    const collection = fakeCollection()
    const logger = silentLogger()
    collection.db.commandError = serverError(13, 'not authorized')

    await expect(rankFusionSupport(driver(collection), logger)).resolves.toBe(false)

    expect(logger.debug).toHaveBeenCalledOnce()
    const line = String(vi.mocked(logger.debug).mock.calls[0]?.[0])
    expect(line).toContain('not authorized')
    expect(line).toMatch(/\| event=rank_fusion_probe_failed, namespace=testdb\.memory$/)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logs nothing when buildInfo answers', async () => {
    const logger = silentLogger()

    await rankFusionSupport(driver(fakeCollection()), logger)

    expect(logger.debug).not.toHaveBeenCalled()
  })
})

describe('AT-176, AT-192: requireBinaryComparison', () => {
  it('wraps a failed listCollections in a StorageError', async () => {
    const collection = fakeCollection()
    const thrown = serverError(13, 'not authorized')
    vi.spyOn(collection.db, 'listCollections').mockReturnValue({ toArray: () => Promise.reject(thrown) })

    const error = await rejectionOf(requireBinaryComparison(driver(collection)))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('reading the collation of testdb.memory failed')
    expect(error.cause).toBe(thrown)
  })

  it('declines to verify an absent collection and verifies a present one', async () => {
    const absent = fakeCollection()
    const present = fakeCollection()
    present.setCollation(undefined)
    const simple = fakeCollection()
    simple.setCollation({ locale: 'simple' })

    await expect(requireBinaryComparison(driver(absent))).resolves.toBe(false)
    await expect(requireBinaryComparison(driver(present))).resolves.toBe(true)
    await expect(requireBinaryComparison(driver(simple))).resolves.toBe(true)
  })

  it('refuses a folding collation, naming the locale, the namespace and the remedy', async () => {
    const collection = fakeCollection()
    collection.setCollation(FOLDING)

    const error = await rejectionOf(requireBinaryComparison(driver(collection)))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toMatch(/^strands_mongodb: /)
    expect(error.message).toContain('testdb.memory')
    expect(error.message).toContain("'en'")
    expect(error.message).toContain("{collation: {locale: 'simple'}}")
  })
})

describe('AT-204: each probe is a span naming what it probed', () => {
  it('records search, rank_fusion and collation probes under the namespace', async () => {
    const collection = fakeCollection()

    await searchSupport(driver(collection))
    await rankFusionSupport(driver(collection), silentLogger())
    await requireBinaryComparison(driver(collection))

    const probes = spansNamed(exporter, 'strands_mongodb.indexes.probe')
    expect(probes.map((probe) => probe.attributes['strands_mongodb.indexes.probe'])).toEqual([
      'search',
      'rank_fusion',
      'collation',
    ])
    for (const probe of probes) {
      expect(probe.attributes['strands_mongodb.database']).toBe('testdb')
      expect(probe.attributes['strands_mongodb.collection']).toBe('memory')
    }
  })
})
