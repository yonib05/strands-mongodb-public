import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect } from 'vitest'
import { PACKAGE_ROOT } from './readme.js'

const TSX = join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

// Any credentialed URI except the exact redaction `support.ts` writes, as in `python/tests/test_examples.py`.
export const CREDENTIALED_URI = /mongodb(\+srv)?:\/\/(?!<redacted>@)[^\s/]*@/

/** One finished example process. */
export interface ExampleRun {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Runs `npx tsx examples/<script> ...arguments` from the package root, as a reader would.
 *
 * @param script - File name inside `examples/`
 * @param args - Step first, then flags
 * @param env - The child's whole environment
 * @returns Exit status and both streams
 */
export function runExample(script: string, args: string[], env: Record<string, string | undefined>): ExampleRun {
  const result = spawnSync(process.execPath, [TSX, join('examples', script), ...args], {
    cwd: PACKAGE_ROOT,
    env,
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Both streams joined, for failure messages and leak checks.
 *
 * @param run - A finished run
 * @returns stdout then stderr
 */
export function streams(run: ExampleRun): string {
  return `${run.stdout}\n${run.stderr}`
}

/**
 * Asserts neither stream carries a credentialed URI, or the password from `uri` on its own.
 *
 * @param run - A finished run
 * @param uri - The URI the run was given, if any
 */
export function expectNoCredentials(run: ExampleRun, uri?: string): void {
  const output = streams(run)
  expect(output).not.toMatch(CREDENTIALED_URI)
  const password = uri ? /:\/\/[^:@/]+:([^@]+)@/.exec(uri)?.[1] : undefined
  if (password) expect(output).not.toContain(password)
}

/**
 * Parses the `--summary-json` line, which is the last line of stdout.
 *
 * @param run - A run made with `--summary-json`
 * @returns The decoded object
 */
export function summaryOf(run: ExampleRun): Record<string, unknown> {
  const last = run.stdout.trim().split('\n').at(-1) ?? ''
  return JSON.parse(last) as Record<string, unknown>
}

/**
 * The distinct lowercase words in `text`.
 *
 * @param text - Any prose
 * @returns Word set
 */
export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  )
}
