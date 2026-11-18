import type { Embedder } from '@strands-agents/sdk/storage/search'

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Rejects a setting that is not a well-formed string, since an operator object from a JavaScript caller would join a query.
 *
 * @param key - The setting's name, for the message
 * @param value - What the caller supplied
 * @throws TypeError if `value` is not a string, or holds an unpaired surrogate
 */
export function requireString(key: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') throw wrongType(key, 'a string', value)
  // bson encodes an unpaired surrogate as U+FFFD, so two distinct strings would become one stored value.
  if (UNPAIRED_SURROGATE.test(value)) {
    throw new TypeError(`strands_mongodb: '${key}' holds an unpaired surrogate, which cannot be stored as UTF-8.`)
  }
}

/**
 * Rejects a payload that is not bytes, since the driver would store `undefined` or `null` as an empty value.
 *
 * @param key - The argument's name, for the message
 * @param value - What the caller supplied
 * @throws TypeError if `value` is not a `Uint8Array`
 */
export function requireBytes(key: string, value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) throw wrongType(key, 'a Uint8Array', value)
}

/**
 * Rejects a setting that is not a boolean, since a string such as `'false'` is truthy.
 *
 * @param key - The setting's name, for the message
 * @param value - What the caller supplied
 * @throws TypeError if `value` is not a boolean
 */
export function requireBoolean(key: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw wrongType(key, 'a boolean', value)
}

/**
 * Rejects an argument that is not an object, before a property is read off it.
 *
 * @param key - The argument's name, for the message
 * @param value - What the caller supplied
 * @throws TypeError if `value` is a primitive, `null` or an array
 */
export function requireObject(key: string, value: unknown): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw wrongType(key, 'an object', value)
}

/**
 * Rejects an `embedder` that has no `embed` method.
 *
 * @param value - What the caller supplied
 * @throws TypeError if `value` is not an object with an `embed` function
 */
export function requireEmbedder(value: unknown): asserts value is Embedder {
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'embed') !== 'function') {
    throw wrongType('embedder', 'an object with an embed() method', value)
  }
}

function wrongType(key: string, expected: string, value: unknown): TypeError {
  const actual = value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value
  return new TypeError(`strands_mongodb: '${key}' must be ${expected}, but it is ${actual}.`)
}

/**
 * Rejects a setting that is not one of a closed list of names.
 *
 * @param key - The setting's name, for the message
 * @param value - What the caller supplied
 * @param allowed - Every name the setting takes
 * @throws TypeError if `value` is not in `allowed`
 */
export function requireOneOf<T extends string>(key: string, value: unknown, allowed: readonly T[]): asserts value is T {
  if (!allowed.some((name) => name === value)) {
    const rendered = typeof value === 'string' ? `'${value}'` : String(value)
    throw new TypeError(`strands_mongodb: '${key}' is ${rendered} and must be one of ${allowed.join(', ')}.`)
  }
}

/**
 * Rejects a numeric setting that is not finite, is out of bounds, or is a fraction where a count is needed.
 *
 * @param key - The setting's name, for the message
 * @param value - What the caller supplied
 * @param bounds - The inclusive range, and whether only an integer will do
 * @throws RangeError if `value` does not qualify
 */
export function requireNumber(
  key: string,
  value: unknown,
  bounds: { min?: number; max?: number; integer?: boolean } = {}
): asserts value is number {
  const { min = -Infinity, max = Infinity, integer = false } = bounds
  const usable = typeof value === 'number' && (integer ? Number.isInteger(value) : Number.isFinite(value))
  if (usable && value >= min && value <= max) return
  const kind = integer ? 'an integer' : 'a finite number'
  const range = max !== Infinity ? ` within ${min}..${max}` : min !== -Infinity ? ` of at least ${min}` : ''
  throw new RangeError(`strands_mongodb: '${key}' is ${String(value)} and must be ${kind}${range}.`)
}

// The last instant a `Date` holds. bson encodes a later, invalid one as the epoch, which a TTL index deletes at once.
const MAX_DATE_MS = 8.64e15

/**
 * Rejects a `ttlSeconds` that is negative, not finite, or whose expiry no `Date` can hold.
 *
 * @param value - What the caller supplied
 * @throws RangeError if `value` does not qualify
 */
export function requireTtlSeconds(value: unknown): asserts value is number {
  requireNumber('ttlSeconds', value, { min: 0, max: Math.floor((MAX_DATE_MS - Date.now()) / 1000) })
}
