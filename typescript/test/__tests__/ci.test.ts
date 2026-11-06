import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REPO_ROOT } from '../readme.js'

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
  'working-directory'?: string
}

interface Job {
  name: string
  if?: string
  'runs-on': string
  'timeout-minutes'?: unknown
  needs?: string | string[]
  environment?: string | { name: string }
  permissions?: Record<string, string>
  services?: Record<string, { image: string; options?: string }>
  strategy?: { matrix: Record<string, unknown> }
  env?: Record<string, string>
  steps: Step[]
}

interface Workflow {
  on: Record<string, Record<string, unknown> | null>
  permissions: Record<string, string>
  concurrency?: Record<string, string>
  jobs: Record<string, Job>
}

const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows')
const CI_PATH = join(WORKFLOWS, 'ci-typescript.yml')
const RELEASE_PATH = join(WORKFLOWS, 'release-typescript.yml')

const load = <T>(path: string): T => parse(readFileSync(path, 'utf8')) as T
const ci = () => load<Workflow>(CI_PATH)
const release = () => load<Workflow>(RELEASE_PATH)
const jobs = (workflow: Workflow) => Object.values(workflow.jobs)
const job = (workflow: Workflow, name: string) => jobs(workflow).find((candidate) => candidate.name === name)!
const runs = (target: Job) => target.steps.map((step) => step.run ?? '')
const stepIndex = (target: Job, fragment: string) => runs(target).findIndex((run) => run.includes(fragment))

const CRON_OR_DISPATCH = "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"
const CONTRACT_JOB = 'Contract tier (${{ matrix.deployment.label }})'
const MONGO_HEALTH = "mongosh --quiet --eval 'db.adminCommand({ping:1})'"
const ATLAS_LOCAL_HEALTH = '/usr/local/bin/runner healthcheck'
const TIMEOUT_CEILING_MINUTES = 75

const CI_JOBS = [
  'Lint',
  'Test - Node ${{ matrix.node-version }}',
  'Dependency floors',
  CONTRACT_JOB,
  'Latest SDK compatibility',
  'Atlas tiers',
]

// Everything outside `typescript/` that a test in this package reads or runs.
const WATCHED_PATHS = [
  'typescript/**',
  '.github/workflows/ci-typescript.yml',
  '.github/workflows/release-typescript.yml',
  '.github/dependabot.yml',
  'python/src/strands_mongodb/**',
  'python/pyproject.toml',
  '**.md',
]

// A job name with its variable part cut off, as `python/tests/test_conventions.py` compares them.
const canonical = (name: string) => name.split(/\$\{\{|</)[0]!.trim()

function contributingJobTable(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8')
  const after = text.slice(text.indexOf('`.github/workflows/ci-typescript.yml`'))
  const table = after.slice(after.indexOf('\n|'))
  const rows = table.split('\n').slice(1)
  const end = rows.findIndex((line) => !line.startsWith('|'))
  return rows
    .slice(0, end)
    .map((line) => /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1])
    .filter((cell): cell is string => cell !== undefined)
}

function admitsPullRequest(target: Job): boolean {
  return target.if !== CRON_OR_DISPATCH
}

function referencesSecret(value: unknown): boolean {
  return JSON.stringify(value).includes('secrets.')
}

describe('ci-typescript.yml', () => {
  it('defines exactly the jobs CONTRIBUTING.md documents', () => {
    expect(jobs(ci()).map((candidate) => candidate.name)).toEqual(CI_JOBS)
    expect(new Set(contributingJobTable().map(canonical))).toEqual(new Set(CI_JOBS.map(canonical)))
  })

  it('runs on a change to every file the suite reads, and on the weekly cron and on demand', () => {
    const { on } = ci()

    expect(on.pull_request!.paths).toEqual(WATCHED_PATHS)
    expect(on.push!.paths).toEqual(WATCHED_PATHS)
    expect(on.push!.branches).toEqual(['main'])
    expect(on.schedule).toEqual([{ cron: '0 6 * * 1' }])
    expect(Object.keys(on)).toContain('workflow_dispatch')
  })

  it('grants read access only and cancels a superseded run only on a pull request', () => {
    const workflow = ci()

    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(jobs(workflow).filter((candidate) => candidate.permissions !== undefined)).toEqual([])
    expect(workflow.concurrency!['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}")
  })

  it('keeps the cluster jobs to the cron and dispatch, and every other job off the cron', () => {
    const scheduled = jobs(ci()).filter((candidate) => !admitsPullRequest(candidate))

    expect(scheduled.map((candidate) => candidate.name)).toEqual(['Latest SDK compatibility', 'Atlas tiers'])
    for (const candidate of jobs(ci()).filter(admitsPullRequest)) {
      expect(candidate.if, candidate.name).toBe("github.event_name != 'schedule'")
    }
  })

  it('hands no secret to a job a pull request runs', () => {
    expect(
      jobs(ci())
        .filter(admitsPullRequest)
        .filter(referencesSecret)
        .map((candidate) => candidate.name)
    ).toEqual([])
  })

  it('reads every secret under env, never on a command line', () => {
    const atlas = job(ci(), 'Atlas tiers')

    expect(atlas.steps.filter((step) => (step.run ?? '').includes('secrets.'))).toEqual([])
    expect(atlas.steps.filter(referencesSecret).map((step) => step.name)).toEqual([
      'Create the cluster',
      'Delete the cluster',
    ])
  })

  it('lints, type-checks and builds in Lint', () => {
    const lint = job(ci(), 'Lint')

    for (const script of ['npm run format:check', 'npm run lint', 'npm run type-check', 'npm run build']) {
      expect(stepIndex(lint, script), script).toBeGreaterThan(-1)
    }
  })

  it('runs the unit tier with both coverage floors on Node 22 and 24, then the gate over it', () => {
    const test = job(ci(), 'Test - Node ${{ matrix.node-version }}')

    expect(test.strategy!.matrix['node-version']).toEqual(['22', '24'])
    expect(stepIndex(test, 'npm run test:coverage')).toBeGreaterThan(-1)
    expect(stepIndex(test, 'npm run test:gate')).toBeGreaterThan(stepIndex(test, 'npm run test:coverage'))
  })

  it('installs the declared floors before it tests and type-checks against them', () => {
    const floors = job(ci(), 'Dependency floors')
    const install = stepIndex(floors, 'node scripts/pin-floors.mjs --install')

    expect(install).toBeGreaterThan(-1)
    expect(stepIndex(floors, 'npm ls')).toBeGreaterThan(install)
    expect(stepIndex(floors, 'npm test')).toBeGreaterThan(install)
    expect(stepIndex(floors, 'npm run type-check')).toBeGreaterThan(install)
  })

  describe('the contract job', () => {
    const contract = () => job(ci(), CONTRACT_JOB)

    it('runs over exactly the two deployments Python uses, each with its own health command', () => {
      const deployments = contract().strategy!.matrix.deployment as Record<string, string>[]

      expect(
        deployments.map(({ image, health, uri, expect_search }) => ({ image, health, uri, expect_search }))
      ).toEqual([
        { image: 'mongo:8', health: MONGO_HEALTH, uri: 'mongodb://localhost:27017', expect_search: '' },
        {
          image: 'mongodb/mongodb-atlas-local:8',
          health: ATLAS_LOCAL_HEALTH,
          uri: 'mongodb://localhost:27017/?directConnection=true',
          expect_search: '1',
        },
      ])
    })

    it('takes its service and its connection string from the matrix', () => {
      const { services, env } = contract()

      expect(services!.mongodb!.image).toBe('${{ matrix.deployment.image }}')
      expect(services!.mongodb!.options).toContain('--health-cmd "${{ matrix.deployment.health }}"')
      expect(env).toEqual({
        MONGODB_URI: '${{ matrix.deployment.uri }}',
        STRANDS_MONGODB_EXPECT_SEARCH: '${{ matrix.deployment.expect_search }}',
      })
    })

    it('runs the integration tier on the leg with a search process only', () => {
      const integration = contract().steps[stepIndex(contract(), 'npm run test:integration')]!

      expect(integration.if).toBe("matrix.deployment.expect_search == '1'")
      expect(integration.env).toEqual({ MONGODB_ATLAS_URI: '${{ matrix.deployment.uri }}' })
    })

    it('runs the interop tier on the leg with a search process only, after building and linting with hatch', () => {
      const steps = contract().steps
      const interop = stepIndex(contract(), 'npm run test:interop')
      const python = steps.findIndex((step) => step.uses?.startsWith('actions/setup-python@'))
      const hatch = stepIndex(contract(), 'pip install hatch')
      const env = stepIndex(contract(), 'hatch env create')
      const lint = stepIndex(contract(), 'hatch run ruff check ../typescript/scripts/interop/*.py')

      expect(python).toBeGreaterThan(-1)
      const order = [python, hatch, env, lint, interop]
      expect(order).toEqual([...order].sort((a, b) => a - b))
      expect(steps[env]!['working-directory']).toBe('python')
      expect(steps[lint]!['working-directory']).toBe('python')
      for (const index of [python, hatch, env, lint, interop]) {
        expect(steps[index]!.if).toBe("matrix.deployment.expect_search == '1'")
      }
      expect(steps[interop]!.env).toEqual({ MONGODB_ATLAS_URI: '${{ matrix.deployment.uri }}' })
    })

    it('runs the gate after each tier, before the next one replaces the results it reads', () => {
      const steps = runs(contract())
      const tiers = steps.flatMap((run, index) =>
        /npm run test:(contract|integration|interop)\b/.test(run) ? [index] : []
      )
      const gates = steps.flatMap((run, index) => (run.includes('npm run test:gate') ? [index] : []))

      expect(tiers).toHaveLength(3)
      tiers.forEach((tier, position) => {
        const next = tiers[position + 1] ?? steps.length
        expect(
          gates.some((gate) => gate > tier && gate < next),
          `gate after step ${tier}`
        ).toBe(true)
      })
      expect(contract().steps[gates.at(-1)!]!.if).toBe(contract().steps[tiers.at(-1)!]!.if)
    })

    it('asserts the working tree is clean as its last step', () => {
      expect(runs(contract()).at(-1)).toContain('git status --porcelain')
    })
  })

  it('runs the canary against the newest SDK, type-checking and testing after the upgrade', () => {
    const compat = job(ci(), 'Latest SDK compatibility')
    const upgrade = stepIndex(compat, 'npm install @strands-agents/sdk@latest --no-save')

    expect(upgrade).toBeGreaterThan(-1)
    for (const script of ['npm run type-check', 'npm run test:compat', 'npm run test:contract']) {
      expect(stepIndex(compat, script), script).toBeGreaterThan(upgrade)
    }
    expect(compat.services!.mongodb!.image).toBe('mongodb/mongodb-atlas-local:8')
    expect(compat.services!.mongodb!.options).toContain(`--health-cmd "${ATLAS_LOCAL_HEALTH}"`)
    expect(compat.env!.MONGODB_URI).toBe('mongodb://localhost:27017/?directConnection=true')
  })

  it('creates a cluster for the Atlas tiers and always deletes it', () => {
    const atlas = job(ci(), 'Atlas tiers')
    const up = stepIndex(atlas, 'scripts/atlas_ci_cluster.py up')
    const down = stepIndex(atlas, 'scripts/atlas_ci_cluster.py down')

    expect(up).toBeGreaterThan(-1)
    expect(stepIndex(atlas, 'npm run test:integration')).toBeGreaterThan(up)
    expect(stepIndex(atlas, 'npm run test:autoembed')).toBeGreaterThan(up)
    expect(down).toBe(atlas.steps.length - 1)
    expect(atlas.steps[down]!.if).toBe('always()')
    expect(atlas.env!.ATLAS_CI_CLUSTER).toBeDefined()
    for (const step of [atlas.steps[up]!, atlas.steps[down]!]) {
      expect(Object.keys(step.env!).sort()).toEqual([
        'MONGODB_ATLAS_CLIENT_ID',
        'MONGODB_ATLAS_CLIENT_SECRET',
        'MONGODB_ATLAS_PROJECT_ID',
      ])
    }
  })
})

describe('ci-typescript.yml and release-typescript.yml', () => {
  const both = () => [...jobs(ci()), ...jobs(release())]

  it('give every job a budget under the ceiling instead of the six-hour default', () => {
    for (const candidate of both()) {
      const budget = candidate['timeout-minutes']
      expect(Number.isInteger(budget), candidate.name).toBe(true)
      expect(budget as number, candidate.name).toBeGreaterThan(0)
      expect(budget as number, candidate.name).toBeLessThanOrEqual(TIMEOUT_CEILING_MINUTES)
    }
  })

  it('leave no checkout token behind', () => {
    const checkouts = both().flatMap((candidate) =>
      candidate.steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
    )

    expect(checkouts.length).toBeGreaterThanOrEqual(8)
    expect(checkouts.filter((step) => step.with?.['persist-credentials'] !== false)).toEqual([])
  })

  it('run every MongoDB container on ubuntu-22.04, whose kernel MongoDB 8 accepts', () => {
    const withServices = both().filter((candidate) => candidate.services !== undefined)

    expect(withServices.length).toBeGreaterThan(0)
    expect(withServices.filter((candidate) => candidate['runs-on'] !== 'ubuntu-22.04')).toEqual([])
  })
})

describe('release-typescript.yml', () => {
  it('exists', () => {
    expect(existsSync(RELEASE_PATH)).toBe(true)
  })

  it('runs on a typescript-v tag push and nothing else', () => {
    expect(release().on).toEqual({ push: { tags: ['typescript-v*'] } })
  })

  it('grants read access only, and raises no permission on any job', () => {
    expect(release().permissions).toEqual({ contents: 'read' })
    expect(jobs(release()).filter((candidate) => candidate.permissions !== undefined)).toEqual([])
  })

  it('pins every action to a digest with the version beside it', () => {
    const uses = readFileSync(RELEASE_PATH, 'utf8')
      .split('\n')
      .filter((line) => /^\s*(-\s+)?uses:/.test(line))

    expect(uses.length).toBeGreaterThan(0)
    expect(uses.filter((line) => !/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} {2}# v\d+\.\d+\.\d+$/.test(line))).toEqual([])
  })

  it('runs the contract tier against a mongo:8 container, then the gate over it, with no secret', () => {
    const contract = release().jobs.contract!

    expect(contract.name).toBe('Contract tier')
    expect(contract.services!.mongodb!.image).toBe('mongo:8')
    expect(contract.services!.mongodb!.options).toContain(`--health-cmd "${MONGO_HEALTH}"`)
    expect(contract.env).toEqual({ MONGODB_URI: 'mongodb://localhost:27017' })
    expect(stepIndex(contract, 'npm ci')).toBeGreaterThan(-1)
    expect(stepIndex(contract, 'npm run test:gate')).toBeGreaterThan(stepIndex(contract, 'npm run test:contract'))
    expect(runs(contract).at(-1)).toContain('git status --porcelain')
    expect(referencesSecret(contract)).toBe(false)
  })

  it('gates, versions from the tag, checks the version, then packs', () => {
    const [gate, build] = [job(release(), 'Release gate'), job(release(), 'Build and verify the artifact')]
    const version = stepIndex(build, 'npm version --no-git-tag-version "${GITHUB_REF_NAME#typescript-v}"')

    expect(stepIndex(gate, 'npm ci')).toBeGreaterThan(-1)
    expect(stepIndex(gate, 'npm run check')).toBeGreaterThan(stepIndex(gate, 'npm ci'))
    expect(build.needs).toEqual(['gate', 'contract'])
    expect(version).toBeGreaterThan(-1)
    expect(stepIndex(build, 'npm pack --dry-run --json')).toBeGreaterThan(version)
    expect(stepIndex(build, 'npm run test:build')).toBeGreaterThan(version)
    expect(stepIndex(build, 'npm pack --pack-destination')).toBeGreaterThan(stepIndex(build, 'npm pack --dry-run'))
  })

  it('publishes the artifact the build job uploaded, only from the npm environment, without provenance', () => {
    const workflow = release()
    const publishers = jobs(workflow).filter((candidate) => runs(candidate).some((run) => run.includes('npm publish')))
    const [publish] = publishers
    const upload = jobs(workflow)
      .flatMap((candidate) => candidate.steps)
      .find((step) => step.uses?.startsWith('actions/upload-artifact@'))!
    const download = publish!.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))!

    expect(publishers).toHaveLength(1)
    expect(publish!.environment).toEqual({ name: 'npm', url: 'https://www.npmjs.com/package/strands-mongodb' })
    expect(publish!.needs).toEqual(['build'])
    expect(download.with!.name).toBe(upload.with!.name)
    expect(upload.with!['if-no-files-found']).toBe('error')
    expect(jobs(workflow).filter(referencesSecret)).toEqual([publish])
    expect(publish!.steps.filter((step) => (step.run ?? '').includes('secrets.'))).toEqual([])
    expect(
      jobs(workflow)
        .flatMap(runs)
        .filter((run) => run.includes('--provenance'))
    ).toEqual([])
  })
  it('is the procedure RELEASING.md describes, job by job', () => {
    const releasing = readFileSync(join(REPO_ROOT, 'typescript', 'RELEASING.md'), 'utf8')

    for (const name of [...jobs(release()).map((candidate) => candidate.name), 'typescript-v', 'NPM_TOKEN']) {
      expect(releasing, name).toContain(`\`${name}\``)
    }
    expect(releasing).toContain('`npm` environment')
  })
})

describe('dependabot.yml', () => {
  it('proposes development dependency updates for /typescript and never a new peer floor', () => {
    const { updates } = load<{ updates: Record<string, unknown>[] }>(join(REPO_ROOT, '.github', 'dependabot.yml'))
    const npm = updates.filter((entry) => entry['package-ecosystem'] === 'npm')

    expect(npm.map((entry) => entry.directory)).toEqual(['/typescript'])
    expect(npm[0]!.allow).toEqual([{ 'dependency-type': 'development' }])
  })
})
