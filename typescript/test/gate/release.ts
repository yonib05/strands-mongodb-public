// The strict release gate, `npm run test:gate:release`: run it after the contract and integration tiers.
import { CHECKLIST, RELEASE_GATE } from './checklist.js'
import { readResults, REAL_DEPLOYMENT_PROJECTS, revision } from './reporter.js'
import { failures, stale, unproven } from './verdict.js'

const items = CHECKLIST.filter((item) => RELEASE_GATE.has(item.number))
const results = readResults()
const now = revision()
const problems = [...stale(results, now), ...failures(results), ...unproven(results, items)]

if (problems.length > 0) {
  console.error(`release gate: ${problems.length} problem(s) in the ${REAL_DEPLOYMENT_PROJECTS.join(' and ')} runs`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
const recorded = REAL_DEPLOYMENT_PROJECTS.flatMap((project) => results[project]?.tests ?? []).length
console.log(
  `release gate: the ${items.length} gate items passed against a real deployment at commit ${now.commit.slice(0, 7)}, and none of the ${recorded} tests recorded in the ${REAL_DEPLOYMENT_PROJECTS.join(' and ')} runs failed`
)
