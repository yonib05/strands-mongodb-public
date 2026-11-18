import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { MongoClient } from 'mongodb'
import { afterAll, expect, it } from 'vitest'
import { tierUri } from '../../env.js'
import { type ExampleRun, expectNoCredentials, runExample, streams, words } from '../../examples.js'
import { unconfigured } from '../../readme.js'
import { describeTier } from '../../tiers.js'

// Atlas embeds a document after the write acknowledges, about 15 s on a quiet cluster; the ceiling is Python's.
const EMBEDDING_BUDGET_MS = 90_000
const EMBEDDING_POLL_MS = 5_000

// Needs MONGODB_AUTOEMBED_URI: a cluster with an embedding model registered, so `$vectorSearch` embeds server-side.
describeTier('autoembed', 'AT-086: examples/memory-recall.ts across two processes', () => {
  const uri = tierUri('autoembed')!
  const database = `strands_examples_autoembed_${randomUUID().slice(0, 8)}`
  const env = { ...unconfigured(), MONGODB_URI: uri, MONGODB_DATABASE: database }
  const printed = (run: ExampleRun, label: string) => new RegExp(`^${label}: (.+)$`, 'm').exec(run.stdout)?.[1]

  afterAll(async () => {
    const client = new MongoClient(uri)
    try {
      await client.db(database).dropDatabase()
    } finally {
      await client.close()
    }
  })

  // The recall step exits 1 while Atlas has not embedded the fact yet.
  async function recallUntilEmbedded(): Promise<ExampleRun> {
    const deadline = Date.now() + EMBEDDING_BUDGET_MS
    for (;;) {
      const recall = await runExample('memory-recall.ts', ['recall'], env)
      expectNoCredentials(recall, uri)
      if (recall.status === 0) return recall
      if (Date.now() >= deadline) throw new Error(`the stored fact was never recalled:\n${streams(recall)}`)
      await sleep(EMBEDDING_POLL_MS)
    }
  }

  it('recalls in a second process what the first stored, from a query sharing no word with it', async () => {
    const write = await runExample('memory-recall.ts', ['write'], env)
    expect(write.status, streams(write)).toBe(0)
    expectNoCredentials(write, uri)
    expect(write.stdout).toContain('npx tsx examples/memory-recall.ts recall')
    const stored = printed(write, 'stored')
    expect(stored, streams(write)).toBeDefined()

    const recall = await recallUntilEmbedded()

    expect(recall.stdout).toContain(`  ${stored}`)
    expect(recall.stdout).toContain('recalled by vector search')
    const query = words(printed(recall, 'query')!)
    expect([...words(stored!)].filter((word) => query.has(word))).toEqual([])
  })
})
