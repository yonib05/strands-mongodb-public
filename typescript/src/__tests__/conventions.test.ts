import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// The character class keeps this file from matching itself; a backticked one names the token rather than using it.
const UNNAMED_PLACEHOLDER = /(?<!`)\bTO[D]O\b(?!`|\([^)\s][^)]*\))/

const ALLOWED_SDK_IMPORTS: ReadonlySet<string> = new Set([
  '@strands-agents/sdk',
  '@strands-agents/sdk/storage',
  '@strands-agents/sdk/storage/search',
])

function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return UNWALKED_DIRECTORIES.has(entry.name) ? [] : walk(join(root, entry.name))
    return entry.isFile() && !UNREAD_FILES.has(entry.name) ? [join(root, entry.name)] : []
  })
}

function relativeToRepo(path: string): string {
  return relative(REPO_ROOT, path)
}

const read = (path: string) => readFileSync(path, 'utf8')

const srcFiles = () => walk(join(PACKAGE_ROOT, 'src')).filter((path) => path.endsWith('.ts'))

const moduleFiles = () => srcFiles().filter((path) => !/[/\\]__(tests|fixtures)__[/\\]/.test(path))

const markdownDocuments = (root: string) => walk(root).filter((path) => path.endsWith('.md'))

function logEvents(): Set<string> {
  const declaration = /export type LogEvent =([^=]*?)\n\n/.exec(read(join(PACKAGE_ROOT, 'src', 'logging.ts')))
  return new Set([...(declaration?.[1] ?? '').matchAll(/'(\w+)'/g)].map((match) => match[1]!))
}

// The text of the call opened at `open`, assuming the parentheses inside its strings balance.
function callText(source: string, open: number): string {
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '(') depth++
    else if (source[index] === ')' && --depth === 0) return source.slice(open, index + 1)
  }
  return source.slice(open)
}

function logCalls(): { at: string; event: string | undefined }[] {
  return moduleFiles().flatMap((path) => {
    const source = read(path)
    return [...source.matchAll(/\b_?logger\.(?:debug|info|warn|error)\(/g)].map((match) => {
      const line = source.slice(0, match.index).split('\n').length
      const event = /logFields\('(\w+)'/.exec(callText(source, match.index + match[0].length - 1))?.[1]
      return { at: `${relativeToRepo(path)}:${line}`, event }
    })
  })
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

describe('AT-113: every placeholder names its subject', () => {
  it('finds no placeholder without a parenthesised subject in typescript/, AGENTS.md or CONTRIBUTING.md', () => {
    expect(matchingLines([...walk(PACKAGE_ROOT), ...ROOT_DOCUMENTS], UNNAMED_PLACEHOLDER)).toEqual([])
  })

  it('tells a named placeholder from a bare or empty one', () => {
    const mark = ['TO', 'DO'].join('')

    expect(UNNAMED_PLACEHOLDER.test(`// ${mark}(release): pin the floor`)).toBe(false)
    expect(UNNAMED_PLACEHOLDER.test(`// ${mark}: pin the floor`)).toBe(true)
    expect(UNNAMED_PLACEHOLDER.test(`// ${mark}() pin the floor`)).toBe(true)
    expect(UNNAMED_PLACEHOLDER.test(`Do not write a bare \`${mark}\`.`)).toBe(false)
  })
})

describe('AT-114: no Markdown file in the repository carries a credential', () => {
  it('reaches the documents that ship', () => {
    const reached = new Set(markdownDocuments(REPO_ROOT).map(relativeToRepo))

    expect(
      ['AGENTS.md', 'CONTRIBUTING.md', 'README.md', 'python/README.md', 'typescript/docs/PARITY.md'].filter(
        (name) => !reached.has(name)
      )
    ).toEqual([])
  })

  it('finds no connection string with a user and password in any of them', () => {
    expect(
      markdownDocuments(REPO_ROOT)
        .filter((path) => CREDENTIALED_URI.test(read(path)))
        .map(relativeToRepo)
    ).toEqual([])
  })

  it('catches a planted credential and passes the redacted form', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strands-mongodb-conventions-'))
    try {
      writeFileSync(
        join(dir, 'leak.md'),
        'Connect with `mongodb+srv://admin:SUPERSECRET@cluster0.example.mongodb.net/`.\n'
      )
      writeFileSync(join(dir, 'clean.md'), 'Connect with `mongodb+srv://<redacted>@cluster0.example.mongodb.net/`.\n')

      expect(
        markdownDocuments(dir)
          .filter((path) => CREDENTIALED_URI.test(read(path)))
          .map((path) => relative(dir, path))
      ).toEqual(['leak.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('AT-115: the house conventions hold in src/', () => {
  describe('logging', () => {
    it('declares the fourteen events', () => {
      expect(logEvents().size).toBe(14)
    })

    it('passes a logFields event literal on every logger call', () => {
      const calls = logCalls()

      expect(calls.length).toBeGreaterThan(0)
      expect(calls.filter((call) => call.event === undefined).map((call) => call.at)).toEqual([])
    })

    it('logs only events LogEvent declares', () => {
      const declared = logEvents()

      expect(logCalls().filter((call) => call.event !== undefined && !declared.has(call.event))).toEqual([])
    })
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
