# strands-mongodb

MongoDB storage and memory backends for the [Strands Agents](https://strandsagents.com) TypeScript SDK.

This is the TypeScript half of the [strands-mongodb](../README.md) repository. One MongoDB deployment
sits behind both of the SDK's persistence extension points:

| Surface | Class | Entry point | SDK interface | Serves |
|---|---|---|---|---|
| Storage | `MongoDBStorage` | `strands-mongodb/storage` | `Storage` from `@strands-agents/sdk/storage` | Sessions, context offloading, memory persistence, context history, transcripts |
| Memory | `MongoDBMemoryStore` | `strands-mongodb/memory` | `MemoryStore` from `@strands-agents/sdk` | Semantic recall over Atlas Vector Search, extraction writes |

Either class can be imported from the package root or from its own entry point:

<!-- run: unit -->
```ts
import { MongoDBStorage } from 'strands-mongodb'
import { MongoDBStorage as SameClass } from 'strands-mongodb/storage'
```

The entry points load only their own modules. There are no extras: one package and three peer
dependencies cover both surfaces, and `strands-mongodb/storage` never loads the memory store.

The `Storage` interface is what makes one backend serve five subsystems: the SDK accepts a single
top-level `storage` on `Agent`, and session management and context offloading inherit it. Each is still
turned on with the SDK's own objects (`SessionManager`, and `contextManager: 'auto'`), and neither needs a
MongoDB-specific class.

The documents, index names and index definitions are the Python package's, so the two packages can share
a deployment and a collection. The Python reference is [`python/README.md`](../python/README.md); the
facts this package relies on for that parity are in [`docs/PARITY.md`](docs/PARITY.md).

## Install

<!-- skip: these reach npm for a package that is not published yet -->
```bash
npm install strands-mongodb @strands-agents/sdk mongodb
```

`@strands-agents/sdk` and `mongodb` are peer dependencies, so your application chooses their versions.
The third peer, `@opentelemetry/api`, is installed by npm 7 and later without being named.

### Before the package reaches npm

Nothing is published yet, so the command above resolves to nothing. Until it does, install from this
repository. `npm install github:mongodb/strands-mongodb` fails twice over: the repository is private
behind SAML single sign-on, so the download npm attempts needs a token it does not have, and npm cannot
install a subdirectory of a git repository, which `typescript/` is.

Clone over SSH and point npm at the clone instead:

<!-- skip: it clones a private repository over SSH, which no test tier holds a key for -->
```bash
git clone git@github.com:mongodb/strands-mongodb.git
cd strands-mongodb/typescript && npm ci && npm run build
cd /path/to/your/app && npm install /path/to/strands-mongodb/typescript
```

`npm install <folder>` links the folder, so the clone has to be built first and stays in use. For a copy
that does not, run `npm pack` in `typescript/` (which builds) and install the `.tgz` it writes.

This needs a GitHub account in the `mongodb` organization holding an SSH key authorized for single
sign-on. What you get is not a release: `package.json` carries `0.0.1-development`, and the real version
is written at publish time, as [RELEASING.md](RELEASING.md) describes.

## Quickstart

The test suite runs both snippets below directly from this file. Each reads its connection string from
`MONGODB_URI` and its database from `MONGODB_DATABASE`, defaulting to `agents`.

### Storage

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

Nothing has to be provisioned first. Storage needs no index the server does not already create, which
is the reason keys are stored as `_id`.

### Memory

This one needs an Atlas cluster with a registered embedding model, because it takes the default path
where the deployment embeds the text and you never handle a vector.

<!-- run: autoembed -->
```ts
import { MongoDBMemoryStore, type MongoDBConfig } from 'strands-mongodb'
import { setTimeout as sleep } from 'node:timers/promises'

const connection: MongoDBConfig = {
  connectionString: process.env.MONGODB_URI!,
  database: process.env.MONGODB_DATABASE ?? 'agents',
}

const store = new MongoDBMemoryStore({ name: 'preferences', config: connection, scope: 'user-abc', writable: true })
try {
  await store.initialize() // creates the indexes; every other operation calls it too
  await store.add('Prefers metric units and a 24-hour clock.')

  // Atlas embeds a new document after the write is acknowledged, and on a new collection the text index
  // can finish before the vector one. Until the vector tier is ready a search answers lexically, so this
  // query finds nothing for a few minutes rather than failing.
  let found = await store.search('how should times be displayed for this person?')
  for (let attempt = 0; found.length === 0 && attempt < 90; attempt++) {
    await sleep(5_000)
    found = await store.search('how should times be displayed for this person?')
  }
  if (found.length === 0) throw new Error('The vector index or the embedding is not ready yet. Run this again.')

  for (const entry of found) console.log(entry.metadata?._relevanceScore, entry.content)
} finally {
  await store.close()
}
```

The query shares no word with the stored fact. That is the point of the vector tier, and it is also why
the first run of this snippet is slower. The first `search` waits for the first index to be ready, and
when that is the text index, searches answer lexically until a retry finds the vector index ready: 60
seconds later, then at doubling intervals up to an hour (`TIER_RETRY_SECONDS`, `TIER_RETRY_MAX_SECONDS`).
On an existing collection both indexes are ready at once.

To give an agent both surfaces, pass one config to both and let the SDK wire them:

<!-- skip: needs a model provider and its credentials, which no test tier configures -->
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

The two `true`s are what let the agent save anything. `MemoryManager` always gives the model a
`search_memory` tool, but it adds `add_memory` only when `addToolConfig` is `true`, and the SDK defaults
that to `false`. The store must also be writable, and this package defaults `writable` to `false`. If no
store is writable, `addToolConfig: true` throws an `Error` when you construct the manager. With neither
set, the agent can recall memories but has no way to save new ones. If you would rather the SDK
pick facts out of the conversation than leave it to the model, set `extraction: true` on the writable
store instead of, or as well as, `addToolConfig`.

One `storage` on `Agent` serves five subsystems, but it does not turn them on. The `sessionManager`
line is what persists the conversation under its session ID, and `contextManager: 'auto'` is what
offloads context.

`MongoDBMemoryStore` omits `addMessages` on purpose. The SDK's `MemoryManager` feature-detects it and
falls back to its own extractor, which dedupes; a present one would take extraction away from the SDK and
hand it to one this package would have to write. The `MemoryStore` interface declares it optional, so
`stores: [store]` type-checks as written.

## Connecting to a deployment

`MongoDBConfig` takes either a client you built or a connection string, and it needs one of the two. In
preference order:

| How | Key | What it costs you |
|---|---|---|
| Inject a client | `client` | Nothing. The credential stays inside an object you own, and you get every driver option, including ones this package never exposes. |
| A connection string with a passwordless mechanism | `connectionString` | Your deployment has to be set up for X.509, AWS IAM, OIDC or Kerberos. |
| A connection string with a password | `connectionString` | The password is now a value in a plain object. |

That order is a security order, not a style one. A plain object ends up in error output, log records and
debugger views. The stores keep their config off their own enumerable properties, so `console.log(store)`
and `JSON.stringify(store)` never print it, but the object you built is still yours to keep out of the
log. An injected client keeps the credential out of it:

<!-- run: contract -->
```ts
import { MongoClient } from 'mongodb'
import { MongoDBStorage, type MongoDBConfig } from 'strands-mongodb'

const client = new MongoClient(process.env.MONGODB_URI!)
const connection: MongoDBConfig = { client, database: process.env.MONGODB_DATABASE ?? 'agents' }

const storage = new MongoDBStorage(connection)
try {
  await storage.write('notes/injected', new TextEncoder().encode('the credential never entered the config'))
  await storage.delete('notes/injected')
} finally {
  // `storage.close()` deliberately does nothing to an injected client. It is yours, and something
  // else in the process may still be using it.
  await client.close()
}
```

`clientOptions` covers the middle ground: this package passes it to the `MongoClient` it builds from
your connection string, so TLS settings, timeouts and read preferences all reach the driver without an
injected client.

Every store built from the same config object shares one connection pool. The identity is the config's
`connectionString` and `clientOptions`, so two configs with the same values share a pool too, and an
injected `client` is its own identity.

<!-- driver-info -->
Every client this package uses identifies the package in its connection handshake, the way MongoDB's
handshake specification asks a library that wraps the driver to: it adds `Strands-MongoDB` and the
installed version to the driver name and version the server records, so `nodejs|Strands-MongoDB` and
`7.8.0|0.1.0`. Server logs and `$currentOp` show this as `clientMetadata.driver`. A client this package
builds gets it through `driverInfo` at construction; an injected `client` gets it through the driver's
`appendMetadata`, once. `appName` stays yours: the package never sets, defaults or changes it, whether
you give it in the connection string, in `clientOptions` or on an injected client.

### Authentication mechanisms

The driver decides what is available here, not this package. `mongodb` 7 declares `MONGODB-AWS`,
`MONGODB-OIDC`, `MONGODB-X509`, `GSSAPI`, `PLAIN`, `SCRAM-SHA-1` and `SCRAM-SHA-256`, and any of them
works through either route above: as `authMechanism` in the connection string, or in the options of the
client you inject. Whether your deployment accepts one is a question for the deployment.

Two of them reach for packages the driver does not install. `GSSAPI` needs `kerberos`, and the driver
reports its absence when it first authenticates rather than when the client is constructed, so a
misconfigured process starts cleanly and fails on its first operation. `MONGODB-AWS` works with nothing
extra from environment variables and the EC2 and ECS metadata endpoints; the AWS SDK's full credential
chain, profiles and SSO among it, needs `@aws-sdk/credential-providers`.

## Configuration reference

Three interfaces, and every key of all three is listed here. A test compares these tables against the
declarations, so a key added to the package and not to this file fails the build.

### `MongoDBConfig`

The connection half. Build one per process and share it: two stores holding the same config object share
one connection pool.

<!-- keys: MongoDBConfig -->
| Key | Type | Required | Default | What it does |
|---|---|---|---|---|
| `database` | `string` | yes | | Database holding every collection this config reaches. |
| `client` | `MongoClient` | no | | A client you built. Preferred over `connectionString`, and this package never closes it. |
| `connectionString` | `string` | no | | A MongoDB URI. Required unless `client` is set; supplying neither throws `TypeError`. |
| `clientOptions` | `MongoClientOptions` | no | | Extra options for the client this package builds. Ignored when `client` is set. |
| `ensureIndexes` | `boolean` | no | `true` | Whether to create missing indexes. `false` verifies and reports instead. See below. |
| `indexReadyTimeout` | `number` | no | `300` | Seconds to wait for each search index to become queryable, timed separately per index, so an `auto` store can wait this long once per tier. Raise it on a shared deployment where a build queues behind somebody else's. |
| `searchType` | `'auto' \| 'vector' \| 'text' \| 'hybrid'` | no | `'auto'` | Which memory search tiers to prepare and query. |
| `embeddingModel` | `string` | no | `voyage-4-lite` | Atlas embedding model, on the AutoEmbeddings path where the deployment embeds your text. |
| `embeddingDimensions` | `number` | no | | Vector length, on the manual path where you supply the vectors. Mutually exclusive with `embeddingModel`, and requires `similarity`. |
| `similarity` | `'cosine' \| 'dotProduct' \| 'euclidean'` | no | | Distance metric, on the manual path. Requires `embeddingDimensions`. No default: the right metric is a property of your embeddings. |
| `filterFields` | `string[]` | no | `[]` | Extra document paths a caller may filter on. `scope` and `store_name` are always declared. |
| `vectorIndexName` | `string` | no | `vector_index` | Name of the Atlas Vector Search index. |
| `textIndexName` | `string` | no | `text_index` | Name of the Atlas Search full-text index. |
| `logger` | `Logger` | no | the SDK's default | Receives this package's log lines. The default writes `warn` and `error` to the console and drops `debug` and `info`. See [Observability](#observability). |

### `MongoDBMemoryStoreConfig`

The constructor argument of `MongoDBMemoryStore`. The first five keys come from the SDK's
`MemoryStoreConfig` and behave as they do for any store, with one exception noted below.

<!-- keys: MongoDBMemoryStoreConfig -->
| Key | Type | Required | Default | What it does |
|---|---|---|---|---|
| `name` | `string` | yes | | Identifies the store. Stamped on every document as `store_name` and part of every read predicate. |
| `description` | `string` | no | | Passed to the SDK, which shows it to the model when it chooses a store. |
| `maxSearchResults` | `number` | no | `10` | Default result count, not a ceiling. A per-call `limit` overrides it, and so does the SDK `search_memory` tool's `maxSearchResults` argument, which the model chooses. Below 1 throws `RangeError`. |
| `writable` | `boolean` | no | `false` | Gates `add`, `delete` and `deleteAll`. `false` here, unlike `FileMemoryStore`: the cost of the wrong default is a retrieval store that starts accepting model-written memories. |
| `extraction` | `boolean \| ExtractionConfig` | no | | Passed to the SDK's extractor. This package never extracts anything itself. |
| `config` | `MongoDBConfig` | yes | | The connection, nested. Share one across stores. |
| `collection` | `string` | no | `memory` | Collection holding this store's documents. |
| `scope` | `string` | no | `__unscoped__` | Tenant boundary. Stamped on writes and applied to reads by this package, never by the caller. Absence is the distinct scope `UNSCOPED`, never "everything". |
| `filter` | `Record<string, unknown>` | no | | Extra search predicate, composed as a narrowing conjunction. It cannot widen what this store can read. Paths must appear in `filterFields`. |
| `minScore` | `number` | no | | Relevance floor. Applied after the search, so it drops results without changing their order. |
| `maxScore` | `number` | no | | Relevance ceiling. Mutually exclusive with `minScore`. |
| `ttlSeconds` | `number` | no | | How long a memory lives, in seconds from its own `created_at`. Absent means it never expires and stamps no field; `0` means "at the next sweep" and is a real value, not a disabled one; a negative value throws `RangeError`. Set on insert, so re-remembering a fact does not extend it. Needs no `ensureIndexes()` call here: `initialize()` already creates the TTL index. |
| `embedder` | `Embedder` | no | | Manual-vector path only: embeds on `add()` and string `search()`. See [Supplying your own vectors](#supplying-your-own-vectors). |

### `MongoDBSearchQuery`

Passed to `search()` instead of a plain string, when a per-query filter, limit or embedding is needed.
Every key is optional, but at least one of `text` and `vector` has to be set. Setting both is valid only
on a manual-vector store whose `searchType` is `'auto'` or `'hybrid'`, where the hybrid tier reads one
key in each of its two pipelines; anywhere else it throws `TypeError`.

<!-- keys: MongoDBSearchQuery -->
| Key | Type | Required | Default | What it does |
|---|---|---|---|---|
| `text` | `string` | no | | The query text. What `search('...')` fills in. |
| `vector` | `number[]` | no | | A query embedding, on the manual-vector path. Combined with `text` only by the hybrid tier, as above. |
| `filter` | `Record<string, unknown>` | no | | Narrows this query only. Same rules as the store's `filter`. |
| `limit` | `number` | no | `10` | Result ceiling for this query. Outranks both `maxSearchResults` settings. |
| `oversamplingFactor` | `number` | no | `10` | Multiplier turning the limit into a `$vectorSearch` candidate count. |

### `MongoDBStorage`

`new MongoDBStorage(config, options?)`. The config comes first and can be the same object a memory store
holds; the options are a `MongoDBStorageOptions`.

| Argument | Type | Default | What it does |
|---|---|---|---|
| `config` | `MongoDBConfig` | | The connection. Only the connection keys matter here; the search keys are memory-only. |
| `options.collection` | `string` | `storage` | Collection holding this instance's documents. |
| `options.prefix` | `string` | `''` | Prepended to every key, scoping this instance inside the collection. Normalized to end in one `/`. |
| `options.ttlSeconds` | `number` | | Lifetime of the documents this instance writes. Needs the TTL index; see Limits. A negative value throws `RangeError`. |
| `options.searchStrategy` | `SearchStrategy<MongoDBStorage>` | | What `search()` runs instead of the default key-only scan. Shared by `namespace()` views. |

#### Searching storage

By default `search()` scores keys only, in one server-side query that reads no values. A word that is
only inside a value does not match, and `FileMemoryStore` keeps its facts there, under keys named after
their topic. For `FileMemoryStore`, pass a strategy that reads values: the SDK's `KeywordSearchStrategy`
(a value, not a class, from `@strands-agents/sdk/storage/search`) matches shared words, and the vector
strategy below matches by meaning.

#### Vector search over storage

`MongoDBVectorSearchStrategy` is the MongoDB counterpart of the SDK's `S3VectorSearchStrategy`. It
stores each value's vector on the value's own document, under an Atlas Vector Search index named
`storage_vector_index` (`DEFAULT_STORAGE_VECTOR_INDEX_NAME`) unless `indexName` says otherwise. Empty
and non-UTF-8 values are not indexed. Each value is embedded whole, so it must fit the embedding model's
input; a longer one makes `write()` throw `StorageError` after the value is stored. Values written before
the strategy was configured have no vector, so vector search cannot find them until they are rewritten.

Every write through the storage is embedded, so give the strategy only to the storage you search, in
its own collection. On `new Agent({ storage })` it would also embed session snapshots on every turn.

<!-- skip: it needs AWS credentials for Bedrock and Atlas Vector Search -->
```ts
import { BedrockEmbedder } from '@strands-agents/sdk/storage/embeddings/bedrock'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'
import { MongoDBStorage, MongoDBVectorSearchStrategy } from 'strands-mongodb'

const memoryStorage = new MongoDBStorage(connection, {
  collection: 'memory_files',
  searchStrategy: new MongoDBVectorSearchStrategy({
    embedder: new BedrockEmbedder({ modelId: 'amazon.titan-embed-text-v2:0' }),
    dimensions: 1024,
    similarity: 'cosine',
  }),
})
await memoryStorage.ensureIndexes() // also creates the vector index
const knowledge = new FileMemoryStore({ name: 'facts', storage: memoryStorage })
```

`MongoDBVectorSearchStrategyOptions` also takes `maxResults` (default `10`) and `oversamplingFactor`
(default `10`), with the same bounds as a memory search.

### What the methods return

| Method | Returns |
|---|---|
| `MongoDBStorage.read(key)` | `Uint8Array`, or `null` when the key is absent |
| `MongoDBStorage.list(prefix)` | `string[]` of full keys, in ascending byte order |
| `MongoDBStorage.search(query)` | `StorageSearchResult[]`, the SDK's type |
| `MongoDBStorage.deletePrefix(prefix)` | `number`, the documents removed |
| `MongoDBStorage.namespace(prefix)` | A second `MongoDBStorage` over the same collection, scoped under `prefix` |
| `MongoDBMemoryStore.add(content, metadata?)` | `MongoDBAddResult`, with `ids`, `inserted` and `duplicates`. A fact already stored counts as a duplicate rather than a second write |
| `MongoDBMemoryStore.search(query, options?)` | `MemoryEntry[]`, the SDK's type, carrying the reserved metadata keys below |
| `MongoDBMemoryStore.delete(memoryId)` and `deleteAll()` | `number`, the documents removed |

Failures from the database come back as the SDK's `StorageError`, from `@strands-agents/sdk`, with the
namespace in the message and the driver's error as `cause`. A caller mistake that no round trip could
fix, such as an invalid query, is a `TypeError` or `RangeError` thrown before anything is sent.

### Other public names

| Name | Entry point | What it is |
|---|---|---|
| `SearchType` | root, `memory` | The values `searchType` accepts: `auto`, `vector`, `text`, `hybrid` |
| `ResolvedSearchType` | root, `memory` | The tiers that can answer, as `_searchType` reports them |
| `VectorSimilarity` | root, `memory` | The metrics `similarity` accepts |
| `MongoDBAddResult` | root, `memory` | What `add()` resolves to |
| `MongoDBStorageOptions`, `MongoDBVectorSearchStrategyOptions` | root, `storage` | The two option bags above |
| `RESERVED_METADATA_KEYS` | root, `memory` | The four metadata keys this package owns |
| `UNSCOPED` | root, `memory` | The scope stamped and filtered on when a store names none |
| `DEFAULT_COLLECTION`, `DEFAULT_MAX_SEARCH_RESULTS`, `DEFAULT_OVERSAMPLING_FACTOR`, `TIER_RETRY_SECONDS`, `TIER_RETRY_MAX_SECONDS` | root, `memory` | The memory defaults the tables above quote |
| `MAX_KEY_BYTES`, `MAX_DOCUMENT_BYTES`, `DEFAULT_STORAGE_VECTOR_INDEX_NAME` | root, `storage` | The storage limits and default |
| `DEFAULT_EMBEDDING_MODEL`, `DEFAULT_VECTOR_INDEX_NAME`, `DEFAULT_TEXT_INDEX_NAME`, `MAX_DIMENSIONS`, `MAX_NUM_CANDIDATES`, `READY_TIMEOUT_SECONDS`, `RANK_FUSION_PENALTY` | root | The index and search constants the Limits table cites |

## Search: what answers a query

`search()` picks a tier from the query's **shape**, not from what you asked for, and reports which one
ran in the `_searchType` metadata key. Three tiers exist in `0.1.0`:

<!-- tiers -->
| Tier | Runs | Needs |
|---|---|---|
| `hybrid` | one `$rankFusion` over the two pipelines below | MongoDB 8.0 or later, **and** both of the other tiers available |
| `vector` | `$vectorSearch` against `vector_index` | Atlas, or an Atlas CLI local deployment, plus a registered embedding model on the AutoEmbeddings path |
| `text` | `$search` against `text_index` | Atlas Search, and no embedding model |

`searchType` decides which of them `initialize()` prepares. `'auto'` prepares every tier the deployment
offers and prefers the highest one it got; naming one prepares only that one, so a `text` store never
builds a vector index it will never query, and a `vector` store throws rather than quietly answering a
query lexically. Naming `hybrid` prepares both underlying indexes and throws at `initialize()` if the
deployment cannot fuse, rather than falling back to half of what you asked for.

Preparation can come up short without throwing. A deployment with no search process at all gets its
ordinary indexes and a warning, and the search call is what throws. A cluster with Atlas Search but no
registered embedding model rejects the `autoEmbed` index at creation, and a store configured for `'auto'`
falls back to the text tier and says so in a warning. Both of those are visible only in your logs, which
is worth knowing before you conclude that recall is bad.

![How searchType auto picks a tier: hybrid if it is ready, then vector, then text, otherwise StorageError](https://raw.githubusercontent.com/mongodb/strands-mongodb/main/docs/images/search-tiers.png)

### Hybrid scores are on a different scale

<!-- rrf -->
Fused results are **not** similarity scores, and a `minScore` or `maxScore` chosen against the vector
tier will not mean what you meant on this one. `$rankFusion` scores by reciprocal rank fusion:

```
RRFscore(d) = sum over tiers of  weight / (60 + rank of d in that tier)
```

The `60` is MongoDB's rank constant (`RANK_FUSION_PENALTY`), and this package does not change it. With
the two tiers weighted equally, a document ranked first by both scores about `0.033`; one ranked first by
a single tier scores about `0.016`; everything else is smaller. So a `minScore` of `0.7`, a perfectly
ordinary cosine floor, removes every result.

Because that failure is silent (an empty list is also what "no matches" looks like), a store on `'auto'`
with either bound configured stays on the vector tier and logs that it did. Asking for
`searchType: 'hybrid'` by name overrides that: the bound is applied to the fused score, on the scale
above, because you asked for this tier specifically.

### Supplying your own vectors

Setting `embeddingDimensions` and `similarity` selects the manual path, where the vector index covers an
`embedding` field on each document instead of asking Atlas to embed `content`.

<!-- manual-vectors -->
The package indexes and queries `embedding` but never fills it on its own. Pass an `embedder` and `add()`
and string `search()` embed for you, so `MemoryManager` works unchanged. Any subclass of the SDK's
`Embedder` (from `@strands-agents/sdk/storage/search`) whose `embed(text)` resolves to a `number[]` of
the declared length will do; the SDK ships `BedrockEmbedder`:

<!-- skip: it needs AWS credentials for Bedrock and Atlas Vector Search -->
```ts
import { BedrockEmbedder } from '@strands-agents/sdk/storage/embeddings/bedrock'
import { MongoDBMemoryStore } from 'strands-mongodb'

const store = new MongoDBMemoryStore({
  name: 'facts',
  config: { ...connection, embeddingDimensions: 1024, similarity: 'cosine' },
  embedder: new BedrockEmbedder({ modelId: 'amazon.titan-embed-text-v2:0' }),
  writable: true,
})
```

Without one, memories get no `embedding` and only a `MongoDBSearchQuery` with a precomputed `vector`
can use the vector tier. AutoEmbeddings needs no `embedder` and rejects one. A vector whose length is
not `embeddingDimensions` is rejected with `RangeError` before the write, because the server would
silently leave it out of the index.

### Reserved metadata keys

Every returned entry carries four keys this package owns in its `metadata`, because the SDK's
`MemoryEntry` has nowhere else to put them:

| Key | Holds |
|---|---|
| `_relevanceScore` | The score from whichever tier answered |
| `_id` | The document id, which is also the `memoryId` that `delete()` takes |
| `_searchType` | `hybrid`, `vector` or `text`, whichever ran |
| `_scope` | The scope of the store that answered, read from the store and never from the document |

Your own metadata merges underneath these. On a name collision the reserved value wins and the collision
is logged, so a key of yours is never silently dropped without a record. The names are camelCased where
the Python package's are snake_cased (`_relevance_score`, `_search_type`); the documents themselves are
identical.

## Tenancy

Three boundaries are available, and they are not equivalent. The difference that matters is who enforces
them:

| Boundary | Configure | Enforced by |
|---|---|---|
| Database per tenant | `database` | MongoDB, if the tenant's user is scoped to that database |
| Collection per tenant | `collection` | MongoDB, if privileges are per collection |
| Scope inside one collection | `scope` on memory, `prefix` or `namespace()` on storage | This package |

The third one is the cheapest and the one to understand before choosing it. MongoDB applies no
server-side row filter, so a memory lands in the right scope because `add` put it there, and comes back
because `search` asked for it. The package holds that line in four places: it stamps `scope` itself and a
caller cannot set it through `filter` or `metadata`; an absent scope resolves to the distinct sentinel
`__unscoped__` rather than to no predicate; a caller `filter` composes as a narrowing conjunction and
cannot widen the read; and `delete()` reaches exactly as far as `search()` does. The tests for these run
two stores in one collection and check isolation in both directions.

![What every memory write and read goes through: a write is stamped with scope and store name and deduplicated by content hash; a read passes the filter guard and is limited to the store's scope](https://raw.githubusercontent.com/mongodb/strands-mongodb/main/docs/images/memory-guards.png)

If a tenant boundary is a compliance boundary, use one of the first two rows.

## Where your text goes

<!-- data-flow -->
What leaves the process depends on the embedding path, and on neither of them does this package send text
anywhere except the deployment you connected it to.

- **AutoEmbeddings, the default.** The deployment's search process sends the `content` of every memory, and
  the text of every query that reaches the vector tier (including the vector half of a `hybrid` search), to
  the embedding model named by `embeddingModel`, `voyage-4-lite` unless you set it. That is a call the
  deployment makes, not this package; the package only names the model in the index definition. The
  `text` tier sends nothing to a model.
- **The manual path.** The deployment sends your text to no model. Your `embedder`, if any, sees each
  memory and string query.

On both paths `content` is stored in the deployment as written, and `MongoDBStorage` payloads are stored
the same way. Processing region, storage location and retention, for the text and for any vectors, are
governed by your Atlas deployment and not by this package, which can neither see nor change them. This
package makes no confidentiality or isolation claim for text sent to the managed embedding model. Text that
must not leave your boundary belongs on the manual path, embedded by a model you choose.

## Erasing memories

`MongoDBMemoryStore` deletes as well as writes, which is what an erasure request against stored facts
needs from a memory backend. The SDK's `MemoryStore` interface has no deletion member, so these are the
package's own surface rather than interface methods.

| Call | Removes | Returns |
|---|---|---|
| `await store.delete(memoryId)` | The one memory with that `_id`, if this store can see it | `1` or `0` |
| `await store.deleteAll()` | Every memory this store can see | The count |

`memoryId` is the `_id` string a search result carries in its `metadata`, so the id you delete by is
the id you were handed. Anything that is not a 24-character hex ObjectId is rejected with `TypeError`
before a network call.

Both calls require `writable: true`, and both reach exactly as far as `search()` does: one scope, this
store's name, narrowed by any configured `filter`. A store cannot delete what it cannot read. Two
consequences are worth stating rather than leaving to be discovered:

- **Erasing a scope takes one call per store in it.** `deleteAll()` empties one store's view, not the
  whole scope, because `store_name` is part of the predicate. There is no single call that erases a whole scope.
- **`0` does not mean "no such memory."** A well-formed id gets `0` whether it names a memory already
  deleted, one in another scope, or one in another store in this scope. Telling those apart would
  answer whether an id exists somewhere the caller cannot read.

<!-- erasure-reach -->
Erasure reaches the live deployment and nothing else. `delete()` and `deleteAll()` remove documents from
the collection, and the search indexes built from them follow; they do not reach backups, snapshots or the
oplog, which keep what they hold for as long as the deployment's own retention says. A request that has to
cover those copies is a request to whoever operates the deployment.

## Indexes and privileges

`initialize()` creates what it needs by default, which is convenient in development and often the wrong
thing in production, where index creation is a DBA's call and the application's credential is not
supposed to hold `createIndex`. Set `ensureIndexes: false` and this section is the handoff.

### What gets created

Six indexes across two collections. Names are prefixed `strands_` so an operator can tell ours from
theirs, and they are stable: renaming one would be a breaking change.

| Collection | Index | Keys | Why |
|---|---|---|---|
| `storage` | `strands_expires_at_ttl` | `expires_at` | Expires `ttlSeconds` documents. `MongoDBStorage` never creates it as a side effect of a write: call `ensureIndexes()`. |
| `memory` | `strands_scope_store_content_hash_unique` | `scope`, `store_name`, `content_hash` | Makes a duplicate `add` a no-op instead of a second copy. Partial, so documents with no hash are unaffected. |
| `memory` | `strands_scope_store_created_at` | `scope`, `store_name`, `created_at` desc | Every non-search read is scope plus store plus recency. |
| `memory` | `strands_expires_at_ttl` | `expires_at` | Expires memories whose store sets `ttlSeconds`. Unlike the storage one, `initialize()` creates it whether or not any store sets a TTL, so the first store to set one expires from its first write. |
| `memory` | `vector_index` | `content` as `autoEmbed`, `scope` and `store_name` as filters | The vector tier. Atlas only. Name from `vectorIndexName`. |
| `memory` | `text_index` | `content` as a string field | The text tier. Atlas Search only. Name from `textIndexName`. |

The two search indexes shown are the zero-configuration shape, where Atlas embeds your text. Setting
`embeddingDimensions` and `similarity` instead swaps the `autoEmbed` field for a `vector` field of that
width, and adding `filterFields` appends one filter entry per path.

### Creating them by hand

<!-- indexes -->
Paste into `mongosh`, connected to the database in your `MongoDBConfig`. This block is generated from
the same code that runs at `initialize()` and a test asserts they are identical line for line, so it is
worth pasting rather than retyping:

<!-- run: mongosh -->
```javascript
db.runCommand({"createIndexes":"storage","indexes":[{"key":{"expires_at":1},"name":"strands_expires_at_ttl","expireAfterSeconds":0}]})
db.runCommand({"createIndexes":"memory","indexes":[{"key":{"scope":1,"store_name":1,"content_hash":1},"name":"strands_scope_store_content_hash_unique","unique":true,"partialFilterExpression":{"content_hash":{"$exists":true}}}]})
db.runCommand({"createIndexes":"memory","indexes":[{"key":{"scope":1,"store_name":1,"created_at":-1},"name":"strands_scope_store_created_at"}]})
db.runCommand({"createIndexes":"memory","indexes":[{"key":{"expires_at":1},"name":"strands_expires_at_ttl","expireAfterSeconds":0}]})
db.runCommand({"createSearchIndexes":"memory","indexes":[{"name":"vector_index","type":"vectorSearch","definition":{"fields":[{"type":"autoEmbed","path":"content","model":"voyage-4-lite","modality":"text"},{"type":"filter","path":"scope"},{"type":"filter","path":"store_name"}]}}]})
db.runCommand({"createSearchIndexes":"memory","indexes":[{"name":"text_index","type":"search","definition":{"mappings":{"dynamic":false,"fields":{"content":[{"type":"string"}]}}}}]})
```

Substitute your collection names if you set `collection`. The first four are ordinary indexes and any
MongoDB accepts them; the last two need Atlas Search, and the vector one additionally needs an embedding
model registered on the cluster.

A search index cannot be redefined in place. To change one, for example to add a `filterFields` entry,
drop it and create it again; these are the lines this package's own error messages hand you when an
existing index does not cover the definition it needs:

<!-- run: mongosh -->
```javascript
db.runCommand({"dropSearchIndex":"memory","name":"vector_index"})
db.runCommand({"dropSearchIndex":"memory","name":"text_index"})
```

### Ensure versus verify

`ensureIndexes: false` is verify-only rather than skip. A credential with no DDL rights still needs to
know whether the indexes are there, and what happens when one is absent depends on which index it is:

<!-- verify -->
| Index kind | `true` (default) does | `false`, and it is missing |
|---|---|---|
| Ordinary and TTL | Creates what is missing, one `createIndexes` call per collection | Throws `StorageError`. The message is the list of `createIndexes` commands that fix it, one line each |
| Search, under `searchType: 'auto'` | Creates it, then polls until it is queryable | A warning naming the index, and that tier is skipped. The store starts and answers from the tier that is left, and tries the skipped one again later; if neither is left it throws |
| Search, under a named `searchType`: `'vector'`, `'text'` or `'hybrid'` | Creates it, then polls until it is queryable | Throws `StorageError`. There is no second tier to fall back to, and answering from one you did not ask for changes what matches |

So verify mode is not a quiet mode. A missing ordinary index stops startup with a work order, because the
alternative is worse than a late start: the uniqueness index behind `add`'s deduplication is one of them,
and an application that runs without it writes duplicates silently and surfaces the problem in the data
weeks later. The one case that continues is a search index under `auto`, where the package has somewhere
to fall back to and a store answering lexically is worth more than a store that will not start. That one
is visible only in your logs, so read the warnings.

`MongoDBStorage` follows the same rule through `ensureIndexes()`, which is explicit rather than part of
any operation: its collection has one ordinary index and no search index unless a strategy declares one,
so `ensureIndexes: false` there throws with the command for `strands_expires_at_ttl` and creates nothing.

Waiting is bounded. Under a named `searchType`, `initialize()` waits up to 300 s per index, then throws
`StorageError`. Under `'auto'` it does not wait (it runs during `Agent` construction): building tiers are
skipped, and the first `search` waits up to 300 s for the first of them to be ready. Later searches do
not wait, and throw `StorageError` until a tier is ready. Skipped tiers are retried with backoff from
60 s up to an hour.

### Privileges

The table shows MongoDB's built-in `read` and `readWrite` roles as Atlas 8.0 defines them. Role
definitions belong to the server and can change, so a test rechecks the table against whatever deployment
the contract tier points at.

<!-- privileges -->
| Action | This package needs it for | `read` | `readWrite` |
|---|---|---|---|
| `find` | Every read, on both surfaces | yes | yes |
| `insert` | `write`, `add` | no | yes |
| `update` | `write` overwriting an existing key | no | yes |
| `remove` | `delete`, `deleteAll`, `deletePrefix` | no | yes |
| `listCollections` | The collation preflight, before any index, on both surfaces | yes | yes |
| `listIndexes` | Verify mode, ordinary indexes | yes | yes |
| `listSearchIndexes` | Verify mode, search indexes, and the Atlas Search probe | yes | yes |
| `createIndex` | Ensure mode, ordinary indexes | no | yes |
| `createCollection` | Ensure mode, the namespace a search index needs | no | yes |
| `createSearchIndexes` | Ensure mode, search indexes | no | yes |

So `readWrite` covers everything including index creation, and `read` is enough for a search-only store
in verify mode. The interesting case is the one in between: an application that writes memories but must
not create indexes. No built-in role expresses that, so it takes a custom role granting the four data
actions and the three metadata reads, and `ensureIndexes: false`. Keep `insert` in that role even though
this package never sends an `insert` command: every write it makes is an upsert, and a role holding
`update` without `insert` is refused one.

`listCollections` is not optional and is not about indexes. Every `initialize()`, and the first operation
on a `MongoDBStorage`, reads the collection's collation before anything else, because a collection that
folds case cannot keep two scopes apart, and `listCollections` is the only command that reports it. A
role without it fails there and not later, which is the intended direction: the alternative is a store
that runs and compares strings by rules nothing declared.

Self-managed MongoDB grants the same. On 8.2.12 with no search process, every row matches Atlas,
`createSearchIndexes` included. The contract tier reads every row from the deployment's own `rolesInfo`, so
a version that grants any of them differently fails a test. A role says what the server would authorize,
not what it can do, so `readWrite` carries `createSearchIndexes` on a deployment with no search at all.

Two notes for running as such a user. `rolesInfo`, which the test above uses to read the table back, needs
`viewRole`, and no data-access role grants it, so that one test skips under a least-privilege credential
instead of running. And `dropDatabase` is in neither role, so the test suite cannot drop the throwaway
database it creates; it warns and leaves it. No code path in the package drops a database, and erasure
uses `remove`, which `readWrite` grants.

## Limits

Everything a caller runs into that this package does not remove. Each row says what you can do about it,
and the last column names the method, class or constant it concerns.

<!-- limits -->
| Limit | Where it bites, and what you can do | Source |
|---|---|---|
| One pool per config identity | Two configs that differ in `connectionString` or `clientOptions` open two pools. Build one config object and pass it to every store. | `MongoDBConfig` |
| The connection resolves per operation | An operation after `close()` opens a fresh pool rather than throwing, so a mistaken `close()` costs a connection instead of an error. Call `close()` once, at process shutdown. | `MongoDBStorage.close()` |
| `close()` is scoped to the config | Closing one store's connection closes the pool that every store built from the same config is sharing. Siblings with an operation in flight are the ones that notice. | `MongoDBMemoryStore.close()` |
| A memory is not searchable when `add()` resolves | Atlas embeds and indexes asynchronously, after the write is acknowledged. Poll for the memory rather than reading straight back. | `MongoDBMemoryStore.add()` |
| An empty search result is ambiguous | `MemoryManager` turns a failed store into a warning and returns what survived, so zero hits can mean zero matches or a search that failed. Watch for the manager's warning in your logs. | `MongoDBMemoryStore.search()` |
| Document size | 16 MB, the server's BSON ceiling. Checked before the write, so you get the SDK's `StorageError` naming the size instead of a driver error. Chunk, or store a pointer. | `MAX_DOCUMENT_BYTES` |
| Storage key length | 1024 bytes of UTF-8, prefix included, which keeps a key inside an index entry. Same early `StorageError`. | `MAX_KEY_BYTES` |
| `list()` is unpaginated | The SDK's interface takes a prefix and no cursor, so a prefix matching a million keys returns a million keys. Use narrower prefixes, or `namespace()`. | `Storage.list()` |
| On `MongoDBStorage`, `ttlSeconds` needs an index nothing creates implicitly | `write` stamps `expires_at`, and the documents stay until the storage collection has its TTL index. No ordinary operation creates it, so the documents stay forever if nothing does. Call `await storage.ensureIndexes()` once at startup, or run the command above. The memory store is the other way round: `initialize()` creates its TTL index unconditionally, so a `ttlSeconds` there expires from the first write with nothing to call. | `MongoDBStorage.ensureIndexes()` |
| Vector dimensions | 8192 on the manual vector path, rejected at configuration time rather than by the server. | `MAX_DIMENSIONS` |
| Results per search | 10 by default. Raise `maxSearchResults` on the store, or `limit` on a single query. | `DEFAULT_MAX_SEARCH_RESULTS` |
| Vector candidates considered | 10 per result requested. Raise `oversamplingFactor` for recall, lower it for latency. | `DEFAULT_OVERSAMPLING_FACTOR` |
| Vector candidates per query | 10000, the server's `numCandidates` ceiling. A `limit` times `oversamplingFactor` above it throws `RangeError` before the query is sent. Lower one of the two. | `MAX_NUM_CANDIDATES` |
| Waiting for a search index | 300 s per index. Set `indexReadyTimeout` to change it. | `READY_TIMEOUT_SECONDS` |

## Observability

<!-- observability -->
Both stores record an OpenTelemetry span for every public operation, on the tracer provider your
application already has, through `@opentelemetry/api`. The package configures nothing: no provider, no
processor, no exporter, no sampling. With no provider registered, the API's no-op tracer answers, and
each operation costs a few microseconds. Spans join whatever context is active, so in an agent traced by
Strands each memory search shows up inside the model turn or tool call that made it.

To export them, turn on Strands telemetry, which registers a provider:

<!-- skip: it needs the SDK's OpenTelemetry peer packages, which this package's dev tree does not install -->
```ts
import { setupTracer } from '@strands-agents/sdk/telemetry'

setupTracer({ exporters: { otlp: true } })
```

Or register a provider yourself. The tracer is looked up on every call, so it does not matter whether
that happens before or after this package is imported. The two packages below arrive with the SDK's
own OpenTelemetry peers; this package depends on neither:

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

| Span | Recorded by |
|---|---|
| `strands_mongodb.storage.write` | `MongoDBStorage.write()` |
| `strands_mongodb.storage.read` | `MongoDBStorage.read()` |
| `strands_mongodb.storage.delete` | `MongoDBStorage.delete()` |
| `strands_mongodb.storage.list` | `MongoDBStorage.list()` |
| `strands_mongodb.storage.search` | `MongoDBStorage.search()` |
| `strands_mongodb.storage.delete_prefix` | `MongoDBStorage.deletePrefix()` |
| `strands_mongodb.storage.ensure_indexes` | `MongoDBStorage.ensureIndexes()` |
| `strands_mongodb.memory.initialize` | `MongoDBMemoryStore.initialize()`, only on calls that reach the setup lock: the one that does the setup, and any that queued behind it and record a short span spent waiting. Every operation calls it, and once setup is done the calls record nothing. |
| `strands_mongodb.memory.add` | `MongoDBMemoryStore.add()` |
| `strands_mongodb.memory.search` | `MongoDBMemoryStore.search()` |
| `strands_mongodb.memory.delete` | `MongoDBMemoryStore.delete()` |
| `strands_mongodb.memory.delete_all` | `MongoDBMemoryStore.deleteAll()` |
| `strands_mongodb.indexes.ensure` | Creating or checking indexes, inside `memory.initialize` or `storage.ensure_indexes` |
| `strands_mongodb.indexes.probe` | Asking the deployment what it supports: Atlas Search, `$rankFusion`, or the collection's collation |
| `strands_mongodb.indexes.wait` | Waiting for a search index to finish building. One span per index waited on, not one per poll. |

Span names are the Python package's, snake_cased, so one dashboard reads both. The three `indexes.*`
spans are children of the operation that needed them, so a slow first `search()` shows where its time
went.

Every span is `INTERNAL`. It carries the attributes below that apply to it, and none of OpenTelemetry's
`db.*` attributes: those describe one database command, and an operation here can be several. For a span
per command, use the driver's command monitoring or an OpenTelemetry instrumentation for the Node
driver. This package does not duplicate either.

| Attribute | On | Value |
|---|---|---|
| `strands_mongodb.database` | every span | The database name |
| `strands_mongodb.collection` | every span | The collection name |
| `strands_mongodb.store_name` | every `memory.*` span | The store's configured `name` |
| `strands_mongodb.search.requested` | `memory.search`, `memory.initialize` | The configured `searchType`: `auto`, `vector`, `text` or `hybrid` |
| `strands_mongodb.search.tier` | `memory.search` | The tier that answered. Alert on it differing from `search.requested` to catch a store that has degraded. |
| `strands_mongodb.search.tiers` | `memory.initialize` | The tiers that came up, comma-separated |
| `strands_mongodb.result_count` | `memory.search`, `storage.search`, `storage.list` | Entries or keys returned |
| `strands_mongodb.deleted_count` | `memory.delete`, `memory.delete_all`, `storage.delete`, `storage.delete_prefix` | Documents removed, as the server reported them |
| `strands_mongodb.found` | `storage.read` | Whether the key existed |
| `strands_mongodb.duplicate` | `memory.add` | Whether the fact was already stored, so nothing was written |
| `strands_mongodb.indexes.mode` | `indexes.ensure` | `ensure`, or `verify` when `ensureIndexes` is `false` |
| `strands_mongodb.indexes.created` | `indexes.ensure` | Indexes this call created, `0` when they were all there |
| `strands_mongodb.indexes.outcome` | `indexes.wait` | `ready`, or `timed_out` when `indexReadyTimeout` ran out. Absent when a build reports `FAILED`, which ends the span in `ERROR` instead |
| `strands_mongodb.indexes.probe` | `indexes.probe` | `search`, `rank_fusion` or `collation` |
| `strands_mongodb.client.injected` | the `client.acquired` event | Whether you supplied the `client` |
| `error.type` | a failed span | The error's class name, `StorageError` or `MongoServerError` for example |

A span whose operation threw has status `ERROR`, with the error's class name as the description and
`error.type` set to the same name. The error's message is never recorded, and neither is its stack: this
package's messages name the key or namespace on purpose, so you can act on them, and a span is exported
to a third party where a thrown error is not.

A wait that runs out is the exception. Its `indexes.wait` span says `timed_out` and keeps its status
`UNSET`, because waiting longer is all that went wrong; the `indexes.ensure` span above it carries the
`ERROR`. Under `searchType: 'auto'` the store then carries on without that tier, and `search.tiers` on
`memory.initialize` shows which ones came up.

Never recorded, on any span or in any log line: a storage key or prefix, stored content or payload,
metadata you supplied, query text, filter values, a scope, a memory id, a connection string, a username or
a password. A scope is usually a tenant or user id, which is why it is on that list. The store name is
configuration you chose, so it is recorded.

`strands_mongodb.client.acquired` is a span event, recorded once for each connection pool this package
creates or registers, on the span that is active at that moment. That is the store's constructor, if you
build the store inside a traced block, or the first operation after a `close()`, which opens a fresh pool.
On the memory store that first operation does its setup in `memory.initialize`, so the event lands on
that span rather than on `memory.search`. A store built at module load has no active span to record on,
and its first operation takes over the pool that construction built, which creates nothing. The driver
connects lazily, so the cost of connecting sits inside the first operation's span either way.

Log lines go to the `logger` in your `MongoDBConfig`, an SDK `Logger` with `debug`, `info`, `warn` and
`error`. The default is the SDK's: `warn` and `error` to the console, `debug` and `info` dropped. Every
line has one shape, so a pipeline can index it without parsing the sentence:

```text
strands_mongodb: <sentence> | event=<name>, namespace=<database>.<collection>, tier=<tier>
```

`event` is always present; `namespace` and `tier` appear where the line is about one. The event names are
stable, and identical to the Python package's `strands_mongodb_event` values:

| `event` | Level | Logged when |
|---|---|---|
| `retry_writes_disabled` | `warn` | The client has retryable writes turned off |
| `reserved_key_collision` | `warn` | A stored document's metadata uses a key the store sets on every result |
| `no_search_setup` | `warn` | The deployment has no Atlas Search, so no search index is set up |
| `tier_unavailable` | `warn` | Under `auto`, a search tier could not be prepared and was skipped |
| `tier_building` | `info` | Under `auto`, a search index was still building, so its tier was skipped until a search needs it |
| `below_vector` | `warn` | Under `auto`, vector search is unavailable and queries use the text tier |
| `bound_declined_fusion` | `warn` | A score bound kept `auto` off the hybrid tier |
| `score_bound_applied` | `debug` | `minScore` or `maxScore` dropped results |
| `creating_indexes` | `info` | Ordinary indexes are being created |
| `creating_search_index` | `info` | A search index is being created |
| `search_index_status` | `info` | A search index changed status while being waited for |
| `attribute_dropped` | `debug` | A span attribute was not on the allow-list and was dropped |
| `attribution_not_visible`, `closed_loop_client_dropped` | none | Declared in `LogEvent` for parity with the Python package and never emitted by this one: the Node driver always takes `appendMetadata`, and Node has no event loop to close under a client |

## Examples

Two runnable scripts in [`examples/`](examples/README.md), ported from
[`python/examples/`](../python/examples/README.md). Each splits into two commands you run as separate
processes, so the only thing that carries state between them is MongoDB:

<!-- skip: each line is a whole process run against a deployment -->
```bash
npx tsx examples/memory-recall.ts write      # then: recall
npx tsx examples/unified-storage.ts run      # then: resume
```

`MONGODB_URI` is all either one needs, and `--dry-run` shows what a step would do before it connects.

## Requirements

| | |
|---|---|
| Node.js | `>=22.0.0`. The package is ES modules; see below for CommonJS |
| `@strands-agents/sdk` | `>=1.23.0`, the first release exporting `Embedder` from `@strands-agents/sdk/storage/search` |
| `mongodb` | `^7.0.0`, the driver both stores run on |
| `@opentelemetry/api` | `^1.9.0`. The API only: this package installs no SDK, provider or exporter |
| MongoDB | Any deployment serves storage. The text tier needs Atlas Search; the vector tier needs Atlas or an Atlas CLI local deployment. The default embedding path also needs an embedding model registered on the deployment. An Atlas CLI local deployment (`mongodb/mongodb-atlas-local`) has none, so use the manual path or the text tier there. |

**CommonJS.** This package ships ES modules only. Node 22.12 and later load it from a CommonJS file with
`require('strands-mongodb')`, because nothing in its module graph uses top-level `await`; older Node
throws `ERR_REQUIRE_ESM` there, and `await import('strands-mongodb')` is the way in. The build tier runs
both shapes against the packed tarball.

## Development

<!-- skip: each line is a whole run, and one of them is the run reading this line -->
```bash
npm ci
npm test                # unit project, no MongoDB needed
npm run check           # format check, lint, type check, unit tests with coverage, release gate
```

The test suite is tiered by what infrastructure it needs. Tiers whose backend is absent are skipped
with a reason, never silently passed:

| Tier | Script | Backend | Gate |
|---|---|---|---|
| Unit | `npm test` | A fake `MongoClient` | Always runs |
| Contract | `npm run test:contract` | Any real MongoDB | `MONGODB_URI` |
| Integration | `npm run test:integration` | Atlas or Atlas CLI local, with `mongot` | `MONGODB_ATLAS_URI` |
| AutoEmbeddings | `npm run test:autoembed` | Cluster with a registered Atlas embedding model | `MONGODB_AUTOEMBED_URI` |
| Build | `npm run test:build` | Network: packs the tarball and installs it into empty ESM and CommonJS projects | `STRANDS_MONGODB_BUILD_TIER` |
| Gate | `npm run test:gate` | The last run's `.vitest-results.json` | Run it after the suite it measures |

The three connection-string variables are also read from a `.env` file, in `typescript/` first and then
the repository root, whichever exists. Only those three keys are read, and a value already set in the
environment is never replaced, so CI behaves as if the file were absent. Both paths are `.gitignore`d.

<!-- skip: each line is a whole test run, and one of them is the run reading this line -->
```bash
MONGODB_URI=mongodb://localhost:27017 npm run test:contract

# Opt out of a configured backend: empty, not unset. An unset variable is refilled from `.env`.
MONGODB_URI= MONGODB_ATLAS_URI= MONGODB_AUTOEMBED_URI= npm test
```

Pointing all three variables at one Atlas cluster runs every tier and covers less than three
deployments do. Some tests assert what happens where a capability is *missing*, and they skip with a
reason on a cluster that has it. For the widest coverage:

| Variable | Deployment | Covers only there |
|---|---|---|
| `MONGODB_URI` | plain `mongod`, no `mongot` | A search query against a server with no search process |
| `MONGODB_ATLAS_URI` | Atlas CLI local, `mongot`, no registered model | An `autoEmbed` index rejected at creation, and the degraded default that follows |
| `MONGODB_AUTOEMBED_URI` | Atlas cluster with a registered model | The default embedding mode, end to end |

Each tier writes to a database named `strands_mongodb_<tier>`, in collections named after the run, and
drops what it created at the end, so pointing `MONGODB_URI` at a deployment you care about keeps the
tests out of its existing collections, but is still not recommended.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
