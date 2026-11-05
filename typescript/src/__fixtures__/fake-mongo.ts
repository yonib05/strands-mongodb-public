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

function matches(doc: Document, filter: Filter): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    const value = doc[field]
    if (!isOperatorObject(condition)) return value === condition
    return Object.entries(condition).every(([op, operand]) => {
      if (value === undefined) return false
      switch (op) {
        case '$gte':
          return compare(value, operand) >= 0
        case '$lt':
          return compare(value, operand) < 0
        default:
          throw new Error(`FakeCollection does not support ${op}`)
      }
    })
  })
}

/** The database half of the fake: `createCollection`, `listCollections` and `command` for `buildInfo`. */
export class FakeDb {
  readonly createCollectionCalls: string[] = []
  readonly commandCalls: Document[] = []
  // 8.0.23 unless a test says otherwise: what the target deployments report.
  buildInfo: Document = { version: '8.0.23', versionArray: [8, 0, 23, 0] }
  createCollectionError: Error | undefined
  commandError: Error | undefined

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
    return {
      toArray: async () => {
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

  constructor(private readonly docs: Document[]) {}

  sort(spec: SortSpec): this {
    this.sortSpec = spec
    return this
  }

  async toArray(): Promise<Document[]> {
    const keys = Object.entries(this.sortSpec)
    return this.docs
      .map((doc) => structuredClone(doc))
      .sort((a, b) => {
        for (const [field, direction] of keys) {
          const order = compare(a[field], b[field]) * direction
          if (order !== 0) return order
        }
        return 0
      })
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

  async findOne(filter: Filter = {}): Promise<Document | null> {
    const doc = this.docs.find((candidate) => matches(candidate, filter))
    return doc === undefined ? null : structuredClone(doc)
  }

  async replaceOne(
    filter: Filter,
    replacement: Document,
    options: { upsert?: boolean } = {}
  ): Promise<{ acknowledged: true; matchedCount: number; modifiedCount: number; upsertedCount: number }> {
    const index = this.docs.findIndex((candidate) => matches(candidate, filter))
    if (index !== -1) {
      this.docs[index] = { ...structuredClone(replacement), _id: this.docs[index]!._id }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
    }
    if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
    const _id = replacement._id ?? filter._id
    this.docs.push({ ...structuredClone(replacement), _id })
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
  }

  async deleteOne(filter: Filter): Promise<{ acknowledged: true; deletedCount: number }> {
    const index = this.docs.findIndex((candidate) => matches(candidate, filter))
    if (index === -1) return { acknowledged: true, deletedCount: 0 }
    this.docs.splice(index, 1)
    return { acknowledged: true, deletedCount: 1 }
  }

  async deleteMany(filter: Filter = {}): Promise<{ acknowledged: true; deletedCount: number }> {
    const kept = this.docs.filter((candidate) => !matches(candidate, filter))
    const deletedCount = this.docs.length - kept.length
    this.docs.splice(0, this.docs.length, ...kept)
    return { acknowledged: true, deletedCount }
  }

  find(filter: Filter = {}): FakeCursor {
    return new FakeCursor(this.docs.filter((candidate) => matches(candidate, filter)))
  }

  listIndexes(): { toArray(): Promise<IndexDescription[]> } {
    return { toArray: async () => structuredClone(this.indexes) }
  }

  async createIndexes(specs: IndexDescription[]): Promise<string[]> {
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
