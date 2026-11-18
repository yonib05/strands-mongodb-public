import { createRequire } from 'node:module'

const FALLBACK = '0.0.0'

// In a bundle `../package.json` is absent or the host application's, so the name is checked.
function read(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { name?: unknown; version?: unknown }
    return pkg.name === 'strands-mongodb' && typeof pkg.version === 'string' ? pkg.version : FALLBACK
  } catch {
    return FALLBACK
  }
}

/** This package's version, for driver attribution and the tracer scope. `0.0.0` when it cannot be read. */
export const PACKAGE_VERSION = read()
