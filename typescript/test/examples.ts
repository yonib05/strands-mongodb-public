import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { expect } from 'vitest'
import { PACKAGE_ROOT } from './readme.js'

const TSX = join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

// Any credentialed URI except the exact redaction `support.ts` writes, up to the last `@`, so `/` in a password counts.
export const CREDENTIALED_URI = /mongodb(\+srv)?:\/\/(?!<redacted>@)\S*@/

/** One finished example process. */
export interface ExampleRun {
  status: number | null
  stdout: string
  stderr: string
}

/** Runs `npx tsx examples/<script> ...args` from the package root with `env` as the child's whole environment. */
export function runExample(
  script: string,
  args: string[],
  env: Record<string, string | undefined>
): Promise<ExampleRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [TSX, join('examples', script), ...args],
      { cwd: PACKAGE_ROOT, env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const status = error === null ? 0 : typeof error.code === 'number' ? error.code : null
        resolve({ status, stdout, stderr })
      }
    )
  })
}

/** Both streams joined, for failure messages and leak checks. */
export function streams(run: ExampleRun): string {
  return `${run.stdout}\n${run.stderr}`
}

/** Asserts neither stream carries a credentialed URI, or the password from `uri` on its own. */
export function expectNoCredentials(run: ExampleRun, uri?: string): void {
  const output = streams(run)
  expect(output).not.toMatch(CREDENTIALED_URI)
  const password = uri ? /:\/\/[^:@/]+:(.+)@/.exec(uri)?.[1] : undefined
  if (password) expect(output).not.toContain(password)
}

/** Parses the `--summary-json` line, which is the last line of stdout. */
export function summaryOf(run: ExampleRun): Record<string, unknown> {
  const last = run.stdout.trim().split('\n').at(-1) ?? ''
  return JSON.parse(last) as Record<string, unknown>
}

/** The distinct lowercase words in `text`. */
export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  )
}
