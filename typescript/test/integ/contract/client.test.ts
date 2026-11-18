import { StorageError } from '@strands-agents/sdk'
import { type Document, MongoClient, MongoServerSelectionError } from 'mongodb'
import { expect, it, vi } from 'vitest'
import { rejectionOf } from '../../../src/__fixtures__/errors.js'
import { close, resolve } from '../../../src/client.js'
import { MongoDBStorage } from '../../../src/storage.js'
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
      expect(driver.name.split('|')).toContain('Strands-MongoDB')
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
      expect((await driverOf(client)).name.split('|')).toContain('Strands-MongoDB')
      await expect(client.db('admin').command({ ping: 1 })).resolves.toMatchObject({ ok: 1 })
    } finally {
      shut.mockRestore()
      await client.close()
    }
  })

  it('makes a fresh attempt after a failed first connection, which the driver alone answers with a closed topology', async () => {
    const unreachable = new MongoDBStorage({
      database: 'strands_mongodb_contract',
      connectionString: 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300',
    })
    const reachable = new MongoDBStorage({
      database: 'strands_mongodb_contract',
      connectionString: tierUri('contract')!,
    })
    try {
      const first = await rejectionOf(unreachable.read('a'))
      expect(first).toBeInstanceOf(StorageError)
      expect(first.cause).toBeInstanceOf(MongoServerSelectionError)

      await expect(reachable.read('absent')).resolves.toBeNull()

      const second = await rejectionOf(unreachable.read('a'))
      expect(second).toBeInstanceOf(StorageError)
      expect(second.cause).toBeInstanceOf(MongoServerSelectionError)
    } finally {
      await Promise.all([unreachable.close(), reachable.close()])
    }
  })
})
