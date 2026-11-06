// Three SDK subsystems, one MongoDB collection, and a session that survives the process that made it.
import { Agent, SessionManager, tool } from '@strands-agents/sdk'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'
import { MongoClient } from 'mongodb'
import { MongoDBStorage } from '../src/index.js'
import {
  announce,
  type CensusEntry,
  connection,
  dryRun,
  emitSummary,
  ExampleError,
  main,
  mongodbConfig,
  parseStep,
  prefixCensus,
  quoted,
  resolveModel,
  say,
  type ScriptedReply,
  type StepArguments,
} from './support.js'

const SCRIPT = 'unified-storage.ts'
const STEPS = ['run', 'resume'] as const

// Enough rows that the tool result is over contextManager: 'auto''s offload threshold.
const BOOKINGS = 200

const MEMORY_STORE = 'kitchen_notes'
const KNOWLEDGE =
  'Closing checklist: wipe the pass, log the waste sheet, and leave the walk-in door propped open ' +
  'for ten minutes before setting the alarm.'

const PROMPT = "Pull up tonight's reservation book and file the closing checklist."

// The first reply calls the tool, giving the context manager an oversized result to move. The second ends the turn.
const REPLIES: ScriptedReply[] = [
  [{ toolUse: { name: 'reservation_book', toolUseId: 'tooluse-1', input: { service: 'dinner' } } }],
  [{ text: 'Dinner is fully committed. I have filed the closing notes.' }],
]

const reservationBook = tool({
  name: 'reservation_book',
  description: 'Return every booking for one service.',
  inputSchema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
  callback: (input) => {
    const { service } = input as { service: string }
    const rows = Array.from({ length: BOOKINGS }, (_, offset) => {
      const n = offset + 1
      const time = `${19 + (n % 4)}:${String((n * 15) % 60).padStart(2, '0')}`
      const room = n % 3 === 0 ? 'window' : 'main room'
      return `table ${String(n).padStart(2)} | ${time} | party of ${2 + (n % 6)} | guest ${String(n).padStart(3, '0')} | ${room}`
    })
    return `${service} service, ${rows.length} bookings\n${rows.join('\n')}`
  },
})

// No prefix, so the census shows the SDK's own keys. A real application usually sets one per tenant.
function buildStorage(args: StepArguments, uri: string): MongoDBStorage {
  return new MongoDBStorage(mongodbConfig(uri, args.database), { collection: args.collection })
}

// Neither the session manager nor the context manager's stash gets storage of its own: both use agent.storage.
async function buildAgent(args: StepArguments, storage: MongoDBStorage) {
  const sessions = new SessionManager({ sessionId: args.options['session-id']! })
  const agent = new Agent({
    model: resolveModel(args.model, REPLIES),
    tools: [reservationBook],
    contextManager: 'auto',
    sessionManager: sessions,
    storage,
    printer: false,
  })
  // Restores the session, if one is stored, before any turn runs.
  await agent.initialize()
  return { agent, sessions }
}

// Read with a plain driver client: these are ordinary documents, and mongosh would give the same answer.
async function census(args: StepArguments, uri: string): Promise<CensusEntry[]> {
  const client = new MongoClient(uri)
  let entries: CensusEntry[]
  try {
    entries = await prefixCensus(client.db(args.database).collection(args.collection))
  } finally {
    await client.close()
  }
  say(`census of ${args.database}.${args.collection}, read back with a plain driver:`)
  if (entries.length === 0)
    say("  the collection is empty. Run the 'run' step against this database and collection first.")
  for (const entry of entries) {
    say(
      `  ${entry.prefix.padEnd(12)} ${String(entry.documents).padStart(3)} document(s)  ${String(entry.bytes).padStart(7)} bytes`
    )
  }
  return entries
}

async function run(args: StepArguments, uri: string) {
  const storage = buildStorage(args, uri)
  const knowledge = new FileMemoryStore({ name: MEMORY_STORE, storage })
  const sessionId = args.options['session-id']!

  try {
    const { agent, sessions } = await buildAgent(args, storage)
    say(`session ${quoted(sessionId)} opened with ${agent.messages.length} message(s) in context`)

    say(`the user says: ${quoted(PROMPT)}`)
    await agent.invoke(PROMPT)
    say(`the turn settled with ${agent.messages.length} message(s) in context`)

    const key = await knowledge.add(KNOWLEDGE)
    say(`FileMemoryStore(${quoted(MEMORY_STORE)}) wrote ${quoted(key)} through the same backend`)

    await sessions.saveSnapshot({ target: agent, isLatest: false })
    const [snapshotId] = (await sessions.listSnapshotIds({ target: agent })).slice(-1)
    say(`the latest snapshot was written when the turn ended; immutable checkpoint ${quoted(String(snapshotId))} added`)

    const entries = await census(args, uri)
    const prefixes = entries.map((entry) => entry.prefix)
    const missing = ['session/', 'context/', 'memory/'].filter((expected) => !prefixes.includes(expected))
    if (missing.length > 0) {
      throw new ExampleError(
        `nothing was written under ${missing.join(', ')}. The census found ${prefixes.join(', ') || 'nothing'}.`
      )
    }
    say(`three subsystems, one collection: ${prefixes.join(', ')}`)

    return { step: 'run', sessionId, messages: agent.messages.length, snapshotId, memoryKey: key, census: entries }
  } finally {
    await storage.close()
  }
}

async function resume(args: StepArguments, uri: string) {
  const storage = buildStorage(args, uri)
  const sessionId = args.options['session-id']!

  try {
    const { agent } = await buildAgent(args, storage)
    const restored = agent.messages.length
    say(`restored ${restored} message(s) from session ${quoted(sessionId)}, before any turn ran`)
    const first = agent.messages[0]
    const text = first?.content.find((block) => block.type === 'textBlock')
    if (first && text && 'text' in text)
      say(`  the first restored message (${first.role}): ${quoted(text.text.slice(0, 90))}`)
    if (restored === 0) say("  nothing came back. Run the 'run' step first, with this same --session-id.")

    const entries = await census(args, uri)
    say(
      'on the memory/ prefix: Storage moves opaque bytes under a string key, and on this backend FileMemoryStore ' +
        'recall is token overlap over that key space, so it matches file names and not the text inside them. ' +
        'MongoDBMemoryStore is a different collection with typed fields and a vector index. See memory-recall.ts.'
    )

    return { step: 'resume', sessionId, restoredMessages: restored, census: entries }
  } finally {
    await storage.close()
  }
}

const PLANS = {
  run: [
    'build one MongoDBStorage and pass it as Agent({ storage })',
    "add a SessionManager and contextManager: 'auto', neither carrying storage of its own",
    `run one turn in which the model calls ${quoted(reservationBook.name)}, whose result is far over the ` +
      'offload threshold; the context manager stashes the turn under context/',
    `write one knowledge file through FileMemoryStore({ name: ${quoted(MEMORY_STORE)}, storage })`,
    'save an immutable snapshot, then read the prefix census back with a plain driver',
  ],
  resume: [
    'rebuild the same storage and the same session manager in this process',
    'let agent.initialize() restore the latest snapshot, and print how many messages came back',
    'read the census again, and say why FileMemoryStore recall on memory/ is token overlap over keys',
  ],
}

await main(SCRIPT, async () => {
  const args = parseStep(SCRIPT, STEPS, { 'session-id': 'dinner-service' })
  if (args.dryRun) return dryRun(args, PLANS[args.step as keyof typeof PLANS])

  const uri = connection()
  announce(args, uri)
  // Two processes on purpose: the only thing that reaches the resume step is what MongoDB holds.
  const summary = args.step === 'run' ? await run(args, uri) : await resume(args, uri)
  if (args.next) say(`now run, in a new process: ${args.next}`)
  emitSummary(summary, args)
})
