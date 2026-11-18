# strands-mongodb

MongoDB storage and memory backends for the [Strands Agents](https://strandsagents.com) TypeScript SDK.

| Class | Entry point | Implements | Serves |
|---|---|---|---|
| `MongoDBStorage` | `strands-mongodb/storage` | `Storage` from `@strands-agents/sdk/storage` | Sessions, context offloading, `FileMemoryStore`, anything that takes a `Storage` |
| `MongoDBMemoryStore` | `strands-mongodb/memory` | `MemoryStore` from `@strands-agents/sdk` | Semantic recall through Atlas Vector Search and Atlas Search |

Both classes are also exported from the package root. The documents and indexes are the ones the
[Python package](https://github.com/mongodb/strands-mongodb/tree/main/python) writes, so both can share a
collection. [PARITY.md](https://github.com/mongodb/strands-mongodb/blob/main/typescript/docs/PARITY.md)
lists where the two behave differently.

## Install

<!-- skip: it installs from the public registry -->
```bash
npm install strands-mongodb @strands-agents/sdk mongodb
```

`@strands-agents/sdk`, `mongodb` and `@opentelemetry/api` are peer dependencies, so your application
chooses their versions. npm installs `@opentelemetry/api` without being asked.

## Quickstart

### Storage

Works on any MongoDB deployment and needs no index. The snippets read `MONGODB_URI`.

<!-- run: contract -->
```ts
import { MongoDBStorage, type MongoDBConfig } from 'strands-mongodb'

const connection: MongoDBConfig = {
  connectionString: process.env.MONGODB_URI!,
  database: process.env.MONGODB_DATABASE ?? 'agents',
}

const storage = new MongoDBStorage(connection, { collection: 'storage' })
try {
  await storage.write('notes/deployment', new TextEncoder().encode('the cluster is in us-east-1'))
  console.log(new TextDecoder().decode((await storage.read('notes/deployment'))!))
  console.log(await storage.list('notes/'))
  await storage.delete('notes/deployment')
} finally {
  await storage.close()
}
```

### Memory

Needs an Atlas cluster with an embedding model registered: see
[Automated Embedding](https://www.mongodb.com/docs/vector-search/crud-embeddings/automated-embedding/)
in the Atlas documentation. Atlas embeds the text, so you handle no vectors. An Atlas CLI local deployment
has no model to register: there, [supply your own vectors](#supplying-your-own-vectors).

<!-- run: autoembed -->
```ts
import { MongoDBMemoryStore } from 'strands-mongodb'

const config = { connectionString: process.env.MONGODB_URI!, database: process.env.MONGODB_DATABASE ?? 'agents' }
const store = new MongoDBMemoryStore({ name: 'preferences', config, scope: 'user-abc', writable: true })
try {
  await store.add('Prefers metric units and a 24-hour clock.')
  const found = await store.search('how should times be displayed for this person?')
  for (const entry of found) console.log(entry.metadata?._relevanceScore, entry.content)
} finally {
  await store.close()
}
```

The first operation creates the indexes. Atlas embeds a memory after `add()` returns, so a memory takes a
few seconds to become searchable, and the search above can come back empty on a new collection.

### In an agent

<!-- skip: it needs a model provider and its credentials -->
```ts
import { Agent, MemoryManager, SessionManager } from '@strands-agents/sdk'
import { MongoDBMemoryStore, MongoDBStorage } from 'strands-mongodb'

const store = new MongoDBMemoryStore({ name: 'preferences', config: connection, scope: 'user-abc', writable: true })
const agent = new Agent({
  model: yourModel,
  storage: new MongoDBStorage(connection),
  sessionManager: new SessionManager({ sessionId: 'support-ticket-4127' }),
  memoryManager: new MemoryManager({ stores: [store], addToolConfig: true }),
  contextManager: 'auto',
})
```

`sessionManager` and `contextManager: 'auto'` use the agent's `storage`. The agent gets an `add_memory`
tool only with `addToolConfig: true` and a store with `writable: true`. Both default to `false`. To have
the SDK extract facts from the conversation instead, set `extraction: true` on the writable store.

`MongoDBMemoryStore` has no `addMessages` method, so `MemoryManager` runs extraction with the SDK's own
extractor. Two runnable scripts are in
[`examples/`](https://github.com/mongodb/strands-mongodb/tree/main/typescript/examples).

## Connecting

`MongoDBConfig` takes a `client` you built or a `connectionString`. Prefer the client: the credential
stays inside an object you own, and every driver option is available.

<!-- run: contract -->
```ts
import { MongoClient } from 'mongodb'
import { MongoDBStorage } from 'strands-mongodb'

const client = new MongoClient(process.env.MONGODB_URI!)
const storage = new MongoDBStorage({ client, database: process.env.MONGODB_DATABASE ?? 'agents' })
try {
  await storage.write('notes/injected', new TextEncoder().encode('written through an injected client'))
  await storage.delete('notes/injected')
} finally {
  await client.close() // storage.close() never closes an injected client
}
```

With a `connectionString`, the package builds the client and passes it your `clientOptions`. Stores share
one client and pool when their configs hold the same `client`, or equal `connectionString` and
`clientOptions`. The stores keep the config in a private field, so logging a store does not
print the connection string. Each client is registered once through the driver's `appendMetadata`, so
server logs show the driver as `nodejs|Strands-MongoDB`. Your own `driverInfo` and `appName` are kept.

The driver closes a client when its first connection fails. The package reconnects a client it built,
so the next operation tries the deployment again. An injected client is yours to reopen with
`connect()`: until then every operation throws a `StorageError` saying it is closed.

Authentication is the driver's. `mongodb` 7 accepts `MONGODB-AWS`, `MONGODB-OIDC`, `MONGODB-X509`,
`GSSAPI`, `PLAIN`, `SCRAM-SHA-1` and `SCRAM-SHA-256`, as `authMechanism` in the connection string or in
the options of an injected client. `GSSAPI` needs the `kerberos` package and `MONGODB-AWS` needs
`@aws-sdk/credential-providers`. The driver reports a missing one on the first operation.

## Configuration

### `MongoDBConfig`

<!-- keys: MongoDBConfig -->
| Key | Type | Required | Default | What it does |
|---|---|---|---|---|
| `database` | `string` | yes | | Database holding the collections. |
| `client` | `MongoClient` | no | | A client you built. Never closed by this package. |
| `connectionString` | `string` | no | | A MongoDB URI, used when `client` is absent. Supplying neither throws `TypeError`. |
| `clientOptions` | `MongoClientOptions` | no | | Options for the client built from `connectionString`. |
| `ensureIndexes` | `boolean` | no | `true` | Create missing indexes. `false` verifies them instead. See [Indexes](#indexes-and-privileges). |
| `indexReadyTimeout` | `number` | no | `300` | Seconds to wait for a search index to become queryable. |
| `searchType` | `'auto' \| 'vector' \| 'text' \| 'hybrid'` | no | `'auto'` | The memory search tier. See [Search tiers](#search-tiers). |
| `embeddingModel` | `string` | no | `voyage-4-lite` | The Atlas embedding model, when Atlas embeds your text. |
| `embeddingDimensions` | `number` | no | | Vector length, when you supply the vectors. Requires `similarity` and excludes `embeddingModel`. |
| `similarity` | `'cosine' \| 'dotProduct' \| 'euclidean'` | no | | Distance metric, when you supply the vectors. Requires `embeddingDimensions`. |
| `filterFields` | `string[]` | no | `[]` | Extra document paths a `filter` may use. `scope` and `store_name` are always declared. |
| `vectorIndexName` | `string` | no | `vector_index` | Name of the Atlas Vector Search index. |
| `textIndexName` | `string` | no | `text_index` | Name of the Atlas Search index. |
| `logger` | `Logger` | no | | Receives the log lines. The default writes `warn` and `error` to the console. |

### `MongoDBMemoryStoreConfig`

The first five keys are the SDK's `MemoryStoreConfig`. `name`, `scope`, `collection` and the connection's
`database` must be strings, or the constructor throws `TypeError`. A number that is `NaN` or infinite
throws `RangeError`.

<!-- keys: MongoDBMemoryStoreConfig -->
| Key | Type | Required | Default | What it does |
|---|---|---|---|---|
| `name` | `string` | yes | | Identifies the store. Stored on every document as `store_name` and matched on every read. |
| `description` | `string` | no | | Shown to the model by the SDK. |
| `maxSearchResults` | `number` | no | `10` | Default result count. Must be an integer of at least 1, or the constructor throws `RangeError`. |
| `writable` | `boolean` | no | `false` | Allows `add`, `delete` and `deleteAll`. They throw `TypeError` otherwise. |
| `extraction` | `boolean \| ExtractionConfig` | no | | Passed to the SDK's extractor. |
| `config` | `MongoDBConfig` | yes | | The connection. |
| `collection` | `string` | no | `memory` | Collection holding this store's documents. |
| `scope` | `string` | no | `__unscoped__` | Tenant boundary, stored on every write and matched on every read. Absent or `''` is the shared scope `UNSCOPED`. |
| `filter` | `Record<string, unknown>` | no | | Field paths mapped to the exact values they must equal, applied to search and delete. It can only narrow. Paths must be in `filterFields`, and operators such as `$gte` throw `TypeError`. |
| `minScore` | `number` | no | | Drops results scoring below it, after the search. |
| `maxScore` | `number` | no | | Drops results scoring above it. Excludes `minScore`. |
| `ttlSeconds` | `number` | no | | Seconds a memory lives from its first `add`. `0` expires at the next TTL sweep. Negative throws `RangeError`. |
| `embedder` | `Embedder` | no | | Embeds memories and string queries when you supply the vectors. |

### `MongoDBSearchQuery`

Pass one to `search()` in place of a string. Set `text` or `vector`. Setting both is valid only where the
hybrid tier can use both: on a store that supplies its own vectors, with `searchType` `'auto'` or
`'hybrid'`. Anywhere else it throws `TypeError`.

<!-- keys: MongoDBSearchQuery -->
| Key | Type | Required | Default | What it does |
|---|---|---|---|---|
| `text` | `string` | no | | The query text. |
| `vector` | `number[]` | no | | A query embedding you computed. |
| `filter` | `Record<string, unknown>` | no | | Narrows this query. Same rules as the store's `filter`. |
| `limit` | `number` | no | `10` | Result count for this query. Wins over both `maxSearchResults` settings. |
| `oversamplingFactor` | `number` | no | `10` | Vector candidates considered per result. |

The result count is the query's `limit`, then the `maxSearchResults` option of the call, then the
store's, then 10. `MemoryManager` always passes the option: the value it was called with, else the
store's `maxSearchResults`, else 3.

### `MongoDBStorage`

`new MongoDBStorage(config, options?)`

| Option | Type | Default | What it does |
|---|---|---|---|
| `collection` | `string` | `storage` | Collection holding this instance's documents. |
| `prefix` | `string` | `''` | Prepended to every key. Normalized to end in one `/`. |
| `ttlSeconds` | `number` | | Lifetime of written documents. Nothing expires until `ensureIndexes()` has created the TTL index. |
| `searchStrategy` | `SearchStrategy<MongoDBStorage>` | | What `search()` runs. Without one, `search()` scores keys only. |

To search stored values, pass the SDK's `KeywordSearchStrategy` from `@strands-agents/sdk/storage/search`,
or `MongoDBVectorSearchStrategy` to search by meaning. Its `embedder` is any SDK `Embedder`, such as
`BedrockEmbedder` from `@strands-agents/sdk/storage/embeddings/bedrock`:

<!-- skip: it needs an embedder and Atlas Vector Search -->
```ts
const files = new MongoDBStorage(connection, {
  collection: 'memory_files',
  searchStrategy: new MongoDBVectorSearchStrategy({ embedder, dimensions: 1024, similarity: 'cosine' }),
})
await files.ensureIndexes() // creates the vector index
```

The strategy embeds every value written through that storage and keeps the vector on the value's
document, under the index `storage_vector_index` (`DEFAULT_STORAGE_VECTOR_INDEX_NAME`, or `indexName`).
Give it its own collection: on an agent's `storage` it would embed every session snapshot. Empty and
non-UTF-8 values are skipped. If embedding fails, `write()` throws `StorageError` after the value is
stored. `maxResults` and `oversamplingFactor` both default to 10.

### Methods

<!-- methods -->
`MongoDBStorage`: `read()` returns `null` for an absent key, and `list()` returns keys in ascending byte
order. `write()` and `delete()` return nothing. `deletePrefix()` returns the number of documents removed.
`namespace(prefix)` returns a `MongoDBStorage` over the same collection, scoped under the prefix. An
invalid key or prefix throws `StorageError`: at once from the constructor and `namespace()`, and after
the collation check from an operation.

`MongoDBMemoryStore`: `delete()` and `deleteAll()` return the number of documents removed. `add()`
returns a `MongoDBAddResult` with `ids`, `inserted` and `duplicates`: content already stored is a
duplicate, not a second document. An invalid option, query or `memoryId` throws `TypeError` or
`RangeError`.

A database failure in either class throws the SDK's `StorageError`, with the namespace in the message
and the driver's error as `cause`.

The root also exports the constants `DEFAULT_COLLECTION`, `DEFAULT_MAX_SEARCH_RESULTS`,
`DEFAULT_OVERSAMPLING_FACTOR`, `TIER_RETRY_SECONDS`, `TIER_RETRY_MAX_SECONDS`, `MAX_KEY_BYTES`,
`MAX_DOCUMENT_BYTES`, `RESERVED_METADATA_KEYS` and `UNSCOPED`.

## Search tiers

| Tier | Runs | Needs |
|---|---|---|
| `hybrid` | `$rankFusion` over the two below | MongoDB 8.0 or later, and both other tiers |
| `vector` | `$vectorSearch` on `vector_index` | Atlas or an Atlas CLI local deployment. With the default embedding, a registered embedding model |
| `text` | `$search` on `text_index` | Atlas Search |

`searchType: 'auto'` prepares every tier the deployment offers. Each query runs on the first of hybrid,
vector and text that is ready and fits the query, and each result reports the tier in `_searchType`.
When the vector tier is unavailable, `auto` answers from the text tier and logs a warning, so matches
are lexical. A named `searchType` prepares only what that tier needs and throws `StorageError` if it cannot.

Under `auto`, `initialize()` does not wait for an index that is still building. The first `search()`
waits up to `indexReadyTimeout` for the first tier to be ready. A tier that was skipped is tried again
after 60 seconds (`TIER_RETRY_SECONDS`), then at doubling intervals up to an hour
(`TIER_RETRY_MAX_SECONDS`). A named `searchType` waits in `initialize()` instead.

### Hybrid scores

<!-- rrf -->
Hybrid scores are reciprocal rank fusion scores, not similarities: the sum over the two tiers of
`1 / (60 + rank)`. A document ranked first by both tiers scores about `0.033`, and one ranked first by a
single tier about `0.016`. A `minScore` of `0.7` chosen for cosine scores would remove every hybrid
result. So under `auto`, a store with `minScore` or `maxScore` stays on the vector tier and logs that it
did. With `searchType: 'hybrid'` the bound applies to the fused score.

### Supplying your own vectors

<!-- manual-vectors -->
Set `embeddingDimensions` and `similarity` and the vector index covers an `embedding` field instead of
asking Atlas to embed `content`. Pass an `embedder` and `add()` and string `search()` fill and query that
field for you. Any SDK `Embedder` whose vectors have the declared length works:

<!-- skip: it needs an embedder and Atlas Vector Search -->
```ts
const store = new MongoDBMemoryStore({
  name: 'facts',
  config: { ...connection, embeddingDimensions: 1024, similarity: 'cosine' },
  embedder,
  writable: true,
})
```

Without an `embedder`, memories are stored with no `embedding`, and only a query carrying a `vector` can
use the vector tier. A vector of the wrong length throws `RangeError` before the write. An `embedder` on
a store where Atlas embeds throws `TypeError`.

### Reserved metadata keys

Every returned entry carries four keys in its `metadata`. They win over a stored key of the same name,
and the collision is logged.

| Key | Holds |
|---|---|
| `_relevanceScore` | The score from the tier that answered |
| `_id` | The document id, which `delete()` takes as `memoryId` |
| `_searchType` | `hybrid`, `vector` or `text` |
| `_scope` | The scope of the store that answered |

## Tenancy

| Boundary | Configure | Enforced by |
|---|---|---|
| Database per tenant | `database` | MongoDB, when the tenant's user is limited to that database |
| Collection per tenant | `collection` | MongoDB, when privileges are per collection |
| Scope inside one collection | `scope` on memory, `prefix` or `namespace()` on storage | This package |

MongoDB applies no row filter, so the third boundary holds only because every write and read goes
through this package. The store writes `scope` itself and matches it on every search and delete. A
caller cannot set it through `filter` or `metadata`, and a `filter` can only narrow. If a tenant boundary
is a compliance boundary, use one of the first two rows.

With the default embedding, the deployment sends each memory's `content` and each vector query's text to
the embedding model named by `embeddingModel`. To keep text away from that model, supply your own
vectors. This package sends text only to the deployment, and to your `embedder` when you pass one.

## Erasing memories

`store.delete(memoryId)` removes one memory and returns `1` or `0`. `store.deleteAll()` removes every
memory the store can read and returns the count. Both need `writable: true`, and both reach what
`search()` reaches: one scope and one store name, narrowed by the store's `filter`.

- Erasing a scope takes one `deleteAll()` per store name in it.
- `0` means no match: the memory is gone, in another scope, or in another store.
- A `memoryId` that is not a 24-character hex string throws `TypeError`.
- Backups, snapshots and the oplog keep their copies for as long as the deployment retains them.

## Indexes and privileges

By default `initialize()` creates the memory indexes. `MongoDBStorage` creates its indexes only when you
call `ensureIndexes()`. Set `ensureIndexes: false` when the application's credential must not create
indexes, and create them by hand.

<!-- indexes -->
The commands for the default configuration, for `mongosh` on the database in your `MongoDBConfig`:

<!-- run: mongosh -->
```javascript
db.runCommand({"createIndexes":"storage","indexes":[{"key":{"expires_at":1},"name":"strands_expires_at_ttl","expireAfterSeconds":0}]})
db.runCommand({"createIndexes":"memory","indexes":[{"key":{"scope":1,"store_name":1,"content_hash":1},"name":"strands_scope_store_content_hash_unique","unique":true,"partialFilterExpression":{"content_hash":{"$exists":true}}}]})
db.runCommand({"createIndexes":"memory","indexes":[{"key":{"scope":1,"store_name":1,"created_at":-1},"name":"strands_scope_store_created_at"}]})
db.runCommand({"createIndexes":"memory","indexes":[{"key":{"expires_at":1},"name":"strands_expires_at_ttl","expireAfterSeconds":0}]})
db.runCommand({"createSearchIndexes":"memory","indexes":[{"name":"vector_index","type":"vectorSearch","definition":{"fields":[{"type":"autoEmbed","path":"content","model":"voyage-4-lite","modality":"text"},{"type":"filter","path":"scope"},{"type":"filter","path":"store_name"}]}}]})
db.runCommand({"createSearchIndexes":"memory","indexes":[{"name":"text_index","type":"search","definition":{"mappings":{"dynamic":false,"fields":{"content":[{"type":"string"}]}}}}]})
```

The first is the storage TTL index. The next three serve memory: the unique index that makes a repeated
`add` a duplicate, the index for reads by scope, store and recency, and the TTL index. The last two are
the search indexes and need Atlas Search. With `embeddingDimensions` and `similarity`, the `autoEmbed`
field becomes a `vector` field on `embedding`, and each `filterFields` entry adds a filter field. A
search index cannot be changed in place. Drop it and create it again:

<!-- run: mongosh -->
```javascript
db.runCommand({"dropSearchIndex":"memory","name":"vector_index"})
db.runCommand({"dropSearchIndex":"memory","name":"text_index"})
```

With `ensureIndexes: false`, a missing ordinary or TTL index throws `StorageError` listing the
`createIndexes` commands. A missing search index throws `StorageError` under a named `searchType`. Under
`auto` it logs a warning and its tier is skipped and retried later, unless every tier is missing, which
throws.

### Privileges

<!-- privileges -->
| Action | Needed for | `read` | `readWrite` |
|---|---|---|---|
| `find` | Every read | yes | yes |
| `insert` | `write` and `add`, which are upserts | no | yes |
| `update` | `write`, `add`, and storing a vector for `MongoDBVectorSearchStrategy` | no | yes |
| `remove` | `delete`, `deleteAll`, `deletePrefix` | no | yes |
| `listCollections` | The collation check before the first operation on a collection | yes | yes |
| `listIndexes` | Checking ordinary indexes | yes | yes |
| `listSearchIndexes` | Checking search indexes, and detecting Atlas Search | yes | yes |
| `createIndex` | Creating ordinary indexes | no | yes |
| `createCollection` | Creating the collection a search index needs | no | yes |
| `createSearchIndexes` | Creating search indexes | no | yes |

`read` and `readWrite` are MongoDB's built-in roles. `readWrite` covers everything. `read` is enough for a
search-only store with `ensureIndexes: false`. A store that writes but must not create indexes needs a
custom role with the first seven actions.

The collation check is required: a collection whose default collation is not binary is refused with
`StorageError`, because case-folding would merge keys and scopes.

## Limits

<!-- limits -->
| Limit | What to do | Applies to |
|---|---|---|
| `close()` closes the shared pool | It closes the pool of every store with the same connection identity. A later operation on any of them opens a new pool. Call it once, at shutdown. | `close()` |
| `list` and `deletePrefix` match string prefixes | `'user1'` also matches `'user10/a'`. End the prefix with `/`. `deletePrefix('')` removes every key under the instance's prefix. `list` returns every match in one array. | `MongoDBStorage.list()` |
| `search` without a strategy scores keys only | Values are not searched. Key letters are lowercased for ASCII only, so a key word with a non-ASCII capital such as `ÉCOLE` matches no query. Pass a `searchStrategy`. | `MongoDBStorage.search()` |
| `ttlSeconds` on storage needs the TTL index | Call `await storage.ensureIndexes()` once at startup. The memory store creates its TTL index in `initialize()`. | `MongoDBStorage.ensureIndexes()` |
| Key length | 1024 bytes of UTF-8, prefix included. Longer throws `StorageError` before the write. | `MAX_KEY_BYTES` |
| Document size | 16 MB. Larger throws `StorageError` before the write. | `MAX_DOCUMENT_BYTES` |
| An empty result can hide a failure | `MemoryManager` logs a failed store search as a warning and returns the other stores' results. | `MongoDBMemoryStore.search()` |
| Searches can fail after a slow index build | Under `auto`, if no tier is ready within `indexReadyTimeout` on the first search, searches throw `StorageError` until a retry finds one. Retries double from 60 seconds up to an hour. | `MongoDBMemoryStore.search()` |
| Vector candidates per query | 10000. A `limit` times `oversamplingFactor` above it, or not a whole number, throws `RangeError`. | `oversamplingFactor` |
| Vector dimensions | 8192 when you supply the vectors. | `embeddingDimensions` |

## Observability

<!-- observability -->
Every public operation records an `INTERNAL` OpenTelemetry span through `@opentelemetry/api`, on the
tracer provider your application registers. The package registers nothing. Without a provider the calls
are no-ops.

Strands telemetry registers a provider: `setupTracer` from `@strands-agents/sdk/telemetry`. It needs the
SDK's optional peers `@opentelemetry/resources`, `@opentelemetry/sdk-trace-base`,
`@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-trace-otlp-http` and
`@opentelemetry/exporter-metrics-otlp-http` installed.

To register a provider yourself, install `@opentelemetry/sdk-trace-base` and
`@opentelemetry/context-async-hooks`:

<!-- run: unit -->
```ts
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())] })
)
```

Each public method records one span: `strands_mongodb.storage.write`, `strands_mongodb.storage.read`,
`strands_mongodb.storage.delete`, `strands_mongodb.storage.list`, `strands_mongodb.storage.search`,
`strands_mongodb.storage.delete_prefix`, `strands_mongodb.storage.ensure_indexes`,
`strands_mongodb.memory.add`, `strands_mongodb.memory.search`, `strands_mongodb.memory.delete` and
`strands_mongodb.memory.delete_all`. `strands_mongodb.memory.initialize` is recorded only when
`initialize()` sets up the store or retries a tier. Index work appears as child spans:
`strands_mongodb.indexes.ensure` for creating or checking indexes, `strands_mongodb.indexes.probe` for
asking the deployment about Atlas Search, `$rankFusion` or the collation, and
`strands_mongodb.indexes.wait` for each search index waited on.

| Attribute | On | Value |
|---|---|---|
| `strands_mongodb.database`, `strands_mongodb.collection` | every span | The namespace |
| `strands_mongodb.store_name` | `memory.*` spans | The store's `name` |
| `strands_mongodb.search.requested` | `memory.search`, `memory.initialize` | The configured `searchType` |
| `strands_mongodb.search.tier` | `memory.search` | The tier that answered |
| `strands_mongodb.search.tiers` | `memory.initialize` | The tiers that are ready, comma-separated |
| `strands_mongodb.result_count` | `memory.search`, `storage.search`, `storage.list` | Entries or keys returned |
| `strands_mongodb.deleted_count` | the delete spans | Documents removed |
| `strands_mongodb.found` | `storage.read` | Whether the key existed |
| `strands_mongodb.duplicate` | `memory.add` | Whether the content was already stored |
| `strands_mongodb.indexes.mode` | `indexes.ensure` | `ensure`, or `verify` when `ensureIndexes` is `false` |
| `strands_mongodb.indexes.created` | `indexes.ensure` | Indexes this call created |
| `strands_mongodb.indexes.outcome` | `indexes.wait`, `indexes.ensure` | `ready` or `timed_out` on a wait. `abandoned` on an ensure that stopped waiting because another tier was ready |
| `strands_mongodb.indexes.probe` | `indexes.probe` | `search`, `rank_fusion` or `collation` |
| `strands_mongodb.client.injected` | the `strands_mongodb.client.acquired` event | Whether you supplied the `client` |
| `error.type` | a failed span | The error's class name |

A failed span has status `ERROR` with the error's class name as its description. A minifier that renames
classes changes that name. `strands_mongodb.client.acquired` is a span event, added to the active span
when the package builds a client or first sees an injected one.

No span or log line carries a key, a prefix, stored content, metadata, query text, filter values, a
scope, a memory id, a connection string or a credential. Error messages are not recorded on spans.

Log lines go to the `logger` in `MongoDBConfig`, shaped
`strands_mongodb: <sentence> | event=<name>, namespace=<database>.<collection>, tier=<tier>`.

| `event` | Level | Logged when |
|---|---|---|
| `retry_writes_disabled` | `warn` | The client has retryable writes turned off |
| `reserved_key_collision` | `warn` | A stored document's metadata uses a reserved key |
| `no_search_setup` | `warn` | The deployment has no Atlas Search |
| `tier_unavailable` | `warn` | Under `auto`, a search tier could not be prepared and was skipped |
| `tier_building` | `info` | Under `auto`, a search index was still building and its tier was skipped |
| `below_vector` | `warn` | Under `auto`, the vector tier is unavailable and queries use the text tier |
| `bound_declined_fusion` | `warn` | A score bound kept `auto` off the hybrid tier |
| `score_bound_applied` | `debug` | `minScore` or `maxScore` dropped results |
| `creating_indexes` | `info` | Ordinary indexes are being created |
| `creating_search_index` | `info` | A search index is being created |
| `search_index_status` | `info` | A search index changed status during a wait |
| `rank_fusion_probe_failed` | `debug` | `buildInfo` failed, so `$rankFusion` is treated as unsupported |

## Requirements

| | |
|---|---|
| Node.js | `>=22.0.0`. ES modules only. CommonJS code can `require()` the package on Node 22.12 and later, and `await import()` it before |
| `@strands-agents/sdk` | `>=1.23.0`, the first release that exports `Embedder`. No upper bound: a weekly CI job tests the latest SDK release, so a breaking one is seen, not hidden |
| `mongodb` | `^7.0.0` |
| `@opentelemetry/api` | `^1.9.0` |
| MongoDB | Any deployment for storage. Atlas Search for the text tier. Atlas or an Atlas CLI local deployment for the vector tier, with a registered embedding model unless you supply the vectors |

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
