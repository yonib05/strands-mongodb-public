import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { tierUri } from '../../env.js'
import { blocks, PACKAGE_README, prepare, selected, type Snippets, where } from '../../readme.js'
import { describeTier } from '../../tiers.js'

const PACKAGE_BLOCKS = blocks(PACKAGE_README)

describeTier('autoembed', 'README snippets against a registered embedding model', () => {
  const autoembed = selected('autoembed', PACKAGE_BLOCKS)
  const database = `strands_mongodb_readme_${randomUUID().slice(0, 8)}`
  let client: MongoClient
  let snippets: Snippets

  beforeAll(() => {
    client = new MongoClient(tierUri('autoembed')!)
    snippets = prepare(autoembed)
  })

  afterAll(async () => {
    snippets?.dispose()
    await client
      .db(database)
      .dropDatabase()
      .catch(() => false)
    await client.close()
  })

  it('AT-092: type-checks the autoembed snippets', { timeout: 120_000 }, () => {
    expect(autoembed.length).toBeGreaterThan(0)
    expect(() => snippets.typeCheck()).not.toThrow()
  })

  // The memory quickstart waits for Atlas to embed and index, which can take minutes on a new collection.
  it.each(autoembed.map((block) => [where(block), block] as const))(
    'AT-092: runs %s against MONGODB_AUTOEMBED_URI',
    (_location, block) => {
      const uri = tierUri('autoembed')!
      const env = { ...process.env, MONGODB_URI: uri, MONGODB_AUTOEMBED_URI: uri, MONGODB_DATABASE: database }
      expect(() => snippets.run(block, env)).not.toThrow()
    },
    900_000
  )
})
