import { describe, expect, it, vi } from 'vitest'
import { defaultLogger, logFields } from '../logging.js'

describe('defaultLogger', () => {
  it('keeps debug and info silent', () => {
    const spies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    )
    defaultLogger.debug(`strands_mongodb: quiet | ${logFields('creating_indexes')}`)
    defaultLogger.info(`strands_mongodb: quiet | ${logFields('creating_indexes')}`)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('sends warn and error to the console with every argument', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    defaultLogger.warn('strands_mongodb: loud', { event: 'below_vector' })
    defaultLogger.error('strands_mongodb: louder', { event: 'tier_unavailable' })
    expect(warn).toHaveBeenCalledExactlyOnceWith('strands_mongodb: loud', { event: 'below_vector' })
    expect(error).toHaveBeenCalledExactlyOnceWith('strands_mongodb: louder', { event: 'tier_unavailable' })
  })
})

describe('logFields', () => {
  it('renders the event alone', () => {
    expect(logFields('no_search_setup')).toBe('event=no_search_setup')
  })

  it('renders the namespace after the event', () => {
    expect(logFields('creating_indexes', { namespace: 'agents.memory' })).toBe(
      'event=creating_indexes, namespace=agents.memory'
    )
  })

  it('renders namespace and tier together', () => {
    expect(logFields('tier_unavailable', { namespace: 'agents.memory', tier: 'text' })).toBe(
      'event=tier_unavailable, namespace=agents.memory, tier=text'
    )
  })
})
