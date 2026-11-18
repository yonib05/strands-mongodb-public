import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

export const TIER_VARIABLES = {
  contract: 'MONGODB_URI',
  integration: 'MONGODB_ATLAS_URI',
  autoembed: 'MONGODB_AUTOEMBED_URI',
  build: 'STRANDS_MONGODB_BUILD_TIER',
  interop: 'MONGODB_URI',
} as const

export type Tier = keyof typeof TIER_VARIABLES

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// The build flag is set only from the shell, as in `python/tests/conftest.py`.
const DOTENV_VARIABLES: ReadonlySet<string> = new Set([
  TIER_VARIABLES.contract,
  TIER_VARIABLES.integration,
  TIER_VARIABLES.autoembed,
])

export const ENV_FILE_LOCATIONS: readonly string[] = [join(PACKAGE_ROOT, '.env'), join(PACKAGE_ROOT, '..', '.env')]

/**
 * Fills unset connection-string variables from the first `.env` file that exists, as `python/tests/conftest.py` does.
 *
 * @param locations - Candidate files in preference order: `typescript/.env`, then the repository root.
 */
export function loadDotEnv(locations: readonly string[] = ENV_FILE_LOCATIONS): void {
  const path = locations.find((candidate) => existsSync(candidate))
  if (path === undefined) return
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    // Presence, not truthiness: `MONGODB_URI=` on the command line keeps a tier off.
    if (DOTENV_VARIABLES.has(name) && process.env[name] === undefined && value !== undefined) process.env[name] = value
  }
}

/**
 * Reads the connection string or flag that enables a tier.
 *
 * @param tier - Tier to look up.
 * @returns The variable's value, or `undefined` when it is unset or empty.
 */
export function tierUri(tier: Tier): string | undefined {
  return process.env[TIER_VARIABLES[tier]] || undefined
}
