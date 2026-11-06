// Shared scaffolding for the two examples beside it. Not part of the package and not an API.
import { parseArgs } from 'node:util'
import {
  BedrockModel,
  type BaseModelConfig,
  type JSONValue,
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  type ModelStreamEvent,
} from '@strands-agents/sdk'
import type { Collection } from 'mongodb'
import type { MongoDBConfig } from '../src/index.js'

export const URI_VARIABLE = 'MONGODB_URI'
export const DATABASE_VARIABLE = 'MONGODB_DATABASE'

const MODELS = ['scripted', 'bedrock'] as const
type ModelName = (typeof MODELS)[number]

/** A condition the reader can fix, printed as one line with no stack trace. */
export class ExampleError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1
  ) {
    super(message)
  }
}

/** The parsed command line, with every default filled in. */
export interface StepArguments {
  step: string
  next: string | undefined
  dryRun: boolean
  summaryJson: boolean
  model: ModelName
  database: string
  collection: string
  /** The script's own options, such as `--scope`, by name. */
  options: Record<string, string>
}

let line = 0

/**
 * Prints one numbered line, so a transcript can be referred to by line.
 *
 * @param message - One line, worded for a reader
 */
export function say(message: string): void {
  line += 1
  console.log(`${String(line).padStart(2)}. ${message}`)
}

/**
 * Wraps a string in single quotes for display.
 *
 * @param text - Any string
 * @returns The quoted string
 */
export function quoted(text: string): string {
  return `'${text}'`
}

/**
 * Replaces everything between `://` and `@`, which is where a password sits.
 *
 * @param uri - A MongoDB connection string
 * @returns The same string with any credentials replaced by `<redacted>`
 */
export function redact(uri: string): string {
  return uri.replace(/:\/\/[^@/]+@/, '://<redacted>@')
}

/**
 * Reads the connection string, or stops with exit code 2 and says what to set.
 *
 * @returns The value of `MONGODB_URI`
 */
export function connection(): string {
  const uri = process.env[URI_VARIABLE]
  if (!uri) {
    throw new ExampleError(
      `${URI_VARIABLE} is not set. Point it at a deployment this example may write to, for example from a ` +
        `file you keep out of version control:\n    set -a; . .env; set +a\n` +
        'Pass --dry-run to see what a step would do without connecting to anything.',
      2
    )
  }
  return uri
}

/**
 * Builds the config both surfaces take. A connection string leaves the client's lifecycle to the package.
 *
 * @param uri - A MongoDB connection string
 * @param database - Database to use
 * @returns The `config` for a store
 */
export function mongodbConfig(uri: string, database: string): MongoDBConfig {
  return { connectionString: uri, database }
}

function shellQuote(value: string): string {
  return /^[\w./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Parses `<step> [--dry-run] [--summary-json] [--model] [--collection]` plus the script's own options.
 * The database comes from `MONGODB_DATABASE`, so it carries to the next step through the shell.
 *
 * @param script - File name of the running example
 * @param steps - Step names, in the order they are meant to run
 * @param own - The script's own options and their defaults
 * @returns The parsed arguments
 */
export function parseStep(script: string, steps: readonly string[], own: Record<string, string>): StepArguments {
  const defaults: Record<string, string> = { model: 'scripted', collection: 'example', ...own }
  const flags = Object.keys(defaults).map((name) => `[--${name} <value>]`)
  const usage = `usage: npx tsx examples/${script} <${steps.join(' | ')}> [--dry-run] [--summary-json] ${flags.join(' ')}`
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean', default: false },
        'summary-json': { type: 'boolean', default: false },
        ...Object.fromEntries(Object.keys(defaults).map((name) => [name, { type: 'string' as const }])),
      },
    })
  } catch (error) {
    throw new ExampleError(`${(error as Error).message}\n${usage}`, 2)
  }
  const { positionals, values } = parsed
  const step = positionals[0]
  if (positionals.length !== 1 || step === undefined || !steps.includes(step)) {
    throw new ExampleError(`expected one step, one of ${steps.join(', ')}, in that order\n${usage}`, 2)
  }
  const given = values as Record<string, string | boolean | undefined>
  const value = (name: string) => (typeof given[name] === 'string' ? given[name] : defaults[name]!)
  const model = value('model') as ModelName
  if (!MODELS.includes(model)) throw new ExampleError(`--model is one of ${MODELS.join(', ')}\n${usage}`, 2)

  // A dropped flag would send the next step to a namespace this one never wrote to.
  const carried = Object.keys(defaults)
    .filter((name) => value(name) !== defaults[name])
    .flatMap((name) => [`--${name}`, shellQuote(value(name))])
  const following = steps[steps.indexOf(step) + 1]
  return {
    step,
    next: following && ['npx tsx', `examples/${script}`, following, ...carried].join(' '),
    dryRun: given['dry-run'] === true,
    summaryJson: given['summary-json'] === true,
    model,
    database: process.env[DATABASE_VARIABLE] || 'strands_examples',
    collection: value('collection'),
    options: Object.fromEntries(Object.keys(own).map((name) => [name, value(name)])),
  }
}

/**
 * Says which model runs the turn, so a canned reply is never mistaken for model behaviour.
 *
 * @param name - The value of `--model`
 * @returns One line for {@link say}
 */
export function modelBanner(name: ModelName): string {
  if (name === 'scripted') {
    return (
      'model: scripted. The replies come from a list in the script, so the turn costs nothing and reads the ' +
      'same on every run. Only the model is scripted: the MongoDB calls are real. Pass --model bedrock to run ' +
      "against the SDK's default provider."
    )
  }
  return (
    `model: ${name}. Replies come from the provider, so the wording differs from run to run and the turn costs ` +
    'whatever the provider charges. Pass --model scripted to remove that.'
  )
}

/**
 * Prints one line of JSON when `--summary-json` was passed. Tests read it instead of the prose.
 *
 * @param payload - Anything JSON-serializable
 * @param args - The parsed arguments
 */
export function emitSummary(payload: Record<string, unknown>, args: StepArguments): void {
  if (args.summaryJson) console.log(JSON.stringify(payload))
}

/**
 * Prints what a step would do and the command for the next, connecting to nothing.
 *
 * @param args - The parsed arguments
 * @param plan - One line per action, in order
 */
export function dryRun(args: StepArguments, plan: readonly string[]): void {
  const target = `database ${quoted(args.database)}, collection ${quoted(args.collection)}`
  const uri = process.env[URI_VARIABLE]
  say(`dry run of the ${quoted(args.step)} step. Nothing connects, nothing is written.`)
  say(
    uri
      ? `would connect to ${redact(uri)}, ${target}`
      : `${URI_VARIABLE} is not set, so a real run would stop and ask for it. It would use ${target}`
  )
  say(modelBanner(args.model))
  for (const action of plan) say(`  would ${action}`)
  if (args.next) say(`then run: ${args.next}`)
  emitSummary({ step: args.step, dryRun: true }, args)
}

/**
 * Prints the connection line and the model banner a real step starts with.
 *
 * @param args - The parsed arguments
 * @param uri - The connection string, printed redacted
 */
export function announce(args: StepArguments, uri: string): void {
  say(`connecting to ${redact(uri)}, database ${quoted(args.database)}, collection ${quoted(args.collection)}`)
  say(modelBanner(args.model))
}

/**
 * Runs a script's body and turns an {@link ExampleError} into one line on stderr and its exit code.
 *
 * @param script - File name, prefixed to the error line
 * @param body - The script
 */
export async function main(script: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    if (!(error instanceof ExampleError)) throw error
    console.error(`${script}: ${error.message}`)
    process.exitCode = error.exitCode
  }
}

/** One prefix in the census: its document count and byte total. */
export interface CensusEntry {
  prefix: string
  documents: number
  bytes: number
}

/**
 * Counts documents and bytes per top-level key prefix, read from the collection itself.
 *
 * @param collection - A collection holding storage documents
 * @returns One entry per prefix, sorted by prefix
 */
export async function prefixCensus(collection: Collection): Promise<CensusEntry[]> {
  const groups = await collection
    .aggregate<{ _id: string; documents: number; bytes: number }>([
      {
        $project: {
          prefix: { $arrayElemAt: [{ $split: [{ $toString: '$_id' }, '/'] }, 0] },
          size: { $bsonSize: '$$ROOT' },
        },
      },
      { $group: { _id: '$prefix', documents: { $sum: 1 }, bytes: { $sum: '$size' } } },
      { $sort: { _id: 1 } },
    ])
    .toArray()
  return groups.map((group) => ({ prefix: `${group._id}/`, documents: group.documents, bytes: group.bytes }))
}

/** One scripted assistant reply: text blocks stream as text, `toolUse` blocks as a tool call. */
export type ScriptedReply = Array<{ text: string } | { toolUse: { name: string; toolUseId: string; input: JSONValue } }>

/** A `Model` that reads its replies from a list instead of calling a provider. */
export class ScriptedModel extends Model<BaseModelConfig> {
  // A stated window keeps the context manager from warning that it is estimating one.
  private _config: BaseModelConfig = { modelId: 'scripted', contextWindowLimit: 200_000 }
  private _index = 0

  constructor(private readonly _replies: readonly ScriptedReply[]) {
    super()
  }

  updateConfig(config: BaseModelConfig): void {
    this._config = config
  }

  getConfig(): BaseModelConfig {
    return this._config
  }

  async *stream(): AsyncIterable<ModelStreamEvent> {
    const reply = this._replies[this._index]
    // An empty stream would read as a reply with no content.
    if (reply === undefined) {
      throw new Error(`ScriptedModel ran out of replies after ${this._replies.length}; the turn asked for another`)
    }
    this._index += 1
    yield new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' })
    let stopReason: 'endTurn' | 'toolUse' = 'endTurn'
    for (const block of reply) {
      if ('text' in block) {
        yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' })
        yield new ModelContentBlockDeltaEvent({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: block.text },
        })
      } else {
        stopReason = 'toolUse'
        const { name, toolUseId, input } = block.toolUse
        yield new ModelContentBlockStartEvent({
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name, toolUseId },
        })
        yield new ModelContentBlockDeltaEvent({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) },
        })
      }
      yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' })
    }
    yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason })
  }
}

/**
 * Returns the model `--model` asked for. Bedrock takes the region and credentials the environment has.
 *
 * @param name - `scripted` or `bedrock`
 * @param replies - The script, used only by `scripted`
 * @returns A model for the agent
 */
export function resolveModel(name: ModelName, replies: readonly ScriptedReply[]): Model {
  return name === 'scripted' ? new ScriptedModel(replies) : new BedrockModel()
}
