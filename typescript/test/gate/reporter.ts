import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Reporter, TestCase, TestModule, TestState, TestSuite } from 'vitest/node'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESULTS_DIR = join(PACKAGE_ROOT, '.vitest-results')

/** The projects whose tests run against a real deployment; only these prove a release-gate item. */
export const REAL_DEPLOYMENT_PROJECTS = ['contract', 'integration'] as const

export interface RecordedTest {
  file: string
  /** The enclosing describe titles, outermost first, then the test's own. */
  titles: string[]
  state: TestState
}

/** The last run of one project: the commit it tested, whether the tree differed from it, and every test. */
export interface RecordedRun {
  commit: string
  dirty: boolean
  tests: RecordedTest[]
}

/** The last run of each real-deployment project that has one, by project name. */
export type Results = Partial<Record<(typeof REAL_DEPLOYMENT_PROJECTS)[number], RecordedRun>>

const pathOf = (project: string): string => join(RESULTS_DIR, `${project}.json`)

export function readResults(): Results {
  const recorded = REAL_DEPLOYMENT_PROJECTS.filter((project) => existsSync(pathOf(project)))
  return Object.fromEntries(recorded.map((project) => [project, JSON.parse(readFileSync(pathOf(project), 'utf8'))]))
}

/** The commit checked out, and whether the working tree differs from it. */
export function revision(): { commit: string; dirty: boolean } {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: PACKAGE_ROOT, encoding: 'utf8' }).trim()
  return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '' }
}

function titles(test: TestCase): string[] {
  const path = [test.name]
  let parent: TestSuite | TestModule = test.parent
  while (parent.type === 'suite') {
    path.unshift(parent.name)
    parent = parent.parent
  }
  return path
}

export default class GateReporter implements Reporter {
  // One file per project, and only for the projects the gate reads, so concurrent runs neither merge nor race.
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    for (const project of REAL_DEPLOYMENT_PROJECTS) {
      const ran = modules.filter((module) => module.project.name === project)
      if (ran.length === 0) continue
      const tests = ran.flatMap((module) =>
        [...module.children.allTests()].map((test) => ({
          file: module.relativeModuleId,
          titles: titles(test),
          state: test.result().state,
        }))
      )
      mkdirSync(RESULTS_DIR, { recursive: true })
      writeFileSync(pathOf(project), `${JSON.stringify({ ...revision(), tests } satisfies RecordedRun)}\n`)
    }
  }
}
