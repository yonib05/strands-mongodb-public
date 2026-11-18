import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHECKLIST, RELEASE_GATE, type Item } from './checklist.js'
import { REAL_DEPLOYMENT_PROJECTS, type RecordedRun, type RecordedTest } from './reporter.js'
import { leadingIds, stale, unproven } from './verdict.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEST_ROOTS = ['src/__tests__', 'test/integ', 'test/docs']

// A string literal that starts with ids, on a line that is not a `//` comment, is a title declaring them.
const DECLARATION = /['"`]((?:AT|CH|MP)-\d[^'"`]*)/g

function declaredIds(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .flatMap((line) => [...line.matchAll(DECLARATION)].flatMap((match) => leadingIds(match[1]!)))
}

// Every declared id, with the files declaring it.
function declarations(): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const root of TEST_ROOTS) {
    for (const path of readdirSync(join(PACKAGE_ROOT, root), { recursive: true, encoding: 'utf8' })) {
      if (!path.endsWith('.test.ts')) continue
      const file = join(root, path)
      for (const id of declaredIds(readFileSync(join(PACKAGE_ROOT, file), 'utf8'))) {
        index.set(id, [...(index.get(id) ?? []), file])
      }
    }
  }
  return index
}

describe('the checklist', () => {
  it('numbers its twenty-nine items once each, and draws the release gate from them', () => {
    const numbers = CHECKLIST.map((item) => item.number)

    expect(numbers).toEqual(Array.from({ length: 29 }, (_, index) => index + 1))
    expect([...RELEASE_GATE].filter((number) => !numbers.includes(number))).toEqual([])
  })

  it('resolves every id to a test title', () => {
    const declared = declarations()

    expect(CHECKLIST.flatMap((item) => item.ids.filter((id) => !declared.has(id)))).toEqual([])
  })

  it('resolves every release-gate id to a test that runs against a real deployment', () => {
    const declared = declarations()
    const real = (file: string) => REAL_DEPLOYMENT_PROJECTS.some((project) => file.startsWith(`test/integ/${project}/`))

    expect(
      CHECKLIST.filter((item) => RELEASE_GATE.has(item.number)).flatMap((item) =>
        item.ids.filter((id) => !(declared.get(id) ?? []).some(real)).map((id) => `item ${item.number}: ${id}`)
      )
    ).toEqual([])
  })

  it('reads the ids a title starts with, and none from a comment or from later in a title', () => {
    const source = [
      "describe('AT-901, AT-902b: a group', () => {",
      "  ])('AT-903 one row %s', () => {})",
      '    `AT-904: on its own line`,',
      "  it('names AT-905 later', () => {})",
      "  // it('AT-906: commented out', () => {})",
    ].join('\n')

    expect(declaredIds(source)).toEqual(['AT-901', 'AT-902b', 'AT-903', 'AT-904'])
  })
})

describe('the release gate verdict', () => {
  const ITEM: Item = { number: 1, behaviour: 'the behaviour under test', ids: ['AT-999'] }
  const recorded = (state: RecordedTest['state'], titles = ['AT-999: one']): RecordedTest => ({
    file: 't.test.ts',
    titles,
    state,
  })
  const run = (...tests: RecordedTest[]): RecordedRun => ({ commit: 'a'.repeat(40), dirty: false, tests })

  it('is clean when a contract or integration test for the item passed, skipped siblings or not', () => {
    expect(unproven({ contract: run(recorded('passed'), recorded('skipped')) }, [ITEM])).toEqual([])
    expect(unproven({ integration: run(recorded('passed', ['AT-999: a group', 'a member'])) }, [ITEM])).toEqual([])
  })

  it('fails an item whose every test was skipped, or that has no results at all', () => {
    expect(unproven({ contract: run(recorded('skipped')) }, [ITEM])).toEqual([
      'item 1 (AT-999) is unverified on a real deployment: every test for it was skipped: t.test.ts > AT-999: one',
    ])
    expect(unproven({}, [ITEM])).toHaveLength(1)
  })

  it('refuses a run from another commit or from a modified tree, naming what to do', () => {
    const head = { commit: 'b'.repeat(40), dirty: false }
    const current = { ...run(), commit: head.commit }

    expect(stale({ contract: current, integration: current }, head)).toEqual([])
    expect(stale({ contract: run(), integration: current }, head)).toEqual([
      'the contract results are from commit aaaaaaa, not commit bbbbbbb: rerun npm run test:contract',
    ])
    expect(stale({ integration: { ...current, dirty: true } }, head)).toEqual([
      'the integration results are from a modified tree at bbbbbbb, not commit bbbbbbb: commit the changes, then rerun npm run test:integration',
    ])
  })

  it('refuses a working tree modified since the tiers ran clean', () => {
    const head = { commit: 'b'.repeat(40), dirty: true }
    const current = { ...run(), commit: head.commit }

    expect(stale({ contract: current, integration: current }, head)).toEqual([
      'the working tree differs from commit bbbbbbb: commit the changes, then rerun both tiers and this gate',
    ])
  })

  it('fails an item with a failed or unfinished test, even beside a passing one', () => {
    for (const state of ['failed', 'pending'] as const) {
      expect(unproven({ contract: run(recorded('passed'), recorded(state, ['AT-999: two'])) }, [ITEM])).toEqual([
        'item 1 (AT-999) did not pass: t.test.ts > AT-999: two',
      ])
    }
  })
})
