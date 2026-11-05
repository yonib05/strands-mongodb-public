// normalizeKey, normalizePrefix and tokenize are verbatim copies from strands-ts at 74bb30721,
// which exports none of them from a public subpath.
import { StorageError } from '@strands-agents/sdk'

/**
 * Symbol present on namespaced storage views. The same global symbol the SDK reads, so its
 * constructs recognise a namespaced `MongoDBStorage` without importing SDK internals.
 */
export const NAMESPACED: unique symbol = Symbol.for('strands.storage.namespaced')

/**
 * Validates and normalizes a storage key: collapses runs of `/` and strips leading and trailing `/`.
 *
 * @param key - The raw key to normalize
 * @returns The normalized key
 * @throws {@link StorageError} if the key is empty, contains a backslash or a `..` segment
 */
export function normalizeKey(key: string): string {
  if (key.includes('\\')) {
    throw new StorageError(`Invalid storage key '${key}': backslashes are not allowed`)
  }
  const segments = key.split('/').filter(Boolean)
  if (segments.length === 0) {
    throw new StorageError('Storage key must not be empty')
  }
  if (segments.includes('..')) {
    throw new StorageError(`Invalid storage key '${key}': '..' path segments are not allowed`)
  }
  return segments.join('/')
}

/**
 * Normalizes a list prefix: collapses slash runs, strips leading slashes. An empty prefix matches everything.
 *
 * @param prefix - The raw prefix to normalize
 * @returns The normalized prefix
 * @throws {@link StorageError} if the prefix contains a backslash or a `..` segment
 */
export function normalizePrefix(prefix: string): string {
  if (prefix.includes('\\')) {
    throw new StorageError(`Invalid storage prefix '${prefix}': backslashes are not allowed`)
  }
  const parts = prefix.split('/')
  const segments = parts.filter(Boolean)
  if (segments.includes('..')) {
    throw new StorageError(`Invalid storage prefix '${prefix}': '..' path segments are not allowed`)
  }
  const joined = segments.join('/')
  const normalized = parts[parts.length - 1] === '' && joined ? joined + '/' : joined
  return normalized
}

/**
 * Splits text into lowercased word tokens, as the SDK's `KeywordSearchStrategy` does.
 *
 * @param text - The text to tokenize
 * @returns The distinct tokens
 */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
  )
}

/**
 * Smallest string that sorts above every key starting with `text`: the exclusive upper bound of
 * the `_id` range scan. Works on code points, stepping over the surrogate range BSON cannot encode.
 *
 * @param text - The prefix the range starts at, never empty
 * @returns The bound, or `undefined` when the prefix is made only of U+10FFFF and has none
 */
export function successor(text: string): string | undefined {
  const chars = Array.from(text)
  for (let index = chars.length - 1; index >= 0; index--) {
    let point = chars[index]!.codePointAt(0)! + 1
    if (point === 0xd800) point = 0xe000
    // Carry left: every string starting with `text` also starts with the shorter prefix.
    if (point > 0x10ffff) continue
    return chars.slice(0, index).join('') + String.fromCodePoint(point)
  }
  return undefined
}

/**
 * Shortens a key for an error message.
 *
 * @param key - The key to shorten
 * @returns The first 60 code points, followed by `[+N more]` when the key is longer
 */
export function abbreviate(key: string): string {
  const chars = Array.from(key)
  return chars.length <= 60 ? key : `${chars.slice(0, 60).join('')}[+${chars.length - 60} more]`
}
