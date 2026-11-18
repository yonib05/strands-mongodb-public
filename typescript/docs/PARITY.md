# Parity findings

Facts the TypeScript port relies on, measured on 2026-11-05.
Fixtures in `src/__fixtures__/` are regenerated with `cd python && hatch run python ../typescript/scripts/export-python-fixtures.py`.

## 1. SDK floor: `@strands-agents/sdk` 1.23.0

The floor is `>=1.23.0`.
`StorageSearchResult` is exported from `@strands-agents/sdk/storage/search`, not from `@strands-agents/sdk/storage`.

```ts
import type { Storage } from '@strands-agents/sdk/storage'
import type { SearchStrategy, Embedder, StorageSearchResult } from '@strands-agents/sdk/storage/search'
```

The stub (those imports plus `StorageError`, `Logger`, `JSONValue`, `Tool`, `MemoryStore`, `MemoryStoreConfig`, `MemoryEntry`, `SearchOptions` from `@strands-agents/sdk`, using `SearchStrategy['index']`, `MemoryStore['initialize']`, `MemoryStore['getTools']`) gives:

| SDK | `tsc --noEmit` | First error |
| --- | --- | --- |
| 1.10.0, 1.12.0 | fail | no `@strands-agents/sdk/storage/search` module |
| 1.14.0 to 1.17.0 | fail | no `Embedder` export; `SearchStrategy` has no `index` |
| 1.18.0 to 1.22.0 | fail | `@strands-agents/sdk/storage/search` has no `Embedder` export |
| 1.23.0, 1.24.0 | pass | |

Measured in a scratch project with the import path above on TypeScript 5.9.3, while this package pins `typescript` `^6.0.3`: 1.22.0 fails with `TS2305: Module '"@strands-agents/sdk/storage/search"' has no exported member 'Embedder'`, and 1.23.0 passes.

## 2. Keyword tokenizer: identical

TypeScript (`strands-ts/src/storage/search/keyword.ts`): `text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)`, into a `Set`.
Python (`strands-py/src/strands/storage/search/keyword.py`): `{t for t in re.split(r"\W+", text.lower()) if t}`.
The source regexes differ textually but split on the same characters.
Every code point assigned in Python 3.13's Unicode 15.1 is classified the same by Python `\w` and by JS `[\p{L}\p{N}_]` (Node 24, Unicode 17). The 9039 differences are all code points unassigned in Unicode 15.1.
`str.lower()` and `String.prototype.toLowerCase()` agree on every code point assigned in Unicode 15.1, including final sigma.

## 3. `listSearchIndexes` status fields

atlas-local `mongodb/mongodb-atlas-local:8` (MongoDB 8.3.13), driver `mongodb@7.8.0`, `bson@7.3.4`.
Fields: `id`, `name`, `type`, `status`, `queryable`, `latestVersion`, `latestDefinition`.
`status` goes from `PENDING` to `READY`; `queryable` goes from `false` to `true`.

Abbreviated, with only the fields that change between creation and settling:

```
{ name: 'vector_index', type: 'vectorSearch', status: 'PENDING', queryable: false, ... }
{ name: 'vector_index', type: 'vectorSearch', status: 'READY', queryable: true, ... }
```

## 4. AutoEmbeddings on atlas-local: code 8

Creating an `autoEmbed` index fails with code 8. No AutoEmbeddings index can exist on this image:

```
{
  name: 'MongoServerError',
  code: 8,
  codeName: 'UnknownError',
  message: 'CanonicalModel: voyage-4-lite not registered yet, supported models are: []'
}
```

An AutoEmbeddings `$vectorSearch` (`query: { text }`, `model`) against a READY manual index also fails with code 8, for `path: 'content'` and for `path: 'embedding'`:

```
{
  name: 'MongoServerError',
  code: 8,
  codeName: 'UnknownError',
  message: 'Executor error during aggregate command on namespace: parity2.memory :: caused by :: queryVector must be present'
}
```

A `$vectorSearch` naming an index that does not exist returns `[]` with no error.

## 5. Empty `Binary`

`new Binary(new Uint8Array(0))` and a bare `Uint8Array(0)` field value both read back as a `Binary` of subtype 0 and length 0.

## 6. Document size: matches `_encoded_size`

`BSON.calculateObjectSize({ _id, data: Binary, updated_at: Date })` equals `46 + utf8(_id) + data.length`.
Adding `expires_at: Date` adds exactly 20.
Both equal `BSON.serialize(...).length`, and a bare `Uint8Array` for `data` sizes the same as a `Binary`.

Every combination of four keys (1 to 26 UTF-8 bytes) and four `data` lengths (0 to 65536) matched `_encoded_size`, for example:

```
key                    keyBytes  size   plain  python  withTtl  pythonTtl
'strands/session/abc'  19        1000   1065   1065    1085     1085
```

## 7. `listIndexes` on an absent collection: code 26

The Node driver surfaces `NamespaceNotFound` (code 26) from `listIndexes` on a collection that does not exist, where pymongo returns an empty cursor. `readIndexes` in `src/ensure-indexes.ts` reads 26 as "no indexes" so verify mode reports the missing indexes rather than the missing collection.

## Behaviours shared with Python that a user may trip on

Kept so both packages behave the same on a shared collection. Each is a candidate to raise upstream for
both languages.

- `close()` on one store closes the client and pool shared by every store with the same connection identity (the same injected client, or equal connection string and client options). A later operation on any of them opens a fresh pool.
- One lock per connection serialises `initialize()` across every store on it. A named `searchType` holds the lock while it waits for its index, up to `indexReadyTimeout`.
- Under `auto`, when the first search's wait times out with no tier ready, searches throw until a retry finds one. Retries start 60 seconds later and double up to 3600 seconds, so a tier can stay unused for up to an hour after its index finishes building.
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
- Log fields ride in the message tail (`| event=<name>, namespace=<db.coll>, tier=<tier>`), because the SDK's `Logger` has no `extra`. Python passes them as `strands_mongodb_event`, `strands_mongodb_namespace` and `strands_mongodb_tier`.
- `rank_fusion_probe_failed` is logged at `debug` when `buildInfo` fails. Python logs nothing there.
- The key-only search pipeline carries `hint: { _id: 1 }`. Without it an unprefixed store plans a COLLSCAN that reads every payload (measured on MongoDB 8.0.4: 50 of 50 documents examined, against 0 with the hint). Python sends no hint and has the COLLSCAN: worth raising upstream.
- `add` matches `scope` and `store_name` with `$eq` in the upsert selector, so a non-string value from a JavaScript caller cannot act as a query operator. The server copies `$eq` terms onto the inserted document exactly as it copies bare ones.
- Errors are `TypeError` for a wrong type or an invalid combination, `RangeError` for a number out of bounds, and the SDK's `StorageError` for a database failure. Python raises `ValueError` for the first two and the SDK's `StorageError` for the third.
- `name`, `scope` and `collection` are checked to be strings at construction, which Python's type hints do not enforce at runtime.
