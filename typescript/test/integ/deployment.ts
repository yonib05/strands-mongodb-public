import { randomUUID } from 'node:crypto'
import { type Db, MongoServerError } from 'mongodb'
import type { Capabilities } from '../../src/client.js'
import { memorySearchSpecs } from '../../src/index-specs.js'
import { searchSupport } from '../../src/probes.js'

/** What the deployment can do, asked of it directly so a test never reads the answer back from the store under test. */
export async function capabilitiesOf(db: Db): Promise<Capabilities> {
  const { available, code } = await searchSupport(db.collection('capabilities'))
  const { versionArray } = await db.command({ buildInfo: 1 })
  const capabilities: Capabilities = { search: available, rankFusion: available && versionArray[0] >= 8 }
  if (code !== undefined) capabilities.noSearchCode = code
  return capabilities
}

/** The skip reason for a test that pins how a deployment without an embedding model refuses an `autoEmbed` index. */
export const EMBEDS = 'this deployment registers an embedding model, so it builds the autoEmbed index'

/** Whether the deployment refuses an `autoEmbed` vector index (code 8), as atlas-local does and Atlas does not. */
export async function refusesAutoEmbed(db: Db): Promise<boolean> {
  const scratch = db.collection(`autoembed_probe_${randomUUID().slice(0, 8)}`)
  await db.createCollection(scratch.collectionName)
  try {
    await scratch.createSearchIndex(memorySearchSpecs({ database: db.databaseName })[0]!.toDescription())
    return false
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 8) return true
    throw error
  } finally {
    await scratch.drop()
  }
}
