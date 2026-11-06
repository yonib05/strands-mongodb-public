import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { PACKAGE_ROOT, REPO_ROOT } from '../../readme.js'

const SCRIPTS = join(PACKAGE_ROOT, 'scripts', 'interop')

const hatchOnPath = spawnSync('hatch', ['--version'], { stdio: 'ignore' }).error === undefined

/**
 * Names whatever the interop tier needs beyond `MONGODB_URI` that this machine lacks.
 *
 * @param variables - Further variables the suite needs set
 * @returns A skip reason, or `undefined` when nothing is missing
 */
export function interopUnmet(...variables: string[]): string | undefined {
  const missing = [
    ...variables.filter((name) => !process.env[name]).map((name) => `${name} is unset`),
    ...(hatchOnPath ? [] : ['hatch is not on PATH']),
  ]
  return missing.length === 0 ? undefined : missing.join('; ')
}

/**
 * Runs `hatch run python scripts/interop/<script>` from `python/`, the payload as JSON on stdin.
 *
 * @param script - File name inside `scripts/interop/`
 * @param options - Passed as `--<name> <value>`; `uri`, `database` and `collection` are required by every script
 * @param payload - Written to stdin as JSON
 * @returns The one JSON object the script printed
 */
export function runPython<T = Record<string, unknown>>(
  script: string,
  options: Record<string, string>,
  payload: unknown = {}
): Promise<T> {
  const args = Object.entries(options).flatMap(([name, value]) => [`--${name}`, value])
  return new Promise((resolve, reject) => {
    const child = spawn('hatch', ['run', 'python', join(SCRIPTS, script), ...args], { cwd: join(REPO_ROOT, 'python') })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', reject)
    // The arguments carry the URI, so the message names only the script.
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${script} exited with ${code}\nstderr:\n${stderr}`))
      try {
        resolve(JSON.parse(stdout) as T)
      } catch {
        reject(new Error(`${script} printed no single JSON object\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}
