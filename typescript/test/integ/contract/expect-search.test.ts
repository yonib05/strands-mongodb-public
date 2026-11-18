import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { expect, it } from 'vitest'
import { searchSupport } from '../../../src/probes.js'
import { tierUri } from '../../env.js'
import { describeTier } from '../../tiers.js'

const EXPECT_SEARCH = 'STRANDS_MONGODB_EXPECT_SEARCH'

describeTier('contract', 'the deployment the environment promised', () => {
  it('AT-187: has a search process when STRANDS_MONGODB_EXPECT_SEARCH is set', async (context) => {
    if (!process.env[EXPECT_SEARCH]) context.skip(`${EXPECT_SEARCH} is unset, so this deployment promised nothing`)
    const client = new MongoClient(tierUri('contract')!)
    try {
      // An absent collection is enough: the probe reads the server's answer, not an index.
      const collection = client.db('strands_mongodb_contract').collection(`expect_search_${randomUUID().slice(0, 8)}`)
      const support = await searchSupport(collection)

      expect(support, `${EXPECT_SEARCH} is set, but MONGODB_URI names a deployment without a search process`).toEqual({
        available: true,
      })
    } finally {
      await client.close()
    }
  })
})
