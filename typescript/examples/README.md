# Examples

Two scripts, each with two steps that run as separate processes. MongoDB is the only thing the second
process shares with the first.

| Script | Shows | Needs |
|---|---|---|
| `memory-recall.ts` | An agent stores a fact, and a new process recalls it from a query that shares no word with it | An Atlas cluster with an embedding model registered |
| `unified-storage.ts` | One `MongoDBStorage` holds a session, offloaded context and a `FileMemoryStore` under three key prefixes, and a new process restores the session | Any MongoDB deployment |

Run them from `typescript/` after `npm ci`:

```bash
export MONGODB_URI='<your connection string>'
npx tsx examples/unified-storage.ts run
npx tsx examples/unified-storage.ts resume
npx tsx examples/memory-recall.ts write
npx tsx examples/memory-recall.ts recall
```

`MONGODB_URI` is required; a script exits with code 2 and names it when it is missing. `MONGODB_DATABASE`
picks the database and defaults to `strands_examples`. The scripts print the URI with its credentials
replaced by `<redacted>`.

Atlas embeds a memory a few seconds after the write returns. If `recall` finds nothing straight after
`write`, it exits with code 1; run it again.

The agent turns use `ScriptedModel` from `support.ts`, which replays a list of replies, so the examples
need no model provider. Every MongoDB call is real. In your own code, pass your provider's model to
`Agent` instead.

The scripts import `strands-mongodb` by name, which `tsconfig.json` maps to `src/` inside this repository.
Copied with `support.ts` into a project that has the package installed, they run unchanged.
