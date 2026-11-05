import type { Document, IndexDescription } from 'mongodb'

type Filter = Record<string, unknown>
type SortSpec = Record<string, 1 | -1>

const notImplemented = (): never => {
  throw new Error('not implemented in this task')
}

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

  /**
   * Orders the results.
   *
   * @param spec - Field to direction, as the driver takes it.
   * @returns This cursor.
   */
  sort(spec: SortSpec): this {
    this.sortSpec = spec
    return this
  }

  /**
   * Materialises the results.
   *
   * @returns Copies of the matching documents in sort order.
   */
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

  /**
   * @param filter - Equality or `$gte`/`$lt` conditions per field.
   * @returns A copy of the first match, or `null`.
   */
  async findOne(filter: Filter = {}): Promise<Document | null> {
    const doc = this.docs.find((candidate) => matches(candidate, filter))
    return doc === undefined ? null : structuredClone(doc)
  }

  /**
   * @param filter - Selects the document to replace.
   * @param replacement - New document body; `_id` is kept from the match or the filter.
   * @param options - `upsert` inserts when nothing matches.
   * @returns Counts in the driver's `UpdateResult` shape.
   */
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

  /** Not implemented until a later task. */
  updateOne(..._args: unknown[]): Promise<Document> {
    return notImplemented()
  }

  /**
   * @param filter - Selects the document to delete.
   * @returns The number deleted.
   */
  async deleteOne(filter: Filter): Promise<{ acknowledged: true; deletedCount: number }> {
    const index = this.docs.findIndex((candidate) => matches(candidate, filter))
    if (index === -1) return { acknowledged: true, deletedCount: 0 }
    this.docs.splice(index, 1)
    return { acknowledged: true, deletedCount: 1 }
  }

  /**
   * @param filter - Selects the documents to delete.
   * @returns The number deleted.
   */
  async deleteMany(filter: Filter = {}): Promise<{ acknowledged: true; deletedCount: number }> {
    const kept = this.docs.filter((candidate) => !matches(candidate, filter))
    const deletedCount = this.docs.length - kept.length
    this.docs.splice(0, this.docs.length, ...kept)
    return { acknowledged: true, deletedCount }
  }

  /**
   * @param filter - Equality or `$gte`/`$lt` conditions per field.
   * @returns A cursor over the matches.
   */
  find(filter: Filter = {}): FakeCursor {
    return new FakeCursor(this.docs.filter((candidate) => matches(candidate, filter)))
  }

  /** Not implemented until a later task. */
  aggregate(..._args: unknown[]): { toArray(): Promise<Document[]> } {
    return notImplemented()
  }

  /** @returns A cursor over the stored index descriptions. */
  listIndexes(): { toArray(): Promise<IndexDescription[]> } {
    return { toArray: async () => structuredClone(this.indexes) }
  }

  /**
   * @param specs - Index descriptions to store.
   * @returns The index names.
   */
  async createIndexes(specs: IndexDescription[]): Promise<string[]> {
    return Promise.all(specs.map((spec) => this.createIndex(spec.key as Document, spec)))
  }

  /**
   * @param key - Field to direction.
   * @param options - Further index options, `name` among them.
   * @returns The index name.
   */
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

  /** Not implemented until a later task. */
  listSearchIndexes(..._args: unknown[]): { toArray(): Promise<Document[]> } {
    return notImplemented()
  }

  /** Not implemented until a later task. */
  createSearchIndex(..._args: unknown[]): Promise<string> {
    return notImplemented()
  }

  /** Not implemented until a later task. */
  options(): Promise<Document> {
    return notImplemented()
  }
}

/** In-memory stand-in for `MongoClient`, handing out one {@link FakeCollection} per namespace. */
export class FakeMongoClient {
  readonly collections = new Map<string, FakeCollection>()
  closed = false

  /**
   * @param dbName - Database name.
   * @returns A handle whose `collection(name)` returns the same fake each time.
   */
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

  /** Marks the client closed. */
  async close(): Promise<void> {
    this.closed = true
  }
}
