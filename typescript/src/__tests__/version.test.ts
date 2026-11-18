import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT } from '../../test/readme.js'
import { PACKAGE_VERSION } from '../version.js'

describe('PACKAGE_VERSION', () => {
  it('is the version in package.json, which the build writes into the committed constant', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }

    expect(PACKAGE_VERSION).toBe(pkg.version)
  })
})
