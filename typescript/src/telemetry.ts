import { context, type AttributeValue, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import type { Logger } from '@strands-agents/sdk'
import { logFields } from './logging.js'
import { packageVersion } from './version.js'

/** Every attribute name the package may set, identical to the Python package's. */
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

/** One of {@link ATTRIBUTES}. */
export type Attribute = (typeof ATTRIBUTES)[number]

/** Every span opened by {@link span} rather than by {@link traced}: index work under the operation that needed it. */
export type SpanName =
  'strands_mongodb.indexes.ensure' | 'strands_mongodb.indexes.probe' | 'strands_mongodb.indexes.wait'

/** Every span event the package may add. */
export type EventName = 'strands_mongodb.client.acquired'

/** What every operation span carries, read off the store and never off the call. */
export interface SpanBase {
  database: string
  collection: string
  storeName?: string
  logger: Logger
}

// The allow-list exists so no caller data (keys, content, metadata, query text, filter values) reaches a span.
const ALLOWED: ReadonlySet<string> = new Set(ATTRIBUTES)

/**
 * Records one `INTERNAL` span named `strands_mongodb.<surface>.<operation>` around a store operation.
 *
 * @param surface - `storage` or `memory`
 * @param operation - The public method's name
 * @param base - The store's namespace, its name for a memory store, and its logger
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
  const attributes: Partial<Record<Attribute, AttributeValue>> = {
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
 * @param attributes - Its starting attributes; names off the allow-list are dropped
 * @param fn - The work, run with the span active
 * @returns Whatever `fn` resolves to
 * @throws Whatever `fn` throws, as the same object, after the span is marked
 */
export function span<T>(
  name: SpanName,
  attributes: Partial<Record<Attribute, AttributeValue>>,
  fn: () => Promise<T>
): Promise<T> {
  return run(name, allowed(attributes), fn)
}

/**
 * Sets an outcome attribute on the active span; a no-op when there is none.
 *
 * @param name - An allow-listed attribute name; any other is dropped and logged at `debug`
 * @param value - A count, flag, tier name or configuration value, never anything the caller supplied
 * @param logger - Where a dropped name is logged
 */
export function annotate(name: Attribute, value: AttributeValue, logger: Logger): void {
  if (!ALLOWED.has(name)) {
    logger.debug(
      `strands_mongodb: dropped span attribute ${name}, which is not on the allow-list | ${logFields('attribute_dropped')}`
    )
    return
  }
  trace.getActiveSpan()?.setAttribute(name, value)
}

/**
 * Adds an event to the active span, keeping only allow-listed attributes.
 *
 * @param name - The event name
 * @param attributes - The event's attributes
 */
export function event(name: EventName, attributes: Partial<Record<Attribute, AttributeValue>>): void {
  trace.getActiveSpan()?.addEvent(name, allowed(attributes))
}

/** A span ended by hand, for work that spans several rounds of a loop rather than one function. */
export interface OpenSpan {
  /** Sets an allow-listed attribute; any other name is dropped. */
  set(name: Attribute, value: AttributeValue): void
  /** Ends the span with its status unset. */
  end(): void
  /** Marks the span as failed by `error`'s class and ends it. */
  fail(error: unknown): void
}

/**
 * Opens an `INTERNAL` child span under the active one and hands it back for the caller to end.
 *
 * @param name - An index span name
 * @param attributes - Its starting attributes; names off the allow-list are dropped
 * @returns The handle that ends the span
 */
export function open(name: SpanName, attributes: Partial<Record<Attribute, AttributeValue>>): OpenSpan {
  const current = trace
    .getTracer('strands_mongodb', packageVersion())
    .startSpan(name, { kind: SpanKind.INTERNAL, attributes: allowed(attributes) })
  return {
    set: (attribute, value): void => {
      if (ALLOWED.has(attribute)) current.setAttribute(attribute, value)
    },
    end: (): void => current.end(),
    fail: (error): void => {
      mark(current, error)
      current.end()
    },
  }
}

async function run<T>(
  name: string,
  attributes: Partial<Record<Attribute, AttributeValue>>,
  fn: () => Promise<T>
): Promise<T> {
  const current = trace
    .getTracer('strands_mongodb', packageVersion())
    .startSpan(name, { kind: SpanKind.INTERNAL, attributes })
  try {
    return await context.with(trace.setSpan(context.active(), current), fn)
  } catch (error) {
    mark(current, error)
    throw error
  } finally {
    current.end()
  }
}

function allowed(attributes: Partial<Record<Attribute, AttributeValue>>): Partial<Record<Attribute, AttributeValue>> {
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => ALLOWED.has(key)))
}

function mark(current: Span, error: unknown): void {
  const kind = error instanceof Error ? error.constructor.name : 'Error'
  current.setStatus({ code: SpanStatusCode.ERROR, message: kind })
  current.setAttribute('error.type', kind)
}
