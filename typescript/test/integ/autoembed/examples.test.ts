import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { MongoClient } from 'mongodb'
import { afterAll, expect, it } from 'vitest'
import { tierUri } from '../../env.js'
import { type ExampleRun, expectNoCredentials, runExample, streams, summaryOf, words } from '../../examples.js'
import { unconfigured } from '../../readme.js'
import { describeTier } from '../../tiers.js'

// Atlas embeds a document after the write acknowledges, about 15 s on a quiet cluster; the ceiling is Python's.
const EMBEDDING_BUDGET_MS = 90_000
const EMBEDDING_POLL_MS = 5_000

interface Hit {
  content: string
  score: number
  storeName: string
  scope: string
}

// Needs MONGODB_AUTOEMBED_URI: a cluster with an embedding model registered, so `$vectorSearch` embeds server-side.
describeTier('autoembed', 'AT-086: examples/memory-recall.ts across two processes', () => {
  const uri = tierUri('autoembed')!
  const run = randomUUID().slice(0, 8)
  const database = `strands_examples_autoembed_${run}`
  const env = { ...unconfigured(), MONGODB_URI: uri, MONGODB_DATABASE: database }
  const scope = `at086-${run}`
  const args = ['--scope', scope, '--summary-json']

  afterAll(async () => {
    const client = new MongoClient(uri)
    try {
      await client.db(database).dropDatabase()
    } finally {
      await client.close()
    }
  })

  // Polls on a hit matching what was stored: the curated entry is written first and can answer first.
  async function recallUntilEmbedded(stored: string[]): Promise<[ExampleRun, Record<string, unknown>, Hit[]]> {
    const deadline = Date.now() + EMBEDDING_BUDGET_MS
    for (let attempt = 1; ; attempt++) {
      const recall = runExample('memory-recall.ts', ['recall', ...args], env)
      expect(recall.status, streams(recall)).toBe(0)
      expectNoCredentials(recall, uri)
      const found = summaryOf(recall)
      const recalled = (found['hits'] as Hit[]).filter((hit) => stored.includes(hit.content))
      if (recalled.length > 0) return [recall, found, recalled]
      if (Date.now() >= deadline) {
        throw new Error(`no stored fact recalled after ${attempt} attempt(s): ${stored.join(', ')}\n${streams(recall)}`)
      }
      await sleep(EMBEDDING_POLL_MS)
    }
  }

  it('recalls in a second process what the first stored, from a query sharing no word with it', async () => {
    const write = runExample('memory-recall.ts', ['write', ...args], env)
    expect(write.status, streams(write)).toBe(0)
    expectNoCredentials(write, uri)
    expect(write.stdout).toContain(`npx tsx examples/memory-recall.ts recall --scope ${scope}`)
    const stored = (summaryOf(write)['stored'] as Array<{ content: string }>).map((entry) => entry.content)
    expect(stored).not.toEqual([])

    const [recall, found, recalled] = await recallUntilEmbedded(stored)

    expect(recall.stdout).toContain(recalled[0]!.content)
    expect(typeof recalled[0]!.score).toBe('number')
    expect(recalled.some((hit) => hit.storeName === found['writableStore'])).toBe(true)
    const query = words(found['query'] as string)
    expect([...words(recalled[0]!.content)].filter((word) => query.has(word))).toEqual([])
  })
})
