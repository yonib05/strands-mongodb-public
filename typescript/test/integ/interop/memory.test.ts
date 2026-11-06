import { randomUUID } from 'node:crypto'
import type { MemoryEntry } from '@strands-agents/sdk'
import { type Db, MongoClient } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { close } from '../../../src/client.js'
import { MongoDBMemoryStore } from '../../../src/memory-store.js'
import type { MongoDBConfig } from '../../../src/types.js'
import { TIER_VARIABLES, tierUri } from '../../env.js'
import { describeTier } from '../../tiers.js'
import { interopUnmet, runPython } from './python-bridge.js'

const DATABASE = 'strands_mongodb_interop'
const TIMEOUT_SECONDS = 180
const SEARCHABLE_BUDGET_MS = TIMEOUT_SECONDS * 1000

const WINDOW = 'The guest prefers a window table'
const SHELLFISH = 'Allergic to shellfish'

interface PythonEntry {
  content: string
  metadata: Record<string, unknown>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// `READY` means the index exists, not that every document has reached it.
async function answered(store: MongoDBMemoryStore, query: string): Promise<MemoryEntry[]> {
  const deadline = Date.now() + SEARCHABLE_BUDGET_MS
  for (;;) {
    const results = await store.search(query)
    if (results.length > 0 || Date.now() >= deadline) return results
    await sleep(500)
  }
}

describeTier(
  'interop',
  'memory store across languages',
  () => {
    const collection = `memory_${randomUUID().slice(0, 8)}`
    const configs: MongoDBConfig[] = []
    let client: MongoClient
    let db: Db

    // The `--name`, `--scope` and `--search-type` every Python half is given, matching `store()` below.
    const placement = {
      uri: tierUri('integration')!,
      database: DATABASE,
      collection,
      name: 'facts',
      scope: 'tenant-a',
      'search-type': 'text',
    }

    function store(scope: string): MongoDBMemoryStore {
      const config: MongoDBConfig = {
        database: DATABASE,
        connectionString: tierUri('integration')!,
        searchType: 'text',
        indexReadyTimeout: TIMEOUT_SECONDS,
      }
      configs.push(config)
      return new MongoDBMemoryStore({ name: 'facts', scope, writable: true, collection, config })
    }

    const hashOf = async (scope: string, content: string) =>
      (await db.collection(collection).findOne({ scope, store_name: 'facts', content }))?.content_hash as unknown

    beforeAll(() => {
      client = new MongoClient(tierUri('integration')!)
      db = client.db(DATABASE)
    })

    afterAll(async () => {
      await Promise.all(configs.map((config) => close(config)))
      await db
        .collection(collection)
        .drop()
        .catch(() => false)
      await client.close()
    })

    describe('a memory Python added', () => {
      let added: { ids: string[]; inserted: number; duplicates: number }

      beforeAll(async () => {
        added = await runPython('memory_add.py', placement, {
          content: WINDOW,
          metadata: { seen: { $date: '2026-01-02T03:04:05Z' }, ref: { $oid: '65f1a2b3c4d5e6f7a8b9c0d1' } },
        })
      })

      it('is found by a TypeScript text search, its metadata as relaxed EJSON', async () => {
        const results = await answered(store('tenant-a'), 'window table')

        expect(results.map((entry) => entry.content)).toEqual([WINDOW])
        expect(results[0]!.metadata).toMatchObject({
          _id: added.ids[0],
          _scope: 'tenant-a',
          _searchType: 'text',
          seen: { $date: '2026-01-02T03:04:05Z' },
          ref: { $oid: '65f1a2b3c4d5e6f7a8b9c0d1' },
        })
      })

      it('is the duplicate a TypeScript add of the same content reports', async () => {
        expect(added).toMatchObject({ inserted: 1, duplicates: 0 })

        expect(await store('tenant-a').add(WINDOW)).toEqual({ ids: added.ids, inserted: 0, duplicates: 1 })
      })

      it('carries the content_hash TypeScript computes for the same content', async () => {
        await store('tenant-b').add(WINDOW)

        const python = await hashOf('tenant-a', WINDOW)
        expect(python).toMatch(/^[0-9a-f]{64}$/)
        expect(await hashOf('tenant-b', WINDOW)).toBe(python)
      })
    })

    describe('a memory TypeScript added', () => {
      let id: string

      beforeAll(async () => {
        ;[id] = (await store('tenant-a').add(SHELLFISH, { source: 'typescript', tags: ['food'] })).ids as [string]
      })

      it('is found by a Python text search, with the reserved keys Python names', async () => {
        const { results } = await runPython<{ results: PythonEntry[] }>('memory_search.py', placement, {
          query: 'shellfish',
          budget: TIMEOUT_SECONDS,
        })

        expect(results).toEqual([
          {
            content: SHELLFISH,
            metadata: {
              source: 'typescript',
              tags: ['food'],
              _id: id,
              _relevance_score: expect.any(Number),
              _search_type: 'text',
              _scope: 'tenant-a',
            },
          },
        ])
      })
    })
  },
  interopUnmet(TIER_VARIABLES.integration)
)
