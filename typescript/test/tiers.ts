import { describe, it } from 'vitest'
import { tierUri, type Tier } from './env.js'

/**
 * Declares a suite that is skipped unless the tier's variable is set.
 *
 * @param tier - Tier whose variable gates the suite.
 * @param name - Suite name.
 * @param fn - Suite body.
 * @param unmet - Why the suite cannot run although the variable is set; it then reports one skip carrying the reason.
 */
export function describeTier(tier: Tier, name: string, fn: () => void, unmet?: string): void {
  describe.skipIf(!tierUri(tier))(
    name,
    unmet === undefined ? fn : () => it('prerequisites', (context) => context.skip(unmet))
  )
}
