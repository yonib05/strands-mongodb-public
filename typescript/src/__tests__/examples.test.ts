import { describe, expect, it, vi } from 'vitest'
import { expectNoCredentials, runExample, streams, summaryOf, words } from '../../test/examples.js'
import { unconfigured } from '../../test/readme.js'

const PASSWORD = 'hunter2-example-secret'
// Assembled so no file in the repository carries a credentialed URI literally.
const CREDENTIALED = ['mongodb+srv://', 'appuser', ':', PASSWORD, '@cluster0.example.mongodb.net/?appName=demo'].join(
  ''
)
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

// Each test starts one or two `tsx` processes, which compile the source tree on the way in.
vi.setConfig({ testTimeout: 30_000 })

const withUri = (uri: string) => ({ ...unconfigured(), MONGODB_URI: uri })

describe.each(SCRIPTS)('AT-088: examples/$script', ({ script, first, second, carried, plans }) => {
  it('refuses a real step without MONGODB_URI, exits 2 and names the variable', () => {
    const run = runExample(script, [first], unconfigured())

    expect(run.status, streams(run)).toBe(2)
    expect(run.stderr).toContain('MONGODB_URI')
    expect(run.stdout).toBe('')
    expectNoCredentials(run)
  })

  it.each(Object.entries(plans))('describes the %s step on --dry-run with the URI redacted', (step, plan) => {
    const run = runExample(script, [step, '--dry-run'], withUri(CREDENTIALED))

    expect(run.status, streams(run)).toBe(0)
    expect(run.stdout).toContain(`dry run of the '${step}' step`)
    expect(run.stdout).toContain(REDACTED)
    expect(run.stdout).toContain("database 'strands_examples', collection 'example'")
    for (const fragment of plan) expect(run.stdout).toContain(fragment)
    expectNoCredentials(run, CREDENTIALED)
  })

  it('needs no MONGODB_URI for --dry-run, and says a real run would refuse', () => {
    const run = runExample(script, [first, '--dry-run'], unconfigured())

    expect(run.status, streams(run)).toBe(0)
    expect(run.stdout).toContain('MONGODB_URI is not set')
  })

  it('takes the database from MONGODB_DATABASE', () => {
    const run = runExample(script, [first, '--dry-run'], { ...withUri(CREDENTIALED), MONGODB_DATABASE: 'tenant_7' })

    expect(run.stdout).toContain("database 'tenant_7'")
  })

  it('prints the next command with the options this run was given', () => {
    const run = runExample(script, [first, '--dry-run', carried, 'at088', '--collection', 'c1'], unconfigured())

    const handoff = run.stdout.split('\n').filter((line) => line.includes(`npx tsx examples/${script} ${second}`))
    expect(handoff, run.stdout).toHaveLength(1)
    expect(handoff[0]).toContain(`${carried} at088`)
    expect(handoff[0]).toContain('--collection c1')
  })

  it('leaves default options out of the next command', () => {
    const run = runExample(script, [first, '--dry-run'], unconfigured())

    expect(run.stdout).toMatch(new RegExp(`then run: npx tsx examples/${script.replace('.', '\\.')} ${second}\\n`))
  })

  it('prints JSON only with --summary-json, as the last line', () => {
    const quiet = runExample(script, [first, '--dry-run'], unconfigured())
    for (const line of quiet.stdout.trim().split('\n')) expect(() => JSON.parse(line)).toThrow()

    const loud = runExample(script, [first, '--dry-run', '--summary-json'], unconfigured())
    expect(summaryOf(loud)).toEqual({ step: first, dryRun: true })
  })

  it('rejects an unknown step with exit 2 and the steps it takes', () => {
    const run = runExample(script, ['launch'], unconfigured())

    expect(run.status).toBe(2)
    expect(run.stderr).toContain(`${first}, ${second}`)
  })
})

describe('AT-086: examples/memory-recall.ts on --dry-run', () => {
  it('shows a stored fact and a query that share no word', () => {
    const run = runExample('memory-recall.ts', ['write', '--dry-run'], unconfigured())

    const fact = /the fact: '([^']+)'/.exec(run.stdout)?.[1]
    const query = /the query: '([^']+)'/.exec(run.stdout)?.[1]
    expect(fact, run.stdout).toBe('the guest prefers a window table for two on Thursday evenings')
    expect(query, run.stdout).toBe('where should we seat them?')
    expect([...words(fact!)].filter((word) => words(query!).has(word))).toEqual([])
  })
})
