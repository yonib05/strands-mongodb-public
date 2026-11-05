import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TIER_VARIABLES = {
  contract: 'MONGODB_URI',
  integration: 'MONGODB_ATLAS_URI',
  autoembed: 'MONGODB_AUTOEMBED_URI',
  build: 'STRANDS_MONGODB_BUILD_TIER',
} as const

export type Tier = keyof typeof TIER_VARIABLES

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const ENV_FILE_LOCATIONS: readonly string[] = [join(PACKAGE_ROOT, '.env'), join(PACKAGE_ROOT, '..', '.env')]

function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim().replace(/^export\s+/, '')
    const eq = stripped.indexOf('=')
    if (!stripped || stripped.startsWith('#') || eq === -1) continue
    let value = stripped.slice(eq + 1).trim()
    if (value.length > 1 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1)
    }
    values.set(stripped.slice(0, eq).trim(), value)
  }
  return values
}

/**
 * Fills unset tier variables from the first `.env` file that exists, as `python/tests/conftest.py` does.
 *
 * @param locations - Candidate files in preference order: `typescript/.env`, then the repository root.
 */
export function loadDotEnv(locations: readonly string[] = ENV_FILE_LOCATIONS): void {
  const wanted = new Set<string>(Object.values(TIER_VARIABLES))
  const path = locations.find((candidate) => existsSync(candidate))
  if (path === undefined) return
  for (const [name, value] of parseEnvFile(readFileSync(path, 'utf8'))) {
    // Presence, not truthiness: `MONGODB_URI=` on the command line keeps a tier off.
    if (wanted.has(name) && process.env[name] === undefined) process.env[name] = value
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
