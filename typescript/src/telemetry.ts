import { context, type AttributeValue, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { PACKAGE_VERSION } from './version.js'

/** Every `strands_mongodb.*` attribute name the package may set, identical to the Python package's. */
export const ATTRIBUTES = [
  'strands_mongodb.store_name',
  'strands_mongodb.search.requested',
  'strands_mongodb.search.tier',
  'strands_mongodb.search.tiers',
  'strands_mongodb.result_count',
  'strands_mongodb.deleted_count',
  'strands_mongodb.found',
  'strands_mongodb.duplicate',
  'strands_mongodb.database',
  'strands_mongodb.collection',
  'strands_mongodb.client.injected',
  'strands_mongodb.indexes.mode',
  'strands_mongodb.indexes.created',
  'strands_mongodb.indexes.outcome',
  'strands_mongodb.indexes.probe',
] as const

/** One of {@link ATTRIBUTES}. The type is the guard that keeps caller data off a span. */
export type Attribute = (typeof ATTRIBUTES)[number]

/** Attributes for a span or an event. */
export type Attributes = Partial<Record<Attribute, AttributeValue>>

/** Every span opened by {@link span} or {@link open} rather than by {@link traced}. */
export type SpanName =
  'strands_mongodb.indexes.ensure' | 'strands_mongodb.indexes.probe' | 'strands_mongodb.indexes.wait'

/** Every span event the package may add. */
export type EventName = 'strands_mongodb.client.acquired'

/** What every operation span carries, read off the store and never off the call. */
export interface SpanBase {
  database: string
  collection: string
  storeName?: string
}

/**
 * Records one `INTERNAL` span named `strands_mongodb.<surface>.<operation>` around a store operation.
 *
 * @param surface - `storage` or `memory`
 * @param operation - The public method's name
 * @param base - The store's namespace, and its name for a memory store
 * @param fn - The operation, run with the span active
 * @returns Whatever `fn` resolves to
 * @throws Whatever `fn` throws, as the same object, after the span is marked
 */
export function traced<T>(
  surface: 'storage' | 'memory',
  operation: string,
  base: SpanBase,
  fn: () => Promise<T>
): Promise<T> {
  const attributes: Attributes = {
    'strands_mongodb.database': base.database,
    'strands_mongodb.collection': base.collection,
  }
  if (base.storeName !== undefined) attributes['strands_mongodb.store_name'] = base.storeName
  return run(`strands_mongodb.${surface}.${operation}`, attributes, fn)
}

/**
 * Opens an `INTERNAL` child span under the active one, for work a store operation causes.
 *
 * @param name - An index span name
 * @param attributes - Its starting attributes
 * @param fn - The work, run with the span active
 * @returns Whatever `fn` resolves to
 * @throws Whatever `fn` throws, as the same object, after the span is marked
 */
export function span<T>(name: SpanName, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  return run(name, attributes, fn)
}

/**
 * Sets an outcome attribute on the active span; a no-op when there is none.
 *
 * @param name - The attribute name
 * @param value - A count, flag, tier name or configuration value, never anything the caller supplied
 */
export function annotate(name: Attribute, value: AttributeValue): void {
  trace.getActiveSpan()?.setAttribute(name, value)
}

/**
 * Adds an event to the active span; a no-op when there is none.
 *
 * @param name - The event name
 * @param attributes - The event's attributes
 */
export function event(name: EventName, attributes: Attributes): void {
  trace.getActiveSpan()?.addEvent(name, attributes)
}

/** How a span ended by hand finished. */
export interface SpanEnd {
  /** Attributes to set before ending. */
  attributes?: Attributes
  /** Marks the span as failed by this error's class. */
  error?: unknown
  /** End time in epoch milliseconds. Defaults to now. */
  at?: number
}

/** A span ended by hand, for work that spans several rounds of a loop rather than one function. */
export interface OpenSpan {
  /** Ends the span, with its status unset unless `error` is given. */
  end(result?: SpanEnd): void
}

/**
 * Opens an `INTERNAL` child span under the active one and hands it back for the caller to end.
 *
 * @param name - An index span name
 * @param attributes - Its starting attributes
 * @returns The handle that ends the span
 */
export function open(name: SpanName, attributes: Attributes): OpenSpan {
  const current = tracer().startSpan(name, { kind: SpanKind.INTERNAL, attributes })
  return {
    end: ({ attributes: final = {}, error, at } = {}): void => {
      current.setAttributes(final)
      if (error !== undefined) mark(current, error)
      current.end(at)
    },
  }
}

function tracer(): ReturnType<typeof trace.getTracer> {
  return trace.getTracer('strands_mongodb', PACKAGE_VERSION)
}

async function run<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  const current = tracer().startSpan(name, { kind: SpanKind.INTERNAL, attributes })
  try {
    return await context.with(trace.setSpan(context.active(), current), fn)
  } catch (error) {
    mark(current, error)
    throw error
  } finally {
    current.end()
  }
}

function mark(current: Span, error: unknown): void {
  const kind = error instanceof Error ? error.constructor.name : 'Error'
  current.setStatus({ code: SpanStatusCode.ERROR, message: kind })
  current.setAttribute('error.type', kind)
}
