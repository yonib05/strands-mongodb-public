# strands-mongodb

MongoDB storage and memory backends for the [Strands Agents](https://strandsagents.com) SDK.

This is the Python half of the [strands-mongodb](https://github.com/mongodb/strands-mongodb) repository. One MongoDB deployment
sits behind both of the SDK's persistence extension points:

| Surface | Class | Module | Extra | SDK protocol | Serves |
|---|---|---|---|---|---|
| Storage | `MongoDBStorage` | `strands_mongodb.storage` | `[storage]` | `strands.storage.Storage` | Sessions, context offloading, memory persistence, context history, transcripts |
| Memory | `MongoDBMemoryStore` | `strands_mongodb.memory_store` | `[memory]` | `strands.memory` `MemoryStore` | Semantic recall over Atlas Vector Search, extraction writes |

Note that the memory module and its extra are spelled differently: `strands_mongodb.memory_store` is
installed by `strands-mongodb[memory]`.

Either class can be imported from the package root or from its own module:

<!-- run: unit -->
```python
from strands_mongodb import MongoDBStorage          # resolved on first access
from strands_mongodb.storage import MongoDBStorage  # identical class
```

The root import resolves the class lazily, so it imports only the module you name. On a
`[storage]`-only install, `import strands_mongodb` followed by `MongoDBStorage` never touches the
memory module and never needs `pymongo-search-utils`. The one exception is
`from strands_mongodb import *`, which walks `__all__` and therefore loads every module, the memory one
included.

The `Storage` protocol is what makes this possible: the SDK accepts a single top-level `storage` on
`Agent`, and five subsystems inherit it. One `MongoDBStorage` is therefore the backend for session
management and context offloading. Each is still turned on with the SDK's own objects
(`SnapshotSessionManager`, and `context_manager="auto"`), and neither needs a MongoDB-specific class.

![strands-mongodb in a Strands agent: the SDK's session manager, context manager and memory manager use MongoDBStorage and MongoDBMemoryStore, which store to MongoDB](https://raw.githubusercontent.com/mongodb/strands-mongodb/main/docs/images/architecture.png)

**Already using another MongoDB backend for Strands?** Three exist: the archived `mongodb_memory` tool
in `strands-agents-tools`, and the community `strands-mongodb-store` and `strands-mongodb-storage`
packages. [MIGRATION.md](https://github.com/mongodb/strands-mongodb/blob/main/python/MIGRATION.md) maps each one's settings and document fields onto this
package's, says which of the three need data copied and which do not, and covers the index-name
collision all three run into.

## Install

Pick the surface you need. Each extra pulls only its own dependencies.

<!-- skip: installs from PyPI, which no test tier reaches -->
```bash
pip install 'strands-mongodb[storage]'   # MongoDBStorage
pip install 'strands-mongodb[memory]'    # MongoDBMemoryStore
pip install 'strands-mongodb[all]'       # both
```

> **Quote the brackets.** In `zsh` (the default macOS shell) and `fish`, an unquoted
> `pip install strands-mongodb[storage]` fails with `no matches found` because the shell tries to
> glob the brackets. `bash` is unaffected. The quoted form above works in every shell.

A bare `pip install strands-mongodb` installs no runtime dependencies and gives you no working
backend. It is metadata only. The extra you choose is what selects the dependency set, so
`[storage]` never drags in vector-search machinery you are not using.

## Quickstart

The test suite runs both snippets below directly from this file. Each reads its connection string from `MONGODB_URI` and its
database from `MONGODB_DATABASE`, defaulting to `agents`.

### Storage

<!-- run: contract -->
```python
import asyncio
import os

from strands_mongodb import MongoDBStorage
from strands_mongodb.types import MongoDBConfig

connection: MongoDBConfig = {
    "connection_string": os.environ["MONGODB_URI"],
    "database": os.environ.get("MONGODB_DATABASE", "agents"),
}


async def main() -> None:
    storage = MongoDBStorage(connection, collection="storage")
    try:
        await storage.write("notes/deployment", b"the cluster is in us-east-1")
        print(await storage.read("notes/deployment"))
        print(await storage.list("notes/"))
        await storage.delete("notes/deployment")
    finally:
        await storage.close()


asyncio.run(main())
```

Nothing has to be provisioned first. Storage needs no index the server does not already create, which
is the reason keys are stored as `_id`.

### Memory

This one needs an Atlas cluster with a registered embedding model, because it takes the default path
where the deployment embeds the text and you never handle a vector.

<!-- run: autoembed -->
```python
import asyncio
import os

from strands_mongodb import MongoDBMemoryStore
from strands_mongodb.types import MongoDBConfig

connection: MongoDBConfig = {
    "connection_string": os.environ["MONGODB_URI"],
    "database": os.environ.get("MONGODB_DATABASE", "agents"),
}


async def main() -> None:
    store = MongoDBMemoryStore(name="preferences", config=connection, scope="user-abc", writable=True)
    try:
        await store.initialize()  # creates the indexes; every other operation calls it too
        await store.add("Prefers metric units and a 24-hour clock.")

        # Atlas embeds a new document asynchronously, after the write is acknowledged, and on a new
        # collection the text index can finish before the vector one. Until the vector tier is ready a
        # search answers lexically, so this query finds nothing for a few minutes rather than failing.
        for _ in range(90):
            found = await store.search("how should times be displayed for this person?")
            if found:
                break
            await asyncio.sleep(5)
        else:
            raise SystemExit("The vector index or the embedding is not ready yet. Run this again.")

        for entry in found:
            print(entry.metadata["_relevance_score"], entry.content)
    finally:
        await store.close()


asyncio.run(main())
```

The query shares no word with the stored fact. That is the point of the vector tier, and it is also why
the first run of this snippet is slower. The first `search` waits for the first index to be ready, and
when that is the text index, searches answer lexically until a retry finds the vector index ready: 120
seconds later, then at doubling intervals. On an existing collection both indexes are ready at once.

To give an agent both surfaces, pass one config to both and let the SDK wire them:

<!-- skip: needs a model provider and its credentials, which no test tier configures -->
```python
from strands import Agent
from strands.memory import MemoryManager
from strands.session import SnapshotSessionManager

store = MongoDBMemoryStore(name="preferences", config=connection, scope="user-abc", writable=True)
agent = Agent(
    model=your_model,
    storage=MongoDBStorage(connection),
    session_manager=SnapshotSessionManager(session_id="support-ticket-4127"),
    memory_manager=MemoryManager(stores=[store], add_tool_config=True),
)
```

The two `True`s are what let the agent save anything. `MemoryManager` always gives the model a
`search_memory` tool, but it adds `add_memory` only when `add_tool_config=True`, and the SDK defaults
that to `False`. The store must also be writable, and this package defaults `writable` to `False`. If no
store is writable, `add_tool_config=True` raises `ValueError` when you construct the manager. With
neither set, the agent can recall memories but has no way to save new ones. If you would rather the SDK
pick facts out of the conversation than leave it to the model, set `extraction=True` on the writable
store instead of, or as well as, `add_tool_config`.

One `storage` on `Agent` serves five subsystems, but it doesn't turn them on. The `session_manager`
line above is what persists the conversation under its session ID. To offload context as well, pass
`context_manager="auto"`:

<!-- skip: needs a model provider and its credentials, which no test tier configures -->
```python
agent = Agent(
    model=your_model,
    storage=MongoDBStorage(connection),
    session_manager=SnapshotSessionManager(session_id="support-ticket-4127"),
    context_manager="auto",
)
```

A type checker will reject `stores=[store]`, and the reason is the SDK's rather than yours: its
`MemoryStore` protocol declares `add_messages` as a member while its own docstring calls it optional, so
any store that omits it fails the assignment. `MongoDBMemoryStore` omits it on purpose, because
`MemoryManager` feature-detects the method and falls back to its own extractor, which dedupes.
`examples/memory_recall.py` carries the one-line `cast` and the full explanation.

## Connecting to a deployment

`MongoDBConfig` takes either a client you built or a connection string, and it needs one of the two. In
preference order:

| How | Key | What it costs you |
|---|---|---|
| Inject a client | `client` | Nothing. The credential stays inside an object you own, and you get every driver option, including ones this package never exposes. |
| A connection string with a passwordless mechanism | `connection_string` | Your deployment has to be set up for X.509, AWS IAM, OIDC or Kerberos. |
| A connection string with a password | `connection_string` | The password is now a value in a plain dict. |

That order is a security order, not a style one. `MongoDBConfig` is a `TypedDict`, so it is a dict at
runtime, and a dict ends up in tracebacks, log records and debugger frames. An injected client keeps the
credential out of it:

<!-- run: contract -->
```python
import asyncio
import os

from pymongo import AsyncMongoClient

from strands_mongodb import MongoDBStorage
from strands_mongodb.types import MongoDBConfig

client = AsyncMongoClient(os.environ["MONGODB_URI"])
connection: MongoDBConfig = {
    "client": client,
    "database": os.environ.get("MONGODB_DATABASE", "agents"),
}


async def main() -> None:
    storage = MongoDBStorage(connection)
    try:
        await storage.write("notes/injected", b"the credential never entered the config dict")
        await storage.delete("notes/injected")
    finally:
        # `storage.close()` deliberately does nothing to an injected client. It is yours, and something
        # else in the process may still be using it.
        await client.close()


asyncio.run(main())
```

An injected client also carries its own event loop affinity, which matters if you build one per request.
`client_args` covers the middle ground: this package passes it to the `AsyncMongoClient` it builds from
your connection string, so TLS settings, timeouts and read preferences all reach the driver without an
injected client.

<!-- driver-info -->
Every client this package uses identifies the package in its connection handshake, the way MongoDB's
handshake specification asks a library that wraps the driver to: it adds `Strands-MongoDB` and the installed
version to the driver name and version the server records, so `PyMongo|c|async|Strands-MongoDB` and
`4.17.0|0.1.0`. Server logs and `$currentOp` show this as `clientMetadata.driver`. A client this package
builds gets it at construction; an injected `client` gets it through pymongo's `append_metadata`, once.
`appName` stays yours: the package never sets, defaults or changes it, whether you give it in the
connection string, in `client_args` or on an injected client.

### Authentication mechanisms

The driver decides what is available here, not this package. `pymongo` 4.17.0 declares `MONGODB-AWS`,
`MONGODB-OIDC`, `MONGODB-X509`, `GSSAPI`, `PLAIN`, `SCRAM-SHA-1` and `SCRAM-SHA-256`, and any of them
works through either route above: as `authMechanism` in the connection string, or as a keyword to the
client you inject. Whether your deployment accepts one is a question for the deployment.

One of them needs a package neither of this package's extras installs. `MONGODB-AWS` requires
`pymongo-auth-aws`, which arrives with `pip install 'pymongo[aws]'`, and the driver does not tell you
until it tries to authenticate: the failure is a `ConfigurationError` on the first connection, not an
`ImportError` at startup, so a misconfigured process starts cleanly and fails on its first operation.

## Configuration reference

Three `TypedDict`s, and every key of all three is listed here. A test compares these tables against the
declarations, so a key added to the package and not to this file fails the build.

### `MongoDBConfig`

The connection half. Build one per process and share it: two stores holding the same config object share
one connection pool.

<!-- keys: MongoDBConfig -->
| Key | Type | Required | Default | What it does |
|---|---|---|---|---|
| `database` | `str` | yes | | Database holding every collection this config reaches. |
| `client` | `AsyncMongoClient` | no | | A client you built. Preferred over `connection_string`, and this package never closes it. |
| `connection_string` | `str` | no | | A MongoDB URI. Required unless `client` is set; supplying neither raises. |
| `client_args` | `dict[str, Any]` | no | `{}` | Extra keyword arguments for the client this package builds. Ignored when `client` is set. |
| `ensure_indexes` | `bool` | no | `True` | Whether to create missing indexes. `False` verifies and reports instead. See below. |
| `index_ready_timeout` | `float` | no | `300` | Seconds to wait for each search index to become queryable, timed separately per index, so an `"auto"` store can wait this long once per tier. Raise it on a shared deployment where a build queues behind somebody else's. |
| `search_type` | `"auto" \| "vector" \| "text" \| "hybrid"` | no | `"auto"` | Which memory search tiers to prepare and query. |
| `embedding_model` | `str` | no | `voyage-4-lite` | Atlas embedding model, on the AutoEmbeddings path where the deployment embeds your text. |
| `embedding_dimensions` | `int` | no | | Vector length, on the manual path where you supply the vectors. Mutually exclusive with `embedding_model`, and requires `similarity`. |
| `similarity` | `"cosine" \| "dotProduct" \| "euclidean"` | no | | Distance metric, on the manual path. Requires `embedding_dimensions`. No default: the right metric is a property of your embeddings. |
| `filter_fields` | `list[str]` | no | `[]` | Extra document paths a caller may filter on. `scope` and `store_name` are always declared. |
| `vector_index_name` | `str` | no | `vector_index` | Name of the Atlas Vector Search index. |
| `text_index_name` | `str` | no | `text_index` | Name of the Atlas Search full-text index. |

### `MongoDBMemoryStoreConfig`

The keyword arguments of `MongoDBMemoryStore`. The first five come from the SDK's `MemoryStoreConfig`
and behave as they do for any store, with one exception noted below.

<!-- keys: MongoDBMemoryStoreConfig -->
| Key | Type | Required | Default | What it does |
|---|---|---|---|---|
| `name` | `str` | yes | | Identifies the store. Stamped on every document as `store_name` and part of every read predicate. |
| `description` | `str` | no | | Passed to the SDK, which shows it to the model when it chooses a store. |
| `max_search_results` | `int` | no | `10` | Default result count, not a ceiling. A per-call `limit` overrides it, and so does the SDK `search_memory` tool's `max_search_results` argument, which the model chooses. Below 1 raises. |
| `writable` | `bool` | no | `False` | Gates `add`, `delete` and `delete_all`. `False` here, unlike `FileMemoryStore`: the cost of the wrong default is a retrieval store that starts accepting model-written memories. |
| `extraction` | `ExtractionConfig \| bool` | no | | Passed to the SDK's extractor. This package never extracts anything itself. |
| `config` | `MongoDBConfig` | yes | | The connection, nested. Share one across stores. |
| `collection` | `str` | no | `memory` | Collection holding this store's documents. |
| `scope` | `str` | no | a sentinel | Tenant boundary. Stamped on writes and applied to reads by this package, never by the caller. Absence is a distinct scope, never "everything". |
| `filter` | `dict[str, Any]` | no | | Extra search predicate, composed as a narrowing conjunction. It cannot widen what this store can read. Paths must appear in `filter_fields`. |
| `min_score` | `float` | no | | Relevance floor. Applied after the search, so it drops results without changing their order. |
| `max_score` | `float` | no | | Relevance ceiling. Mutually exclusive with `min_score`. |
| `ttl_seconds` | `int` | no | | How long a memory lives, measured from its own `created_at`. Absent means it never expires and stamps no field; `0` means "at the next sweep" and is a real value, not a disabled one; a negative value raises `ValueError`. Set on insert, so re-remembering a fact does not extend it. Needs no `ensure_indexes()` call here: `initialize()` already creates the TTL index. |
| `embedder` | `TextEmbedder` | no | | Manual-vector path only: embeds on `add()` and string `search()`. See [Supplying your own vectors](#supplying-your-own-vectors). |

### `MongoDBSearchQuery`

Passed to `search()` instead of a plain string, when a per-query filter, limit or embedding is needed.
Every key is optional, but at least one of `text` and `vector` has to be set. Setting both is valid only
on a manual-vector store whose `search_type` is `"auto"` or `"hybrid"`, where the hybrid tier reads one
key in each of its two pipelines; anywhere else it raises `ValueError`.

<!-- keys: MongoDBSearchQuery -->
| Key | Type | Required | Default | What it does |
|---|---|---|---|---|
| `text` | `str` | no | | The query text. What `search("...")` fills in. |
| `vector` | `list[float]` | no | | A query embedding, on the manual-vector path. Combined with `text` only by the hybrid tier, as above. |
| `filter` | `dict[str, Any]` | no | | Narrows this query only. Same rules as the store's `filter`. |
| `limit` | `int` | no | `10` | Result ceiling for this query. Outranks both `max_search_results` settings. |
| `oversampling_factor` | `int` | no | `10` | Multiplier turning the limit into a `$vectorSearch` candidate count. |

### `MongoDBStorage`

`MongoDBStorage(config, /, *, collection="storage", prefix="", ttl_seconds=None, search_strategy=None)`.
The config comes first and positionally, and can be the same object a memory store holds.

| Argument | Type | Default | What it does |
|---|---|---|---|
| `config` | `MongoDBConfig` | | The connection. Only the connection keys matter here; the search keys are memory-only. |
| `collection` | `str` | `storage` | Collection holding this instance's documents. |
| `prefix` | `str` | `""` | Prepended to every key, scoping this instance inside the collection. Normalized to end in one `/`. |
| `ttl_seconds` | `int \| None` | `None` | Lifetime of the documents this instance writes. Needs the TTL index; see Limits. A negative value raises `ValueError`. |
| `search_strategy` | `SearchStrategy \| None` | `None` | What `search()` runs instead of the default key-only scan. Shared by `namespace()` views. |

#### Searching storage

By default `search()` scores keys only, in one server-side query that reads no values. A word that is
only inside a value doesn't match, and `FileMemoryStore` keeps its facts there, under keys named after
their topic. For `FileMemoryStore`, pass a strategy that reads values: the SDK's
`KeywordSearchStrategy()` matches shared words, and the vector strategy below matches by meaning.

#### Vector search over storage

`MongoDBVectorSearchStrategy` is the MongoDB counterpart of the SDK's `S3VectorSearchStrategy`. It
stores each value's vector on the value's own document. Empty and non-UTF-8 values aren't indexed.
Each value is embedded whole, so it must fit the embedding model's input; a longer one makes `write()`
raise `StorageError` after the value is stored. Values written before the strategy was configured have
no vector, so vector search can't find them until they're rewritten. `VoyageEmbedder` is defined in
[Supplying your own vectors](#supplying-your-own-vectors).

Every write through the storage is embedded, so give the strategy only to the storage you search, in
its own collection. On `Agent(storage=...)` it would also embed session snapshots on every turn.

<!-- skip: it needs an embedding model and Atlas Vector Search -->
```python
from strands.vended_memory_stores.file_memory_store import FileMemoryStore
from strands_mongodb import MongoDBStorage, MongoDBVectorSearchStrategy

memory_storage = MongoDBStorage(
    connection,
    collection="memory_files",
    search_strategy=MongoDBVectorSearchStrategy(
        embedder=VoyageEmbedder(), dimensions=1024, similarity="cosine"
    ),
)
await memory_storage.ensure_indexes()  # also creates the vector index
knowledge = FileMemoryStore(name="facts", storage=memory_storage)
```

### What the methods return

| Method | Returns |
|---|---|
| `MongoDBStorage.read(key)` | `bytes`, or `None` when the key is absent |
| `MongoDBStorage.list(prefix)` | `list[str]` of keys |
| `MongoDBStorage.search(query)` | `list[StorageSearchResult]`, the SDK's type |
| `MongoDBStorage.delete_prefix(prefix)` | `int`, the documents removed |
| `MongoDBStorage.namespace(prefix)` | A second `MongoDBStorage` over the same collection, scoped under `prefix` |
| `MongoDBMemoryStore.add(content, metadata)` | `MongoDBAddResult`, with `ids`, `inserted` and `duplicates`. A fact already stored counts as a duplicate rather than a second write |
| `MongoDBMemoryStore.search(query, options)` | `list[MemoryEntry]`, the SDK's type, carrying the reserved metadata keys below |
| `MongoDBMemoryStore.delete(memory_id)` and `delete_all()` | `int`, the documents removed |

Failures from the database come back as the SDK's `StorageError`, from `strands.types.exceptions`, with
the namespace in the message. A caller mistake that no round trip could fix, such as an invalid query,
is a `ValueError` raised before anything is sent.

### Other public names

| Name | Module | What it is |
|---|---|---|
| `SearchType` | `strands_mongodb.types` | The values `search_type` accepts: `auto`, `vector`, `text`, `hybrid` |
| `ResolvedSearchType` | `strands_mongodb.types` | The tiers that can answer, as `_search_type` reports them |
| `VectorSimilarity` | `strands_mongodb.types` | The metrics `similarity` accepts |
| `RESERVED_METADATA_KEYS` | `strands_mongodb.types` | The four metadata keys this package owns |
| `UNSCOPED` | `strands_mongodb.memory_store` | The scope stamped and filtered on when a store names none |
| `__version__` | `strands_mongodb` | The installed version |

## Search: what answers a query

`search()` picks a tier from the query's **shape**, not from what you asked for, and reports which one
ran in the `_search_type` metadata key. Three tiers exist in `0.1.0`:

<!-- tiers -->
| Tier | Runs | Needs |
|---|---|---|
| `hybrid` | one `$rankFusion` over the two pipelines below | MongoDB 8.0 or later, **and** both of the other tiers available |
| `vector` | `$vectorSearch` against `vector_index` | Atlas, or an Atlas CLI local deployment, plus a registered embedding model on the AutoEmbeddings path |
| `text` | `$search` against `text_index` | Atlas Search, and no embedding model |

`search_type` decides which of them `initialize()` prepares. `"auto"` prepares every tier the deployment
offers and prefers the highest one it got; naming one prepares only that one, so a `text` store never
builds a vector index it will never query, and a `vector` store fails rather than quietly answering a
query lexically. Naming `hybrid` prepares both underlying indexes and fails at `initialize()` if the
deployment cannot fuse, rather than falling back to half of what you asked for.

Preparation can come up short without failing. A deployment with no search process at all gets its
ordinary indexes and a warning, and the search call is what raises. A cluster with Atlas Search but no
registered embedding model rejects the `autoEmbed` index at creation, and a store configured for `"auto"`
falls back to the text tier and says so in a warning. Both of those are visible only in your logs, which
is worth knowing before you conclude that recall is bad.

![How search_type auto picks a tier: hybrid if it is ready, then vector, then text, otherwise StorageError](https://raw.githubusercontent.com/mongodb/strands-mongodb/main/docs/images/search-tiers.png)

`regex` is not here. `SearchType` is a `Literal` of the values that actually run, so a type checker
rejects it today rather than a runtime raising on it later.

### Hybrid scores are on a different scale

<!-- rrf -->
Fused results are **not** similarity scores, and a `min_score` or `max_score` chosen against the vector
tier will not mean what you meant on this one. `$rankFusion` scores by reciprocal rank fusion:

```
RRFscore(d) = sum over tiers of  weight / (60 + rank of d in that tier)
```

The `60` is MongoDB's rank constant, and this package does not change it. With the two tiers weighted
equally, a document ranked first by both scores about `0.033`; one ranked first by a single tier scores
about `0.016`; everything else is smaller. So a `min_score` of `0.7`, a perfectly ordinary cosine floor,
removes every result.

Because that failure is silent (an empty list is also what "no matches" looks like), a store on `"auto"`
with either bound configured stays on the vector tier and logs that it did. Asking for `search_type="hybrid"`
by name overrides that: the bound is applied to the fused score, on the scale above, because you asked
for this tier specifically.

### Supplying your own vectors

Setting `embedding_dimensions` and `similarity` selects the manual path, where the vector index covers an
`embedding` field on each document instead of asking Atlas to embed `content`.

<!-- manual-vectors -->
The package indexes and queries `embedding` but never fills it on its own. Pass an `embedder` and `add()`
and string `search()` embed for you, so `MemoryManager` works unchanged.
From strands-agents 1.64.0, any SDK `Embedder` works, including `BedrockEmbedder`. On every supported
release, so does any object with an `async embed(text)` method, such as this one for Voyage AI:

<!-- skip: it needs a Voyage AI API key -->
```python
import voyageai


class VoyageEmbedder:
    def __init__(self, model: str = "voyage-4-lite") -> None:
        self._client = voyageai.AsyncClient()  # reads VOYAGE_API_KEY
        self._model = model

    async def embed(self, text: str) -> list[float]:
        return (await self._client.embed([text], model=self._model)).embeddings[0]


store = MongoDBMemoryStore(
    name="facts",
    config={**connection, "embedding_dimensions": 1024, "similarity": "cosine"},
    embedder=VoyageEmbedder(),
    writable=True,
)
```

Without one, memories get no `embedding` and only a `MongoDBSearchQuery` with a precomputed `vector`
can use the vector tier. AutoEmbeddings needs no `embedder` and rejects one.

### Reserved metadata keys

Every returned entry carries four keys this package owns in its `metadata`, because the SDK's
`MemoryEntry` has nowhere else to put them:

| Key | Holds |
|---|---|
| `_relevance_score` | The score from whichever tier answered |
| `_id` | The document id, which is also the `memory_id` that `delete()` takes |
| `_search_type` | `hybrid`, `vector` or `text`, whichever ran |
| `_scope` | The scope of the store that answered, read from the store and never from the document |

Your own metadata merges underneath these. On a name collision the reserved value wins and the collision
is logged, so a key of yours is never silently dropped without a record.

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
caller cannot set it through `filter` or `metadata`; an absent scope resolves to a distinct sentinel
rather than to no predicate; a caller `filter` composes as a narrowing conjunction and cannot widen the
read; and `delete()` reaches exactly as far as `search()` does. The tests for these run two stores in
one collection and check isolation in both directions.

![What every memory write and read goes through: a write is stamped with scope and store name and deduplicated by content hash; a read passes the filter guard and is limited to the store's scope](https://raw.githubusercontent.com/mongodb/strands-mongodb/main/docs/images/memory-guards.png)

If a tenant boundary is a compliance boundary, use one of the first two rows.

## Where your text goes

<!-- data-flow -->
What leaves the process depends on the embedding path, and on neither of them does this package send text
anywhere except the deployment you connected it to.

- **AutoEmbeddings, the default.** The deployment's search process sends the `content` of every memory, and
  the text of every query that reaches the vector tier (including the vector half of a `hybrid` search), to
  the embedding model named by `embedding_model`, `voyage-4-lite` unless you set it. That is a call the
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
needs from a memory backend. The SDK's `MemoryStore` protocol has no deletion member, so these are the
package's own surface rather than a protocol method.

| Call | Removes | Returns |
|---|---|---|
| `await store.delete(memory_id)` | The one memory with that `_id`, if this store can see it | `1` or `0` |
| `await store.delete_all()` | Every memory this store can see | The count |

`memory_id` is the `_id` string a search result carries in its `metadata`, so the id you delete by is
the id you were handed. Anything that is not a 24-character hex ObjectId is rejected before a network
call.

Both calls require `writable: True`, and both reach exactly as far as `search()` does: one scope, this
store's name, narrowed by any configured `filter`. A store cannot delete what it cannot read. Two
consequences are worth stating rather than leaving to be discovered:

- **Erasing a scope takes one call per store in it.** `delete_all()` empties one store's view, not the
  whole scope, because `store_name` is part of the predicate. There is no single call that erases a whole scope.
- **`0` does not mean "no such memory."** A well-formed id gets `0` whether it names a memory already
  deleted, one in another scope, or one in another store in this scope. Telling those apart would
  answer whether an id exists somewhere the caller cannot read.

<!-- erasure-reach -->
Erasure reaches the live deployment and nothing else. `delete()` and `delete_all()` remove documents from
the collection, and the search indexes built from them follow; they do not reach backups, snapshots or the
oplog, which keep what they hold for as long as the deployment's own retention says. A request that has to
cover those copies is a request to whoever operates the deployment.

## Indexes and privileges

`initialize()` creates what it needs by default, which is convenient in development and often the wrong
thing in production, where index creation is a DBA's call and the application's credential is not
supposed to hold `createIndex`. Set `ensure_indexes: False` and this section is the handoff.

### What gets created

Six indexes across two collections. Names are prefixed `strands_` so an operator can tell ours from
theirs, and they are stable: renaming one would be a breaking change.

| Collection | Index | Keys | Why |
|---|---|---|---|
| `storage` | `strands_expires_at_ttl` | `expires_at` | Expires `ttl_seconds` documents. `MongoDBStorage` never creates it as a side effect of a write: call `ensure_indexes()`. |
| `memory` | `strands_scope_store_content_hash_unique` | `scope`, `store_name`, `content_hash` | Makes a duplicate `add` a no-op instead of a second copy. Partial, so documents with no hash are unaffected. |
| `memory` | `strands_scope_store_created_at` | `scope`, `store_name`, `created_at` desc | Every non-search read is scope plus store plus recency. |
| `memory` | `strands_expires_at_ttl` | `expires_at` | Expires memories whose store sets `ttl_seconds`. Unlike the storage one, `initialize()` creates it whether or not any store sets a TTL, so the first store to set one expires from its first write. |
| `memory` | `vector_index` | `content` as `autoEmbed`, `scope` and `store_name` as filters | The vector tier. Atlas only. Name from `vector_index_name`. |
| `memory` | `text_index` | `content` as a string field | The text tier. Atlas Search only. Name from `text_index_name`. |

The two search indexes shown are the zero-configuration shape, where Atlas embeds your text. Setting
`embedding_dimensions` and `similarity` instead swaps the `autoEmbed` field for a `vector` field of that
width, and adding `filter_fields` appends one filter entry per path.

### Creating them by hand

Paste into `mongosh`, connected to the database in your `MongoDBConfig`. This block is generated from
the same code that runs at `initialize()` and a test asserts they are identical line for line, so it is
worth pasting rather than retyping:

<!-- run: mongosh -->
```javascript
db.runCommand({"createIndexes": "storage", "indexes": [{"key": {"expires_at": 1}, "name": "strands_expires_at_ttl", "expireAfterSeconds": 0}]})
db.runCommand({"createIndexes": "memory", "indexes": [{"key": {"scope": 1, "store_name": 1, "content_hash": 1}, "name": "strands_scope_store_content_hash_unique", "unique": true, "partialFilterExpression": {"content_hash": {"$exists": true}}}]})
db.runCommand({"createIndexes": "memory", "indexes": [{"key": {"scope": 1, "store_name": 1, "created_at": -1}, "name": "strands_scope_store_created_at"}]})
db.runCommand({"createIndexes": "memory", "indexes": [{"key": {"expires_at": 1}, "name": "strands_expires_at_ttl", "expireAfterSeconds": 0}]})
db.runCommand({"createSearchIndexes": "memory", "indexes": [{"name": "vector_index", "type": "vectorSearch", "definition": {"fields": [{"type": "autoEmbed", "path": "content", "model": "voyage-4-lite", "modality": "text"}, {"type": "filter", "path": "scope"}, {"type": "filter", "path": "store_name"}]}}]})
db.runCommand({"createSearchIndexes": "memory", "indexes": [{"name": "text_index", "type": "search", "definition": {"mappings": {"dynamic": false, "fields": {"content": [{"type": "string"}]}}}}]})
```

Substitute your collection names if you set `collection`. The first four are ordinary indexes and any
MongoDB accepts them; the last two need Atlas Search, and the vector one additionally needs an embedding
model registered on the cluster.

### Ensure versus verify

`ensure_indexes: False` is verify-only rather than skip. A credential with no DDL rights still needs to
know whether the indexes are there, and what happens when one is absent depends on which index it is:

<!-- verify -->
| Index kind | `True` (default) does | `False`, and it is missing |
|---|---|---|
| Ordinary and TTL | Creates what is missing, one `createIndexes` call per collection | Raises. The message is the list of `createIndexes` commands that fix it, one line each |
| Search, under `search_type: "auto"` | Creates it, then polls until it is queryable | A warning naming the index, and that tier is skipped. The store starts and answers from the tier that is left, and tries the skipped one again later; if neither is left it raises |
| Search, under a named `search_type`: `"vector"`, `"text"` or `"hybrid"` | Creates it, then polls until it is queryable | Raises. There is no second tier to fall back to, and answering from one you did not ask for changes what matches |

So verify mode is not a quiet mode. A missing ordinary index stops startup with a work order, because the
alternative is worse than a late start: the uniqueness index behind `add`'s deduplication is one of them,
and an application that runs without it writes duplicates silently and surfaces the problem in the data
weeks later. The one case that continues is a search index under `auto`, where the package has somewhere
to fall back to and a store answering lexically is worth more than a store that will not start. That one
is visible only in your logs, so read the warnings.

`MongoDBStorage` follows the same rule through `ensure_indexes()`, which is explicit rather than part of
any operation: its collection has one ordinary index and no search index, so `ensure_indexes: False`
there raises with the command for `strands_expires_at_ttl` and creates nothing.

Waiting is bounded. Under a named `search_type`, `initialize()` waits up to 300 s per index, then raises
`StorageError`. Under `"auto"` it doesn't wait (it runs during `Agent` construction): building tiers are
skipped, and the first `search` waits up to 300 s for the first of them to be ready. Later searches
don't wait, and raise `StorageError` until a tier is ready. Skipped tiers are retried with backoff from
60 s up to an hour.

### Privileges

The table shows MongoDB's built-in `read` and `readWrite` roles as Atlas 8.0.30 defines them. Role
definitions belong to the server and can change, so a test rechecks the table against whatever deployment
the contract tier points at.

<!-- privileges -->
| Action | This package needs it for | `read` | `readWrite` |
|---|---|---|---|
| `find` | Every read, on both surfaces | yes | yes |
| `insert` | `write`, `add` | no | yes |
| `update` | `write` overwriting an existing key | no | yes |
| `remove` | `delete`, `delete_all` | no | yes |
| `listCollections` | The collation preflight, before any index, on both surfaces | yes | yes |
| `listIndexes` | Verify mode, ordinary indexes | yes | yes |
| `listSearchIndexes` | Verify mode, search indexes | yes | yes |
| `createIndex` | Ensure mode, ordinary indexes | no | yes |
| `createCollection` | Ensure mode, the namespace a search index needs | no | yes |
| `createSearchIndexes` | Ensure mode, search indexes | no | yes |

So `readWrite` covers everything including index creation, and `read` is enough for a search-only store
in verify mode. The interesting case is the one in between: an application that writes memories but must
not create indexes. No built-in role expresses that, so it takes a custom role granting the four data
actions and the three metadata reads, and `ensure_indexes: False`. Keep `insert` in that role even though
this package never sends an `insert` command: every write it makes is an upsert, and a role holding `update`
without `insert` is refused one.

`listCollections` is not optional and is not about indexes. Every `initialize()` reads the collection's
collation before anything else, because a collection that folds case cannot keep two scopes apart, and
`listCollections` is the only command that reports it. A role without it fails at `initialize()` and not
later, which is the intended direction: the alternative is a store that runs and compares strings by rules
nothing declared.

Self-managed MongoDB grants the same. On 6.0.28, 7.0.40 and 8.3.8, started with `--auth` and with no search
process, every row other than `listCollections` matches Atlas, `createSearchIndexes` included, and
`listCollections` matches on 8.0.32. The contract tier reads every row from the deployment's own `rolesInfo`,
so a version that grants any of them differently fails a test. A role says what the server would authorize,
not what it can do, so `readWrite` carries `createSearchIndexes` on a deployment with no search at all.

Two notes for running as such a user. `rolesInfo`, which the test above uses to read the table back, needs
`viewRole`, and no data-access role grants it, so that one test skips under a least-privilege credential
instead of running. And `dropDatabase` is in neither role, so the test suite cannot drop the throwaway
databases it creates; it warns and leaves them. No code path in the package drops a database, and erasure
uses `remove`, which `readWrite` grants.

## Limits

Everything a caller runs into that this package does not remove. Each row says what you can do about it,
and the last column names the method, class or constant it concerns. A constant named there may be private
to the package: it is named so the value can be traced, not so it can be imported.

<!-- limits -->
| Limit | Where it bites, and what you can do | Source |
|---|---|---|
| One client per event loop | A new loop means a new connection and a new handshake. A synchronous `Agent` calling `invoke()` in a loop pays that per call. Drive the package from one loop, through the SDK's `invoke_async`. | `MongoDBConfig` |
| The connection resolves per operation | An operation after `close()` opens a fresh pool rather than raising, so a mistaken `close()` costs a connection instead of an error. Call `close()` once, at process shutdown. | `MongoDBStorage.close()` |
| `close()` is scoped to the config | Closing one store's connection closes the pool that every store built from the same config is sharing. Siblings with an operation in flight are the ones that notice. | `MongoDBMemoryStore.close()` |
| A memory is not searchable when `add()` returns | Atlas embeds and indexes asynchronously, after the write is acknowledged. Poll for the memory rather than reading straight back. | `MongoDBMemoryStore.add()` |
| An empty search result is ambiguous | `MemoryManager` turns a failed store into a warning and returns what survived, so zero hits can mean zero matches or a search that failed. Watch for `store search failed` in your logs. | `MongoDBMemoryStore.search()` |
| Embedding throughput on the default path | On the AutoEmbeddings path the deployment embeds every query that reaches the vector tier, the vector half of a `hybrid` search included, and Atlas limits how fast it will. Atlas accepted about 2,000 embedding requests a minute (about 33 a second) in load testing on an M30. Above that, searches fail with "Embedding provider rate limit exceeded", and `MemoryManager` turns the failure into a warning (see the empty-result row above). The default memory search issues two searches per agent turn, so this supports about 16 turns a second per deployment. `search_type="text"` embeds nothing and is not affected, and the manual-vector path embeds in your own `embedder`. | `MongoDBMemoryStore.search()` |
| Default storage search examines every key | `search()` with no `search_strategy` scores each key under the instance's prefix, in one server-side query that reads no values. Cost grows with the number of keys examined: about 30 ms at 1,000 keys, 1.5 s at 100,000 and 4.6 s at 300,000 in load testing on an M30. Sessions, `read`, `write`, `list` and `MongoDBMemoryStore` are unaffected. Search a narrower key space with `namespace()` or a `prefix`, since the scan is bounded by the instance's prefix. Where the searched keys are ephemeral, give them their own instance or collection with `ttl_seconds` and call `ensure_indexes()` at startup to keep the key count down. A TTL deletes what it covers and applies to everything that instance writes, so never set it on the storage that holds sessions or memories you need to keep. | `MongoDBStorage.search()` |
| Document size | 16 MB, the server's `BSON` ceiling. Checked before the write, so you get the SDK's `StorageError` naming the size instead of a driver error. Chunk, or store a pointer. | `MAX_DOCUMENT_BYTES` |
| Storage key length | 1024 bytes, which keeps a key inside an index entry. Same early `StorageError`. | `MAX_KEY_BYTES` |
| `list()` is unpaginated | The SDK's protocol takes a prefix and no cursor, so a prefix matching a million keys returns a million keys. Use narrower prefixes, or `namespace()`. | `Storage.list()` |
| On `MongoDBStorage`, `ttl_seconds` needs an index nothing creates implicitly | `write` stamps `expires_at`, and the documents stay until the storage collection has its TTL index. No ordinary operation creates it, so the documents stay forever if nothing does. Call `await storage.ensure_indexes()` once at startup, or run the command above. The memory store is the other way round: `initialize()` creates its TTL index unconditionally, so a `ttl_seconds` there expires from the first write with nothing to call. | `MongoDBStorage.ensure_indexes()` |
| Vector dimensions | 8192 on the manual vector path, rejected at configuration time rather than by the server. | `MAX_DIMENSIONS` |
| Results per search | 10 by default. Raise `max_search_results` on the store, or `limit` on a single query. | `DEFAULT_MAX_SEARCH_RESULTS` |
| Vector candidates considered | 10 per result requested. Raise `oversampling_factor` for recall, lower it for latency. | `DEFAULT_OVERSAMPLING_FACTOR` |
| Vector candidates per query | 10000, the server's `numCandidates` ceiling. A `limit` times `oversampling_factor` above it raises `ValueError` before the query is sent. Lower one of the two. | `MAX_NUM_CANDIDATES` |
| Waiting for a search index | 300 s per index. Set `index_ready_timeout` to change it. | `READY_TIMEOUT_SECONDS` |

## Observability

<!-- observability -->
Both stores record an OpenTelemetry span for every public operation, on the tracer provider your
application already has. The package configures nothing: no provider, no processor, no exporter, no
sampling. With no provider installed, OpenTelemetry's no-op tracer answers, and each operation costs
a few microseconds. Spans join whatever trace is current, so in an agent traced by Strands each memory
search shows up inside the model turn or tool call that made it.

To export them, turn on Strands telemetry, which installs a provider:

<!-- skip: it needs strands-agents' otel extra and a collector to send to -->
```python
from strands.telemetry import StrandsTelemetry

StrandsTelemetry().setup_otlp_exporter()
```

Or install a `TracerProvider` yourself. The tracer is looked up on every call, so it does not matter
whether that happens before or after this package is imported. `opentelemetry-sdk` is not a dependency
of this package; the snippet below works because `strands-agents` already requires it:

<!-- run: unit -->
```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
trace.set_tracer_provider(provider)
```

| Span | Recorded by |
|---|---|
| `strands_mongodb.storage.write` | `MongoDBStorage.write()` |
| `strands_mongodb.storage.read` | `MongoDBStorage.read()` |
| `strands_mongodb.storage.delete` | `MongoDBStorage.delete()` |
| `strands_mongodb.storage.list` | `MongoDBStorage.list()` |
| `strands_mongodb.storage.search` | `MongoDBStorage.search()` |
| `strands_mongodb.storage.delete_prefix` | `MongoDBStorage.delete_prefix()` |
| `strands_mongodb.storage.ensure_indexes` | `MongoDBStorage.ensure_indexes()` |
| `strands_mongodb.memory.initialize` | `MongoDBMemoryStore.initialize()`, only on calls that reach the setup lock: the one that does the setup, and any that queued behind it and record a short span spent waiting. Every operation calls it, and once setup is done the calls record nothing. |
| `strands_mongodb.memory.add` | `MongoDBMemoryStore.add()` |
| `strands_mongodb.memory.search` | `MongoDBMemoryStore.search()` |
| `strands_mongodb.memory.delete` | `MongoDBMemoryStore.delete()` |
| `strands_mongodb.memory.delete_all` | `MongoDBMemoryStore.delete_all()` |
| `strands_mongodb.indexes.ensure` | Creating or checking indexes, inside `memory.initialize` or `storage.ensure_indexes` |
| `strands_mongodb.indexes.probe` | Asking the deployment what it supports: Atlas Search, `$rankFusion`, or the collection's collation |
| `strands_mongodb.indexes.wait` | Waiting for a search index to finish building. One span per index waited on, not one per poll. |

The three `indexes.*` spans are children of the operation that needed them, so a slow first `search()`
shows where its time went.

Every span is `INTERNAL`. It carries the attributes below that apply to it, and none of OpenTelemetry's
`db.*` attributes: those describe one database command, and an operation here can be several. For a span
per command, use the driver's command monitoring or an OpenTelemetry instrumentation for pymongo. This
package does not duplicate either.

| Attribute | On | Value |
|---|---|---|
| `strands_mongodb.database` | every span | The database name |
| `strands_mongodb.collection` | every span | The collection name |
| `strands_mongodb.store_name` | every `memory.*` span | The store's configured `name` |
| `strands_mongodb.search.requested` | `memory.search`, `memory.initialize` | The configured `search_type`: `auto`, `vector`, `text` or `hybrid` |
| `strands_mongodb.search.tier` | `memory.search` | The tier that answered. Alert on it differing from `search.requested` to catch a store that has degraded. |
| `strands_mongodb.search.tiers` | `memory.initialize` | The tiers that came up, comma-separated |
| `strands_mongodb.result_count` | `memory.search`, `storage.search`, `storage.list` | Entries or keys returned |
| `strands_mongodb.deleted_count` | `memory.delete`, `memory.delete_all`, `storage.delete`, `storage.delete_prefix` | Documents removed, as the server reported them |
| `strands_mongodb.found` | `storage.read` | Whether the key existed |
| `strands_mongodb.duplicate` | `memory.add` | Whether the fact was already stored, so nothing was written |
| `strands_mongodb.indexes.mode` | `indexes.ensure` | `ensure`, or `verify` when `ensure_indexes` is `False` |
| `strands_mongodb.indexes.created` | `indexes.ensure` | Indexes this call created, `0` when they were all there |
| `strands_mongodb.indexes.outcome` | `indexes.wait` | `ready`, or `timed_out` when `index_ready_timeout` ran out. Absent when a build reports `FAILED`, which ends the span in `ERROR` instead |
| `strands_mongodb.indexes.probe` | `indexes.probe` | `search`, `rank_fusion` or `collation` |
| `strands_mongodb.client.injected` | the `client.acquired` event | Whether you supplied the `client` |
| `error.type` | a failed span | The exception's qualified class name |

A span whose operation raised has status `ERROR`, with the exception's class name as the description and
`error.type` set. The exception's message is never recorded, and neither is its traceback: this package's
messages name the key or namespace on purpose, so you can act on them, and a span is exported to a third
party where a raised exception is not.

A wait that runs out is the exception. Its `indexes.wait` span says `timed_out` and keeps its status
`UNSET`, because waiting longer is all that went wrong; the `indexes.ensure` span above it carries the
`ERROR`. Under `search_type="auto"` the store then carries on without that tier, and `search.tiers` on
`memory.initialize` shows which ones came up.

Never recorded, on any span or in any log record: a storage key or prefix, stored content or payload,
metadata you supplied, query text, filter values, a scope, a memory id, a connection string, a username or
a password. A scope is usually a tenant or user id, which is why it is on that list. The store name is
configuration you chose, so it is recorded.

`strands_mongodb.client.acquired` is a span event, recorded once for each connection pool this package
creates or registers, on the span that is current at that moment. That is the store's constructor, if you
build the store inside a traced block, or the first operation on a new event loop, if you call a
synchronous `Agent` repeatedly and each call runs a fresh loop. On the memory store that first operation
does its setup in `memory.initialize`, so the event lands on that span rather than on `memory.search`. A
store built at import time has no span to record on, and its first operation takes over the pool that
construction built, which creates nothing. The driver connects lazily, so the cost of connecting sits inside the first operation's span either way.

Log records keep their messages, levels and logger names, which are the module names under
`strands_mongodb`, so a handler on `logging.getLogger("strands_mongodb")` sees every one. Each record
also carries fields a JSON formatter can index without parsing the message: `strands_mongodb_event`, always, and
`strands_mongodb_namespace` (`<database>.<collection>`) and `strands_mongodb_tier` where the record is
about one. The event names are stable:

| `strands_mongodb_event` | Level | Logged when |
|---|---|---|
| `retry_writes_disabled` | `WARNING` | The client has retryable writes turned off |
| `attribution_not_visible` | `DEBUG` | An injected client did not take the Strands-MongoDB driver attribution |
| `closed_loop_client_dropped` | `DEBUG` | An event loop closed before its client could be closed |
| `reserved_key_collision` | `WARNING` | A stored document's metadata uses a key the store sets on every result |
| `no_search_setup` | `WARNING` | The deployment has no Atlas Search, so no search index is set up |
| `tier_unavailable` | `WARNING` | Under `auto`, a search tier could not be prepared and was skipped |
| `tier_building` | `INFO` | Under `auto`, a search index was still building, so its tier was skipped until a search needs it |
| `below_vector` | `WARNING` | Under `auto`, vector search is unavailable and queries use the text tier |
| `bound_declined_fusion` | `WARNING` | A score bound kept `auto` off the hybrid tier |
| `score_bound_applied` | `DEBUG` | `min_score` or `max_score` dropped results |
| `creating_indexes` | `INFO` | Ordinary indexes are being created |
| `creating_search_index` | `INFO` | A search index is being created |
| `search_index_status` | `INFO` | A search index changed status while being waited for |
| `attribute_dropped` | `DEBUG` | A span attribute was not on the allow-list and was dropped |

## Examples

Two runnable scripts in [`examples/`](https://github.com/mongodb/strands-mongodb/blob/main/python/examples/README.md), each split into two commands you run as two
processes, so the only thing crossing between them is MongoDB:

<!-- skip: the examples are run by their own tests, which supply the second command and the backend -->
```bash
python examples/memory_recall.py write     # then: recall
python examples/unified_storage.py run     # then: resume
```

`memory_recall.py` stores a fact in one process and recalls it in the next from a query that shares no
word with it, over server-side embeddings. `unified_storage.py` has three SDK subsystems writing to one
collection under three key prefixes, then restores the session in a fresh interpreter.

`MONGODB_URI` is the only variable either one needs, and `--dry-run` prints what a step would do without
connecting to anything.

## Requirements

| | |
|---|---|
| Python | >= 3.10 |
| `strands-agents` | >= 1.54.0, the first release shipping every `strands` module the storage backend imports |
| `pymongo` | >= 4.14.0, the async driver both stores run on |
| `pymongo-search-utils` | >= 0.3.0, pulled in by the `memory` extra (and so by `all`) only |
| `typing-extensions` | >= 4.13.2 |
| `opentelemetry-api` | >= 1.30.0. The API only: this package installs no SDK, provider or exporter |
| MongoDB | Any deployment serves storage. The text tier needs Atlas Search; the vector tier needs Atlas or an Atlas CLI local deployment. The default embedding path also needs an embedding model registered on the deployment. An Atlas CLI local deployment (`mongot` 8.3.8) has none, so use the manual path or the text tier there. |

## Development

<!-- skip: running this would install into whatever interpreter the test suite happens to be using -->
```bash
pip install -e '.[all,dev]'

hatch run test          # unit tier, no MongoDB needed
hatch run lint
hatch run typecheck
hatch run prepare       # format, lint, typecheck, test
```

The test suite is tiered by what infrastructure it needs. Tiers whose backend is absent are
skipped with a reason, never silently passed:

| Tier | Marker | Backend | Gate |
|---|---|---|---|
| Unit | none | Mocked `AsyncMongoClient` | Always runs |
| Contract | `contract` | Any real MongoDB | `MONGODB_URI` |
| Integration | `integration` | Atlas or Atlas CLI local, with `mongot` | `MONGODB_ATLAS_URI` |
| AutoEmbeddings | `autoembed` | Cluster with a registered Atlas embedding model | `MONGODB_AUTOEMBED_URI` |
| Compatibility | `compat` | Latest published `strands-agents`, not the pinned one | CI cron only |

Two markers mean two requirements, not either one: an `autoembed` test also carries `integration`
and needs both variables set.

Those three variables are also read from a `.env` file, in `python/` first and then the repository
root, whichever exists. Only those three keys are read, and a value already set in the environment is
never replaced, so CI behaves as if the file were absent. Both paths are `.gitignore`d.

<!-- skip: each line is a whole test run, and one of them is the run reading this line -->
```bash
hatch run test                                  # unit only
MONGODB_URI=mongodb://localhost:27017 hatch run test
hatch run cov                                   # release gate: 90% aggregate, 70% per module

# Opt out of a configured backend: empty, not unset. `env -u` is refilled from `.env`.
MONGODB_URI= MONGODB_ATLAS_URI= MONGODB_AUTOEMBED_URI= hatch run test
```

Pointing all three variables at one Atlas cluster runs every tier and covers less than three
deployments do. Some tests assert what happens where a capability is *missing*, and they skip with a
reason on a cluster that has it. For the widest coverage:

| Variable | Deployment | Covers only there |
|---|---|---|
| `MONGODB_URI` | plain `mongod`, no `mongot` | A search query against a server with no search process |
| `MONGODB_ATLAS_URI` | Atlas CLI local, `mongot`, no registered model | An `autoEmbed` index rejected at creation, and the degraded default that follows |
| `MONGODB_AUTOEMBED_URI` | Atlas cluster with a registered model | The default embedding mode, end to end |

For the last row, `python scripts/atlas_ci_cluster.py up` creates a throwaway Atlas cluster with what automated
embedding needs and prints its connection string; `down <name>` deletes it. It is what CI runs, and it needs
the Atlas CLI, logged in, with `MONGODB_ATLAS_PROJECT_ID` set to the project to create it in.

Each test session writes to a database named `strands_mongodb_test_<random>` and drops it at the
end, so pointing `MONGODB_URI` at a deployment you care about keeps the tests out of its existing
databases, but is still not recommended.

## License

Apache-2.0. See [LICENSE](https://github.com/mongodb/strands-mongodb/blob/main/python/LICENSE) and [NOTICE](https://github.com/mongodb/strands-mongodb/blob/main/python/NOTICE).
