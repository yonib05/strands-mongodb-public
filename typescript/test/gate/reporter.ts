import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Reporter, TestCase, TestModule, TestState, TestSuite } from 'vitest/node'

export const RESULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.vitest-results.json')

export interface RecordedTest {
  file: string
  /** The enclosing describe titles, outermost first, then the test's own. */
  titles: string[]
  state: TestState
}

/** Every recorded test of the last run of each project, by project name. */
export type Results = Record<string, RecordedTest[]>

export function readResults(): Results {
  return existsSync(RESULTS_PATH) ? (JSON.parse(readFileSync(RESULTS_PATH, 'utf8')) as Results) : {}
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
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const ran: Results = {}
    for (const module of modules) {
      const tests = (ran[module.project.name] ??= [])
      for (const test of module.children.allTests()) {
        tests.push({ file: module.relativeModuleId, titles: titles(test), state: test.result().state })
      }
    }
    // A project that ran replaces its own entries and keeps the others, so tier runs add up.
    if (Object.keys(ran).length > 0) writeFileSync(RESULTS_PATH, `${JSON.stringify({ ...readResults(), ...ran })}\n`)
  }
}
