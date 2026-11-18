# strands-mongodb

MongoDB storage and memory backends for the [Strands Agents](https://strandsagents.com) SDK.

One MongoDB deployment behind the SDK's two extension points:

| Surface | Class | SDK protocol | Serves |
|---|---|---|---|
| Storage | `MongoDBStorage` | `strands.storage.Storage` | Sessions, context offloading, memory persistence, context history, transcripts |
| Memory | `MongoDBMemoryStore` | `strands.memory` `MemoryStore` | Semantic recall over Atlas Vector Search, extraction writes |

The SDK accepts a single top-level `storage` on `Agent`, and **five** subsystems inherit it. One
`MongoDBStorage` is therefore the backend for session management and context offloading. Each is still
turned on with the SDK's own objects (`SnapshotSessionManager`, and `context_manager="auto"`), and
neither needs a MongoDB-specific class.

![strands-mongodb in a Strands agent: the SDK's session manager, context manager and memory manager use MongoDBStorage and MongoDBMemoryStore, which store to MongoDB](docs/images/architecture.png)

## Status

> **Under construction. Both halves have their operations; neither is released.** `MongoDBStorage`
> implements all five `Storage` contract methods plus `namespace()` and `delete_prefix()`, so an
> `Agent` given one gets working sessions, context offloading and context history.
> `MongoDBMemoryStore` has `initialize()`, `add()`, `search()` across a vector tier, a text tier and a
> `hybrid` tier fusing the two with `$rankFusion`,
> `delete()`, `delete_all()` and `get_tools()`. `add_messages()` is absent on purpose: the SDK's
> `MemoryManager` feature-detects it, and a present one would take extraction away from the SDK's own
> extractor and hand it to one this package would have to write.
>
> | Version | Contains |
> |---|---|
> | `0.0.1` | Package metadata, extras, import paths, public names |
> | `0.1.0` | `MongoDBStorage` + `MongoDBMemoryStore`, the three search tiers, record expiry, OpenTelemetry spans and structured log fields, docs, tests |
>
> The TypeScript package has both surfaces with the same three tiers, expiry, spans and log events. It
> is unreleased too, and releases on its own `typescript-v` tag.
>
> Storage `search()` ranks by token overlap in a single aggregation over the key space, where the SDK's
> default issues one read per key. Scores come from keys rather than payload text, so a word that appears
> only inside a stored value will not match.
>
> Record expiry is armed differently on each surface. `MongoDBMemoryStore.initialize()` provisions the
> TTL index itself, so a store configured with `ttl_seconds` expires its records without further work.
> `MongoDBStorage` leaves it to an explicit `await storage.ensure_indexes()` at startup, because an
> `Agent` builds its storage in a code path the operator never sees and DDL should not be issued from
> one. Without that index, `MongoDBStorage` stamps the expiry field and nothing removes the record.
>
> Tested against MongoDB 8.3.8 with a local `mongot` and against Atlas. The two report search index state
> differently, and the tests accept both forms.

## Install

Pick the surface you need. Each extra pulls only its own dependencies.

<!-- skip: these reach PyPI for a package that is not published yet -->
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

### Before the package reaches PyPI

Nothing is published yet, so the commands above resolve to nothing. Until they do, install from this
repository. The plain `https://` URL fails for two separate reasons.

The repository is private and MongoDB enforces SAML single sign-on, so an unauthenticated `https://`
clone stops before pip ever sees a package:

```text
remote: The 'mongodb' organization has enabled or enforced SAML SSO.
fatal: unable to access 'https://github.com/mongodb/strands-mongodb.git/': The requested URL returned error: 403
```

And this is a monorepo. The distribution lives in `python/`, a sibling of a future `typescript/`, so
there is no `pyproject.toml` at the repository root for pip to build even once the clone succeeds.

One URL addresses both: SSH for the first, a `subdirectory` fragment for the second.

<!-- skip: it clones a private repository over SSH, which no test tier holds a key for -->
```bash
pip install 'strands-mongodb[all] @ git+ssh://git@github.com/mongodb/strands-mongodb.git#subdirectory=python'
uv add 'strands-mongodb[all] @ git+ssh://git@github.com/mongodb/strands-mongodb.git#subdirectory=python'
```

`[all]` is the same choice as above: `[storage]` and `[memory]` work here too, and the extra is still
what selects the dependency set.

This needs a GitHub account in the `mongodb` organization holding an SSH key authorized for single
sign-on. A CI runner needs a deploy key for the same reason. There is no anonymous path to this
package until it is published.

What you get is not a release. No release tag exists yet, so the version is a development version of
the form `0.0.1.devN+g<sha>`, counted from the first commit, and it changes every time `main` does. Pin
a commit for anything that has to resolve the same way twice, after the `.git` and before the fragment:

<!-- skip: the same private clone as above, against a commit this document does not pin for you -->
```bash
pip install 'strands-mongodb[all] @ git+ssh://git@github.com/mongodb/strands-mongodb.git@<commit-sha>#subdirectory=python'
```

## Install from npm

The TypeScript package has one install line. The SDK and the driver are peer dependencies.

<!-- skip: it installs from the public registry -->
```bash
npm install strands-mongodb @strands-agents/sdk mongodb
```

Until the package is on npm, [CONTRIBUTING.md](CONTRIBUTING.md#installing-the-typescript-package-before-its-first-release)
says how to install it from a clone.

## Documentation

[`python/README.md`](python/README.md) is the reference: quickstarts for both surfaces, every
configuration key of all three `TypedDict`s, how a search picks its tier, the tenancy boundaries and who
enforces each one, how to erase stored memories, the index and privilege handoff for a DBA, the
spans and log fields it emits, and the limits this package does not remove. This page stays short so that
each fact lives in one place.

[`typescript/README.md`](typescript/README.md) is the reference for the TypeScript package.

[`python/MIGRATION.md`](python/MIGRATION.md) is for readers arriving from one of the three MongoDB
backends that already exist for Strands: the archived `mongodb_memory` tool in `strands-agents-tools`,
and the community `strands-mongodb-store` and `strands-mongodb-storage` packages. One of the three
migrates by pointing this package at the same collection. The other two need data copied, and the guide
gives the script.

## Examples

Two runnable scripts in [`python/examples/`](python/examples/README.md), and their TypeScript
counterparts in [`typescript/examples/`](typescript/examples/README.md). Each splits into two commands
you run as separate processes, so the only thing that carries state between them is MongoDB.
`MONGODB_URI` is all either one needs. The Python scripts take `--dry-run`, which shows what a step would
do before it connects.

## Requirements

| | |
|---|---|
| Python | >= 3.10 |
| `strands-agents` | >= 1.54.0, the first release shipping every `strands` module the storage backend imports, `strands.storage.search.keyword` among them |
| Node.js | >= 22, for the TypeScript package |
| `@strands-agents/sdk` | >= 1.23.0, the first release exporting `Embedder`, with the `mongodb` driver at `^7` |
| `pymongo` | >= 4.14.0 |
| `pymongo-search-utils` | >= 0.3.0, with the `memory` extra only |
| `opentelemetry-api` | >= 1.30.0. The API only; exporting spans is the application's choice |
| MongoDB | Any deployment serves storage. The text tier needs Atlas Search; the vector tier needs Atlas or an Atlas CLI local deployment. The default embedding path also needs an embedding model registered on the cluster, which Atlas provides and a local `mongot` 8.3.8 does not. |

## Erasing memories

`MongoDBMemoryStore` has `delete(memory_id)` and `delete_all()`, so an erasure request against stored
facts has something to call. Both need `writable: True`, and both reach exactly as far as `search()`
does, which is one scope and one store. [`python/README.md`](python/README.md#erasing-memories) has the
details, including the two ways this surprises people.

## Repository layout

| Directory | Package | Publishes to |
|---|---|---|
| `python/` | `strands-mongodb` | PyPI |
| `typescript/` | `strands-mongodb` | npm |

Both publish the same name, write the same documents and indexes, version independently, and release on
their own tag prefix: `python-v` and `typescript-v`.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) is the process: how to get an environment, how to report a bug, what a
pull request has to pass. [AGENTS.md](AGENTS.md) is what a change has to look like once you are writing
one, and it is the shorter read of the two.

Most of the test suite needs no MongoDB deployment, so a first run on a laptop with no cluster is green.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
