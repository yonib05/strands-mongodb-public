import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(PACKAGE_ROOT, '..')

const UNWALKED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.superpowers',
  'node_modules',
  'dist',
  'coverage',
  '.venv',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
])

// Generated or local files nobody writes by hand.
const UNREAD_FILES: ReadonlySet<string> = new Set(['package-lock.json', '.env', '.vitest-results.json'])

const ROOT_DOCUMENTS = ['AGENTS.md', 'CONTRIBUTING.md'].map((name) => join(REPO_ROOT, name))

const CREDENTIALED_URI = /mongodb(\+srv)?:\/\/[^@\s/]+:[^@\s/]+@/

const ALLOWED_SDK_IMPORTS: ReadonlySet<string> = new Set([
  '@strands-agents/sdk',
  '@strands-agents/sdk/storage',
  '@strands-agents/sdk/storage/search',
])

// The docs tier writes and removes `.readme-snippets-*` while this walk may be running.
function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      const skipped = UNWALKED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.readme-snippets-')
      return skipped ? [] : walk(join(root, entry.name))
    }
    return entry.isFile() && !UNREAD_FILES.has(entry.name) ? [join(root, entry.name)] : []
  })
}

const relativeToRepo = (path: string) => relative(REPO_ROOT, path)
const read = (path: string) => readFileSync(path, 'utf8')
const srcFiles = () => walk(join(PACKAGE_ROOT, 'src')).filter((path) => path.endsWith('.ts'))
const moduleFiles = () => srcFiles().filter((path) => !/[/\\]__(tests|fixtures)__[/\\]/.test(path))

// The text of the call opened at `open`, assuming the parentheses inside its strings balance.
function callText(source: string, open: number): string {
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '(') depth++
    else if (source[index] === ')' && --depth === 0) return source.slice(open, index + 1)
  }
  return source.slice(open)
}

const TSDOC_AT_END = /\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/

// Re-exports are documented where the symbol is defined.
function undocumentedExports(path: string): string[] {
  const lines = read(path).split('\n')
  return lines.flatMap((line, index) => {
    if (!line.startsWith('export ')) return []
    const statement = lines.slice(index, index + 40).join('\n')
    if (/^export (type )?(\{[^}]*\}|\*( as \w+)?) from /.test(statement)) return []
    if (TSDOC_AT_END.test(lines.slice(0, index).join('\n'))) return []
    return [`${relativeToRepo(path)}:${index + 1}`]
  })
}

function matchingLines(paths: readonly string[], pattern: RegExp): string[] {
  return paths.flatMap((path) =>
    read(path)
      .split('\n')
      .flatMap((line, index) => (pattern.test(line) ? [`${relativeToRepo(path)}:${index + 1}: ${line.trim()}`] : []))
  )
}

describe('AT-114: no Markdown file in the repository carries a credential', () => {
  it('finds no connection string with a user and password, in a walk that reaches the documents that ship', () => {
    const documents = walk(REPO_ROOT).filter((path) => path.endsWith('.md'))
    const reached = new Set(documents.map(relativeToRepo))

    expect(CREDENTIALED_URI.test(['mongodb+srv://', 'admin:SECRET', '@cluster0.example.mongodb.net/'].join(''))).toBe(
      true
    )
    expect(
      ['AGENTS.md', 'README.md', 'python/README.md', 'typescript/README.md'].filter((name) => !reached.has(name))
    ).toEqual([])
    expect(documents.filter((path) => CREDENTIALED_URI.test(read(path))).map(relativeToRepo)).toEqual([])
  })
})

describe('AT-115: the house conventions hold in src/', () => {
  it('passes a logFields event literal on every logger call', () => {
    const calls = moduleFiles().flatMap((path) => {
      const source = read(path)
      return [...source.matchAll(/\b_?logger\.(?:debug|info|warn|error)\(/g)].map((match) => ({
        at: `${relativeToRepo(path)}:${source.slice(0, match.index).split('\n').length}`,
        event: /logFields\('(\w+)'/.exec(callText(source, match.index + match[0].length - 1))?.[1],
      }))
    })

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter((call) => call.event === undefined).map((call) => call.at)).toEqual([])
  })

  it('precedes every export in a module with a TSDoc block', () => {
    expect(moduleFiles().flatMap(undocumentedExports)).toEqual([])
  })

  it('has no default export', () => {
    expect(matchingLines(srcFiles(), /^\s*export\s+default\b/)).toEqual([])
  })

  it('imports the SDK only through its root, storage and storage/search entry points', () => {
    const specifiers = srcFiles().flatMap((path) =>
      [...read(path).matchAll(/(?:from\s+|import\s*\(\s*|import\s+)'(@strands-agents\/sdk[^']*)'/g)].map(
        (match) => `${relativeToRepo(path)}: ${match[1]}`
      )
    )

    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((entry) => !ALLOWED_SDK_IMPORTS.has(entry.split(': ')[1]!))).toEqual([])
  })
})

describe('no em dash', () => {
  it('appears in typescript/ or in the root AGENTS.md and CONTRIBUTING.md', () => {
    expect(matchingLines([...walk(PACKAGE_ROOT), ...ROOT_DOCUMENTS], /\u2014/)).toEqual([])
  })
})
