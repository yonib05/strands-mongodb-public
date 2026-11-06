import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PACKAGE_ROOT } from '../readme.js'

const SCRIPT = join(PACKAGE_ROOT, 'scripts', 'pin-floors.mjs')

const pinFloors = (cwd: string) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' })

describe('scripts/pin-floors.mjs', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strands-mongodb-pin-floors-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const withPeers = (peerDependencies: Record<string, string>) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', peerDependencies }))
    return pinFloors(dir)
  }

  it('prints the install command for the floors this package declares', () => {
    const result = pinFloors(PACKAGE_ROOT)

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(
      'npm install --no-save @opentelemetry/api@1.9.0 @strands-agents/sdk@1.23.0 mongodb@7.0.0'
    )
  })

  it('reads >= and ^ as the version they start from', () => {
    const result = withPeers({ a: '>=1.23.0', b: '^7.0.0', c: '^0.4.1' })

    expect(result.stdout.trim()).toBe('npm install --no-save a@1.23.0 b@7.0.0 c@0.4.1')
  })

  it.each(['~1.2.3', '1.x', '>=1.0.0 <2.0.0', '*', '^1.2'])('refuses %s, which names no single floor', (range) => {
    const result = withPeers({ a: range })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`a@${range}`)
  })

  it('refuses a manifest with no peer ranges, which would install everything instead', () => {
    const result = withPeers({})

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('peerDependencies')
  })
})
