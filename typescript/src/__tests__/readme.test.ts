import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryStoreConfig } from '@strands-agents/sdk'
import { AuthMechanism } from 'mongodb'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  blocks,
  EXECUTABLE_LANGUAGES,
  PACKAGE_README,
  PACKAGE_ROOT,
  ROOT_README,
  RUN_TIERS,
  runCommandLines,
  selected,
  where,
} from '../../test/readme.js'
import * as root from '../index.js'
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_TEXT_INDEX_NAME,
  DEFAULT_VECTOR_INDEX_NAME,
  MAX_DIMENSIONS,
  MAX_NUM_CANDIDATES,
  memorySearchSpecs,
  memorySpecs,
  READY_TIMEOUT_SECONDS,
  storageSpecs,
  VECTOR_FIELD,
} from '../index-specs.js'
import type { LogEvent } from '../logging.js'
import { DEFAULT_COLLECTION, type MongoDBMemoryStore, UNSCOPED } from '../memory-store.js'
import { RANK_FUSION_PENALTY } from '../pipeline.js'
import { MAX_DOCUMENT_BYTES, MAX_KEY_BYTES, type MongoDBStorage } from '../storage.js'
import { ATTRIBUTES, type EventName, type SpanName } from '../telemetry.js'
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_OVERSAMPLING_FACTOR,
  type MongoDBConfig,
  type MongoDBMemoryStoreConfig,
  type MongoDBSearchQuery,
  RESERVED_METADATA_KEYS,
} from '../types.js'

const README = readFileSync(PACKAGE_README, 'utf8')
const LANDING = readFileSync(ROOT_README, 'utf8')
const PACKAGE_BLOCKS = blocks(PACKAGE_README)
const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  engines: { node: string }
  peerDependencies: Record<string, string>
}

const CREDENTIALED_URI = /mongodb(\+srv)?:\/\/(?!<redacted>@)[^\s/`]*@/

// The passage following a marker comment, up to the next heading of any level.
function markedSection(marker: string, text = README): string {
  const lines = text.split('\n')
  const start = lines.indexOf(`<!-- ${marker} -->`)
  if (start === -1) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break
    body.push(line)
  }
  return body.join('\n')
}

// The body rows of the first table after a marker, each as its trimmed cells.
function tableRows(marker: string): string[][] {
  const rows: string[][] = []
  for (const line of markedSection(marker).split('\n')) {
    if (!line.startsWith('|')) {
      if (rows.length > 0) break
      continue
    }
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())
    if (cells.every((cell) => /^[-:]*$/.test(cell))) continue
    rows.push(cells)
  }
  return rows.slice(1)
}

function sourceOf(file: string): string {
  return readFileSync(join(PACKAGE_ROOT, 'src', file), 'utf8')
}

// Every `strands_mongodb.<surface>.<operation>` span, read off the calls that open one.
function operationSpans(): string[] {
  const named = (surface: string, source: string) =>
    [...source.matchAll(/\b_run\('([a-z_]+)'/g)].map((match) => `strands_mongodb.${surface}.${match[1]}`)
  const explicit = (source: string) =>
    [...source.matchAll(/traced\('(storage|memory)', '([a-z_]+)'/g)].map(
      (match) => `strands_mongodb.${match[1]}.${match[2]}`
    )
  const storage = sourceOf('storage.ts')
  const memory = sourceOf('memory-store.ts')
  return [
    ...new Set([...named('storage', storage), ...explicit(storage), ...named('memory', memory), ...explicit(memory)]),
  ]
}

type RequiredKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K }[keyof T]

// `satisfies` makes each list exhaustive at compile time, in both directions, so a key added to a type fails here.
const CONFIG_KEYS = {
  database: true,
  client: true,
  connectionString: true,
  clientOptions: true,
  ensureIndexes: true,
  indexReadyTimeout: true,
  searchType: true,
  embeddingModel: true,
  embeddingDimensions: true,
  similarity: true,
  filterFields: true,
  vectorIndexName: true,
  textIndexName: true,
  logger: true,
} satisfies Record<keyof MongoDBConfig, true>
const CONFIG_REQUIRED = { database: true } satisfies Record<RequiredKeys<MongoDBConfig>, true>

const STORE_KEYS = {
  name: true,
  description: true,
  maxSearchResults: true,
  writable: true,
  extraction: true,
  config: true,
  collection: true,
  scope: true,
  filter: true,
  minScore: true,
  maxScore: true,
  ttlSeconds: true,
  embedder: true,
} satisfies Record<keyof MongoDBMemoryStoreConfig | keyof MemoryStoreConfig, true>
const STORE_REQUIRED = { name: true, config: true } satisfies Record<RequiredKeys<MongoDBMemoryStoreConfig>, true>

const QUERY_KEYS = {
  text: true,
  vector: true,
  filter: true,
  limit: true,
  oversamplingFactor: true,
} satisfies Record<keyof MongoDBSearchQuery, true>
const QUERY_REQUIRED = {} satisfies Record<RequiredKeys<MongoDBSearchQuery>, true>

const SPAN_NAMES = {
  'strands_mongodb.indexes.ensure': true,
  'strands_mongodb.indexes.probe': true,
  'strands_mongodb.indexes.wait': true,
} satisfies Record<SpanName, true>
const EVENT_NAMES = { 'strands_mongodb.client.acquired': true } satisfies Record<EventName, true>
const LOG_EVENTS = {
  retry_writes_disabled: true,
  reserved_key_collision: true,
  no_search_setup: true,
  tier_unavailable: true,
  tier_building: true,
  below_vector: true,
  bound_declined_fusion: true,
  score_bound_applied: true,
  creating_indexes: true,
  creating_search_index: true,
  search_index_status: true,
  rank_fusion_probe_failed: true,
} satisfies Record<LogEvent, true>

// Limits rows that quote a value, by the name in their first column.
const LIMIT_VALUES: Record<string, string[]> = {
  'Key length': [String(MAX_KEY_BYTES)],
  'Document size': [`${MAX_DOCUMENT_BYTES / 1024 / 1024} MiB`, String(MAX_DOCUMENT_BYTES)],
  'Vector dimensions': [String(MAX_DIMENSIONS)],
  'Vector candidates per query': [String(MAX_NUM_CANDIDATES)],
}

function renderedCommands(): { create: string[]; drop: string[] } {
  const config: MongoDBConfig = { database: 'agents' }
  const search = memorySearchSpecs(config)
  return {
    create: [
      ...storageSpecs().map((spec) => spec.creationCommand('storage')),
      ...memorySpecs().map((spec) => spec.creationCommand(DEFAULT_COLLECTION)),
      ...search.map((spec) => spec.creationCommand(DEFAULT_COLLECTION)),
    ],
    drop: search.map((spec) => spec.dropCommand(DEFAULT_COLLECTION)),
  }
}

describe('AT-097: every block declares what happens to it', () => {
  it('finds a directive above every executable block', () => {
    expect(
      PACKAGE_BLOCKS.filter((block) => EXECUTABLE_LANGUAGES.has(block.language) && block.kind === '').map(where)
    ).toEqual([])
  })

  it('finds a reason of at least three words on every skip', () => {
    expect(
      PACKAGE_BLOCKS.filter((block) => block.kind === 'skip' && block.value.split(/\s+/).length < 3).map(where)
    ).toEqual([])
  })

  it('finds only tiers the suite runs on every run directive', () => {
    const known: readonly string[] = RUN_TIERS
    expect(PACKAGE_BLOCKS.filter((block) => block.kind === 'run' && !known.includes(block.value)).map(where)).toEqual(
      []
    )
  })

  it('finds no connection string with credentials in the document', () => {
    expect(CREDENTIALED_URI.test(README)).toBe(false)
  })

  it('reads the deployment from the environment in every connecting snippet', () => {
    const connecting = PACKAGE_BLOCKS.filter(
      (block) => ['ts', 'typescript'].includes(block.language) && /connectionString|new MongoClient\(/.test(block.body)
    )
    expect(connecting.length).toBeGreaterThan(0)
    expect(connecting.filter((block) => !block.body.includes('process.env')).map(where)).toEqual([])
  })
})

describe('AT-092: the quickstarts are executed from the README text', () => {
  it('has an executed snippet constructing each backend', () => {
    const bodies = PACKAGE_BLOCKS.filter((block) => block.kind === 'run')
      .map((block) => block.body)
      .join('\n')
    expect(bodies).toContain('new MongoDBStorage(')
    expect(bodies).toContain('new MongoDBMemoryStore(')
  })
})

describe('AT-093: the landing page and the reference agree', () => {
  it('points at the reference', () => {
    expect(LANDING).toContain('typescript/README.md')
  })

  it('tells a reader to install the same thing', () => {
    const install = (path: string) => blocks(path).find((block) => block.body.includes('npm install strands-mongodb'))
    expect(install(PACKAGE_README)?.body).toBeDefined()
    expect(install(ROOT_README)?.body).toBe(install(PACKAGE_README)?.body)
  })

  it('states the floors package.json declares', () => {
    const requirements = README
    expect(PACKAGE_JSON.engines.node.startsWith('>=22')).toBe(true)
    expect(requirements).toMatch(/^\| Node(\.js)? \| .*>= ?22/m)
    for (const [name, range] of Object.entries(PACKAGE_JSON.peerDependencies)) {
      const row = requirements.split('\n').find((line) => line.startsWith(`| \`${name}\` |`))
      expect(row, `no requirements row for ${name}`).toBeDefined()
      expect(row).toContain(`\`${range}\``)
    }
  })
})

describe('AT-094: the configuration tables match the types', () => {
  it.each([
    ['MongoDBConfig', CONFIG_KEYS, CONFIG_REQUIRED],
    ['MongoDBMemoryStoreConfig', STORE_KEYS, STORE_REQUIRED],
    ['MongoDBSearchQuery', QUERY_KEYS, QUERY_REQUIRED],
  ] as const)('lists every key of %s, no others, with its required flag', (marker, keys, required) => {
    const rows = tableRows(`keys: ${marker}`)
    expect(rows.length, `no table marked '<!-- keys: ${marker} -->'`).toBeGreaterThan(0)
    const documented = Object.fromEntries(rows.map((cells) => [cells[0]!.replace(/`/g, ''), cells[2]!]))
    expect(Object.keys(documented).sort()).toEqual(Object.keys(keys).sort())
    for (const [key, cell] of Object.entries(documented)) {
      expect(cell.toLowerCase().startsWith('yes'), `${marker}.${key} required column`).toBe(key in required)
    }
  })
})

describe('AT-095: the documented values are the values', () => {
  it('quotes the current value on every limits row that states a constant', () => {
    const rows = new Map(tableRows('limits').map((cells) => [cells[0]!, cells[1]!]))

    for (const [limit, accepted] of Object.entries(LIMIT_VALUES)) {
      const value = rows.get(limit)
      expect(
        accepted.some((form) => value?.includes(form)),
        `${limit}: ${value} is not ${accepted.join(' or ')}`
      ).toBe(true)
    }
  })

  it.each([
    ['MongoDBConfig', 'indexReadyTimeout', READY_TIMEOUT_SECONDS],
    ['MongoDBConfig', 'embeddingModel', DEFAULT_EMBEDDING_MODEL],
    ['MongoDBConfig', 'vectorIndexName', DEFAULT_VECTOR_INDEX_NAME],
    ['MongoDBConfig', 'textIndexName', DEFAULT_TEXT_INDEX_NAME],
    ['MongoDBMemoryStoreConfig', 'collection', DEFAULT_COLLECTION],
    ['MongoDBMemoryStoreConfig', 'maxSearchResults', DEFAULT_MAX_SEARCH_RESULTS],
    ['MongoDBMemoryStoreConfig', 'scope', UNSCOPED],
    ['MongoDBSearchQuery', 'limit', DEFAULT_MAX_SEARCH_RESULTS],
    ['MongoDBSearchQuery', 'oversamplingFactor', DEFAULT_OVERSAMPLING_FACTOR],
  ])('states the default of %s.%s', (marker, key, value) => {
    const row = tableRows(`keys: ${marker}`).find((cells) => cells[0] === `\`${key}\``)
    expect(row?.[3]).toBe(`\`${value}\``)
  })

  it('lists every reserved metadata key', () => {
    expect([...RESERVED_METADATA_KEYS].filter((key) => !README.includes(`\`${key}\``))).toEqual([])
  })

  it('names every authentication mechanism the driver declares', () => {
    const mechanisms = Object.values(AuthMechanism).filter((name) => name !== 'DEFAULT')
    expect(mechanisms.length).toBeGreaterThan(5)
    expect(mechanisms.filter((name) => !README.includes(`\`${name}\``))).toEqual([])
  })

  it('documents every runtime export of the root barrel', () => {
    expect(Object.keys(root).filter((name) => !README.includes(`\`${name}\``))).toEqual([])
  })

  it('names the field the manual vector path indexes', () => {
    const passage = markedSection('manual-vectors')
    expect(passage).toContain(`\`${VECTOR_FIELD}\``)
    expect(passage).toContain('`embedder`')
  })
})

describe('the Methods section states what the classes declare', () => {
  // The type assertions run under `npm run type-check`, so a changed return type fails there.
  it('says which methods return a count and which return nothing', () => {
    const passage = markedSection('methods').replace(/\s+/g, ' ')

    expectTypeOf<MongoDBStorage['write']>().returns.resolves.toBeVoid()
    expectTypeOf<MongoDBStorage['delete']>().returns.resolves.toBeVoid()
    expect(passage).toContain('`write()` and `delete()` return nothing')
    expectTypeOf<MongoDBStorage['deletePrefix']>().returns.resolves.toBeNumber()
    expect(passage).toContain('`deletePrefix()` returns the number of documents removed')
    expectTypeOf<MongoDBMemoryStore['delete']>().returns.resolves.toBeNumber()
    expectTypeOf<MongoDBMemoryStore['deleteAll']>().returns.resolves.toBeNumber()
    expect(passage).toContain(
      '`MongoDBMemoryStore`: `delete()` and `deleteAll()` return the number of documents removed'
    )
  })
})

describe('AT-151: the fused scale is stated where a bound is chosen', () => {
  it('quotes the live penalty and the two scores it implies', () => {
    const passage = markedSection('rrf')
    expect(passage).not.toBe('')
    expect(passage).toContain(String(RANK_FUSION_PENALTY))
    expect(passage).toContain((2 / (RANK_FUSION_PENALTY + 1)).toFixed(3))
    expect(passage).toContain((1 / (RANK_FUSION_PENALTY + 1)).toFixed(3))
  })
})

describe('AT-096: the index and privilege commands are generated, not written', () => {
  it('documents exactly the rendered creation and drop commands, in order', () => {
    const rendered = renderedCommands()
    expect(runCommandLines(PACKAGE_BLOCKS)).toEqual([...rendered.create, ...rendered.drop])
  })

  it('names every index the package creates', () => {
    const names = [...storageSpecs(), ...memorySpecs(), ...memorySearchSpecs({ database: 'agents' })].map(
      (spec) => spec.name
    )
    expect(names.filter((name) => !README.includes(name))).toEqual([])
  })

  it('keeps the command blocks inside the marked section', () => {
    const indexes = markedSection('indexes')
    for (const block of selected('mongosh', PACKAGE_BLOCKS)) expect(indexes).toContain(block.body.trim())
  })

  it('lists the privilege actions the package needs', () => {
    const actions = tableRows('privileges').map((cells) => cells[0]!.replace(/`/g, ''))
    expect(actions).toEqual(
      expect.arrayContaining([
        'find',
        'insert',
        'update',
        'remove',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'createIndex',
        'createCollection',
        'createSearchIndexes',
      ])
    )
  })
})

describe('AT-213: the observability section matches the code', () => {
  const observability = markedSection('observability')

  it('names every span, attribute and event the code can emit', () => {
    const spans = operationSpans()
    expect(spans.length).toBeGreaterThan(0)
    const expected = [...spans, ...Object.keys(SPAN_NAMES), ...Object.keys(EVENT_NAMES), ...ATTRIBUTES]
    expect(expected.filter((name) => !observability.includes(`\`${name}\``))).toEqual([])
    expect(observability).toContain('`error.type`')
  })

  it('names nothing the code does not emit', () => {
    const expected = new Set([
      ...operationSpans(),
      ...Object.keys(SPAN_NAMES),
      ...Object.keys(EVENT_NAMES),
      ...ATTRIBUTES,
    ])
    const named = [...observability.matchAll(/`(strands_mongodb\.[a-z_.]+)`/g)].map((match) => match[1]!)
    expect(named.filter((name) => !expected.has(name))).toEqual([])
  })

  it('AT-210: names every log event and the line shape', () => {
    expect(Object.keys(LOG_EVENTS).filter((event) => !observability.includes(`\`${event}\``))).toEqual([])
    expect(observability).toContain('event=')
  })
})
