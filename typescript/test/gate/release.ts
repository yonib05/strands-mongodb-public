// The strict release gate, `npm run test:gate:release`: run it after the contract and integration tiers.
import { CHECKLIST, RELEASE_GATE } from './checklist.js'
import { readResults, REAL_DEPLOYMENT_PROJECTS, revision } from './reporter.js'
import { stale, unproven } from './verdict.js'

const items = CHECKLIST.filter((item) => RELEASE_GATE.has(item.number))
const results = readResults()
const problems = [...stale(results, revision()), ...unproven(results, items)]

if (problems.length > 0) {
  console.error(`release gate: ${problems.length} problem(s) in the ${REAL_DEPLOYMENT_PROJECTS.join(' and ')} runs`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`release gate: all ${items.length} items passed against a real deployment`)
