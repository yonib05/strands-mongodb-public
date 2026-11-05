import { BSONRegExp } from 'mongodb'

/** Fields the vector index always declares filterable, before `filterFields`. Stored names, so snake_case. */
export const BAKED_IN_FILTER_FIELDS = ['scope', 'store_name'] as const

function mappingEntries(value: unknown): [unknown, unknown][] | undefined {
  if (value instanceof Map) return [...(value as Map<unknown, unknown>).entries()]
  if (typeof value !== 'object' || value === null) return undefined
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? Object.entries(value) : undefined
}

function isRegex(value: unknown): boolean {
  return value instanceof RegExp || value instanceof BSONRegExp
}

function quote(key: unknown): string {
  return typeof key === 'string' ? `'${key}'` : String(key)
}

function rejectOperatorKeys(value: unknown): void {
  const entries = mappingEntries(value)
  if (entries) {
    for (const [key, nested] of entries) {
      if (typeof key !== 'string' || key.startsWith('$')) {
        throw new TypeError(
          `strands_mongodb: invalid filter key ${quote(key)}. MongoDB operator keys and non-string keys are ` +
            `not allowed anywhere in a filter, at any depth. A filter is a mapping of field path to exact ` +
            `value, such as { 'metadata.tier': 'gold' }.`
        )
      }
      rejectOperatorKeys(nested)
    }
  } else if (Array.isArray(value)) {
    for (const item of value) rejectOperatorKeys(item)
  }
}

function rejectRegexValues(value: unknown): void {
  const entries = mappingEntries(value)
  if (entries) {
    for (const [key, nested] of entries) {
      if (isRegex(nested)) {
        throw new TypeError(
          `strands_mongodb: invalid filter value for ${quote(key)}: a regular expression. A filter is a ` +
            `mapping of field path to exact value, and a regex is matched as a pattern rather than compared, ` +
            `so it would select documents this filter does not name. Pass the literal value to match, such ` +
            `as { ${quote(key)}: 'gold' }.`
        )
      }
      rejectRegexValues(nested)
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (isRegex(item)) {
        throw new TypeError(
          'strands_mongodb: invalid filter value: a regular expression inside a list. A filter is a mapping ' +
            'of field path to exact value, at any depth, and a regex is matched as a pattern rather than compared.'
        )
      }
      rejectRegexValues(item)
    }
  }
}

function rejectUndeclaredFields(callerFilter: Record<string, unknown>, declared: readonly string[]): void {
  const declaredSet = new Set(declared)
  const keys = (mappingEntries(callerFilter) ?? []).map(([key]) => key as string)
  const undeclared = keys.filter((key) => !declaredSet.has(key)).sort()
  if (undeclared.length === 0) return

  const available = [...declaredSet].sort().join(', ') || 'none'
  throw new TypeError(
    `strands_mongodb: filter field(s) ${undeclared.map(quote).join(', ')} are not declared filterable on ` +
      `this index, and the server rejects a filter over an undeclared path. Filterable here: ${available}. ` +
      `Add the field to 'filterFields' in MongoDBConfig and recreate the index to filter on it.`
  )
}

/**
 * Checks a caller-supplied filter: no `$`-prefixed or non-string key at any depth, no regex value at
 * any depth, and every top-level key declared filterable. Guards run in that order, so an operator key
 * is reported before a regex and both before an undeclared field.
 *
 * @param callerFilter - The filter as the caller supplied it. Not modified.
 * @param options - `declaredFields`: every path the index declares filterable
 * @throws {@link TypeError} naming the offending key, the field path, or every undeclared path
 */
export function validate(callerFilter: Record<string, unknown>, options: { declaredFields: Iterable<string> }): void {
  rejectOperatorKeys(callerFilter)
  rejectRegexValues(callerFilter)
  rejectUndeclaredFields(callerFilter, [...options.declaredFields])
}

/**
 * Conjoins caller filters with the scope predicate. Uses `$and` rather than a merge, so a caller's
 * `scope` key adds a term instead of replacing the store's. Does not validate.
 *
 * @param callerFilters - Validated caller filters in order; `undefined` and `{}` add no term
 * @param options - `scope` and `storeName` of this store, never taken from caller input
 * @returns `{ $and: [scope term, store term, ...caller filters] }`, sharing no structure with the input
 */
export function compose(
  callerFilters: ReadonlyArray<Record<string, unknown> | undefined>,
  options: { scope: string; storeName: string }
): Record<string, unknown> {
  const terms: Record<string, unknown>[] = [
    { scope: { $eq: options.scope } },
    { store_name: { $eq: options.storeName } },
  ]
  for (const callerFilter of callerFilters) {
    if (callerFilter && Object.keys(callerFilter).length > 0) terms.push(structuredClone(callerFilter))
  }
  return { $and: terms }
}
