import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import type { Logger } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'
import { oneSpan, recordSpans } from '../__fixtures__/spans.js'
import type { Attribute } from '../telemetry.js'
import { annotate, ATTRIBUTES, event, span, traced } from '../telemetry.js'

const exporter = recordSpans()

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function one(name: string): ReadableSpan {
  return oneSpan(exporter, name)
}

class StorageError extends Error {}

describe('ATTRIBUTES', () => {
  it('matches the Python allow-list name for name', () => {
    const source = readFileSync(new URL('../../../python/src/strands_mongodb/_telemetry.py', import.meta.url), 'utf8')
    const literal = /^Attribute = Literal\[(.*?)^\]/ms.exec(source)?.[1] ?? ''
    const python = [...literal.matchAll(/"([^"]+)"/g)].map((match) => match[1])

    expect(python).toHaveLength(15)
    expect(ATTRIBUTES).toEqual(python)
  })
})

describe('traced', () => {
  describe('AT-205: kind, namespace attributes, and no db.* key', () => {
    it('records an internal span carrying the namespace and the store', async () => {
      const logger = silentLogger()
      const base = { database: 'appdb', collection: 'things', storeName: 'facts', logger }

      const result = await traced('memory', 'probe', base, async () => {
        await Promise.resolve()
        annotate('strands_mongodb.result_count', 3, logger)
        return 'x'
      })

      expect(result).toBe('x')
      const recorded = one('strands_mongodb.memory.probe')
      expect(recorded.kind).toBe(SpanKind.INTERNAL)
      expect(recorded.instrumentationScope.name).toBe('strands_mongodb')
      expect(recorded.attributes).toEqual({
        'strands_mongodb.database': 'appdb',
        'strands_mongodb.collection': 'things',
        'strands_mongodb.store_name': 'facts',
        'strands_mongodb.result_count': 3,
      })
      expect(recorded.status.code).toBe(SpanStatusCode.UNSET)
    })

    it('omits the store name when there is none', async () => {
      await traced(
        'storage',
        'read',
        { database: 'appdb', collection: 'things', logger: silentLogger() },
        async () => {}
      )

      expect(one('strands_mongodb.storage.read').attributes).toEqual({
        'strands_mongodb.database': 'appdb',
        'strands_mongodb.collection': 'things',
      })
    })
  })

  describe('AT-207: status and type, never the message, and the raise unchanged', () => {
    it('marks a raising operation as an error named by class alone', async () => {
      const thrown = new StorageError('strands_mongodb: searching MARKER-KEY failed')
      const base = { database: 'appdb', collection: 'things', logger: silentLogger() }

      const caught = await traced('memory', 'probe', base, async () => {
        await Promise.resolve()
        throw thrown
      }).catch((error: unknown) => error)

      expect(caught).toBe(thrown)
      const recorded = one('strands_mongodb.memory.probe')
      expect(recorded.status).toEqual({ code: SpanStatusCode.ERROR, message: 'StorageError' })
      expect(recorded.attributes['error.type']).toBe('StorageError')
      expect(recorded.events).toEqual([])
      expect(JSON.stringify([recorded.attributes, recorded.status, recorded.events])).not.toContain('MARKER-KEY')
    })

    it('names a non-Error throw Error and rethrows it unchanged', async () => {
      const base = { database: 'appdb', collection: 'things', logger: silentLogger() }

      const caught = await traced('storage', 'write', base, () => Promise.reject('MARKER-KEY')).catch(
        (error: unknown) => error
      )

      expect(caught).toBe('MARKER-KEY')
      const recorded = one('strands_mongodb.storage.write')
      expect(recorded.status).toEqual({ code: SpanStatusCode.ERROR, message: 'Error' })
      expect(recorded.attributes['error.type']).toBe('Error')
    })
  })
})

describe('span', () => {
  describe('AT-204: index work is a child of the operation that caused it', () => {
    it('opens under the traced span across an await', async () => {
      const logger = silentLogger()
      const base = { database: 'appdb', collection: 'things', storeName: 'facts', logger }

      await traced('memory', 'initialize', base, async () => {
        await Promise.resolve()
        await span('strands_mongodb.indexes.ensure', { 'strands_mongodb.indexes.mode': 'create' }, async () => {
          await Promise.resolve()
          annotate('strands_mongodb.indexes.created', 2, logger)
        })
      })

      const parent = one('strands_mongodb.memory.initialize')
      const child = one('strands_mongodb.indexes.ensure')
      expect(child.kind).toBe(SpanKind.INTERNAL)
      expect(child.spanContext().traceId).toBe(parent.spanContext().traceId)
      expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
      expect(child.attributes).toEqual({
        'strands_mongodb.indexes.mode': 'create',
        'strands_mongodb.indexes.created': 2,
      })
      expect(parent.attributes).not.toHaveProperty('strands_mongodb.indexes.created')
    })

    it('marks a failure and rethrows the same object', async () => {
      const thrown = new TypeError('MARKER-KEY')

      const caught = await span('strands_mongodb.indexes.wait', {}, () => Promise.reject(thrown)).catch(
        (error: unknown) => error
      )

      expect(caught).toBe(thrown)
      const recorded = one('strands_mongodb.indexes.wait')
      expect(recorded.status).toEqual({ code: SpanStatusCode.ERROR, message: 'TypeError' })
      expect(recorded.attributes).toEqual({ 'error.type': 'TypeError' })
    })

    it('drops an attribute that is not on the allow-list', async () => {
      const attributes = { 'strands_mongodb.query': 'MARKER-KEY' } as Partial<Record<Attribute, string>>

      await span('strands_mongodb.indexes.probe', attributes, async () => {})

      expect(one('strands_mongodb.indexes.probe').attributes).toEqual({})
    })
  })
})

describe('annotate', () => {
  describe('AT-214: dropped rather than raised at runtime', () => {
    it('is a no-op outside any span', () => {
      const logger = silentLogger()

      annotate('strands_mongodb.result_count', 1, logger)

      expect(exporter.getFinishedSpans()).toEqual([])
      expect(logger.debug).not.toHaveBeenCalled()
    })

    it('drops an unknown name and logs it at debug', async () => {
      const logger = silentLogger()

      await trace.getTracer('host').startActiveSpan('host', async (host) => {
        annotate('strands_mongodb.query' as Attribute, 'MARKER-KEY', logger)
        host.end()
      })

      expect(one('host').attributes).toEqual({})
      expect(logger.debug).toHaveBeenCalledExactlyOnceWith(
        'strands_mongodb: dropped span attribute strands_mongodb.query, which is not on the allow-list | event=attribute_dropped'
      )
      expect(logger.info).not.toHaveBeenCalled()
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })
})

describe('event', () => {
  describe('AT-203: a new pool is an event on the span that caused it', () => {
    it('lands on the active span with only the allowed attributes', async () => {
      const base = { database: 'appdb', collection: 'things', logger: silentLogger() }
      const attributes = {
        'strands_mongodb.client.injected': false,
        'strands_mongodb.scope': 'MARKER-KEY',
      } as Partial<Record<Attribute, boolean | string>>

      await traced('storage', 'write', base, async () => {
        await Promise.resolve()
        event('strands_mongodb.client.acquired', attributes)
      })

      const recorded = one('strands_mongodb.storage.write')
      expect(recorded.events.map(({ name, attributes }) => ({ name, attributes }))).toEqual([
        { name: 'strands_mongodb.client.acquired', attributes: { 'strands_mongodb.client.injected': false } },
      ])
    })
  })
})
