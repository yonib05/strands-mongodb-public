# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `MongoDBStorage`, the SDK's `Storage` interface on a MongoDB collection, plus `namespace()`,
  `deletePrefix()` and `ensureIndexes()`. Keys are stored in `_id`, so no extra index is needed.
- `MongoDBMemoryStore`, the SDK's `MemoryStore` interface, with `initialize()`, `add()`, `search()`,
  `delete()`, `deleteAll()` and `getTools()`. It has no `addMessages`, so the SDK's `MemoryManager` runs
  extraction.
- Three memory search tiers: `vector`, `text`, and `hybrid`, which fuses the two with `$rankFusion`.
  `searchType: 'auto'` uses the best tier that is ready, skips a tier whose index is still building, and
  retries it after 60 seconds, then at doubling intervals up to an hour.
- `MongoDBVectorSearchStrategy`, Atlas Vector Search for `MongoDBStorage`, taking any SDK `Embedder`.
- `embedder` on `MongoDBMemoryStore`, so `add()` and string `search()` embed when you supply the vectors.
- `ttlSeconds` on both stores. `MongoDBMemoryStore.initialize()` creates its TTL index.
  `MongoDBStorage` needs `ensureIndexes()` called once.
- `ensureIndexes: false`, which verifies the indexes and reports a missing or conflicting one with the
  `db.runCommand` lines that fix it.
- Runtime validation for JavaScript callers: names such as `name`, `scope`, `collection`, `database`,
  `prefix` and the index names must be strings, and `searchType` and `similarity` a listed value
  (`TypeError`). Numeric settings, the score bounds included, must be finite, counts must be integers,
  and `ttlSeconds` must leave the expiry a valid date (`RangeError`). A query's `text` must be a string
  and its `vector` an array of finite numbers (`TypeError`).
- Recovery from a failed first connection: a client the package built is reconnected on the next operation.
- `Strands-MongoDB` and the package version in each client's handshake metadata. `appName` and
  `driverInfo` are left to the application.
- OpenTelemetry spans for every public operation and the index work it causes, through
  `@opentelemetry/api`. Keys, content, queries, scopes and credentials are never recorded.
- Log lines through the `logger` in `MongoDBConfig`, shaped
  `strands_mongodb: <sentence> | event=<name>, namespace=<db.coll>, tier=<tier>`.
- The entry points `strands-mongodb`, `strands-mongodb/storage` and `strands-mongodb/memory`, as ES
  modules that Node 22.12 and later can also load with `require()`.
- Two examples in `examples/`: `memory-recall.ts` and `unified-storage.ts`.
