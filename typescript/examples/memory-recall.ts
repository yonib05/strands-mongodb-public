// An agent learns a fact in one process and recalls it in the next, from a query with no word in common.
import {
  Agent,
  type ExtractionResult,
  type Extractor,
  InvocationTrigger,
  MemoryManager,
  type MessageData,
} from '@strands-agents/sdk'
import { MongoDBMemoryStore, type MongoDBMemoryStoreConfig } from '../src/index.js'
import {
  announce,
  connection,
  dryRun,
  emitSummary,
  ExampleError,
  main,
  mongodbConfig,
  parseStep,
  quoted,
  resolveModel,
  say,
  type ScriptedReply,
  type StepArguments,
} from './support.js'

const SCRIPT = 'memory-recall.ts'
const STEPS = ['write', 'recall'] as const

// Only the text after the marker is worth storing; the rest of the turn is small talk.
const MARKER = 'Note for next time: '
const TURN = `Table 7 went well tonight. ${MARKER}the guest prefers a window table for two on Thursday evenings.`
const QUERY = 'where should we seat them?'

const WRITABLE_STORE = 'guest_notes'
const CURATED_STORE = 'house_policies'
const CURATED_ENTRY = 'Window tables are held for parties who booked ahead.'

// One reply is enough: the turn only gives InvocationTrigger an invocation to fire after.
const REPLIES: ScriptedReply[] = [[{ text: 'Noted. I will keep that in mind for the next booking.' }]]

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  )

function factFrom(turn: string): string {
  const at = turn.indexOf(MARKER)
  return at === -1
    ? ''
    : turn
        .slice(at + MARKER.length)
        .trim()
        .replace(/\.$/, '')
}

// A shared word would let a keyword match answer the query, which would prove nothing.
function requireDisjoint(fact: string, query: string): void {
  const overlap = [...words(fact)].filter((word) => words(query).has(word))
  if (overlap.length > 0) {
    throw new ExampleError(
      `the query and the stored fact share ${overlap.join(', ')}. Edit QUERY or TURN until they do not.`
    )
  }
}

// Keeps the text after MARKER in each user message, so the write costs no model call. In your own
// application, `extraction: true` selects the SDK's ModelExtractor, at one model call per turn.
class MarkerExtractor implements Extractor {
  readonly extracted: string[] = []

  async extract(messages: MessageData[]): Promise<ExtractionResult[]> {
    const results: ExtractionResult[] = []
    for (const message of messages.filter((candidate) => candidate.role === 'user')) {
      for (const block of message.content) {
        const fact = 'text' in block ? factFrom(block.text) : ''
        if (fact) {
          this.extracted.push(fact)
          results.push({ content: fact, metadata: { extractor: 'MarkerExtractor' } })
        }
      }
    }
    return results
  }
}

// One collection, two scopes. The curated store is read-only to the agent.
function buildStores(args: StepArguments, uri: string, extraction?: MongoDBMemoryStoreConfig['extraction']) {
  const config = mongodbConfig(uri, args.database)
  const scope = args.options['scope']!
  const writable = new MongoDBMemoryStore({
    name: WRITABLE_STORE,
    description: 'what the assistant has learned about this guest',
    config,
    collection: args.collection,
    scope,
    writable: true,
    ...(extraction ? { extraction } : {}),
  })
  const curated = new MongoDBMemoryStore({
    name: CURATED_STORE,
    description: 'house policy, curated by the restaurant and read-only to the assistant',
    config,
    collection: args.collection,
    scope: `${scope}-house`,
    writable: false,
  })
  return [writable, curated] as const
}

async function write(args: StepArguments, uri: string) {
  const extractor = new MarkerExtractor()
  const stores = buildStores(args, uri, { trigger: [new InvocationTrigger()], extractor })
  // Stands in for whoever curates the policy store, which the agent itself cannot write to.
  const curator = new MongoDBMemoryStore({
    name: CURATED_STORE,
    config: mongodbConfig(uri, args.database),
    collection: args.collection,
    scope: `${args.options['scope']}-house`,
    writable: true,
  })
  const manager = new MemoryManager({ stores: [...stores] })
  const agent = new Agent({ model: resolveModel(args.model, REPLIES), memoryManager: manager, printer: false })

  try {
    await curator.add(CURATED_ENTRY)
    say(`curated ${quoted(CURATED_ENTRY)} into scope ${quoted(curator.scope)} of store ${quoted(CURATED_STORE)}`)

    say(`the user says: ${quoted(TURN)}`)
    await agent.invoke(TURN)
    say(`the turn settled with ${agent.messages.length} messages in context`)
    // Without addToolConfig the agent has no add_memory tool, so the extractor does the writing.
    say('the assistant has no tool for writing memories, only search. What follows writes them:')

    // Extraction writes in the background; flush() keeps the process from exiting with it in flight.
    await manager.flush()
    say(`MarkerExtractor produced ${extractor.extracted.length} fact(s), written by extraction`)
    for (const fact of extractor.extracted) {
      say(`  stored in ${quoted(WRITABLE_STORE)}, scope ${quoted(args.options['scope']!)}: ${quoted(fact)}`)
    }
    if (extractor.extracted.length === 0) {
      throw new ExampleError(
        `extraction produced nothing, so the recall step has nothing to find. The turn needs ${quoted(MARKER)}.`
      )
    }
  } finally {
    await Promise.all([curator.close(), ...stores.map((store) => store.close())])
  }

  return {
    step: 'write',
    stored: extractor.extracted.map((content) => ({ content, storeName: WRITABLE_STORE })),
    curated: [{ content: CURATED_ENTRY, storeName: CURATED_STORE }],
    writableStore: WRITABLE_STORE,
  }
}

async function recall(args: StepArguments, uri: string) {
  const stores = buildStores(args, uri)
  // MemoryManager.search needs no agent and no model.
  const manager = new MemoryManager({ stores: [...stores] })
  const hits: Array<{ content: string; score: number; storeName: string | undefined; scope: unknown }> = []

  try {
    say(`searching ${stores.length} stores in one collection for ${quoted(QUERY)}`)
    const results = await manager.search(QUERY)
    say(`${results.length} hit(s), each attributed to the store that answered`)
    for (const entry of results) {
      const score = Number(entry.metadata?.['_relevanceScore'] ?? 0)
      const scope = entry.metadata?.['_scope']
      say(`  [${entry.storeName}] score ${score.toFixed(4)}, scope ${quoted(String(scope))}: ${quoted(entry.content)}`)
      hits.push({ content: entry.content, score, storeName: entry.storeName, scope })
    }
    if (hits.length === 0) {
      // Atlas embeds a document after the write is acknowledged, and a search before then finds nothing.
      say('nothing came back. Three causes, in the order worth checking:')
      say('  the write step has not run against this database and collection;')
      say('  Atlas has not finished embedding it yet, which takes a few seconds after the write')
      say('    returns, so if the write step just finished, wait and run this again;')
      say('  or a store search failed. MemoryManager logs a warning for that and returns the hits')
      say('    it did get, so check above for one.')
    }
  } finally {
    await Promise.all(stores.map((store) => store.close()))
  }

  return { step: 'recall', query: QUERY, hits, writableStore: WRITABLE_STORE }
}

const PLANS = {
  write: [
    `seed ${quoted(CURATED_STORE)} with one curated entry, through a writable instance of it`,
    `build ${quoted(WRITABLE_STORE)} (writable, extraction on) and ${quoted(CURATED_STORE)} (read-only)`,
    'run one agent turn, so InvocationTrigger has an invocation to fire after',
    'await MemoryManager.flush(), so the background extraction write completes before exit',
    `extract and store the fact: ${quoted(factFrom(TURN))}`,
    `leave the recall step to search for it with the query: ${quoted(QUERY)}`,
  ],
  recall: [
    'build the same two stores in this process, which has seen none of the write step',
    `search both for ${quoted(QUERY)} and print each hit with its score and store`,
  ],
}

await main(SCRIPT, async () => {
  requireDisjoint(factFrom(TURN), QUERY)
  const args = parseStep(SCRIPT, STEPS, { scope: 'bistro-demo' })
  if (args.dryRun) return dryRun(args, PLANS[args.step as keyof typeof PLANS])

  const uri = connection()
  announce(args, uri)
  // Two processes on purpose: the only thing that reaches the recall step is what MongoDB holds.
  const summary = args.step === 'write' ? await write(args, uri) : await recall(args, uri)
  if (args.next) say(`now run, in a new process: ${args.next}`)
  emitSummary(summary, args)
})
