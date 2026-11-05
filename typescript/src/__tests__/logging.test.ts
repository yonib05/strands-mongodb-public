import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { defaultLogger, fields, resolveLogger, type LogEvent, type LogFields } from '../logging.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LogEvent', () => {
  it('names the fourteen Python events', () => {
    expectTypeOf<LogEvent>().toEqualTypeOf<
      | 'retry_writes_disabled'
      | 'attribution_not_visible'
      | 'closed_loop_client_dropped'
      | 'reserved_key_collision'
      | 'no_search_setup'
      | 'tier_unavailable'
      | 'tier_building'
      | 'below_vector'
      | 'bound_declined_fusion'
      | 'score_bound_applied'
      | 'creating_indexes'
      | 'creating_search_index'
      | 'search_index_status'
      | 'attribute_dropped'
    >()
  })
})

describe('defaultLogger', () => {
  describe('debug and info', () => {
    it('are silent', () => {
      const spies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {})
      )
      defaultLogger.debug('strands_mongodb: quiet', fields('creating_indexes'))
      defaultLogger.info('strands_mongodb: quiet', fields('creating_indexes'))
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('warn and error', () => {
    it('reach the console with every argument', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      defaultLogger.warn('strands_mongodb: loud', { event: 'below_vector' })
      defaultLogger.error('strands_mongodb: louder', { event: 'tier_unavailable' })
      expect(warn).toHaveBeenCalledExactlyOnceWith('strands_mongodb: loud', { event: 'below_vector' })
      expect(error).toHaveBeenCalledExactlyOnceWith('strands_mongodb: louder', { event: 'tier_unavailable' })
    })
  })
})

describe('resolveLogger', () => {
  it('returns the configured logger', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    expect(resolveLogger({ database: 'agents', logger })).toBe(logger)
  })

  it('falls back to the default logger', () => {
    expect(resolveLogger({ database: 'agents' })).toBe(defaultLogger)
  })
})

describe('fields', () => {
  it('carries the event alone when nothing else is given', () => {
    expect(fields('no_search_setup')).toStrictEqual({ event: 'no_search_setup' })
  })

  it('omits an absent key rather than setting it to undefined', () => {
    expect(fields('tier_building', { tier: 'vector' })).toStrictEqual({ event: 'tier_building', tier: 'vector' })
    expect(fields('tier_building', {})).toStrictEqual({ event: 'tier_building' })
  })

  it('carries namespace and tier together', () => {
    const result = fields('tier_unavailable', { namespace: 'agents.memory', tier: 'text' })
    expect(result).toStrictEqual({ event: 'tier_unavailable', namespace: 'agents.memory', tier: 'text' })
    expectTypeOf(result).toEqualTypeOf<LogFields>()
  })
})
