import { BSON } from 'mongodb'

// The driver accepts a `_bsontype` object only when it carries its own bson major version under this symbol.
const BSON_VERSION = Symbol.for('@@mdb.bson.version')
const INSTALLED_BSON_VERSION: unknown = Reflect.get(BSON.BSONValue.prototype, BSON_VERSION)

// By tag, as bson detects one, so a `RegExp` from another realm counts.
function isRegex(value: object): boolean {
  return Object.prototype.toString.call(value) === '[object RegExp]' || Reflect.get(value, '_bsontype') === 'BSONRegExp'
}

// bson treats `_bsontype == null` as a plain document, so only a non-null marker claims to be a BSON value.
function claimsBsonType(value: object): boolean {
  return Reflect.get(value, '_bsontype') != null
}

function isBsonValue(value: object): boolean {
  return INSTALLED_BSON_VERSION !== undefined && Reflect.get(value, BSON_VERSION) === INSTALLED_BSON_VERSION
}

// Every other object is encoded as a subdocument and walked. `DBRef.fields`, `Code` scope and getters are not read.
function isScalar(value: object): boolean {
  return value instanceof Date || value instanceof Uint8Array || isBsonValue(value)
}

// By tag as well, as bson detects one, so a `Map` from another realm counts.
function isMap(value: object): value is Map<unknown, unknown> {
  return value instanceof Map || Object.prototype.toString.call(value) === '[object Map]'
}

function entriesOf(value: object): [unknown, unknown][] {
  return isMap(value) ? [...value.entries()] : Object.entries(value)
}

function quote(key: unknown): string {
  return typeof key === 'string' ? `'${key}'` : String(key)
}

function where(path: string): string {
  return path === '' ? 'the top level' : quote(path)
}

function requireDocument(callerFilter: unknown): asserts callerFilter is Record<string, unknown> {
  const plain =
    typeof callerFilter === 'object' &&
    callerFilter !== null &&
    !Array.isArray(callerFilter) &&
    !isMap(callerFilter) &&
    !isRegex(callerFilter) &&
    !isScalar(callerFilter)
  if (!plain) {
    throw new TypeError(
      `strands_mongodb: invalid filter: ${Object.prototype.toString.call(callerFilter)} is not a plain object. Pass a mapping of field path to exact value, such as { 'metadata.tier': 'gold' }.`
    )
  }
}

function rejectOperatorKeys(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  if (isRegex(value) || isScalar(value) || claimsBsonType(value)) return
  if (Array.isArray(value)) {
    value.forEach(rejectOperatorKeys)
    return
  }
  for (const [key, nested] of entriesOf(value)) {
    if (typeof key !== 'string' || key.startsWith('$')) {
      throw new TypeError(
        `strands_mongodb: invalid filter key ${quote(key)}: operator keys and non-string keys are not allowed at any depth. Pass a mapping of field path to exact value, such as { 'metadata.tier': 'gold' }.`
      )
    }
    rejectOperatorKeys(nested)
  }
}

// Rejects what the driver would send differently from how it reads here, or not send at all.
function rejectUnsendableValues(value: unknown, path: string): void {
  const invalid = (what: string, advice: string): TypeError =>
    new TypeError(`strands_mongodb: invalid filter value at ${where(path)}: ${what}. ${advice}`)
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw invalid(
      `${typeof value}, which the driver can leave out so the term matches everything`,
      'Pass the literal value to match, or null.'
    )
  }
  if (typeof value !== 'object' || value === null) return
  if (typeof Reflect.get(value, 'toBSON') === 'function') {
    throw invalid("it has a 'toBSON' method, whose result the driver would send in its place", 'Pass the plain value.')
  }
  if (isRegex(value)) throw invalid('a regular expression', 'Pass the literal value to match.')
  if (isScalar(value)) return
  if (claimsBsonType(value)) {
    throw invalid(
      "it has a '_bsontype' but is not a BSON value the installed driver accepts",
      "Pass a value built with the driver's own BSON classes."
    )
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsendableValues(item, `${path}[${index}]`))
    return
  }
  for (const [key, nested] of entriesOf(value)) {
    rejectUnsendableValues(nested, path === '' ? String(key) : `${path}.${String(key)}`)
  }
}

function rejectUndeclaredFields(callerFilter: Record<string, unknown>, declared: ReadonlySet<string>): void {
  const undeclared = Object.keys(callerFilter)
    .filter((key) => !declared.has(key))
    .sort()
  if (undeclared.length === 0) return

  const available = [...declared].sort().join(', ') || 'none'
  throw new TypeError(
    `strands_mongodb: filter field(s) ${undeclared.map(quote).join(', ')} are not declared filterable on this index (filterable here: ${available}). Add the field to 'filterFields' in MongoDBConfig and recreate the vector index.`
  )
}

/**
 * Checks a caller-supplied filter, reporting an operator key before a bad value and both before an undeclared field.
 *
 * @param callerFilter - The filter as the caller supplied it. Not modified
 * @param options - `declaredFields`: every path the index declares filterable
 * @throws TypeError if the filter is not a plain object, a key at any depth starts with `$` or is not a string, a
 * value at any depth is `undefined`, a function, a symbol, a regex, a forged BSON value or carries `toBSON`, or a
 * top-level key is not declared
 */
export function validate(callerFilter: Record<string, unknown>, options: { declaredFields: Iterable<string> }): void {
  requireDocument(callerFilter)
  rejectOperatorKeys(callerFilter)
  rejectUnsendableValues(callerFilter, '')
  rejectUndeclaredFields(callerFilter, new Set(options.declaredFields))
}

/**
 * Conjoins caller filters with the scope predicate. `$and` rather than a merge, so a caller's `scope` adds a term.
 *
 * @param callerFilters - Validated caller filters in order; `undefined` and `{}` add no term
 * @param options - `scope` and `storeName` of this store, never taken from caller input
 * @returns `{ $and: [scope term, store term, ...caller filters] }`, each caller filter shallow-copied
 * @throws TypeError if a caller filter is not a plain object
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
    if (callerFilter === undefined) continue
    requireDocument(callerFilter)
    if (Object.keys(callerFilter).length > 0) terms.push({ ...callerFilter })
  }
  return { $and: terms }
}
