import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = join(PACKAGE_ROOT, '..')
export const PACKAGE_README = join(PACKAGE_ROOT, 'README.md')
export const ROOT_README = join(REPO_ROOT, 'README.md')

/** Languages a reader can paste into something that runs them. `text` and an unlabelled fence are not. */
export const EXECUTABLE_LANGUAGES: ReadonlySet<string> = new Set([
  'ts',
  'typescript',
  'js',
  'javascript',
  'bash',
  'sh',
  'shell',
])

/** The tiers a `<!-- run: <tier> -->` directive may name. */
export const RUN_TIERS = ['unit', 'contract', 'integration', 'autoembed', 'mongosh'] as const

export type RunTier = (typeof RUN_TIERS)[number]

/** One fenced code block, with the directive on the line above it. */
export interface Block {
  path: string
  line: number
  language: string
  kind: '' | 'run' | 'skip'
  value: string
  body: string
}

const DIRECTIVE = /^<!--\s*(run|skip):\s*(.+?)\s*-->$/
const FENCE = /^```([A-Za-z0-9_+-]*)\s*$/
const RUN_COMMAND = /^db\.runCommand\((.+)\)$/

/**
 * Parses every fenced block out of a Markdown file. A directive governs only the fence directly below it.
 *
 * @param path - The Markdown file
 * @returns The blocks in document order
 */
export function blocks(path: string): Block[] {
  const found: Block[] = []
  let directive: [Block['kind'], string] = ['', '']
  let language: string | undefined
  let openedAt = 0
  let body: string[] = []
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const fence = FENCE.exec(line)
      if (language === undefined) {
        if (fence) {
          language = fence[1]!.toLowerCase()
          openedAt = index + 1
          return
        }
        const match = DIRECTIVE.exec(line.trim())
        directive = match ? [match[1] as 'run' | 'skip', match[2]!] : ['', '']
        return
      }
      if (fence && fence[1] === '') {
        found.push({
          path,
          line: openedAt,
          language,
          kind: directive[0],
          value: directive[1],
          body: `${body.join('\n')}\n`,
        })
        directive = ['', '']
        language = undefined
        body = []
        return
      }
      body.push(line)
    })
  if (language !== undefined) throw new Error(`${path} has an unclosed fence opened at line ${openedAt}`)
  return found
}

/**
 * Names a block's location for a failure message.
 *
 * @param block - The block
 * @returns `<path relative to the repository>:<line>`
 */
export function where(block: Block): string {
  return `${relative(REPO_ROOT, block.path)}:${block.line}`
}

/**
 * Picks the blocks one tier runs.
 *
 * @param tier - The tier named in the directive
 * @param all - The blocks to pick from
 * @returns The blocks, in document order
 */
export function selected(tier: RunTier, all: readonly Block[]): Block[] {
  return all.filter((block) => block.kind === 'run' && block.value === tier)
}

/**
 * Reads the `db.runCommand(...)` lines out of the `mongosh` blocks, blank lines and comments dropped.
 *
 * @param all - The blocks to read
 * @returns The lines, in document order
 */
export function runCommandLines(all: readonly Block[]): string[] {
  return selected('mongosh', all)
    .flatMap((block) => block.body.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
}

/**
 * Parses the argument of one documented `db.runCommand(...)` line.
 *
 * @param line - The line
 * @returns The command document
 */
export function runCommandArgument(line: string): Record<string, unknown> {
  const match = RUN_COMMAND.exec(line)
  if (!match) throw new Error(`not a runCommand line: ${line}`)
  return JSON.parse(match[1]!) as Record<string, unknown>
}

/** The environment a `unit` snippet runs in: every tier variable emptied, so nothing is reachable. */
export function unconfigured(): Record<string, string | undefined> {
  return { ...process.env, MONGODB_URI: '', MONGODB_ATLAS_URI: '', MONGODB_AUTOEMBED_URI: '' }
}

/** Snippets written to disk beside a tsconfig that resolves `strands-mongodb` to `src/`. */
export interface Snippets {
  /** Type-checks every snippet in one `tsc` run; throws with the diagnostics on a failure. */
  typeCheck(): void
  /** Executes one snippet under `tsx`; throws with its stderr on a non-zero exit. */
  run(block: Block, env: Record<string, string | undefined>): string
  /** Removes the directory. */
  dispose(): void
}

const TSC = join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const TSX = join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/**
 * Writes the snippets into a directory under the package root, where `mongodb` and the SDK resolve.
 *
 * @param all - The blocks to write, as the README carries them
 * @returns The handle that type-checks, runs and removes them
 */
export function prepare(all: readonly Block[]): Snippets {
  const dir = mkdtempSync(join(PACKAGE_ROOT, '.readme-snippets-'))
  const tsconfig = join(dir, 'tsconfig.json')
  writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        extends: '../tsconfig.json',
        compilerOptions: {
          noEmit: true,
          paths: {
            'strands-mongodb': ['../src/index.ts'],
            'strands-mongodb/storage': ['../src/storage/index.ts'],
            'strands-mongodb/memory': ['../src/memory/index.ts'],
          },
        },
        include: ['*.ts'],
      },
      null,
      2
    )
  )
  const files = new Map<Block, string>()
  for (const block of all) {
    const file = join(dir, `snippet-${block.line}.ts`)
    writeFileSync(file, block.body)
    files.set(block, file)
  }

  function execute(args: string[], env: Record<string, string | undefined>): string {
    const result = spawnSync(process.execPath, args, { cwd: PACKAGE_ROOT, env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`.trim())
    return result.stdout
  }

  return {
    typeCheck: () => {
      execute([TSC, '-p', tsconfig], process.env)
    },
    run: (block, env) => execute([TSX, '--tsconfig', tsconfig, files.get(block)!], env),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
