import { createRequire } from 'node:module'

/**
 * Reads this package's version from its `package.json`, for driver attribution and the tracer scope.
 *
 * @returns The `version` field
 */
export function packageVersion(): string {
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version
}
