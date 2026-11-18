import { type Document, MongoClient } from 'mongodb'
import { expect, it, vi } from 'vitest'
import { close, DRIVER_NAME, resolve } from '../../../src/client.js'
import { PACKAGE_VERSION } from '../../../src/version.js'
import { tierUri } from '../../env.js'
import { describeTier } from '../../tiers.js'

// `options.metadata` is internal in the driver typings: a promise of the handshake document.
async function driverOf(client: MongoClient): Promise<{ name: string; version: string }> {
  const metadata = await (client.options as unknown as { metadata: Promise<Document> }).metadata
  return metadata.driver as { name: string; version: string }
}

describeTier('contract', 'client', () => {
  it('AT-013a: builds a client that carries the attribution and reaches the server', async () => {
    const config = { database: 'strands_mongodb_contract', connectionString: tierUri('contract')! }
    const { client } = resolve(config)
    try {
      const driver = await driverOf(client)
      expect(driver.name.split('|')).toContain(DRIVER_NAME)
      expect(driver.version.split('|')).toContain(PACKAGE_VERSION)
      await expect(client.db('admin').command({ ping: 1 })).resolves.toMatchObject({ ok: 1 })
    } finally {
      await close(config)
    }
  })

  it('AT-013b, AT-010: attributes an injected client and never closes it', async () => {
    const client = new MongoClient(tierUri('contract')!)
    const shut = vi.spyOn(client, 'close')
    const config = { database: 'strands_mongodb_contract', client }
    try {
      resolve(config)
      await close(config)

      expect(shut).not.toHaveBeenCalled()
      expect((await driverOf(client)).name.split('|')).toContain(DRIVER_NAME)
      await expect(client.db('admin').command({ ping: 1 })).resolves.toMatchObject({ ok: 1 })
    } finally {
      shut.mockRestore()
      await client.close()
    }
  })
})
