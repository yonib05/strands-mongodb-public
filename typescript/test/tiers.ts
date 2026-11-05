import { describe } from 'vitest'
import { tierUri, type Tier } from './env.js'

/**
 * Declares a suite that is skipped unless the tier's variable is set.
 *
 * @param tier - Tier whose variable gates the suite.
 * @param name - Suite name.
 * @param fn - Suite body.
 */
export function describeTier(tier: Tier, name: string, fn: () => void): void {
  describe.skipIf(!tierUri(tier))(name, fn)
}
