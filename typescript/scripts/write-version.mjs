// Writes src/version.ts from ./package.json, so a bundled build reports the real version with no file read.
import { readFileSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
writeFileSync(
  'src/version.ts',
  `// Written by scripts/write-version.mjs on every build; edit package.json instead.

/** This package's version, for driver attribution and the tracer scope. */
export const PACKAGE_VERSION = '${version}'
`
)
