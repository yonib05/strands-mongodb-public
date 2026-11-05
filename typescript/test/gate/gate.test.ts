import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TIER_VARIABLES, type Tier } from '../env.js'
import { CHECKLIST, RELEASE_GATE, type Item } from './checklist.js'
import { RESULTS_PATH, type RecordedRun, type RecordedTest } from './reporter.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The ids a title declares are the comma-separated run it starts with, as Python reads a docstring's first paragraph.
const LEADING_IDS = /^(?:AT|CH|MP)-\d{1,3}[a-z]*(?:,\s*(?:AT|CH|MP)-\d{1,3}[a-z]*)*/

// A regex over the source, so the static half needs no prior run; `.each(...)` and `.skipIf(...)` may sit between.
const TITLE = /\b(?:it|test|describe)(?:\.\w+(?:\((?:[^()]|\([^()]*\))*\))?)*\(\s*(['"`])(.*?)\1/gs

function leadingIds(title: string): string[] {
  return title.match(LEADING_IDS)?.[0].split(/,\s*/) ?? []
}

function titleIds(source: string): string[] {
  return [...source.matchAll(TITLE)].flatMap((match) => leadingIds(match[2]!))
}

function testFiles(): string[] {
  const under = (dir: string) =>
    readdirSync(join(PACKAGE_ROOT, dir), { recursive: true, encoding: 'utf8' }).map((path) => join(dir, path))
  return [...under('src').filter((path) => path.includes('__tests__/')), ...under(join('test', 'integ'))].filter(
    (path) => path.endsWith('.test.ts')
  )
}

function collectedIds(): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const file of testFiles()) {
    for (const id of titleIds(readFileSync(join(PACKAGE_ROOT, file), 'utf8'))) {
      index.set(id, (index.get(id) ?? new Set()).add(file))
    }
  }
  return index
}

// An id on a test's own title wins over the same id on an enclosing describe, as in `ChecklistGate`.
function carriers(tests: readonly RecordedTest[], item: Item): RecordedTest[] {
  const found = new Set<RecordedTest>()
  for (const id of item.ids) {
    const own = tests.filter((test) => leadingIds(test.titlePath.at(-1)!).includes(id))
    const inherited = tests.filter((test) =>
      test.titlePath.slice(0, -1).some((title) => leadingIds(title).includes(id))
    )
    for (const test of own.length > 0 ? own : inherited) found.add(test)
  }
  return [...found]
}

function tierOf(project: string): Tier | undefined {
  return Object.hasOwn(TIER_VARIABLES, project) ? (project as Tier) : undefined
}

function label(test: RecordedTest): string {
  return `${test.file} > ${test.titlePath.join(' > ')}`
}

function skipReason(test: RecordedTest): string {
  const tier = tierOf(test.project)
  return test.note ?? (tier === undefined ? 'skipped' : `${TIER_VARIABLES[tier]} is unset`)
}

function verdict(run: RecordedRun, items: readonly Item[]): { problems: string[]; unverified: Map<number, string[]> } {
  const problems: string[] = []
  const unverified = new Map<number, string[]>()
  for (const item of items) {
    const found = carriers(run.tests, item)
    if (found.length === 0) {
      unverified.set(item.number, ['no test for it in this run'])
      continue
    }
    const failed = found.filter((test) => test.state === 'failed')
    if (failed.length > 0) problems.push(`item ${item.number} has failing tests: ${failed.map(label).join('; ')}`)
    const unfinished = found.filter((test) => test.state === 'pending')
    if (unfinished.length > 0)
      problems.push(`item ${item.number} has tests that never finished: ${unfinished.map(label).join('; ')}`)
    if (found.some((test) => test.state === 'passed')) continue
    const skipped = found.filter((test) => test.state === 'skipped')
    // A projectless or ungated test, or a tier whose variable was set, had no reason to skip.
    const refused = skipped.filter((test) => {
      const tier = tierOf(test.project)
      return tier === undefined || run.enabled[tier]
    })
    if (refused.length > 0) {
      problems.push(
        `item ${item.number} skipped every test although its tier was enabled: ${refused.map(label).join('; ')}`
      )
    } else if (skipped.length > 0) {
      unverified.set(item.number, [...new Set(skipped.map(skipReason))].sort())
    }
  }
  return { problems, unverified }
}

describe('the checklist table', () => {
  it('holds the twenty-nine items, each numbered once', () => {
    expect(CHECKLIST.map((item) => item.number)).toEqual(Array.from({ length: 29 }, (_, index) => index + 1))
  })

  it('draws the release gate as items 1 to 9 and 16 to 19', () => {
    expect(new Set(CHECKLIST.filter((item) => item.gate).map((item) => item.number))).toEqual(RELEASE_GATE)
    expect([...RELEASE_GATE].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19])
  })

  it('names at least one id and describes the behaviour on every item', () => {
    expect(CHECKLIST.filter((item) => item.ids.length === 0).map((item) => item.number)).toEqual([])
    expect(CHECKLIST.filter((item) => item.behaviour.length < 20).map((item) => item.number)).toEqual([])
  })
})

describe('every checklist id', () => {
  it('resolves to a test title in the unit or tier suites', () => {
    const index = collectedIds()
    const unresolved = CHECKLIST.map((item) => [item.number, item.ids.filter((id) => !index.has(id))] as const).filter(
      ([, ids]) => ids.length > 0
    )

    expect(Object.fromEntries(unresolved)).toEqual({})
  })

  describe('collection', () => {
    it('reads the ids a title leads with, across .each, .skipIf and a line break', () => {
      const source = [
        "describe('AT-901, AT-902b: a group', () => {",
        "  it.each(['a', 'b'])(\n    'AT-903 one row %s',",
        '  it.skipIf(!uri)(`AT-904: tiered`, () => {})',
        "  it('names AT-905 later, which is not a declaration', () => {})",
        '  // AT-906 in a comment is not a title',
        "  expect(value).toBe('AT-907')",
      ].join('\n')

      expect(titleIds(source)).toEqual(['AT-901', 'AT-902b', 'AT-903', 'AT-904'])
    })

    it('reaches both the unit and the tier suites', () => {
      const files = testFiles()

      expect(files.some((file) => file.startsWith('src/'))).toBe(true)
      expect(files.some((file) => file.startsWith('test/integ/contract/'))).toBe(true)
      expect(files.some((file) => file.startsWith('test/integ/integration/'))).toBe(true)
    })
  })
})

describe('the release gate', () => {
  it('fails on a gate item whose tests failed or skipped where they could run, and names any it could not verify', (context) => {
    if (!existsSync(RESULTS_PATH)) context.skip(`no ${RESULTS_PATH}; run a suite before the gate`)
    const run = JSON.parse(readFileSync(RESULTS_PATH, 'utf8')) as RecordedRun

    const { problems, unverified } = verdict(
      run,
      CHECKLIST.filter((item) => item.gate)
    )

    expect(problems).toEqual([])
    if (unverified.size > 0) {
      const grouped = new Map<string, number[]>()
      for (const [number, reasons] of unverified) {
        const key = reasons.join(' / ')
        grouped.set(key, [...(grouped.get(key) ?? []), number])
      }
      context.skip(
        `release gate unverified in this run: ${[...grouped].map(([reasons, numbers]) => `items ${numbers.join(', ')}: ${reasons}`).join('; ')}`
      )
    }
  })

  describe('verdict', () => {
    const ITEM: Item = {
      number: 1,
      gate: true,
      behaviour: 'the behaviour whose verdict is under test',
      ids: ['AT-999'],
    }
    const ALL_OFF: RecordedRun['enabled'] = { contract: false, integration: false, autoembed: false, build: false }

    const recorded = (
      state: RecordedTest['state'],
      project = 'contract',
      titlePath = ['AT-999: one']
    ): RecordedTest => ({
      project,
      file: 't.test.ts',
      titlePath,
      state,
    })

    it('leaves nothing to report when a carrier passed', () => {
      expect(verdict({ enabled: ALL_OFF, tests: [recorded('passed')] }, [ITEM])).toEqual({
        problems: [],
        unverified: new Map(),
      })
    })

    it('reports a failure even beside a passing carrier', () => {
      const { problems, unverified } = verdict(
        { enabled: ALL_OFF, tests: [recorded('passed'), recorded('failed', 'contract', ['AT-999: two'])] },
        [ITEM]
      )

      expect(problems).toEqual(['item 1 has failing tests: t.test.ts > AT-999: two'])
      expect(unverified).toEqual(new Map())
    })

    it('reads every carrier skipping with its tier variable unset as unverified', () => {
      expect(verdict({ enabled: ALL_OFF, tests: [recorded('skipped')] }, [ITEM])).toEqual({
        problems: [],
        unverified: new Map([[1, ['MONGODB_URI is unset']]]),
      })
    })

    it('fails every carrier skipping with its tier variable set', () => {
      const { problems } = verdict({ enabled: { ...ALL_OFF, contract: true }, tests: [recorded('skipped')] }, [ITEM])

      expect(problems).toEqual(['item 1 skipped every test although its tier was enabled: t.test.ts > AT-999: one'])
    })

    it('fails a skipped carrier in a project no variable gates', () => {
      const { problems } = verdict({ enabled: ALL_OFF, tests: [recorded('skipped', 'unit')] }, [ITEM])

      expect(problems).toHaveLength(1)
    })

    it('reads an item with no carrier in the run as unverified, since the static half owns absence', () => {
      expect(verdict({ enabled: ALL_OFF, tests: [] }, [ITEM]).unverified).toEqual(
        new Map([[1, ['no test for it in this run']]])
      )
    })

    it('blames a test declaring the id over the tests of a describe declaring it too', () => {
      const own = recorded('passed', 'contract', ['group', 'AT-999: own'])
      const inherited = recorded('failed', 'unit', ['AT-999: group', 'other'])

      expect(verdict({ enabled: ALL_OFF, tests: [own, inherited] }, [ITEM]).problems).toEqual([])
    })

    it('falls back to the tests under a describe declaring the id', () => {
      const inherited = recorded('failed', 'unit', ['AT-999: group', 'other'])

      expect(verdict({ enabled: ALL_OFF, tests: [inherited] }, [ITEM]).problems).toEqual([
        'item 1 has failing tests: t.test.ts > AT-999: group > other',
      ])
    })
  })
})
