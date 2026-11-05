import { randomBytes } from 'node:crypto'
import type { Document, DriverInfo, IndexDescription, MongoClientOptions, SearchIndexDescription } from 'mongodb'

type Filter = Record<string, unknown>
type SortSpec = Record<string, 1 | -1>

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length > 0 &&
    Object.keys(value)[0]!.startsWith('$')
  )
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  return (a as string | number) < (b as string | number) ? -1 : 1
}

// Only a type import of `mongodb` here: a runtime one would cycle through the tests that mock `MongoClient` with this file.
function objectIdHex(value: unknown): string | undefined {
  const bsonType: unknown = typeof value === 'object' && value !== null ? (value as Document)._bsontype : undefined
  return bsonType === 'ObjectId' ? String(value) : undefined
}

function binaryHex(value: unknown): string | undefined {
  const bsonType: unknown = typeof value === 'object' && value !== null ? (value as Document)._bsontype : undefined
  return bsonType === 'Binary' ? (value as { toString(encoding: 'hex'): string }).toString('hex') : undefined
}

// An `ObjectId` equals another, or the hex string the fake stores as `_id`, by its hex form; a `Binary` equals another by its bytes.
function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const [leftBytes, rightBytes] = [binaryHex(a), binaryHex(b)]
  if (leftBytes !== undefined || rightBytes !== undefined) return leftBytes === rightBytes
  const [left, right] = [objectIdHex(a), objectIdHex(b)]
  return (left ?? right) !== undefined && (left ?? a) === (right ?? b)
}

function matches(doc: Document, filter: Filter): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$and') return (condition as Filter[]).every((term) => matches(doc, term))
    const value = doc[field]
    if (!isOperatorObject(condition)) return equals(value, condition)
    return Object.entries(condition).every(([op, operand]) => {
      if (value === undefined) return false
      switch (op) {
        case '$eq':
          return equals(value, operand)
        case '$gte':
          return compare(value, operand) >= 0
        case '$gt':
          return compare(value, operand) > 0
        case '$lt':
          return compare(value, operand) < 0
        default:
          throw new Error(`FakeCollection does not support ${op}`)
      }
    })
  })
}

function isPlainObject(value: unknown): value is Document {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// `structuredClone` strips the prototype off a BSON value such as `Binary` or a nested `ObjectId`, so those are kept by reference.
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (value instanceof Date) return new Date(value.getTime())
  return isPlainObject(value) ? clone(value) : value
}

function clone(doc: Document): Document {
  return Object.fromEntries(Object.entries(doc).map(([field, value]) => [field, cloneValue(value)]))
}

function sortBy(docs: Document[], spec: SortSpec): Document[] {
  const keys = Object.entries(spec)
  return [...docs].sort((a, b) => {
    for (const [field, direction] of keys) {
      const order = compare(a[field], b[field]) * direction
      if (order !== 0) return order
    }
    return 0
  })
}

// `1` copies the field; anything else is an aggregation expression. `_id` stays unless excluded.
function project(doc: Document, spec: Document): Document {
  const out: Document = { _id: doc._id }
  for (const [field, value] of Object.entries(spec)) {
    if (field === '_id') {
      if (!value) delete out._id
      continue
    }
    out[field] = value === 1 || value === true ? doc[field] : evaluate(value, doc, {})
  }
  return out
}

function variable(path: string, vars: Document): unknown {
  const [name, ...rest] = path.split('.')
  return rest.reduce<unknown>((value, segment) => (value as Document)[segment], vars[name!])
}

// Only the operators the storage search pipeline uses, so a test cannot pass on an unmodelled stage.
function evaluate(expression: unknown, doc: Document, vars: Document): unknown {
  if (typeof expression === 'string' && expression.startsWith('$$')) return variable(expression.slice(2), vars)
  if (typeof expression === 'string' && expression.startsWith('$')) return doc[expression.slice(1)]
  if (Array.isArray(expression)) return expression.map((item) => evaluate(item, doc, vars))
  if (!isOperatorObject(expression)) return expression
  const [op, operand] = Object.entries(expression)[0]!
  const text = (value: unknown): string => String(evaluate(value, doc, vars))
  switch (op) {
    case '$toLower':
      return text(operand).toLowerCase()
    case '$strLenCP':
      return Array.from(text(operand)).length
    case '$substrCP': {
      const [input, start, count] = (operand as unknown[]).map((item) => evaluate(item, doc, vars))
      return Array.from(String(input))
        .slice(start as number, (start as number) + (count as number))
        .join('')
    }
    case '$regexFindAll': {
      const { input, regex } = operand as { input: unknown; regex: string }
      return [...text(input).matchAll(new RegExp(regex, 'gu'))].map((found) => ({ match: found[0] }))
    }
    case '$map': {
      const { input, in: mapped } = operand as { input: unknown; in: unknown }
      return (evaluate(input, doc, vars) as unknown[]).map((item) => evaluate(mapped, doc, { ...vars, this: item }))
    }
    case '$setIntersection': {
      const sets = (operand as unknown[]).map((item) => new Set(evaluate(item, doc, vars) as unknown[]))
      return [...sets[0]!].filter((member) => sets.every((set) => set.has(member)))
    }
    case '$size':
      return (evaluate(operand, doc, vars) as unknown[]).length
    default:
      throw new Error(`FakeCollection does not support ${op}`)
  }
}

// The server copies a filter's equality fields onto an upserted document.
function equalityFields(filter: Filter): Document {
  return Object.fromEntries(Object.entries(filter).filter(([, condition]) => !isOperatorObject(condition)))
}

const SEARCH_STAGES: ReadonlySet<string> = new Set(['$vectorSearch', '$search', '$rankFusion'])

function isSearchPipeline(pipeline: Document[]): boolean {
  const first = pipeline[0]
  return first !== undefined && SEARCH_STAGES.has(Object.keys(first)[0] ?? '')
}

function runPipeline(docs: Document[], pipeline: Document[]): Document[] {
  return pipeline.reduce<Document[]>((current, stage) => {
    const [name, spec] = Object.entries(stage)[0]!
    switch (name) {
      case '$match':
        return current.filter((doc) => matches(doc, spec as Filter))
      case '$project':
        return current.map((doc) => project(doc, spec as Document))
      case '$sort':
        return sortBy(current, spec as SortSpec)
      default:
        throw new Error(`FakeCollection does not support the ${name} stage`)
    }
  }, docs)
}

/** One recorded driver call: the method name and the positional arguments it received. */
export interface FakeCall {
  method: string
  args: unknown[]
}

/** The database half of the fake: `createCollection`, `listCollections` and `command` for `buildInfo`. */
export class FakeDb {
  readonly createCollectionCalls: string[] = []
  readonly commandCalls: Document[] = []
  readonly listCollectionsCalls: Document[] = []
  // 8.0.23 unless a test says otherwise: what the target deployments report.
  buildInfo: Document = { version: '8.0.23', versionArray: [8, 0, 23, 0] }
  createCollectionError: Error | undefined
  commandError: Error | undefined
  listCollectionsError: Error | undefined

  constructor(
    readonly databaseName: string,
    private readonly collection: FakeCollection
  ) {}

  async createCollection(name: string): Promise<void> {
    this.createCollectionCalls.push(name)
    if (this.createCollectionError !== undefined) throw this.createCollectionError
    if (name === this.collection.collectionName) this.collection.exists = true
  }

  listCollections(filter: { name: string }): { toArray(): Promise<Document[]> } {
    const { collection } = this
    this.listCollectionsCalls.push(filter)
    return {
      toArray: async () => {
        if (this.listCollectionsError !== undefined) throw this.listCollectionsError
        if (filter.name !== collection.collectionName || !collection.exists) return []
        return [{ name: collection.collectionName, type: 'collection', options: collection.collectionOptions }]
      },
    }
  }

  async command(command: Document): Promise<Document> {
    this.commandCalls.push(command)
    if (this.commandError !== undefined) throw this.commandError
    return this.buildInfo
  }
}

/** Cursor returned by {@link FakeCollection.find}. */
export class FakeCursor {
  private sortSpec: SortSpec = {}

  constructor(
    private readonly docs: Document[],
    private readonly projection: Document | undefined,
    private readonly drainFailure: Error | undefined
  ) {}

  sort(spec: SortSpec): this {
    this.sortSpec = spec
    return this
  }

  // The failure comes after the documents, as a connection dying mid-scan would surface.
  async toArray(): Promise<Document[]> {
    if (this.drainFailure !== undefined) throw this.drainFailure
    const sorted = sortBy(this.docs.map(clone), this.sortSpec)
    const { projection } = this
    return projection === undefined ? sorted : sorted.map((doc) => project(doc, projection))
  }
}

/** In-memory stand-in for the parts of `Collection<Document>` the package uses. */
export class FakeCollection {
  readonly docs: Document[] = []
  readonly indexes: IndexDescription[] = [{ key: { _id: 1 }, name: '_id_' }]
  readonly db: FakeDb
  readonly createdSearchIndexes: SearchIndexDescription[] = []
  readonly searchIndexes = new Map<string, Document>()
  /** Whether `listCollections` reports this collection. Set by `createCollection` and `setCollation`. */
  exists = false
  collectionOptions: Document = {}
  /** Every data and index call, in order, with its arguments. */
  readonly calls: FakeCall[] = []
  /** Thrown by every recorded call once set, as a dead connection would. */
  failure: Error | undefined
  /** Thrown while a `find` cursor drains, after `find` itself returned. */
  drainFailure: Error | undefined
  /** What `aggregate` answers for a search pipeline, which no fake can run; the stages are still recorded. */
  searchResults: Document[] = []
  /** Thrown by the next `updateOne` that would insert, in place of the insert, as the unique index does when a concurrent upsert won. */
  insertFailure: Error | undefined
  /** Reported by `deleteOne` and `deleteMany` in place of the real count once set, so a passthrough can be told from arithmetic. */
  deletedCount: number | undefined
  private listSearchIndexesFailures: Error[] = []
  private listSearchIndexReads = 0

  constructor(
    readonly dbName: string,
    readonly collectionName: string
  ) {
    this.db = new FakeDb(dbName, this)
  }

  /** How many times `listSearchIndexes().toArray()` ran. */
  get searchIndexReads(): number {
    return this.listSearchIndexReads
  }

  /** The recorded method names, in order. */
  get namesCalled(): string[] {
    return this.calls.map((call) => call.method)
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
    if (this.failure !== undefined) throw this.failure
  }

  /** Marks the collection present with the given default collation, as `createCollection` would. */
  setCollation(collation: Document | undefined): void {
    this.exists = true
    this.collectionOptions = collation === undefined ? {} : { collation }
  }

  /** Puts a search index in place as the server would report it, `READY` unless told otherwise. */
  addSearchIndex(description: SearchIndexDescription, status = 'READY'): void {
    const name = description.name ?? 'default'
    this.searchIndexes.set(name, {
      id: `id-${name}`,
      name,
      type: description.type ?? 'search',
      status,
      queryable: status === 'READY',
      latestVersion: 0,
      latestDefinition: structuredClone(description.definition),
    })
  }

  /** Moves a search index to `status`, or removes it when `status` is `undefined`, as another actor might. */
  setSearchIndexStatus(name: string, status: string | undefined): void {
    const index = this.searchIndexes.get(name)
    if (status === undefined) {
      this.searchIndexes.delete(name)
      return
    }
    if (index === undefined) throw new Error(`no search index ${name}`)
    index.status = status
    index.queryable = status === 'READY'
  }

  /** Makes the next `listSearchIndexes` reads fail, one error per read, in order. */
  failListSearchIndexes(...errors: Error[]): void {
    this.listSearchIndexesFailures.push(...errors)
  }

  listSearchIndexes(name?: string): { toArray(): Promise<Document[]> } {
    return {
      toArray: async () => {
        this.listSearchIndexReads += 1
        const failure = this.listSearchIndexesFailures.shift()
        if (failure !== undefined) throw failure
        const all = [...this.searchIndexes.values()].map((index) => structuredClone(index))
        return name === undefined ? all : all.filter((index) => index.name === name)
      },
    }
  }

  async createSearchIndex(description: SearchIndexDescription): Promise<string> {
    this.createdSearchIndexes.push(description)
    this.addSearchIndex(description)
    return description.name ?? 'default'
  }

  async findOne(filter: Filter = {}, options: { projection?: Document } = {}): Promise<Document | null> {
    this.record('findOne', filter, options)
    const doc = this.docs.find((candidate) => matches(candidate, filter))
    if (doc === undefined) return null
    return options.projection === undefined ? clone(doc) : project(clone(doc), options.projection)
  }

  /** Only `$setOnInsert` and `$set` are modelled: the update operators this package sends. */
  async updateOne(
    filter: Filter,
    update: Document,
    options: { upsert?: boolean } = {}
  ): Promise<{
    acknowledged: true
    matchedCount: number
    modifiedCount: number
    upsertedCount: number
    upsertedId: string | null
  }> {
    this.record('updateOne', filter, update, options)
    const operators = Object.keys(update)
    if (operators.some((operator) => operator !== '$setOnInsert' && operator !== '$set')) {
      throw new Error(`FakeCollection does not support ${operators.join(', ')}`)
    }
    const unchanged = { acknowledged: true as const, modifiedCount: 0, upsertedCount: 0, upsertedId: null }
    const matched = this.docs.find((candidate) => matches(candidate, filter))
    if (matched !== undefined && update.$set !== undefined) {
      Object.assign(matched, clone(update.$set as Document))
      return { ...unchanged, matchedCount: 1, modifiedCount: 1 }
    }
    if (matched !== undefined) return { ...unchanged, matchedCount: 1 }
    if (!options.upsert) return { ...unchanged, matchedCount: 0 }
    if (this.insertFailure !== undefined) {
      const failure = this.insertFailure
      this.insertFailure = undefined
      throw failure
    }
    const _id = randomBytes(12).toString('hex')
    this.docs.push({ _id, ...equalityFields(filter), ...clone((update.$setOnInsert as Document | undefined) ?? {}) })
    this.exists = true
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: _id }
  }

  async replaceOne(
    filter: Filter,
    replacement: Document,
    options: { upsert?: boolean } = {}
  ): Promise<{ acknowledged: true; matchedCount: number; modifiedCount: number; upsertedCount: number }> {
    this.record('replaceOne', filter, replacement, options)
    const index = this.docs.findIndex((candidate) => matches(candidate, filter))
    if (index !== -1) {
      this.docs[index] = { ...clone(replacement), _id: this.docs[index]!._id }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
    }
    if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
    const _id = replacement._id ?? filter._id
    this.docs.push({ ...clone(replacement), _id })
    this.exists = true
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
  }

  async deleteOne(filter: Filter): Promise<{ acknowledged: true; deletedCount: number }> {
    this.record('deleteOne', filter)
    const index = this.docs.findIndex((candidate) => matches(candidate, filter))
    if (index !== -1) this.docs.splice(index, 1)
    return { acknowledged: true, deletedCount: this.deletedCount ?? (index === -1 ? 0 : 1) }
  }

  async deleteMany(filter: Filter = {}): Promise<{ acknowledged: true; deletedCount: number }> {
    this.record('deleteMany', filter)
    const kept = this.docs.filter((candidate) => !matches(candidate, filter))
    const removed = this.docs.length - kept.length
    this.docs.splice(0, this.docs.length, ...kept)
    return { acknowledged: true, deletedCount: this.deletedCount ?? removed }
  }

  find(filter: Filter = {}, options: { projection?: Document } = {}): FakeCursor {
    this.record('find', filter, options)
    const found = this.docs.filter((candidate) => matches(candidate, filter))
    return new FakeCursor(found, options.projection, this.drainFailure)
  }

  /** Answers a search pipeline with `searchResults`; runs any other over the stored documents. */
  aggregate(pipeline: Document[]): { toArray(): Promise<Document[]> } {
    this.record('aggregate', pipeline)
    return {
      toArray: async () =>
        isSearchPipeline(pipeline) ? this.searchResults.map(clone) : runPipeline(this.docs.map(clone), pipeline),
    }
  }

  listIndexes(): { toArray(): Promise<IndexDescription[]> } {
    this.record('listIndexes')
    return { toArray: async () => structuredClone(this.indexes) }
  }

  async createIndexes(specs: IndexDescription[]): Promise<string[]> {
    this.record('createIndexes', specs)
    this.exists = true
    return Promise.all(specs.map((spec) => this.createIndex(spec.key as Document, spec)))
  }

  async createIndex(key: Document, options: Omit<IndexDescription, 'key'> = {}): Promise<string> {
    const name =
      options.name ??
      Object.entries(key)
        .map(([field, direction]) => `${field}_${String(direction)}`)
        .join('_')
    if (!this.indexes.some((index) => index.name === name)) {
      this.indexes.push(structuredClone({ ...options, key, name }) as IndexDescription)
    }
    return name
  }
}

/** In-memory stand-in for `MongoClient`, handing out one {@link FakeCollection} per namespace. */
export class FakeMongoClient {
  readonly collections = new Map<string, FakeCollection>()
  readonly options: { retryWrites: boolean; metadata: { driver: { name: string; version: string } } }
  readonly appended: DriverInfo[] = []
  closeCount = 0

  constructor(options: { retryWrites?: boolean } = {}) {
    this.options = {
      retryWrites: options.retryWrites ?? true,
      metadata: { driver: { name: 'nodejs', version: '7.8.0' } },
    }
  }

  get closed(): boolean {
    return this.closeCount > 0
  }

  // Does not dedupe, unlike the driver, so a test can count this package's own appends.
  appendMetadata(info: DriverInfo): void {
    this.appended.push(info)
    const { driver } = this.options.metadata
    driver.name += `|${info.name ?? ''}`
    driver.version += `|${info.version ?? ''}`
  }

  db(dbName: string): { databaseName: string; collection(name: string): FakeCollection } {
    return {
      databaseName: dbName,
      collection: (name: string): FakeCollection => {
        const namespace = `${dbName}.${name}`
        let collection = this.collections.get(namespace)
        if (collection === undefined) {
          collection = new FakeCollection(dbName, name)
          this.collections.set(namespace, collection)
        }
        return collection
      },
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1
  }
}

/** Stand-in for the `MongoClient` constructor, recording what it was built with. */
export class ConstructedMongoClient extends FakeMongoClient {
  static readonly built: ConstructedMongoClient[] = []

  constructor(
    readonly url: string,
    readonly clientOptions: MongoClientOptions = {}
  ) {
    super({ retryWrites: clientOptions.retryWrites ?? !/[?&]retryWrites=false/i.test(url) })
    const { driverInfo } = clientOptions
    if (driverInfo !== undefined) {
      this.options.metadata.driver.name += `|${driverInfo.name ?? ''}`
      this.options.metadata.driver.version += `|${driverInfo.version ?? ''}`
    }
    ConstructedMongoClient.built.push(this)
  }
}
