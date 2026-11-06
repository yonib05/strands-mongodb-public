# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with one deviation the
format does not cover: **no version below carries a date, because none of them has been released.**

The repository's landing page publishes a version table saying what `0.0.1` and `0.1.0` contain, and
this package follows it: the same two versions, with the same contents, published to npm instead of
PyPI. Versions are `MAJOR.MINOR.PATCH` per [Semantic Versioning](https://semver.org/spec/v2.0.0.html),
and a release is cut by pushing a `typescript-v` tag. [RELEASING.md](RELEASING.md) is the procedure.

## [Unreleased]

Work that has landed on `main` and is not yet inside a tagged version. Entries move down into a
version heading when that version is tagged.

### Added

- `MongoDBStorage`, implementing the SDK's `Storage` interface plus `namespace()`, `deletePrefix()` and
  `ensureIndexes()`, so an `Agent` given one gets sessions, context offloading and context history.
  Keys live in `_id`, so storage needs no index the server does not create.
- `MongoDBMemoryStore`, implementing the SDK's `MemoryStore` interface with `initialize()`, `add()`,
  `search()`, `delete()`, `deleteAll()` and `getTools()`. `addMessages` is absent on purpose, so the
  SDK's `MemoryManager` keeps extraction.
- Three search tiers behind `MongoDBMemoryStore.search()`: `vector`, `text`, and `hybrid` fusing the
  two with `$rankFusion`. `auto` picks among them, skips a tier whose index is still building, and
  retries it after 60 seconds, then at doubling intervals up to an hour.
- `MongoDBVectorSearchStrategy`: Atlas Vector Search for `MongoDBStorage`, taking any SDK `Embedder`.
- `embedder` on `MongoDBMemoryStore`'s manual-vector path, so `add()` and string `search()` embed.
- Record expiry, armed differently on each surface: `MongoDBMemoryStore.initialize()` provisions the
  TTL index itself, while `MongoDBStorage` leaves it to an explicit `await storage.ensureIndexes()` at
  startup. A negative `ttlSeconds` is rejected at construction.
- Index verification under `ensureIndexes: false`, where a missing index is reported with the
  `db.runCommand` lines that create it, and an existing index that conflicts is reported with the
  lines that drop and recreate it.
- Driver attribution in the connection handshake: every client carries `Strands-MongoDB` and the
  package version in its driver metadata. `appName` is left to the application.
- OpenTelemetry spans for every public operation of both stores, and for the index work they cause,
  through `@opentelemetry/api` on the application's tracer provider. The names and attributes are the
  Python package's. Keys, content, queries, scopes and credentials are never recorded.
- Structured log lines through the `logger` in `MongoDBConfig`, shaped
  `strands_mongodb: <sentence> | event=<name>, namespace=<db.coll>, tier=<tier>`, with the Python
  package's event names.
- The `strands-mongodb`, `strands-mongodb/storage` and `strands-mongodb/memory` entry points, as ES
  modules loadable from CommonJS on Node 22.12 and later.

## [0.1.0]

The first version with working code in it. Planned, not released. Its contents are the `Unreleased`
entries above, which move here when the version is tagged.

## [0.0.1]

Package metadata only: the package name, the three entry points and the public names, with no backend
behind them. Planned, not released.

<!-- No link reference definitions below. Keep a Changelog puts compare links here; this repository
     has no typescript-v tags to compare yet. They go in with the first release, alongside its date. -->
