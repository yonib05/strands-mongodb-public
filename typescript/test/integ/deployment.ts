import type { Db } from 'mongodb'
import type { Capabilities } from '../../src/client.js'
import { searchSupport } from '../../src/probes.js'

/** What the deployment can do, asked of it directly so a test never reads the answer back from the store under test. */
export async function capabilitiesOf(db: Db): Promise<Capabilities> {
  const { available, code } = await searchSupport(db.collection('capabilities'))
  const { versionArray } = await db.command({ buildInfo: 1 })
  const capabilities: Capabilities = { search: available, rankFusion: available && versionArray[0] >= 8 }
  if (code !== undefined) capabilities.noSearchCode = code
  return capabilities
}
