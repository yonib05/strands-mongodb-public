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

Python 3.10 or newer. [`python/README.md`](python/README.md#requirements) lists the dependency floors and what each MongoDB deployment can serve.

Node.js 22 or newer for the TypeScript package. [`typescript/README.md`](typescript/README.md#requirements) lists its peer dependencies.

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
