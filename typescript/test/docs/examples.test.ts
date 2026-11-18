import { beforeAll, describe, expect, it } from 'vitest'
import { redact } from '../../examples/support.js'
import {
  CREDENTIALED_URI,
  type ExampleRun,
  expectNoCredentials,
  runExample,
  streams,
  summaryOf,
  words,
} from '../examples.js'
import { unconfigured } from '../readme.js'

// Assembled from parts so no file in the repository carries a credentialed URI literally.
const uri = (scheme: string, userinfo: string, rest: string) => `${scheme}://${userinfo}@${rest}`

const PASSWORD = 'hunter2-example-secret'
const CREDENTIALED = uri('mongodb+srv', `appuser:${PASSWORD}`, 'cluster0.example.mongodb.net/?appName=demo')
const REDACTED = 'mongodb+srv://<redacted>@cluster0.example.mongodb.net/?appName=demo'

const SCRIPTS = [
  {
    script: 'memory-recall.ts',
    first: 'write',
    second: 'recall',
    carried: '--scope',
    plans: {
      write: ['house_policies', 'guest_notes', 'InvocationTrigger', 'MemoryManager.flush()'],
      recall: ['the same two stores', 'where should we seat them?'],
    },
  },
  {
    script: 'unified-storage.ts',
    first: 'run',
    second: 'resume',
    carried: '--session-id',
    plans: {
      run: ['Agent({ storage })', 'SessionManager', "contextManager: 'auto'", 'FileMemoryStore', 'census'],
      resume: ['restore', 'census', 'token overlap'],
    },
  },
] as const

const configured = { ...unconfigured(), MONGODB_URI: CREDENTIALED, MONGODB_DATABASE: 'tenant_7' }

describe.each(SCRIPTS)('AT-088: examples/$script', ({ script, first, second, carried, plans }) => {
  // Five processes cover every assertion below; they start together.
  let plain: ExampleRun
  let optioned: ExampleRun
  let later: ExampleRun
  let refused: ExampleRun
  let unknown: ExampleRun

  beforeAll(async () => {
    ;[plain, optioned, later, refused, unknown] = await Promise.all([
      runExample(script, [first, '--dry-run'], unconfigured()),
      runExample(script, [first, '--dry-run', carried, 'at088', '--collection', 'c1', '--summary-json'], configured),
      runExample(script, [second, '--dry-run'], { ...unconfigured(), MONGODB_URI: CREDENTIALED }),
      runExample(script, [first], unconfigured()),
      runExample(script, ['launch'], unconfigured()),
    ])
  })

  it('refuses a real step without MONGODB_URI, exits 2 and names the variable', () => {
    expect(refused.status, streams(refused)).toBe(2)
    expect(refused.stderr).toContain('MONGODB_URI')
    expect(refused.stdout).toBe('')
    expectNoCredentials(refused)
  })

  it('rejects an unknown step with exit 2 and the steps it takes', () => {
    expect(unknown.status).toBe(2)
    expect(unknown.stderr).toContain(`${first}, ${second}`)
  })

  it('describes each step on --dry-run with the URI redacted', () => {
    const fragments: Record<string, readonly string[]> = plans
    for (const [run, step, target] of [
      [optioned, first, "database 'tenant_7', collection 'c1'"],
      [later, second, "database 'strands_examples', collection 'example'"],
    ] as const) {
      expect(run.status, streams(run)).toBe(0)
      expect(run.stdout).toContain(`dry run of the '${step}' step`)
      expect(run.stdout).toContain(REDACTED)
      expect(run.stdout).toContain(target)
      for (const fragment of fragments[step]!) expect(run.stdout).toContain(fragment)
      expectNoCredentials(run, CREDENTIALED)
    }
  })

  it('needs no MONGODB_URI for --dry-run, and says a real run would refuse', () => {
    expect(plain.status, streams(plain)).toBe(0)
    expect(plain.stdout).toContain('MONGODB_URI is not set')
  })

  it('prints the next command with the options this run was given, and without the defaults', () => {
    const next = `npx tsx examples/${script} ${second}`
    const handoff = optioned.stdout.split('\n').filter((line) => line.includes(next))

    expect(handoff, optioned.stdout).toHaveLength(1)
    expect(handoff[0]).toContain(`${carried} at088`)
    expect(handoff[0]).toContain('--collection c1')
    expect(plain.stdout).toContain(`then run: ${next}\n`)
  })

  it('prints JSON only with --summary-json, as the last line', () => {
    for (const line of plain.stdout.trim().split('\n')) expect(() => JSON.parse(line)).toThrow()
    expect(summaryOf(optioned)).toEqual({ step: first, dryRun: true })
  })
})

describe('AT-086: examples/memory-recall.ts on --dry-run', () => {
  it('shows a stored fact and a query that share no word', async () => {
    const run = await runExample('memory-recall.ts', ['write', '--dry-run'], unconfigured())

    const fact = /the fact: '([^']+)'/.exec(run.stdout)?.[1]
    const query = /the query: '([^']+)'/.exec(run.stdout)?.[1]
    expect(fact, run.stdout).toBeDefined()
    expect(query, run.stdout).toBeDefined()
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
