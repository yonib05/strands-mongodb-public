# Parity with the Python package

Both packages write the same documents and indexes, so they can share a collection. The first two
sections are what a user of both will notice. The last is for maintainers of the port.

## Behaviours shared with Python that a user may trip on

Kept so both packages behave the same on a shared collection. Each is a candidate to raise upstream for
both languages.

- `close()` on one store closes the client and pool shared by every store with the same connection identity (the same injected client, or equal connection string and client options). A later operation on any of them opens a fresh pool.
- One lock per connection serialises `initialize()` across every store on it. A named `searchType` holds the lock while it waits for its index, up to `indexReadyTimeout`.
- Under `auto`, when the first search's wait times out with no tier ready, searches throw until a retry finds one. The next retry is 120 seconds after that search, and the interval doubles up to 3600 seconds, so a tier can stay unused for up to an hour after its index finishes building.
- Under `auto`, the first search's wait ends when any one index is ready. A query that tier cannot read, such as a text query on a manual-vector store whose vector index was ready first, then throws although the other index would have fitted it.
- `MongoDBStorage.search` without a search strategy scores keys only. Payloads are never read, and SDK consumers such as `FileMemoryStore` get key matches in place of content matches.
- In key-only search the query is lowercased fully, but the server's `$toLower` lowercases ASCII only (MongoDB 8.0.4: `ÉCOLE` becomes `École`). A key word with a non-ASCII capital letter therefore matches no query.
- `list` and `deletePrefix` are string-prefix ranges, not path matches: `user1` also matches `user10/a`. `deletePrefix('')` removes every key under the instance's prefix, and the whole collection when it has none.
- An empty `scope` falls back to the shared `__unscoped__` scope instead of being rejected.
- The `$rankFusion` probe reads any `buildInfo` failure as "not supported" and caches it for the connection, so a transient failure disables the hybrid tier until the process restarts.
- The text tier filters `scope` and `store_name` in a `$match` after `$search`, because the text index maps only `content`: a query in a small scope pays for every lexical hit in the collection. Pre-filtering inside `$search` needs `token` mappings and a `compound` stage, which changes the index definition and the stage both languages send.
- Two processes creating the same search index at once can make one `createSearchIndexes` fail with server code 2 (`duplicate index names for the same collection`). A named `searchType` surfaces it as a `StorageError` from `initialize()`, and a second call succeeds. `auto` logs `tier_unavailable` and skips the tier until the next retry, although the index exists and is building.
- The upsert in `add` copies `scope`, `store_name` and `content_hash` from the selector onto the new document in an order the server chooses. The field set and values are stable. The field order is not.

## Where TypeScript knowingly differs from Python

- Result metadata keys are camelCase: `_relevanceScore` and `_searchType`, where Python returns `_relevance_score` and `_search_type`. `_id` and `_scope` are the same. Stored documents are identical.
- `search` returns stored metadata as relaxed EJSON, because the SDK types it as JSON: a stored date arrives as `{ $date: '...' }`, an ObjectId as `{ $oid: '...' }`, and a 64-bit integer beyond the safe range as a number that may be rounded. Python returns the raw values.
- Log fields ride in the message tail (`| event=<name>, namespace=<db.coll>, tier=<tier>`), because the SDK's `Logger` has no `extra`. Python passes them as `strands_mongodb_event`, `strands_mongodb_namespace` and `strands_mongodb_tier`.
- `rank_fusion_probe_failed` is logged at `debug` when `buildInfo` fails. Python logs nothing there.
- The key-only search pipeline carries `hint: { _id: 1 }`. Without it an unprefixed store plans a COLLSCAN that reads every payload (measured on MongoDB 8.0.4: 50 of 50 documents examined, against 0 with the hint). Python sends no hint and has the COLLSCAN: worth raising upstream.
- `add` matches `scope` and `store_name` with `$eq` in the upsert selector, so a non-string value from a JavaScript caller cannot act as a query operator. The server copies `$eq` terms onto the inserted document exactly as it copies bare ones.
- Errors are `TypeError` for a wrong type or an invalid combination, `RangeError` for a number out of bounds, and the SDK's `StorageError` for a database failure. Python raises `ValueError` for the first two and the SDK's `StorageError` for the third.
- `name`, `scope`, `collection`, `database`, the index names, `embeddingModel`, each `filterFields` entry and the storage `prefix` are checked to be strings at construction, `writable` and `ensureIndexes` to be booleans, `embedder` to have an `embed` method, and `searchType` and `similarity` to be a listed value. `add` checks its content to be a string and its metadata to be an object, `search` its query to be a string or an object whose `text` is a string and whose `vector` is an array of finite numbers, and every storage method its key, prefix or query to be a string. Python's type hints enforce none of this at runtime.
- A vector an embedder returns must be a plain array of finite numbers, or `add`, `write` and `search` throw `TypeError` before anything is stored. The Node driver would store a `Float32Array` as a subdocument that no vector index reads, where pymongo refuses a numpy array.
- Numeric settings, `minScore` and `maxScore` included, are checked for more than their range: a value that is not a number, `NaN`, `Infinity`, and a fraction where a count is needed are `RangeError`s. That includes a `limit` times `oversamplingFactor` that is not a whole number, which Python sends and the server refuses with code 8.
- A `ttlSeconds` whose expiry is past the last date JavaScript can represent is a `RangeError` at construction. Python raises `OverflowError` from `timedelta` on the first write.
- A filter value that is `undefined`, a function, a symbol, or an object with a `toBSON` method is a `TypeError`. The Node driver would leave the first three out of the query or send the result of `toBSON` in the object's place, neither of which pymongo can do.
- The Node driver closes a client when its first connection fails, where pymongo selects a server again on every operation. A client this package built is reconnected and the operation runs once more. An injected client is reported as closed in a `StorageError`, and its owner reopens it with `connect()`.
- Waiting for search indexes records one `strands_mongodb.indexes.wait` span per index. Python records one for the whole wait.
- Both packages make the first search under `auto` wait on every tier at once and drop the rest when one is ready. Python cancels the tasks. TypeScript aborts them with a signal, and their `strands_mongodb.indexes.ensure` spans end with the outcome `abandoned`, a value Python never records.
- A caller's filter is copied one level deep when it is composed with the scope, where Python copies it at every depth. A nested value changed between `search()` being called and the query being sent is sent as changed.
- `search` picks its tier from one reading of the prepared tiers, taken before it embeds the query. Python reads them again after embedding, so a retry in between can leave it with keys no remaining tier accepts.

## Porting notes for maintainers

What the port measured, with `mongodb@7.8.0` and `bson@7.3.4`. The tests that cite a note pin it.
Fixtures in `src/__fixtures__/` are regenerated with `cd python && hatch run python ../typescript/scripts/export-python-fixtures.py`, and CI fails when the result differs from what is committed.

### 1. SDK floor: `@strands-agents/sdk` 1.23.0

A file with this package's SDK imports compiles as follows. The floors job in CI repeats it at 1.23.0 on every pull request.

| SDK | `tsc --noEmit` | First error |
| --- | --- | --- |
| 1.10.0, 1.12.0 | fail | no `@strands-agents/sdk/storage/search` module |
| 1.14.0 to 1.17.0 | fail | no `Embedder` export; `SearchStrategy` has no `index` |
| 1.18.0 to 1.22.0 | fail | `@strands-agents/sdk/storage/search` has no `Embedder` export |
| 1.23.0, 1.24.0 | pass | |

### 2. Keyword tokenizer: identical

The TypeScript SDK's `KeywordSearchStrategy`: `text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)`, into a `Set`.
The Python SDK's: `{t for t in re.split(r"\W+", text.lower()) if t}`.
The two split on the same characters and lowercase the same way for every code point assigned in Unicode 15.1 (Python 3.13), final sigma included.

### 3. `listSearchIndexes` status fields

On `mongodb/mongodb-atlas-local:8` a search index reports `id`, `name`, `type`, `status`, `queryable`, `latestVersion` and `latestDefinition`.
`status` goes from `PENDING` to `READY`, and `queryable` from `false` to `true`.

### 4. AutoEmbeddings on atlas-local: code 8

Creating an `autoEmbed` index on `mongodb/mongodb-atlas-local:8` fails with code 8 (`CanonicalModel: voyage-4-lite not registered yet, supported models are: []`), so no AutoEmbeddings index can exist on this image.
An AutoEmbeddings `$vectorSearch` (`query: { text }`, `model`) against a READY manual index also fails with code 8 (`queryVector must be present`).
A `$vectorSearch` naming an index that does not exist returns `[]` with no error.

### 5. Empty `Binary`

`new Binary(new Uint8Array(0))` and a bare `Uint8Array(0)` field value both read back as a `Binary` of subtype 0 and length 0.

### 6. Document size: matches `_encoded_size`

`BSON.calculateObjectSize({ _id, data: Binary, updated_at: Date })` equals `46 + utf8(_id) + data.length`, and `expires_at: Date` adds exactly 20.
Both equal `BSON.serialize(...).length` and Python's `_encoded_size`.

### 7. `listIndexes` on an absent collection: code 26

The Node driver surfaces `NamespaceNotFound` (code 26) from `listIndexes` on a collection that does not exist, where pymongo returns an empty cursor. `readIndexes` in `src/ensure-indexes.ts` reads 26 as "no indexes" so verify mode reports the missing indexes rather than the missing collection.
