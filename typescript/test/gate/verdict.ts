import type { Item } from './checklist.js'
import { REAL_DEPLOYMENT_PROJECTS, type RecordedTest, type Results } from './reporter.js'

const LEADING_IDS = /^(?:AT|CH|MP)-\d{1,3}[a-z]*(?:,\s*(?:AT|CH|MP)-\d{1,3}[a-z]*)*/

/** The ids a title declares: the comma-separated run it starts with. */
export function leadingIds(title: string): string[] {
  return LEADING_IDS.exec(title)?.[0].split(/,\s*/) ?? []
}

const label = (test: RecordedTest) => `${test.file} > ${test.titles.join(' > ')}`

/**
 * Refuses recorded runs that did not test the commit being released.
 *
 * @param results - The recorded runs
 * @param head - The commit checked out now
 * @returns One line per run from another commit or from a modified tree, naming the project to rerun
 */
export function stale(results: Results, head: string): string[] {
  return REAL_DEPLOYMENT_PROJECTS.flatMap((project) => {
    const run = results[project]
    if (run === undefined || (run.commit === head && !run.dirty)) return []
    const tested = `${run.dirty ? 'a modified tree at' : 'commit'} ${run.commit.slice(0, 7)}`
    return [`the ${project} results are from ${tested}, not commit ${head.slice(0, 7)}: rerun npm run test:${project}`]
  })
}

/**
 * Judges the release gate over the recorded real-deployment runs.
 *
 * @param results - The recorded runs
 * @param items - The gate items
 * @returns One line per item that is not proven: a carrier failed, or no carrier of one of its ids passed
 */
export function unproven(results: Results, items: readonly Item[]): string[] {
  const tests = REAL_DEPLOYMENT_PROJECTS.flatMap((project) => results[project]?.tests ?? [])
  return items.flatMap((item) =>
    item.ids.flatMap((id) => {
      const carriers = tests.filter((test) => test.titles.some((title) => leadingIds(title).includes(id)))
      const failed = carriers.filter((test) => test.state !== 'passed' && test.state !== 'skipped')
      if (failed.length > 0) return [`item ${item.number} (${id}) did not pass: ${failed.map(label).join('; ')}`]
      if (carriers.some((test) => test.state === 'passed')) return []
      const why =
        carriers.length === 0
          ? 'no test for it ran'
          : `every test for it was skipped: ${carriers.map(label).join('; ')}`
      return [`item ${item.number} (${id}) is unverified on a real deployment: ${why}`]
    })
  )
}
