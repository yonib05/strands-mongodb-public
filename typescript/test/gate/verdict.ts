import type { Item } from './checklist.js'
import { REAL_DEPLOYMENT_PROJECTS, type RecordedTest, type Results, type Revision } from './reporter.js'

const LEADING_IDS = /^(?:AT|CH|MP)-\d{1,3}[a-z]*(?:,\s*(?:AT|CH|MP)-\d{1,3}[a-z]*)*/

/** The ids a title declares: the comma-separated run it starts with. */
export function leadingIds(title: string): string[] {
  return LEADING_IDS.exec(title)?.[0].split(/,\s*/) ?? []
}

const label = (test: RecordedTest) => `${test.file} > ${test.titles.join(' > ')}`

/**
 * Refuses a working tree, or recorded runs, that are not the commit being released.
 *
 * @param results - The recorded runs
 * @param now - The commit checked out, and whether the working tree differs from it
 * @returns One line for a modified tree, and one per run from another commit or from a modified tree, each naming
 * what to do
 */
export function stale(results: Results, now: Revision): string[] {
  const head = now.commit.slice(0, 7)
  const tree = now.dirty
    ? [`the working tree differs from commit ${head}: commit the changes, then rerun both tiers and this gate`]
    : []
  const runs = REAL_DEPLOYMENT_PROJECTS.flatMap((project) => {
    const run = results[project]
    if (run === undefined || (run.commit === now.commit && !run.dirty)) return []
    const tested = `${run.dirty ? 'a modified tree at' : 'commit'} ${run.commit.slice(0, 7)}`
    const fix = `${run.dirty ? 'commit the changes, then ' : ''}rerun npm run test:${project}`
    return [`the ${project} results are from ${tested}, not commit ${head}: ${fix}`]
  })
  return [...tree, ...runs]
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
