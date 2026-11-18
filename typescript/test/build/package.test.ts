import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PACKAGE_ROOT } from '../readme.js'
import { describeTier } from '../tiers.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

// What a TypeScript consumer writes: it compiles only if the `types` conditions of all three entry points resolve.
const CONSUMER = `import { type MongoDBConfig, MongoDBStorage } from 'strands-mongodb'
import { MongoDBMemoryStore } from 'strands-mongodb/memory'
import { MongoDBVectorSearchStrategy } from 'strands-mongodb/storage'

const config: MongoDBConfig = { database: 'x', connectionString: 'mongodb://localhost' }
export const built = [new MongoDBStorage(config), new MongoDBMemoryStore({ name: 'facts', config })]
export const strategy: typeof MongoDBVectorSearchStrategy = MongoDBVectorSearchStrategy
`

// The peer at the version the lockfile installed here, so an upstream release cannot turn this tier red.
function installed(name: string): string {
  const manifest = join(PACKAGE_ROOT, 'node_modules', name, 'package.json')
  return `${name}@${(JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version}`
}

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
    // The release workflow passes the tarball it will publish; otherwise one is packed here, which builds `dist`.
    tarball = process.env.STRANDS_MONGODB_TARBALL ?? join(workDir, pack(['--pack-destination', workDir]).filename)
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  function install(fixture: string): string {
    const dir = join(workDir, fixture)
    cpSync(join(FIXTURES, fixture), dir, { recursive: true })
    npm(['install', '--no-audit', '--no-fund', tarball, installed('@strands-agents/sdk'), installed('mongodb')], dir)
    return dir
  }

  describe('contents', () => {
    it('ships only the build output, the changelog and the legal files', () => {
      const paths = pack(['--dry-run', '--ignore-scripts']).files.map((file) => file.path)
      const extra = paths.filter(
        (path) =>
          !path.startsWith('dist/') &&
          !['README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'package.json'].includes(path)
      )

      expect(extra).toEqual([])
      expect(paths).toEqual(
        expect.arrayContaining(['CHANGELOG.md', 'LICENSE', 'NOTICE', 'package.json', 'dist/index.js'])
      )
      expect(paths.filter((path) => /__tests__|__fixtures__|\.test\.|\.map$/.test(path))).toEqual([])
    })
  })

  describe('ESM consumer', () => {
    let dir: string

    beforeAll(() => {
      dir = install('esm')
    })

    it('imports the root and both subpaths', () => {
      expect(execFileSync(process.execPath, ['index.js'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('ok')
    })

    it('type-checks against the published types', () => {
      writeFileSync(join(dir, 'consumer.ts'), CONSUMER)
      const tsc = join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
      const options = ['--noEmit', '--strict', '--skipLibCheck', '--module', 'nodenext', 'consumer.ts']

      // tsc prints its diagnostics on stdout, so an empty one is a clean compile.
      expect(spawnSync(process.execPath, [tsc, ...options], { cwd: dir, encoding: 'utf8' }).stdout).toBe('')
    })

    it('ships types with no member marked @internal', () => {
      const types = (file: string): string =>
        readFileSync(join(dir, 'node_modules', 'strands-mongodb', 'dist', file), 'utf8')

      expect(types('storage.d.ts')).toContain('deletePrefix(')
      expect(types('storage.d.ts')).not.toContain('_collection(')
      expect(types('vector-search.d.ts')).not.toContain('indexSpec(')
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
