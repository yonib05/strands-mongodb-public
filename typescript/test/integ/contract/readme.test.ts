import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type Db, type Document, MongoClient } from 'mongodb'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { tierUri } from '../../env.js'
import {
  blocks,
  PACKAGE_README,
  prepare,
  runCommandArgument,
  runCommandLines,
  selected,
  type Snippets,
  where,
} from '../../readme.js'
import { describeTier } from '../../tiers.js'

const PACKAGE_BLOCKS = blocks(PACKAGE_README)
const PRIVILEGES_TABLE = /<!-- privileges -->\n([\s\S]*?)\n\n/

// The privileges table as the README states it: action to the roles claiming to grant it.
function privilegeRows(): Array<[string, Record<string, boolean>]> {
  const table = PRIVILEGES_TABLE.exec(readFileSync(PACKAGE_README, 'utf8'))?.[1] ?? ''
  const lines = table.split('\n').filter((line) => line.startsWith('|'))
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim().replace(/`/g, ''))
  const roles = cells(lines[0]!).slice(2)
  return lines.slice(2).map((line) => {
    const row = cells(line)
    return [
      row[0]!,
      Object.fromEntries(roles.map((role, offset) => [role, row[2 + offset]!.toLowerCase().startsWith('yes')])),
    ]
  })
}

describeTier('contract', 'README snippets against a deployment', () => {
  const contract = selected('contract', PACKAGE_BLOCKS)
  const database = `strands_mongodb_readme_${randomUUID().slice(0, 8)}`
  let client: MongoClient
  let db: Db
  let snippets: Snippets

  beforeAll(() => {
    client = new MongoClient(tierUri('contract')!)
    db = client.db(database)
    snippets = prepare(contract)
  })

  afterAll(async () => {
    snippets?.dispose()
    // `dropDatabase` is in neither built-in role, so a least-privilege credential leaves the database behind.
    await db.dropDatabase().catch((error: unknown) => console.warn(`could not drop ${database}: ${String(error)}`))
    await client.close()
  })

  it('AT-092: type-checks the contract snippets', { timeout: 120_000 }, () => {
    expect(contract.length).toBeGreaterThan(0)
    expect(() => snippets.typeCheck()).not.toThrow()
  })

  it.each(contract.map((block) => [where(block), block] as const))(
    'AT-092: runs %s against MONGODB_URI',
    (_location, block) => {
      const env = { ...process.env, MONGODB_URI: tierUri('contract')!, MONGODB_DATABASE: database }
      expect(() => snippets.run(block, env)).not.toThrow()
    },
    120_000
  )

  it('AT-096: the deployment accepts the documented ordinary index commands as written', async () => {
    const commands = runCommandLines(PACKAGE_BLOCKS)
      .map(runCommandArgument)
      .filter((command) => 'createIndexes' in command)
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) expect((await db.command(command)).ok).toBe(1)
  })

  it('AT-096b: the privileges table matches the deployment', async (context) => {
    const rows = privilegeRows()
    expect(rows.length).toBeGreaterThan(0)
    const granted: Record<string, Set<string>> = {}
    for (const role of Object.keys(rows[0]![1])) {
      let answer: Document
      try {
        answer = await db.command({ rolesInfo: { role, db: database }, showPrivileges: true })
      } catch (error) {
        context.skip(`this deployment does not answer rolesInfo for '${role}': ${String(error)}`)
        return
      }
      const definition = (answer.roles as Array<{ privileges?: Array<{ actions?: string[] }> }>)[0]
      if (definition?.privileges === undefined) context.skip(`this deployment returns no privilege list for '${role}'`)
      granted[role] = new Set(definition!.privileges!.flatMap((privilege) => privilege.actions ?? []))
    }
    for (const [action, claims] of rows) {
      for (const [role, claimed] of Object.entries(claims)) {
        expect(granted[role]!.has(action), `${role} and ${action}`).toBe(claimed)
      }
    }
  })
})
