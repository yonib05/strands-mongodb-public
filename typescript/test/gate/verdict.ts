import type { Item } from './checklist.js'
import type { RecordedTest, Results } from './reporter.js'

/** The projects whose tests run against a real deployment; only these prove a release-gate item. */
export const REAL_DEPLOYMENT_PROJECTS = ['contract', 'integration'] as const

const LEADING_IDS = /^(?:AT|CH|MP)-\d{1,3}[a-z]*(?:,\s*(?:AT|CH|MP)-\d{1,3}[a-z]*)*/

/** The ids a title declares: the comma-separated run it starts with. */
export function leadingIds(title: string): string[] {
  return LEADING_IDS.exec(title)?.[0].split(/,\s*/) ?? []
}

const label = (test: RecordedTest) => `${test.file} > ${test.titles.join(' > ')}`

/**
 * Judges the release gate over the recorded real-deployment runs.
 *
 * @param results - The merged results file
 * @param items - The gate items
 * @returns One line per item that is not proven: a carrier failed, or no carrier of one of its ids passed
 */
export function unproven(results: Results, items: readonly Item[]): string[] {
  const tests = REAL_DEPLOYMENT_PROJECTS.flatMap((project) => results[project] ?? [])
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
