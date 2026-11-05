import { StorageError } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'
import { abbreviate, NAMESPACED, normalizeKey, normalizePrefix, successor, tokenize } from '../keys.js'

describe('NAMESPACED', () => {
  it('is the global symbol the SDK reads', () => {
    expect(NAMESPACED).toBe(Symbol.for('strands.storage.namespaced'))
  })
})

describe('normalizeKey', () => {
  it('collapses slash runs', () => {
    expect(normalizeKey('a//b')).toBe('a/b')
  })

  it('strips leading and trailing slashes', () => {
    expect(normalizeKey('/a/b/')).toBe('a/b')
  })

  it.each(['', '/', '//'])('rejects the empty key %j', (key) => {
    expect(() => normalizeKey(key)).toThrow(new StorageError('Storage key must not be empty'))
  })

  it('rejects a .. segment', () => {
    expect(() => normalizeKey('a/../b')).toThrow(StorageError)
  })

  it('accepts .. inside a segment', () => {
    expect(normalizeKey('a/b..c')).toBe('a/b..c')
  })

  it('rejects a backslash', () => {
    expect(() => normalizeKey('a\\b')).toThrow(StorageError)
  })
})

describe('normalizePrefix', () => {
  it('collapses slash runs and keeps one trailing slash', () => {
    expect(normalizePrefix('a//b/')).toBe('a/b/')
  })

  it('strips leading slashes', () => {
    expect(normalizePrefix('/a/b')).toBe('a/b')
  })

  it.each(['', '/'])('normalizes %j to the empty prefix', (prefix) => {
    expect(normalizePrefix(prefix)).toBe('')
  })

  it('rejects a .. segment', () => {
    expect(() => normalizePrefix('a/..')).toThrow(StorageError)
  })

  it('rejects a backslash', () => {
    expect(() => normalizePrefix('a\\')).toThrow(StorageError)
  })
})

describe('tokenize', () => {
  it('lowercases and splits on anything but letters, numbers and underscore', () => {
    expect(tokenize('Hello, wörld_1 日本語')).toEqual(new Set(['hello', 'wörld_1', '日本語']))
  })

  it('returns an empty set for punctuation only', () => {
    expect(tokenize(' ,.; ')).toEqual(new Set())
  })
})

describe('successor', () => {
  it('increments an ordinary last character', () => {
    expect(successor('a')).toBe('b')
  })

  it('increments a supplementary character as one code point', () => {
    expect(successor('a\u{1F600}')).toBe('a\u{1F601}')
  })

  it('steps over the surrogate range from U+D7FF to U+E000', () => {
    expect(successor('a\uD7FF')).toBe('a\uE000')
  })

  it('carries left past a last character of U+10FFFF', () => {
    expect(successor('a\u{10FFFF}')).toBe('b')
  })

  it.each(['\u{10FFFF}', '\u{10FFFF}\u{10FFFF}'])('has no bound for %j, made only of U+10FFFF', (text) => {
    expect(successor(text)).toBeUndefined()
  })
})

describe('abbreviate', () => {
  it('keeps a key of 60 characters', () => {
    const key = 'k'.repeat(60)
    expect(abbreviate(key)).toBe(key)
  })

  it('cuts a longer key at 60 characters and counts the rest', () => {
    expect(abbreviate('k'.repeat(1025))).toBe(`${'k'.repeat(60)}[+965 more]`)
  })

  it('counts code points, so a surrogate pair is never split', () => {
    expect(abbreviate('\u{1F600}'.repeat(61))).toBe(`${'\u{1F600}'.repeat(60)}[+1 more]`)
  })
})
