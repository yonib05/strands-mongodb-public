# Examples

Two scripts, each in two steps, each step run as its own process on purpose. The only thing that
crosses from the first process to the second is MongoDB. Nothing is cached in a variable or passed on a
queue, so if the second step prints what the first one stored, the storage worked.

These are the TypeScript ports of [`python/examples/`](../../python/examples/README.md), with the same
data and the same two steps each.

| Script | What it proves | Needs |
|---|---|---|
| `memory-recall.ts` | A fact learned in one process comes back in the next, from a query with no word in common with it | Atlas with an embedding model registered on the cluster, so `$vectorSearch` can embed server-side. A deployment without one has no vector tier, and the recall step finds nothing |
| `unified-storage.ts` | Three SDK subsystems write to one collection under three key prefixes, and a session survives the process that made it | Any deployment, including a plain local `mongod` |

## Setup

Run from the `typescript/` directory of this repository, after `npm ci`:

```bash
export MONGODB_URI="mongodb+srv://..."
npx tsx examples/unified-storage.ts run
```

`MONGODB_URI` is the only variable either script requires. Both refuse to run without it, name it in
the message and exit with code 2. Where a script prints the URI it prints it redacted, with everything
between `://` and the last `@` replaced by `<redacted>`. `MONGODB_DATABASE` picks the database, `strands_examples`
by default, and `--collection` the collection, `example` by default.

Keep the URI in a file you do not commit and load it at the shell:

```bash
set -a; . .env; set +a
```

The scripts import the package as `../src/index.js`, so they run from the source tree with no build. In
your own project, install the package and change that import to `strands-mongodb`:

```ts
import { MongoDBMemoryStore } from 'strands-mongodb'
```

`support.ts` holds what both scripts share: argument parsing, the `MONGODB_URI` lookup and redaction,
the scripted model, the prefix census and the `--dry-run` printer. It is not part of the package and
not an API.

## Look before you connect

Every step takes `--dry-run`, which prints what the step would do, the redacted URI and database it
would use, and the command for the next step, then exits before the first client is built. No variable
needs to be set:

```bash
npx tsx examples/memory-recall.ts write --dry-run
```

## memory-recall.ts

```bash
npx tsx examples/memory-recall.ts write
npx tsx examples/memory-recall.ts recall
```

`write` runs one agent turn. The turn contains a durable fact and some small talk. An
`InvocationTrigger` fires when the turn settles, an extractor keeps the fact and drops the rest, and the
fact goes into MongoDB. `MemoryManager.flush()` waits for that background write, then the process exits.

`recall` starts cold and asks a question that shares no word with what was stored:

```
stored:  the guest prefers a window table for two on Thursday evenings
query:   where should we seat them?
```

A keyword scan answers that with nothing. What answers it is a vector search over embeddings the Atlas
cluster generated server-side, which is this package's default: no embedding code, no API key, no model
of your own. The script checks the two strings are word-disjoint every time it starts, and stops if an
edit made them overlap.

Atlas embeds a document a few seconds after the write is acknowledged, about 15 seconds on a quiet
cluster, and a search before then returns nothing rather than failing. If `recall` comes back empty
straight after `write`, run it again.

Two stores share one collection and differ by `scope`. The assistant writes to the guest's own notes and
reads a curated policy store it is not allowed to write to (`writable: false`). Every result prints the
store that produced it. `--scope` gives a run its own namespace, which is worth using on a shared
cluster.

The extractor here looks for a marker in the text, so the write costs no model call and gives the same
result every run. In your own application, `extraction: true` on the writable store selects the SDK's
`ModelExtractor` instead.

## unified-storage.ts

```bash
npx tsx examples/unified-storage.ts run
npx tsx examples/unified-storage.ts resume
```

`new Agent({ storage })` takes one backend and hands it to every subsystem that does not bring its own,
so one `MongoDBStorage` serves three writers:

```
session/    conversation snapshots, from SessionManager
context/    the turn's messages, stashed by contextManager: 'auto'
memory/     a knowledge file, from new FileMemoryStore({ storage })
```

`run` produces all three in one turn, then prints a census of the collection: every top-level prefix
with a document count and a byte total. The census is read back with a plain `MongoClient`, because
these are ordinary documents and `mongosh` would give the same answer.

`resume` starts a new process, lets `agent.initialize()` restore the session from `session/` alone, and
prints how many messages came back.

The `memory/` documents are **not** vector memory. `Storage` moves opaque bytes under a string key, and
on this backend `FileMemoryStore`'s recall is token overlap over the keys, so it matches file names
rather than the text inside them. `MongoDBMemoryStore` is a different collection with typed fields and a
vector index, which is what `memory-recall.ts` shows.

`--session-id` gives a run its own session.

## The model

Both scripts run their turn against `ScriptedModel` in `support.ts`, which reads its replies from a list
in the script. The turn costs nothing, reads the same on every run, and needs no provider account. Every
MongoDB call is real either way, and each script says which model it used.

Pass `--model bedrock` to run the same script against the SDK's `BedrockModel`, using whatever region
and AWS credentials your environment already has.

## Reading the output as a test

Every line is numbered. `--summary-json` adds one machine-readable line at the end, off by default. The
tests in `src/__tests__/examples.test.ts`, `test/integ/contract/examples.test.ts` and
`test/integ/autoembed/examples.test.ts` run these files as subprocesses and read that line rather than
the prose.
