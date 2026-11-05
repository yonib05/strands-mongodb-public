// Fails when any single file is under the per-file line floor. Reads the summary `vitest --coverage` writes.
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

const FLOOR = 70
const REPORT = 'coverage/coverage-summary.json'

const { total: _total, ...files } = JSON.parse(readFileSync(REPORT, 'utf8'))
if (Object.keys(files).length === 0) {
  console.error(`error: ${REPORT} measured no files at all.`)
  process.exit(1)
}

const failures = Object.entries(files)
  .filter(([, summary]) => summary.lines.total > 0 && summary.lines.pct < FLOOR)
  .map(([path, summary]) => `${relative(process.cwd(), path)}: ${summary.lines.pct}% of lines`)

if (failures.length > 0) {
  console.error(`Files under the ${FLOOR}% per-file line floor:`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`Every file meets the ${FLOOR}% per-file line floor.`)
