/**
 * Rejects a setting that is not a string, since an operator object from a JavaScript caller would join a query.
 *
 * @param key - The setting's name, for the message
 * @param value - What the caller supplied
 * @throws TypeError if `value` is not a string
 */
export function requireString(key: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(
      `strands_mongodb: '${key}' must be a string, but it is ${value === null ? 'null' : typeof value}.`
    )
  }
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
