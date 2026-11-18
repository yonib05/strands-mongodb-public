import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PACKAGE_VERSION } from '../version.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('PACKAGE_VERSION', () => {
  it('is the version in package.json when the package runs from its own tree', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }

    expect(PACKAGE_VERSION).toBe(pkg.version)
  })

  describe('in a bundled application', () => {
    let app: string
    let bundle: string

    beforeAll(async () => {
      app = mkdtempSync(join(tmpdir(), 'strands-mongodb-bundle-'))
      mkdirSync(join(app, 'out'))
      symlinkSync(join(PACKAGE_ROOT, 'node_modules'), join(app, 'node_modules'), 'dir')
      const entry = join(app, 'entry.ts')
      writeFileSync(
        entry,
        [
          `import { MongoDBStorage } from ${JSON.stringify(join(PACKAGE_ROOT, 'src', 'index.ts'))}`,
          `import { PACKAGE_VERSION } from ${JSON.stringify(join(PACKAGE_ROOT, 'src', 'version.ts'))}`,
          `const storage = new MongoDBStorage({ database: 'app', connectionString: 'mongodb://localhost:1' })`,
          `await storage.close()`,
          `console.log(PACKAGE_VERSION)`,
        ].join('\n')
      )
      bundle = join(app, 'out', 'bundle.mjs')
      await build({
        entryPoints: [entry],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        logLevel: 'silent',
      })
    })

    afterAll(() => rmSync(app, { recursive: true, force: true }))

    const run = (): string => execFileSync(process.execPath, [bundle], { cwd: app, encoding: 'utf8' }).trim()

    it('builds a store and falls back when no package.json sits above the bundle', () => {
      expect(run()).toBe('0.0.0')
    })

    it("does not report the host application's version", () => {
      writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'host-app', version: '9.9.9-app' }))

      expect(run()).toBe('0.0.0')
    })
  })
})
