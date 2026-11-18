import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { redact } from '../../examples/support.js'
import { CREDENTIALED_URI, type ExampleRun, expectNoCredentials, runExample, streams, words } from '../examples.js'
import { PACKAGE_ROOT, unconfigured } from '../readme.js'

// Assembled from parts so no file in the repository carries a credentialed URI literally.
const uri = (scheme: string, userinfo: string, rest: string) => `${scheme}://${userinfo}@${rest}`

// Port 1 refuses at once, so the run prints its connection line and then fails without a deployment.
const UNREACHABLE = uri('mongodb', 'appuser:hunter2-example-secret', '127.0.0.1:1/?serverSelectionTimeoutMS=300')

describe.each([
  { script: 'memory-recall.ts', first: 'write', second: 'recall' },
  { script: 'unified-storage.ts', first: 'run', second: 'resume' },
])('AT-088: examples/$script', ({ script, first, second }) => {
  let refused: ExampleRun
  let unknown: ExampleRun
  let unreachable: ExampleRun

  beforeAll(async () => {
    ;[refused, unknown, unreachable] = await Promise.all([
      runExample(script, [first], unconfigured()),
      runExample(script, ['launch'], unconfigured()),
      runExample(script, [first], { ...unconfigured(), MONGODB_URI: UNREACHABLE, MONGODB_DATABASE: 'tenant_7' }),
    ])
  })

  it('refuses to run without MONGODB_URI, exits 2 and names the variable', () => {
    expect(refused.status, streams(refused)).toBe(2)
    expect(refused.stderr).toContain('MONGODB_URI')
    expect(refused.stdout).toBe('')
  })

  it('rejects an unknown step with exit 2 and the steps it takes', () => {
    expect(unknown.status).toBe(2)
    expect(unknown.stderr).toContain(`${first} | ${second}`)
  })

  it('prints the URI redacted and leaks no credential on either stream when the deployment fails', () => {
    expect(unreachable.status, streams(unreachable)).not.toBe(0)
    expect(unreachable.stdout).toContain(redact(UNREACHABLE))
    expect(unreachable.stdout).toContain("database 'tenant_7'")
    expectNoCredentials(unreachable, UNREACHABLE)
  })
})

describe('AT-086: examples/memory-recall.ts', () => {
  it('stores a fact and asks a query that share no word', () => {
    const source = readFileSync(join(PACKAGE_ROOT, 'examples', 'memory-recall.ts'), 'utf8')
    const fact = /^const FACT = '([^']+)'$/m.exec(source)?.[1]
    const query = /^const QUERY = '([^']+)'$/m.exec(source)?.[1]

    expect(fact).toBeDefined()
    expect(query).toBeDefined()
    expect([...words(fact!)].filter((word) => words(query!).has(word))).toEqual([])
  })
})

describe('AT-088: redact', () => {
  it.each([
    [uri('mongodb+srv', 'app:s3cret', 'c.example.net/'), 'mongodb+srv://<redacted>@c.example.net/'],
    [uri('mongodb+srv', 'app:pa/ss', 'c.example.net/'), 'mongodb+srv://<redacted>@c.example.net/'],
    [uri('mongodb', 'app:p@ss', 'h:27017/'), 'mongodb://<redacted>@h:27017/'],
  ])(
    'replaces everything between the scheme and the last @ in %s, which the leak check then passes',
    (given, expected) => {
      expect(CREDENTIALED_URI.test(given)).toBe(true)
      expect(redact(given)).toBe(expected)
      expect(CREDENTIALED_URI.test(expected)).toBe(false)
    }
  )

  it('leaves a URI without credentials alone', () => {
    expect(redact('mongodb://h:27017/?directConnection=true')).toBe('mongodb://h:27017/?directConnection=true')
  })

  it.each(['appuser:<redacted>', '<redacted>:pw'])(
    'the leak check reads the partial redaction %s as a leak',
    (userinfo) => {
      expect(CREDENTIALED_URI.test(uri('mongodb+srv', userinfo, 'cluster.example.mongodb.net/'))).toBe(true)
    }
  )
})
