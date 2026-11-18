// One MongoDBStorage holds an agent's session, its offloaded context and a file memory store,
// and a new process restores the session.
//
//   npx tsx examples/unified-storage.ts run
//   npx tsx examples/unified-storage.ts resume
//
// Needs MONGODB_URI for any MongoDB deployment.
import { Agent, SessionManager, tool } from '@strands-agents/sdk'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'
import { MongoDBStorage } from 'strands-mongodb'
import { connection, ScriptedModel, stepFrom } from './support.js'

const SESSION_ID = 'dinner-service'

// 200 rows put the tool result over the size at which `contextManager: 'auto'` offloads it.
const reservationBook = tool({
  name: 'reservation_book',
  description: 'Return every booking for one service.',
  inputSchema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
  callback: () =>
    Array.from({ length: 200 }, (_, n) => `table ${n + 1} | 19:${String(n % 60).padStart(2, '0')} | party of 4`).join(
      '\n'
    ),
})

const step = stepFrom('unified-storage.ts', ['run', 'resume'])
const storage = new MongoDBStorage(connection(), { collection: 'example' })
const agent = new Agent({
  model: new ScriptedModel([
    { toolUse: { name: 'reservation_book', input: { service: 'dinner' } } },
    { text: 'Dinner is fully booked.' },
  ]),
  tools: [reservationBook],
  // The session manager and the context manager have no storage of their own: both use this one.
  storage,
  sessionManager: new SessionManager({ sessionId: SESSION_ID }),
  contextManager: 'auto',
  printer: false,
})

try {
  // Restores the session when one is stored.
  await agent.initialize()

  if (step === 'run') {
    await agent.invoke("Pull up tonight's reservation book.")
    await new FileMemoryStore({ name: 'kitchen_notes', storage }).add('Closing checklist: wipe the pass.')

    const keys = await storage.list('')
    for (const prefix of ['session/', 'context/', 'memory/']) {
      const count = keys.filter((key) => key.startsWith(prefix)).length
      if (count === 0) throw new Error(`nothing was written under ${prefix}`)
      console.log(`${prefix.padEnd(9)} ${count} key(s)`)
    }
    console.log(`saved ${agent.messages.length} messages in session '${SESSION_ID}'`)
    console.log('now run: npx tsx examples/unified-storage.ts resume')
  } else {
    console.log(`restored ${agent.messages.length} messages from session '${SESSION_ID}'`)
    if (agent.messages.length === 0) {
      console.error("Nothing restored. Run the 'run' step against this database first.")
      process.exitCode = 1
    }
  }
} finally {
  await storage.close()
}
