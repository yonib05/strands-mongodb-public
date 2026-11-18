import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { afterAll, expect, it } from 'vitest'
import { tierUri } from '../../env.js'
import { expectNoCredentials, runExample, streams, summaryOf } from '../../examples.js'
import { unconfigured } from '../../readme.js'
import { describeTier } from '../../tiers.js'

describeTier('contract', 'AT-089: examples/unified-storage.ts across two processes', () => {
  const uri = tierUri('contract')!
  const run = randomUUID().slice(0, 8)
  const database = `strands_examples_contract_${run}`
  const env = { ...unconfigured(), MONGODB_URI: uri, MONGODB_DATABASE: database }
  const args = ['--session-id', `at089-${run}`, '--summary-json']

  afterAll(async () => {
    const client = new MongoClient(uri)
    try {
      await client.db(database).dropDatabase()
    } finally {
      await client.close()
    }
  })

  it('writes three prefixes to one collection, and a new process restores the session', async () => {
    const first = await runExample('unified-storage.ts', ['run', ...args], env)
    expect(first.status, streams(first)).toBe(0)
    expectNoCredentials(first, uri)
    expect(first.stdout).toContain(`npx tsx examples/unified-storage.ts resume --session-id at089-${run}`)

    // Read independently: the script's own census would only show the script agreeing with itself.
    const client = new MongoClient(uri)
    let keys: string[]
    try {
      const documents = await client
        .db(database)
        .collection('example')
        .find({}, { projection: { _id: 1 } })
        .toArray()
      keys = documents.map((document) => String(document._id))
    } finally {
      await client.close()
    }
    for (const prefix of ['session/', 'context/', 'memory/']) {
      expect(
        keys.some((key) => key.startsWith(prefix)),
        `nothing under ${prefix}: ${keys.sort().join(', ')}`
      ).toBe(true)
    }

    const second = await runExample('unified-storage.ts', ['resume', ...args], env)
    expect(second.status, streams(second)).toBe(0)
    expectNoCredentials(second, uri)
    const resumed = summaryOf(second)
    expect(resumed['restoredMessages'], streams(second)).toBeGreaterThan(0)
    expect(resumed['restoredMessages']).toBe(summaryOf(first)['messages'])

    const cited = second.stdout.split('\n').filter((line) => line.includes('token overlap'))
    expect(cited, second.stdout).not.toEqual([])
    expect(cited.some((line) => line.toLowerCase().includes('storage') && line.toLowerCase().includes('memor'))).toBe(
      true
    )
  })
})
