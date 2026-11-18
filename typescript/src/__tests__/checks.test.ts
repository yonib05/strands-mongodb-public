import { describe, expect, it } from 'vitest'
import { errorOf } from '../__fixtures__/errors.js'
import { requireNumber, requireString } from '../checks.js'

describe('requireNumber', () => {
  it.each([0, 0.5, 60])('accepts %d within the bounds', (value) => {
    expect(() => requireNumber('ttlSeconds', value, { min: 0 })).not.toThrow()
  })

  it.each([-1, NaN, Infinity, '8', null])('rejects %s with a RangeError naming the key and the value', (value) => {
    const error = errorOf(() => requireNumber('ttlSeconds', value, { min: 0 }))

    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toMatch(/^strands_mongodb: 'ttlSeconds' is /)
    expect(error.message).toContain(String(value))
  })

  it('rejects a fraction where a count is needed, and a value above the ceiling', () => {
    expect(() => requireNumber('dimensions', 1.5, { min: 1, max: 8, integer: true })).toThrow(RangeError)
    expect(errorOf(() => requireNumber('dimensions', 9, { min: 1, max: 8, integer: true })).message).toContain('1..8')
  })
})

describe('requireString', () => {
  it.each([5, null, { $ne: '' }, ['a']])('rejects %j with a TypeError naming the key', (value) => {
    const error = errorOf(() => requireString('collection', value))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain("'collection'")
  })

  it('accepts a string', () => {
    expect(() => requireString('collection', 'memory')).not.toThrow()
  })
})
