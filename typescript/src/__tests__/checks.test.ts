import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { errorOf } from '../__fixtures__/errors.js'
import {
  requireBoolean,
  requireBytes,
  requireEmbedder,
  requireNumber,
  requireObject,
  requireString,
} from '../checks.js'

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

  it.each(['a\uD800', '\uDC00b', 'a\uD800b'])('rejects an unpaired surrogate, which bson stores as U+FFFD', (value) => {
    const error = errorOf(() => requireString('scope', value))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain("'scope'")
    expect(error.message).toContain('unpaired surrogate')
  })

  it('accepts a surrogate pair', () => {
    expect(() => requireString('scope', 'tenant-\u{1F600}')).not.toThrow()
  })

  it('accepts a string', () => {
    expect(() => requireString('collection', 'memory')).not.toThrow()
  })
})

describe('requireBoolean', () => {
  it.each(['false', 0, null, {}])('rejects %j with a TypeError naming the key', (value) => {
    const error = errorOf(() => requireBoolean('writable', value))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain("'writable'")
  })

  it.each([true, false])('accepts %s', (value) => {
    expect(() => requireBoolean('writable', value)).not.toThrow()
  })
})

describe('requireObject', () => {
  it.each([undefined, null, 'abc', 5, ['a']])('rejects %j with a TypeError naming the key', (value) => {
    const error = errorOf(() => requireObject('metadata', value))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toMatch(/^strands_mongodb: 'metadata' /)
  })

  it('accepts an object', () => {
    expect(() => requireObject('metadata', { tier: 'gold' })).not.toThrow()
  })
})

describe('requireEmbedder', () => {
  it.each([undefined, null, 5, {}, { embed: 'voyage' }])('rejects %j with a TypeError naming the key', (value) => {
    const error = errorOf(() => requireEmbedder(value))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain("'embedder'")
  })

  it('accepts an object with an embed method', () => {
    expect(() => requireEmbedder({ embed: async () => [1] })).not.toThrow()
  })
})

describe('requireBytes', () => {
  it.each([undefined, null, 'text', [1, 2], 7])('rejects %j with a TypeError naming the argument', (value) => {
    const error = errorOf(() => requireBytes('data', value))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain("'data'")
  })

  it('accepts a Uint8Array and a Buffer', () => {
    expect(() => requireBytes('data', new Uint8Array(0))).not.toThrow()
    expect(() => requireBytes('data', Buffer.from('v'))).not.toThrow()
  })
})
