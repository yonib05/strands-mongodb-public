# Working in this repository

The rules that apply every time you touch the code. [CONTRIBUTING.md](CONTRIBUTING.md) is the process
around a change: how to set up, what a pull request has to pass, where to report a bug. This file is what
the change itself has to look like.

Written for whoever arrives next, human or agent. Where a rule can be checked by a tool it is, and the
test that checks it is named, because a convention nothing measures is a preference.

## Layout

One repository, two published packages with one name: `strands-mongodb` on PyPI from `python/`, and on
npm from `typescript/`. They write the same documents and indexes, so one deployment serves both.

| Path | Holds |
|---|---|
| `python/` | The PyPI package. `src/`, `tests/`, `examples/`, `pyproject.toml`, and the reference `README.md` and `MIGRATION.md` |
| `typescript/` | The npm package. `typescript/src/` with co-located `__tests__` directories, `typescript/test/` for the tiers, the docs project and the gate, `package.json`, the reference `typescript/README.md`, `typescript/docs/PARITY.md` and `examples/` |
| `.github/workflows/ci-python.yml`, `.github/workflows/ci-typescript.yml` | Every gate a pull request meets, one workflow per package, each filtered to its own paths |
| `README.md` | The landing page. Short on purpose: `python/README.md` and `typescript/README.md` are the references |
| `docs/images/` | The diagrams the READMEs and `CONTRIBUTING.md` show, as PNG |
| `AGENTS.md`, `CONTRIBUTING.md` | This file and the process |

Each package versions independently under its own directory and releases on its own tag prefix,
`python-v` or `typescript-v`. This file has a TypeScript subsection under each heading rather than a
second copy, because a split is how two files that describe one repository start disagreeing.

### TypeScript

The modules under `typescript/src/`:

| Module | Holds |
|---|---|
| `storage.ts`, `memory-store.ts`, `vector-search.ts` | The three public classes |
| `search-tiers.ts` | Which memory search tiers are ready, the first-search wait and the retry backoff |
| `index-specs.ts` | The index definitions and the `db.runCommand` lines rendered from them |
| `ensure-indexes.ts` | Creating or verifying indexes, and waiting for a search index |
| `probes.ts` | What the deployment supports: Atlas Search, `$rankFusion`, and the collection's collation |
| `pipeline.ts` | The aggregation stages of each search tier |
| `filter.ts` | Validating a caller's filter and composing it with the scope |
| `embedding.ts` | Calling an `Embedder` and checking the vector's length |
| `keys.ts` | Key normalization and the tokenizer, copied from the SDK |
| `client.ts` | The shared connections, keyed by connection identity |
| `driver-errors.ts` | Turning a driver error into a `StorageError` |
| `telemetry.ts`, `logging.ts` | Spans and attributes, and the log line's fields |
| `types.ts`, `version.ts` | The public types and constants, and the package version |
| `index.ts`, `typescript/src/storage/index.ts`, `typescript/src/memory/index.ts` | The three entry points |

`typescript/docs/PARITY.md` records what the port measured, the behaviours it shares with Python on purpose, and
where it differs.

## Where the reasoning lives, and how tests are tagged

The tests are the record of what this package guarantees. A change in behaviour comes with the test that
proves it, written first, and the reason for a non-obvious choice lives in the code that makes it.

**Every test names the item it proves, in the first paragraph of its docstring.** Either its own docstring
or its class's:

```python
async def test_a_bound_above_the_lowest_score_drops_exactly_that_result(self) -> None:
    """AT-059b. Measure first, then bound just above the measurement's floor."""
```

The release gate in `tests/conftest.py` collects these tags to decide which checklist items have evidence.
It reads the first paragraph only, so that a later sentence such as "this tier does not cover X" is never
counted as evidence that X is covered. Use the tag nowhere else: comments, later paragraphs and the
documentation describe the behaviour in words.

In TypeScript the tag leads the test title, `it('AT-045a: initialize is idempotent', ...)`, or the title
of an enclosing `describe`. The gate in `typescript/test/gate/` reads the ids a string literal starts
with, on any line that is not a `//` comment, so a tag anywhere else is not evidence.

A `TODO(...)` in a file names the thing that has to be settled before the placeholder can go, and the test
suite asserts that every placeholder in this file and in `CONTRIBUTING.md` names something. Do not write a
bare `TODO`.

## Commands

Every command runs from `python/`. [Hatch](https://hatch.pypa.io) builds the environment from
`pyproject.toml`, so nothing needs installing first.

| Command | Does |
|---|---|
| `hatch run test` | The suite. Arguments pass through, so `hatch run test tests/test_storage.py -x` works |
| `hatch run lint` | Ruff, over `src/`, `tests/`, `scripts/` and `examples/` |
| `hatch run format` | Ruff's formatter, in place |
| `hatch run format-check` | The same, read-only. What CI runs |
| `hatch run typecheck` | Mypy, over the same four directories |
| `hatch run cov` | The suite plus both coverage floors: 90% aggregate and 70% per module |
| `hatch run prepare` | `format`, `lint`, `typecheck`, `test`, in that order. Run this before pushing |

Pass no path to `lint` or `typecheck`. An explicit path overrides the file list in `pyproject.toml`, which
is the one list both tools read.

`cov` is deliberately not part of `test`. A floor that fails on a half-finished module trains everyone to
reach for `--no-cov`, so `test` stays runnable at any point mid-change and `cov` is the release gate.

Working in a plain virtualenv instead is fine: `pip install -e ".[all,dev]"` from `python/` installs the
same set, and `python -m pytest` replaces `hatch run test`. Python 3.10 is the floor, so use an
interpreter at 3.10 or newer.

### TypeScript

Every command runs from `typescript/`, on Node.js 22 or newer, after `npm ci`.

| Command | Does |
|---|---|
| `npm test` | The unit project: the `__tests__` directories under `typescript/src/`, and `typescript/test/__tests__/`. About two seconds. Arguments pass through, so `npm test -- src/__tests__/storage.test.ts` works |
| `npm run test:contract`, `npm run test:integration`, `npm run test:autoembed`, `npm run test:build`, `npm run test:compat`, `npm run test:interop` | One tier each. A tier whose variable is unset skips with a reason |
| `npm run test:coverage` | The unit project with both coverage floors: 90% aggregate and 70% per file |
| `npm run test:docs` | The docs project: runs the examples and the README's unit snippets, each in a subprocess. No deployment |
| `npm run test:gate` | The static gate: every checklist id resolves to a test title, and every release-gate id to a contract or integration test. Reads no results, so it runs at any time |
| `npm run test:gate:release` | The strict gate: fails unless every release-gate item passed against a real deployment. Run it after `npm run test:contract` and `npm run test:integration` on a deployment with a search process |
| `npm run lint` | ESLint, over `typescript/src/`, `typescript/test/`, `typescript/scripts/` and `typescript/examples/` |
| `npm run format` | Prettier, in place. `npm run format:check` is the read-only form CI runs |
| `npm run type-check` | `tsc --noEmit` over `typescript/src/`, `typescript/test/`, `typescript/examples/` and `typescript/vitest.config.ts` |
| `npm run build` | Empties `dist`, then `tsc` into it. `dist` is what the package ships |
| `npm run check` | `format:check`, `lint`, `type-check`, `test:coverage`, `test:docs`, `test:gate`, in that order. Run this before pushing |

The coverage floors are not part of `test`, for the same reason `cov` is not part of `hatch run test`.

## Test tiers

Most of the suite needs nothing. The tiers that need a deployment are gated on an environment variable
being non-empty, and a tier whose variable is unset skips rather than fails, so a first run on a laptop
with no cluster is green and fast.

| Marker | Gate | Needs |
|---|---|---|
| unmarked | none | Nothing. Around 700 tests, roughly 50 seconds |
| `contract` | `MONGODB_URI` | Any MongoDB deployment, including a local one |
| `integration` | `MONGODB_ATLAS_URI` | Atlas, or an Atlas CLI local deployment with `mongot` |
| `autoembed` | `MONGODB_AUTOEMBED_URI` | An Atlas cluster that runs automated embedding: M10 or larger, storage auto-scaling on. `python/scripts/atlas_ci_cluster.py up` creates one |
| `build` | `STRANDS_MONGODB_BUILD_TIER` | Network. Builds a wheel and installs it into an empty venv. No deployment and no secret |
| `compat` | none, CI cron or dispatch only | Resolves the latest published `strands-agents` rather than the pinned one |
| `example` | its backend's tier | Runs a shipped `examples/` script as a subprocess |
| `gate` | none | The release-gate assertion. Ordered last, so it sees every other outcome |

The variables are read from the process environment, and also from a `.env` file beside this one if you
keep one there. `.env` is gitignored and must stay that way: it holds a connection string with a password
in it.

**The gotcha that will get you once.** Because `.env` is loaded automatically, a bare `hatch run test` on a
machine that has one starts the contract tier, which takes minutes rather than seconds. Opting out means
setting the variables to **empty**, not unsetting them:

```bash
MONGODB_URI= MONGODB_ATLAS_URI= MONGODB_AUTOEMBED_URI= hatch run test
```

To run one tier on purpose, select it: `hatch run test -m contract`, or `hatch run test -m "not integration"`
to keep everything else. `--strict-markers` is on, so a marker that is not registered in `pyproject.toml`
is a collection error rather than a silently ignored decorator. Register it there before you use it.

Two things to know before you wait on a cluster. A first `add()` against a collection with no search index
creates two indexes and waits for both to report `READY`, which takes minutes. A document is then not
searchable the instant its write returns, because the search process indexes it asynchronously. Test
helpers poll to a 180-second ceiling rather than sleeping, so a fast cluster is not slowed down.

### TypeScript

The same variables gate the same tiers, as vitest projects selected by `npm run test:<tier>`. A tier
lives under `typescript/test/integ/<tier>/`, except `build`, `compat`, `docs` and `gate`, which live under
`typescript/test/` by name.

| Project | Gate | Needs |
|---|---|---|
| `unit` | none | Nothing. A fake `MongoClient` |
| `docs` | none | Nothing. Runs each example and each README snippet marked `run: unit` in a subprocess |
| `contract` | `MONGODB_URI` | Any MongoDB deployment, including a local one |
| `integration` | `MONGODB_ATLAS_URI` | Atlas, or an Atlas CLI local deployment with `mongot` |
| `autoembed` | `MONGODB_AUTOEMBED_URI` | An Atlas cluster that runs automated embedding. `python/scripts/atlas_ci_cluster.py up` creates one |
| `build` | `STRANDS_MONGODB_BUILD_TIER` | Network. Packs the tarball and installs it into empty ESM and CommonJS projects. No deployment and no secret |
| `compat` | none | Nothing beyond the installed SDK. Checks it meets the floor, exports what the package imports, and accepts both stores at the type level. CI runs it weekly against the latest published `@strands-agents/sdk` |
| `interop` | `MONGODB_URI`, and `hatch` on `PATH` | Writes through each package and reads through the other against one deployment, the Python halves in `typescript/scripts/interop/`. The memory suite also needs `MONGODB_ATLAS_URI`, for the text tier |
| `gate` | none | Nothing. Checks that every checklist id has a test, without running one |

The variables are read from the process environment and from a `.env` file, the one in the `typescript/`
directory first and then the one beside this file, with the same rule as Python: only the three
connection-string keys are read, and a key already present in the environment is never replaced. The
same gotcha follows, and the same opt-out:

```bash
MONGODB_URI= MONGODB_ATLAS_URI= MONGODB_AUTOEMBED_URI= npm test
```

`test:gate:release` is a script, not a vitest project. Every run records its results per project in
`.vitest-results.json`, and the script fails unless each release-gate item has a passing test in the
`contract` or `integration` project. A filtered run of either replaces that project's results with the
subset, so the strict gate then fails until the tier runs in full. `npm run check` deletes the file first.

Each tier writes to a database named `strands_mongodb_<tier>` and drops what it created. One Atlas
cluster in all three variables runs every tier but skips the tests of a missing capability. Three
deployments cover the most:

| Variable | Deployment | Covers only there |
|---|---|---|
| `MONGODB_URI` | A plain `mongod` | A search against a server with no search process |
| `MONGODB_ATLAS_URI` | Atlas CLI local, which has no embedding model | An `autoEmbed` index rejected at creation, and the fallback to the text tier |
| `MONGODB_AUTOEMBED_URI` | An Atlas cluster with a registered model | The default embedding mode |

## House conventions

The Strands Python SDK's own contributor guide is where these come from. Seven of the nine are checked by a
tool or a test, and the table names which. The two that are not are review's job, and saying so is more
useful than pretending otherwise.

| Convention | Checked by |
|---|---|
| `X \| None`, never `Optional[X]` | `tests/test_conventions.py` |
| `TypedDict` or `dataclass` for structure. No pydantic, no runtime validator | `tests/test_conventions.py` |
| An explicit `__all__` in every module, so the public surface is a decision | `tests/test_conventions.py` |
| `%s` placeholders in log calls, never an f-string | Ruff's `G` rules, and `tests/test_conventions.py` asserts they are selected |
| `warnings.warn` always passes `stacklevel`, so the warning points at the caller | `tests/test_conventions.py`, written for the first call anyone adds |
| A `Raises:` section on anything public that raises | `tests/test_conventions.py`, over every public function and method |
| Google-style docstrings. `snake_case` functions, `_leading_underscore` for private | Review |
| No `asyncio.TaskGroup` or `asyncio.timeout` without a version gate. Both are 3.11+ and the floor is 3.10 | `tests/test_conventions.py` |
| Conventional commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`) | Review. `CONTRIBUTING.md` has the format |

**One deviation, and it is deliberate.** The SDK's log messages are shaped
`field=<%s>, other=<%s> | lowercase message`. This package does not copy that shape, and writes
`strands_mongodb: ` followed by a sentence with `%s` placeholders in it:

```python
_SCORE_BOUND_APPLIED = "strands_mongodb: %s %r on %s kept %d of %d results (applied after the query)."

logger.debug(_SCORE_BOUND_APPLIED, name, bound, self._target, len(kept), len(scored))
```

Message bodies are module constants with docstrings of their own, not literals inside the call. That is
where the reason for a message lives, and it is also what lets a test assert on one without copying the
string.

Two reasons, both about being a third-party integration rather than the SDK itself. The prefix names the
package in a log stream where the logger name is usually not rendered, and several of these messages are
explanatory rather than a field list: the one for a deployment with no Atlas Search names the server error
code the probe saw and what to do about it, which does not fit a key-value line. Every log call in the
package follows this shape, and `tests/test_telemetry.py` pins each one, so reshaping them is a change with
tests to update rather than a matter of taste. Placeholders stay `%s`: that half of the rule is enforced by ruff.

Every log call also passes `extra=_telemetry.event_extra(...)`, which adds `strands_mongodb_event` and,
where the record is about one, `strands_mongodb_namespace` and `strands_mongodb_tier`. A new call needs a
new name in `_telemetry.LogEvent`, and `tests/test_telemetry.py` fails on a call that skips the helper.
Spans go through `_telemetry.traced` or `_telemetry.span`, and an attribute is recorded only if it is in
`_telemetry.Attribute`, the allow-list; anything else is dropped with a `DEBUG` record. Never add an
attribute that carries caller data: a key, content, metadata, query text, filter values, a scope or a
memory id. The README's observability section lists every span, attribute and event, and
`tests/test_readme.py` fails until a new one is named there.

### TypeScript

The Strands TypeScript SDK's own `AGENTS.md` is where these come from. The tools catch most of them, and
the table names which; the rest are review's job.

| Convention | Checked by |
|---|---|
| Explicit return types on every function and method signature; locals are inferred | ESLint, `explicit-function-return-type` and `explicit-module-boundary-types`, in `src/` only |
| No `any`. `unknown`, then narrow | ESLint, `no-explicit-any` |
| Named exports only, never `export default` | `typescript/src/__tests__/conventions.test.ts` |
| A TSDoc block before every export: one summary line, then `@param`, `@returns`, `@throws` tags | ESLint checks the syntax; `typescript/src/__tests__/conventions.test.ts` checks that every export has one |
| The SDK is imported only through `@strands-agents/sdk`, `@strands-agents/sdk/storage` and `@strands-agents/sdk/storage/search` | `typescript/src/__tests__/conventions.test.ts` |
| No semicolons, single quotes, 120 columns | Prettier, through `npm run format:check` |
| An `interface` for an object shape, a `type` alias only for a union or a derived type | Review |
| Kebab-case file names; the class inside stays PascalCase | Review |
| `_`-prefixed private fields, `private readonly` where nothing assigns them later | Review |
| Conventional commit subjects with the `(typescript)` scope: `feat(typescript):`, `fix(typescript):`, `docs(typescript):`, `test(typescript):` | Review |

**The same deviation, in TypeScript form.** The SDK's log lines are template literals shaped
`field=<${value}> | lowercase message`. This package writes the sentence first and the fields last:

```typescript
logger.warn(
  `strands_mongodb: 'searchType' is 'auto' and the vector tier is not available on ${target}, so queries resolve to the ${first} tier. | ${logFields('below_vector', { namespace: target, tier: first })}`
)
```

`logFields` in `typescript/src/logging.ts` renders `event=<name>, namespace=<db.coll>, tier=<tier>`, and
`LogEvent` there is the closed list of event names: the Python package's, plus `rank_fusion_probe_failed`.
`typescript/src/__tests__/conventions.test.ts` fails on a `logger` call with no `logFields` literal, and
the `LogEvent` type rejects an event the list does not declare. Two things differ from the SDK on purpose:
the logger is injected through `logger` on `MongoDBConfig` rather than taken from the SDK's global
`configureLogging`, because a store is configured by the application that built it, and the three barrels
export only what `typescript/src/__tests__/exports.test.ts` lists. A member marked `@internal` is stripped
from the published types, and the build tier checks that.

Spans go through `traced`, `span` or `open` in `typescript/src/telemetry.ts`. An attribute name must be
in `ATTRIBUTES`, the same list as Python's, and the `Attribute` type built from it is what enforces that.
The README's observability section lists every span, attribute and event, and
`typescript/src/__tests__/readme.test.ts` fails until a new one is named there. The same test pins the
README's configuration tables to the types, its defaults and limits to the constants, and its index
commands to `typescript/src/index-specs.ts`. No em dash anywhere under `typescript/`, nor in this file or
`CONTRIBUTING.md`; the conventions test checks.

An error or log message is at most two sentences: what is wrong, naming the key and the value, then what
to do. Tests assert the error class and the facts in a message, never a whole sentence. A comment states
a constraint or a non-obvious reason in one or two lines, and TSDoc is one summary line plus tags.

## What not to do

- **Do not silence a warning to make a run quiet.** Two known ones are tracked and neither is ours to fix:
  `pytest-asyncio` 0.26 calling a deprecated event-loop API, and pymongo closing a periodic executor in a
  weakref callback after the loop has gone. A
  `filterwarnings` entry that hides those also hides the next one, which will be ours.
- **Do not put a connection string in a document, a test or an example.** `tests/test_conventions.py` walks every Markdown file
  in the repository looking for one with credentials in it, and the examples redact the userinfo before they
  print a URI.
- **Do not infer an SDK API.** Read the installed `strands` package. The floor is `strands-agents` 1.54.0
  because that is the first release with every module this package imports, and a guess about an earlier
  release is a guess about somebody's install. Do not raise or lower a floor by reading a changelog either:
  the `Dependency floors` job installs the declared floors and runs the suite against them, which is the only
  check of what the code actually needs.
- **Do not hand-edit the index and privilege commands in `python/README.md` or `typescript/README.md`.** They are
  compared against the renderers in `src/strands_mongodb/_indexes.py` and `typescript/src/index-specs.ts` that
  produce them, so an edit there fails a test rather than shipping a command the package does not run.
- **Do not add a runtime dependency to `dependencies`.** It is empty on purpose in both packages. Every Python
  dependency belongs to the extra that needs it, so `pip install 'strands-mongodb[storage]'` never pulls
  vector-search machinery; every TypeScript dependency the application also holds an instance of, the SDK,
  the driver and the OpenTelemetry API, is a peer dependency.
- **Do not skip a test to get to green.** A skip and a pass are the same colour.
