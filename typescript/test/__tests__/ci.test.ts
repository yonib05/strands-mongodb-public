import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REPO_ROOT } from '../readme.js'

interface Job {
  name: string
  if?: string
  needs?: string[]
  environment?: { name: string }
  permissions?: unknown
  steps: { uses?: string; run?: string; with?: Record<string, unknown> }[]
}

interface Workflow {
  on: unknown
  permissions: unknown
  jobs: Record<string, Job>
}

const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows')
const RELEASE_PATH = join(WORKFLOWS, 'release-typescript.yml')
const ci = parse(readFileSync(join(WORKFLOWS, 'ci-typescript.yml'), 'utf8')) as Workflow
const release = parse(readFileSync(RELEASE_PATH, 'utf8')) as Workflow

const jobs = (workflow: Workflow) => Object.values(workflow.jobs)
const runs = (job: Job) => job.steps.map((step) => step.run ?? '')
const referencesSecret = (job: Job) => JSON.stringify(job).includes('secrets.')
const stepIndex = (job: Job, script: string) => runs(job).findIndex((run) => run.includes(script))

// A job name with its variable part cut off, as `python/tests/test_conventions.py` compares them.
const canonical = (name: string) => name.split(/\$\{\{|</)[0]!.trim()

function contributingJobTable(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8')
  const after = text.slice(text.indexOf('`.github/workflows/ci-typescript.yml`'))
  const rows = after.slice(after.indexOf('\n|')).split('\n').slice(1)
  return rows
    .slice(
      0,
      rows.findIndex((line) => !line.startsWith('|'))
    )
    .flatMap((line) => /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1] ?? [])
}

describe.each([
  ['ci-typescript.yml', ci],
  ['release-typescript.yml', release],
])('%s', (_name, workflow) => {
  it('grants read access only, and raises no permission on any job', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(jobs(workflow).filter((job) => job.permissions !== undefined)).toEqual([])
  })

  it('runs the strict release gate after the contract and integration tiers', () => {
    const gated = jobs(workflow).filter((job) => stepIndex(job, 'npm run test:gate:release') !== -1)

    expect(gated).toHaveLength(1)
    const gate = stepIndex(gated[0]!, 'npm run test:gate:release')
    for (const tier of ['npm run test:contract', 'npm run test:integration']) {
      expect(stepIndex(gated[0]!, tier), tier).toBeGreaterThan(-1)
      expect(stepIndex(gated[0]!, tier), tier).toBeLessThan(gate)
    }
  })
})

describe('ci-typescript.yml', () => {
  it('hands no secret to a job a pull request runs', () => {
    const scheduledOnly = "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"

    expect(
      jobs(ci)
        .filter((job) => job.if !== scheduledOnly && referencesSecret(job))
        .map((job) => job.name)
    ).toEqual([])
  })

  it('defines exactly the jobs CONTRIBUTING.md documents', () => {
    expect(new Set(contributingJobTable().map(canonical))).toEqual(new Set(jobs(ci).map((job) => canonical(job.name))))
  })
})

describe('release-typescript.yml', () => {
  it('runs on a typescript-v tag push and nothing else', () => {
    expect(release.on).toEqual({ push: { tags: ['typescript-v*'] } })
  })

  it('pins every action to a digest', () => {
    const uses = jobs(release).flatMap((job) => job.steps.flatMap((step) => step.uses ?? []))

    expect(uses.length).toBeGreaterThan(0)
    expect(uses.filter((action) => !/@[0-9a-f]{40}$/.test(action))).toEqual([])
  })

  it('refuses a tag whose commit is not on main, before any other job can publish it', () => {
    const [first] = jobs(release)
    const upstream = (job: Job): string[] => (job.needs ?? []).flatMap((id) => [id, ...upstream(release.jobs[id]!)])

    expect(stepIndex(first!, 'git merge-base --is-ancestor "$GITHUB_SHA" origin/main')).not.toBe(-1)
    expect(first!.steps[0]).toMatchObject({ with: { 'fetch-depth': 0 } })
    expect(upstream(release.jobs.publish!)).toContain(Object.keys(release.jobs)[0])
  })

  it('publishes only from the npm environment, after the gated tiers, without provenance', () => {
    const publishers = Object.entries(release.jobs).filter(([, job]) =>
      runs(job).some((run) => /npm publish/.test(run))
    )
    const upstream = (id: string): string[] =>
      (release.jobs[id]!.needs ?? []).flatMap((need) => [need, ...upstream(need)])

    expect(publishers).toHaveLength(1)
    const [id, publish] = publishers[0]!
    expect(publish.environment?.name).toBe('npm')
    expect(jobs(release).filter(referencesSecret)).toEqual([publish])
    expect(upstream(id).some((need) => stepIndex(release.jobs[need]!, 'npm run test:gate:release') !== -1)).toBe(true)
    expect(readFileSync(RELEASE_PATH, 'utf8')).not.toMatch(/^[^#\n]*--provenance/m)
  })
})
