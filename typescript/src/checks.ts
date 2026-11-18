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
  bounds: { min: number; max?: number; integer?: boolean }
): asserts value is number {
  const { min, max = Infinity, integer = false } = bounds
  const usable = typeof value === 'number' && (integer ? Number.isInteger(value) : Number.isFinite(value))
  if (usable && value >= min && value <= max) return
  const kind = integer ? 'an integer' : 'a finite number'
  const range = max === Infinity ? `of at least ${min}` : `within ${min}..${max}`
  throw new RangeError(`strands_mongodb: '${key}' is ${String(value)} and must be ${kind} ${range}.`)
}
