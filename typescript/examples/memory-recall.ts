// An agent stores a fact in one process and recalls it in the next, from a query that shares no word with it.
//
//   npx tsx examples/memory-recall.ts write
//   npx tsx examples/memory-recall.ts recall
//
// Needs MONGODB_URI for an Atlas cluster with an embedding model registered.
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { MongoDBMemoryStore } from 'strands-mongodb'
import { connection, ScriptedModel, stepFrom } from './support.js'

const FACT = 'The guest prefers a window table for two on Thursday evenings.'
const QUERY = 'where should we seat them?'

const step = stepFrom('memory-recall.ts', ['write', 'recall'])
const store = new MongoDBMemoryStore({
  name: 'guest_notes',
  config: connection(),
  collection: 'example_memory',
  scope: 'bistro-demo',
  writable: true,
})
const memoryManager = new MemoryManager({ stores: [store], addToolConfig: true })

try {
  if (step === 'write') {
    // The scripted model calls `add_memory`, as a real model does when it is told something worth keeping.
    const model = new ScriptedModel([
      { toolUse: { name: 'add_memory', input: { entries: [FACT] } } },
      { text: 'Noted for the next booking.' },
    ])
    const agent = new Agent({ model, memoryManager, printer: false })
    await agent.invoke(`Table 7 went well tonight. ${FACT}`)

    const failed = agent.messages
      .flatMap((message) => message.content)
      .some((block) => block.type === 'toolResultBlock' && block.status === 'error')
    if (failed) throw new Error('add_memory failed; the warning above says why')
    console.log(`stored: ${FACT}`)
    console.log('now run: npx tsx examples/memory-recall.ts recall')
  } else {
    const recalled = await memoryManager.search(QUERY)
    console.log(`query: ${QUERY}`)
    for (const entry of recalled) {
      console.log(`recalled by ${entry.metadata?._searchType} search, score ${entry.metadata?._relevanceScore}:`)
      console.log(`  ${entry.content}`)
    }
    if (recalled.length === 0) {
      // Atlas embeds a memory after the write is acknowledged, so a search straight after it can be empty.
      console.error('Nothing recalled yet. Wait a few seconds and run the recall step again.')
      process.exitCode = 1
    }
  }
} finally {
  await store.close()
}
