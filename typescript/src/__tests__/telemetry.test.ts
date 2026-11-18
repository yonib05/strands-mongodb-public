import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { describe, expect, it } from 'vitest'
import { oneSpan, recordSpans } from '../__fixtures__/spans.js'
import { annotate, ATTRIBUTES, event, open, span, traced } from '../telemetry.js'

const exporter = recordSpans()

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
      const base = { database: 'appdb', collection: 'things', storeName: 'facts' }

      const result = await traced('memory', 'probe', base, async () => {
        await Promise.resolve()
        annotate('strands_mongodb.result_count', 3)
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

    it("names the package's version as the scope version, on both kinds of span", async () => {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
        version: string
      }

      await traced('memory', 'initialize', { database: 'appdb', collection: 'things' }, async () =>
        open('strands_mongodb.indexes.wait', {}).end()
      )

      expect(one('strands_mongodb.memory.initialize').instrumentationScope.version).toBe(pkg.version)
      expect(one('strands_mongodb.indexes.wait').instrumentationScope.version).toBe(pkg.version)
    })

    it('omits the store name when there is none', async () => {
      await traced('storage', 'read', { database: 'appdb', collection: 'things' }, async () => {})

      expect(one('strands_mongodb.storage.read').attributes).toEqual({
        'strands_mongodb.database': 'appdb',
        'strands_mongodb.collection': 'things',
      })
    })
  })

  describe('AT-207: status and type, never the message, and the raise unchanged', () => {
    it('marks a raising operation as an error named by class alone', async () => {
      const thrown = new StorageError('strands_mongodb: searching MARKER-KEY failed')
      const base = { database: 'appdb', collection: 'things' }

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
      const base = { database: 'appdb', collection: 'things' }

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
      const base = { database: 'appdb', collection: 'things', storeName: 'facts' }

      await traced('memory', 'initialize', base, async () => {
        await Promise.resolve()
        await span('strands_mongodb.indexes.ensure', { 'strands_mongodb.indexes.mode': 'create' }, async () => {
          await Promise.resolve()
          annotate('strands_mongodb.indexes.created', 2)
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
  })
})

describe('open', () => {
  describe('AT-204: a span ended by hand still sits under the operation that caused it', () => {
    it('opens under the active span, sets the closing attributes, and ends unset', async () => {
      const base = { database: 'appdb', collection: 'things' }

      await traced('memory', 'initialize', base, async () => {
        const wait = open('strands_mongodb.indexes.wait', { 'strands_mongodb.collection': 'things' })
        await Promise.resolve()
        wait.end({ attributes: { 'strands_mongodb.indexes.outcome': 'ready' } })
      })

      const recorded = one('strands_mongodb.indexes.wait')
      expect(recorded.kind).toBe(SpanKind.INTERNAL)
      expect(recorded.parentSpanContext?.spanId).toBe(one('strands_mongodb.memory.initialize').spanContext().spanId)
      expect(recorded.attributes).toEqual({
        'strands_mongodb.collection': 'things',
        'strands_mongodb.indexes.outcome': 'ready',
      })
      expect(recorded.status.code).toBe(SpanStatusCode.UNSET)
    })

    it('ends at the time it is given', () => {
      const at = Date.now() + 5000

      open('strands_mongodb.indexes.wait', {}).end({ at })

      const [seconds, nanoseconds] = one('strands_mongodb.indexes.wait').endTime
      expect(seconds * 1000 + Math.floor(nanoseconds / 1e6)).toBe(at)
    })

    it('marks a failure by class alone', () => {
      const wait = open('strands_mongodb.indexes.wait', {})

      wait.end({ error: new StorageError('strands_mongodb: MARKER-KEY') })

      const recorded = one('strands_mongodb.indexes.wait')
      expect(recorded.status).toEqual({ code: SpanStatusCode.ERROR, message: 'StorageError' })
      expect(recorded.attributes).toEqual({ 'error.type': 'StorageError' })
    })
  })
})

describe('annotate', () => {
  it('is a no-op outside any span', () => {
    annotate('strands_mongodb.result_count', 1)

    expect(exporter.getFinishedSpans()).toEqual([])
  })

  it('sets the attribute on the active span', async () => {
    await trace.getTracer('host').startActiveSpan('host', async (host) => {
      annotate('strands_mongodb.result_count', 1)
      host.end()
    })

    expect(one('host').attributes).toEqual({ 'strands_mongodb.result_count': 1 })
  })
})

describe('event', () => {
  describe('AT-203: a new pool is an event on the span that caused it', () => {
    it('lands on the active span with its attributes', async () => {
      await traced('storage', 'write', { database: 'appdb', collection: 'things' }, async () => {
        await Promise.resolve()
        event('strands_mongodb.client.acquired', { 'strands_mongodb.client.injected': false })
      })

      const recorded = one('strands_mongodb.storage.write')
      expect(recorded.events.map(({ name, attributes }) => ({ name, attributes }))).toEqual([
        { name: 'strands_mongodb.client.acquired', attributes: { 'strands_mongodb.client.injected': false } },
      ])
    })
  })
})
