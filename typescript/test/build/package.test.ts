import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeTier } from '../tiers.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

interface PackResult {
  filename: string
  files: { path: string }[]
}

function npm(args: string[], cwd: string): string {
  return execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function pack(args: string[]): PackResult {
  const [result] = JSON.parse(npm(['pack', '--json', ...args], PACKAGE_ROOT)) as PackResult[]
  return result!
}

describeTier('build', 'package', () => {
  let workDir: string
  let tarball: string

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'strands-mongodb-build-'))
    tarball = join(workDir, pack(['--pack-destination', workDir]).filename)
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  function install(fixture: string): string {
    const dir = join(workDir, fixture)
    cpSync(join(FIXTURES, fixture), dir, { recursive: true })
    // The package's own .npmrc does not apply outside typescript/.
    writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n')
    npm(['install', '--no-audit', '--no-fund', tarball, '@strands-agents/sdk', 'mongodb'], dir)
    return dir
  }

  describe('contents', () => {
    it('ships only the build output and the legal files', () => {
      const paths = pack(['--dry-run']).files.map((file) => file.path)
      const extra = paths.filter(
        (path) => !path.startsWith('dist/') && !['README.md', 'LICENSE', 'NOTICE', 'package.json'].includes(path)
      )

      expect(extra).toEqual([])
      expect(paths).toEqual(expect.arrayContaining(['LICENSE', 'NOTICE', 'package.json', 'dist/index.js']))
      expect(paths.filter((path) => /__tests__|__fixtures__|\.test\.|\.map$/.test(path))).toEqual([])
    })
  })

  describe('published types', () => {
    it('carry no member marked @internal', () => {
      const types = (file: string) => readFileSync(join(PACKAGE_ROOT, 'dist', file), 'utf8')

      expect(types('storage.d.ts')).toContain('deletePrefix(')
      expect(types('storage.d.ts')).not.toContain('_collection(')
      expect(types('vector-search.d.ts')).not.toContain('indexSpec(')
    })
  })

  describe('ESM consumer', () => {
    it('imports the root and both subpaths', () => {
      const dir = install('esm')

      expect(execFileSync(process.execPath, ['index.js'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('ok')
    })
  })

  describe('CommonJS consumer', () => {
    it('loads through require(esm) where Node supports it, and fails with ERR_REQUIRE_ESM otherwise', () => {
      const dir = install('cjs')
      // Observed on Node 24.15: require(esm) loads the package, since no module in its graph uses top-level await.
      const outcome = JSON.parse(execFileSync(process.execPath, ['index.js'], { cwd: dir, encoding: 'utf8' }))

      expect(outcome).toEqual(process.features.require_module ? { loaded: 'function' } : { code: 'ERR_REQUIRE_ESM' })
    })
  })
})
