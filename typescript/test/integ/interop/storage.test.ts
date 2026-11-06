import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { Binary, type Db, type Document, MongoClient } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { close } from '../../../src/client.js'
import { MongoDBStorage } from '../../../src/storage.js'
import type { MongoDBConfig } from '../../../src/types.js'
import { tierUri } from '../../env.js'
import { describeTier } from '../../tiers.js'
import { interopUnmet, runPython } from './python-bridge.js'

const DATABASE = 'strands_mongodb_interop'

const base64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')

describeTier(
  'interop',
  'storage across languages',
  () => {
    const collection = `storage_${randomUUID().slice(0, 8)}`
    let client: MongoClient
    let db: Db
    let config: MongoDBConfig
    let storage: MongoDBStorage

    const raw = (id: string) => db.collection<Document>(collection).findOne({ _id: id as unknown as Document['_id'] })

    beforeAll(() => {
      client = new MongoClient(tierUri('interop')!)
      db = client.db(DATABASE)
      config = { database: DATABASE, connectionString: tierUri('interop')! }
      storage = new MongoDBStorage(config, { collection })
    })

    afterAll(async () => {
      await close(config)
      await db
        .collection(collection)
        .drop()
        .catch(() => false)
      await client.close()
    })

    describe('a document Python wrote', () => {
      beforeAll(async () => {
        await runPython(
          'storage_write.py',
          { uri: tierUri('interop')!, database: DATABASE, collection },
          {
            writes: { 'sessions/s1/state': base64([0, 255, 10]), 'sessions/s1/empty': '' },
          }
        )
      })

      it('reads back in TypeScript as the exact bytes, an empty payload included', async () => {
        expect(await storage.read('sessions/s1/state')).toEqual(new Uint8Array([0, 255, 10]))
        expect(await storage.read('sessions/s1/empty')).toEqual(new Uint8Array([]))
      })

      it('lists in TypeScript in byte order', async () => {
        expect(await storage.list('sessions/')).toEqual(['sessions/s1/empty', 'sessions/s1/state'])
      })

      it('stores its payload as a subtype 0 Binary, with updated_at and no expires_at', async () => {
        const document = await raw('sessions/s1/state')

        expect(document!.data).toBeInstanceOf(Binary)
        expect((document!.data as Binary).sub_type).toBe(Binary.SUBTYPE_DEFAULT)
        expect(document!.updated_at).toBeInstanceOf(Date)
        expect(document).not.toHaveProperty('expires_at')
      })
    })

    describe('a document TypeScript wrote', () => {
      const key = 'a/😀'

      beforeAll(async () => {
        await storage.write(key, new Uint8Array([1, 2, 3]))
      })

      it('reads back in Python as the same bytes', async () => {
        const read = await runPython<{ values: Record<string, string | null> }>(
          'storage_read.py',
          { uri: tierUri('interop')!, database: DATABASE, collection },
          { keys: [key] }
        )

        expect(read.values).toEqual({ [key]: base64([1, 2, 3]) })
      })

      it('carries the same _id and stamps as one Python writes', async () => {
        const ours = await raw(key)
        const theirs = await raw('sessions/s1/state')

        expect(ours!._id).toBe(key)
        expect(Object.keys(ours!).sort()).toEqual(Object.keys(theirs!).sort())
        expect((ours!.data as Binary).sub_type).toBe(Binary.SUBTYPE_DEFAULT)
        expect(ours).not.toHaveProperty('expires_at')
      })
    })
  },
  interopUnmet()
)
