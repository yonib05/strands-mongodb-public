import type { Document, IndexDescription } from 'mongodb'

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

  constructor(
    readonly dbName: string,
    readonly collectionName: string
  ) {}

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
  closed = false

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
    this.closed = true
  }
}
