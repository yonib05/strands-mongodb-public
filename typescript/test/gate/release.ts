// The strict release gate, `npm run test:gate:release`: run it after the contract and integration tiers.
import { CHECKLIST, RELEASE_GATE } from './checklist.js'
import { readResults } from './reporter.js'
import { REAL_DEPLOYMENT_PROJECTS, unproven } from './verdict.js'

const items = CHECKLIST.filter((item) => RELEASE_GATE.has(item.number))
const problems = unproven(readResults(), items)

if (problems.length > 0) {
  console.error(`release gate: ${problems.length} problem(s) in the ${REAL_DEPLOYMENT_PROJECTS.join(' and ')} runs`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`release gate: all ${items.length} items passed against a real deployment`)
