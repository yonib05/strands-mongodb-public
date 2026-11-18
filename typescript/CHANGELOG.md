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
- Runtime validation for JavaScript callers: `name`, `scope`, `collection`, `database` and `prefix` must
  be strings (`TypeError`), numeric settings must be finite, and counts must be integers (`RangeError`).
- Recovery from a failed first connection: a client the package built is replaced on the next operation.
- `Strands-MongoDB` and the package version in each client's handshake metadata. `appName` and
  `driverInfo` are left to the application.
- OpenTelemetry spans for every public operation and the index work it causes, through
  `@opentelemetry/api`. Keys, content, queries, scopes and credentials are never recorded.
- Log lines through the `logger` in `MongoDBConfig`, shaped
  `strands_mongodb: <sentence> | event=<name>, namespace=<db.coll>, tier=<tier>`.
- The entry points `strands-mongodb`, `strands-mongodb/storage` and `strands-mongodb/memory`, as ES
  modules that Node 22.12 and later can also load with `require()`.
- Two examples in `examples/`: `memory-recall.ts` and `unified-storage.ts`.
