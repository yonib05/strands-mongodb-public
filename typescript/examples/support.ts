// What the two examples share: the environment, the step argument, and a model that needs no provider.
import {
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
import type { MongoDBConfig } from 'strands-mongodb'

/** Replaces everything between `://` and the last `@`, so a password holding `/` or `@` is covered. */
export function redact(uri: string): string {
  const scheme = uri.indexOf('://')
  const at = uri.lastIndexOf('@')
  return scheme === -1 || at < scheme ? uri : `${uri.slice(0, scheme + 3)}<redacted>${uri.slice(at)}`
}

/** Reads the step from the command line, or exits with code 2 and the usage. */
export function stepFrom<Step extends string>(script: string, steps: readonly Step[]): Step {
  const step = steps.find((candidate) => candidate === process.argv[2])
  if (step === undefined || process.argv.length !== 3) {
    console.error(`usage: npx tsx examples/${script} <${steps.join(' | ')}>`)
    process.exit(2)
  }
  return step
}

/** Reads `MONGODB_URI` and `MONGODB_DATABASE`, or exits with code 2 naming the variable to set. */
export function connection(): MongoDBConfig {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    console.error('MONGODB_URI is not set. Point it at a deployment this example may write to.')
    process.exit(2)
  }
  const database = process.env.MONGODB_DATABASE || 'strands_examples'
  console.log(`connecting to ${redact(uri)}, database '${database}'`)
  return { connectionString: uri, database }
}

/** One assistant reply: text, or a call to a tool. */
export type Reply = { text: string } | { toolUse: { name: string; input: JSONValue } }

/** Replays `replies` in order, one per model call. Replace it with your provider's model. */
export class ScriptedModel extends Model<BaseModelConfig> {
  private _config: BaseModelConfig = { modelId: 'scripted', contextWindowLimit: 200_000 }
  private _next = 0

  constructor(private readonly _replies: readonly Reply[]) {
    super()
  }

  updateConfig(config: BaseModelConfig): void {
    this._config = config
  }

  getConfig(): BaseModelConfig {
    return this._config
  }

  async *stream(): AsyncIterable<ModelStreamEvent> {
    const reply = this._replies[this._next++]
    if (reply === undefined) throw new Error(`ScriptedModel has only ${this._replies.length} replies`)
    yield new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' })
    if ('text' in reply) {
      yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' })
      yield new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: reply.text },
      })
    } else {
      const { name, input } = reply.toolUse
      yield new ModelContentBlockStartEvent({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name, toolUseId: `tooluse-${this._next}` },
      })
      yield new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) },
      })
    }
    yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' })
    yield new ModelMessageStopEvent({
      type: 'modelMessageStopEvent',
      stopReason: 'text' in reply ? 'endTurn' : 'toolUse',
    })
  }
}
