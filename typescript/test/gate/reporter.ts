import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Reporter, TestCase, TestModule, TestState, TestSuite } from 'vitest/node'
import { loadDotEnv, TIER_VARIABLES, tierUri, type Tier } from '../env.js'

export const RESULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.vitest-results.json')

export interface RecordedTest {
  project: string
  file: string
  titlePath: string[]
  state: TestState
  note?: string
}

export interface RecordedRun {
  enabled: Record<Tier, boolean>
  tests: RecordedTest[]
}

function titlePath(test: TestCase): string[] {
  const path = [test.name]
  let parent: TestSuite | TestModule = test.parent
  while (parent.type === 'suite') {
    path.unshift(parent.name)
    parent = parent.parent
  }
  return path
}

function record(test: TestCase): RecordedTest {
  const result = test.result()
  const recorded: RecordedTest = {
    project: test.project.name,
    file: test.module.relativeModuleId,
    titlePath: titlePath(test),
    state: result.state,
  }
  if (result.state === 'skipped' && result.note) recorded.note = result.note
  return recorded
}

export default class GateReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    // A gate-only run reads this file; writing it would replace the run being measured.
    if (modules.every((module) => module.project.name === 'gate')) return
    // Workers fill the tier variables from `.env` in `test/setup.ts`; this process has to do the same.
    loadDotEnv()
    const enabled = Object.fromEntries(
      (Object.keys(TIER_VARIABLES) as Tier[]).map((tier) => [tier, tierUri(tier) !== undefined])
    ) as Record<Tier, boolean>
    const tests = modules.flatMap((module) => [...module.children.allTests()].map(record))
    writeFileSync(RESULTS_PATH, `${JSON.stringify({ enabled, tests } satisfies RecordedRun, null, 2)}\n`)
  }
}
