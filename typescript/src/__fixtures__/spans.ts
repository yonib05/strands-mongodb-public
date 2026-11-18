import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'

/** Installs an in-memory exporter as the global tracer for the calling test file, reset between tests. */
export function recordSpans(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter()

  beforeAll(() => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }))
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  })

  afterAll(() => {
    trace.disable()
    context.disable()
  })

  afterEach(() => exporter.reset())

  return exporter
}

/** The tiers on the most recent span that reported `strands_mongodb.search.tiers`. */
export function reportedTiers(exporter: InMemorySpanExporter): string[] {
  const reported = exporter
    .getFinishedSpans()
    .map((finished) => finished.attributes['strands_mongodb.search.tiers'])
    .filter((tiers) => tiers !== undefined)
  expect(reported.length).toBeGreaterThan(0)
  return String(reported.at(-1)).split(',').filter(Boolean)
}

/** Every finished span called `name`. */
export function spansNamed(exporter: InMemorySpanExporter, name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((finished) => finished.name === name)
}

/** The single finished span called `name`, failing the test if there is not exactly one. */
export function oneSpan(exporter: InMemorySpanExporter, name: string): ReadableSpan {
  const spans = spansNamed(exporter, name)
  expect(spans.map((finished) => finished.name)).toEqual([name])
  return spans[0]!
}
