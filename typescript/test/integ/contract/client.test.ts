import { StorageError } from '@strands-agents/sdk'
import { type Document, MongoClient, MongoServerSelectionError } from 'mongodb'
import { expect, it, vi } from 'vitest'
import { rejectionOf } from '../../../src/__fixtures__/errors.js'
import { close, resolve } from '../../../src/client.js'
import { MongoDBMemoryStore } from '../../../src/memory-store.js'
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

  it('answers every caller with the connection error after a failed first connection, where the driver alone reports a closed client', async () => {
    const config = {
      database: 'strands_mongodb_contract',
      connectionString: 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300',
    }
    const storage = new MongoDBStorage(config)
    const store = new MongoDBMemoryStore({ name: 'facts', config })
    const reachable = new MongoDBStorage({
      database: 'strands_mongodb_contract',
      connectionString: tierUri('contract')!,
    })
    try {
      const first = await rejectionOf(storage.read('a'))
      const concurrent = await Promise.all(
        [
          storage.read('a'),
          storage.read('b'),
          storage.read('c'),
          store.initialize(),
          store.initialize(),
          store.initialize(),
        ].map(rejectionOf)
      )
      await expect(reachable.read('absent')).resolves.toBeNull()
      const later = await rejectionOf(store.initialize())

      for (const error of [first, ...concurrent, later]) {
        expect(error).toBeInstanceOf(StorageError)
        expect(error.cause).toBeInstanceOf(MongoServerSelectionError)
      }
    } finally {
      await Promise.all([storage.close(), reachable.close()])
    }
  })
})
