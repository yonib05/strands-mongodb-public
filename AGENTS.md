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
| `typescript/` | The npm package. `typescript/src/` with co-located `__tests__` directories, `typescript/test/` for the tiers and the gate, `package.json`, the reference `typescript/README.md`, and `examples/` |
| `.github/workflows/ci-python.yml`, `.github/workflows/ci-typescript.yml` | Every gate a pull request meets, one workflow per package, each filtered to its own paths |
| `README.md` | The landing page. Short on purpose: `python/README.md` and `typescript/README.md` are the references |
| `docs/images/` | The diagrams the READMEs and `CONTRIBUTING.md` show, as PNG |
| `AGENTS.md`, `CONTRIBUTING.md` | This file and the process |

Each package versions independently under its own directory and releases on its own tag prefix,
`python-v` or `typescript-v`. This file has a TypeScript subsection under each heading rather than a
second copy, because a split is how two files that describe one repository start disagreeing.

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
of an enclosing `describe`. The gate in `typescript/test/gate/` reads the ids a title starts with, from the
source for the static half and from the last run's results for the dynamic half, and ignores comments and
strings, so a tag anywhere else is not evidence.

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
| `npm test` | The unit project: the `__tests__` directories under `typescript/src/`, and `typescript/test/__tests__/`. Arguments pass through, so `npm test -- src/__tests__/storage.test.ts` works |
| `npm run test:contract`, `npm run test:integration`, `npm run test:autoembed`, `npm run test:build`, `npm run test:compat`, `npm run test:interop` | One tier each. A tier whose variable is unset skips with a reason |
| `npm run test:coverage` | The unit project with both coverage floors: 90% aggregate and 70% per file |
| `npm run test:gate` | The release-gate assertion, over `.vitest-results.json` from the last run. Run it after the suite it measures |
| `npm run lint` | ESLint, over `typescript/src/`, `typescript/test/` and `typescript/scripts/` |
| `npm run format` | Prettier, in place. `npm run format:check` is the read-only form CI runs |
| `npm run type-check` | `tsc --noEmit` over `typescript/src/` and `typescript/test/` |
| `npm run build` | `tsc` into `dist`, which is what the package ships |
| `npm run check` | `format:check`, `lint`, `type-check`, `test:coverage`, `test:gate`, in that order. Run this before pushing |

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
lives under `typescript/test/integ/<tier>/`, except `build`, `compat` and `gate`, which live under
`typescript/test/` by name.

| Project | Gate | Needs |
|---|---|---|
| `unit` | none | Nothing. A fake `MongoClient` |
| `contract` | `MONGODB_URI` | Any MongoDB deployment, including a local one |
| `integration` | `MONGODB_ATLAS_URI` | Atlas, or an Atlas CLI local deployment with `mongot` |
| `autoembed` | `MONGODB_AUTOEMBED_URI` | An Atlas cluster that runs automated embedding. `python/scripts/atlas_ci_cluster.py up` creates one |
| `build` | `STRANDS_MONGODB_BUILD_TIER` | Network. Packs the tarball and installs it into empty ESM and CommonJS projects. No deployment and no secret |
| `compat` | none, CI cron or dispatch only | Resolves the latest published `@strands-agents/sdk` rather than the pinned one. No tests yet |
| `interop` | `MONGODB_URI`, and `hatch` on `PATH` | Reads and writes through both packages against one deployment. No tests yet |
| `gate` | none | The release-gate assertion. Reads `.vitest-results.json`, so it runs after the suite it measures; `npm run check` orders them |

The variables are read from the process environment and from a `.env` file, the one in the `typescript/`
directory first and then the one beside this file, with the same rule as Python: only the three
connection-string keys are read, and a key already present in the environment is never replaced. The
same gotcha follows, and the same opt-out:

```bash
MONGODB_URI= MONGODB_ATLAS_URI= MONGODB_AUTOEMBED_URI= npm test
```

`test:gate` judges the last recorded run, whatever it was. A filtered run of an enabled tier leaves the
gate items whose files were filtered out without evidence, and the gate reports that as a failure rather
than as unverified.

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
`LogEvent` there is the closed list of event names, identical to the Python package's.
`typescript/src/__tests__/conventions.test.ts` fails on a `logger` call with no `logFields` literal and on
an event the list does not declare, and reports a declared event nothing logs. Two differ from the SDK on
purpose and are written down here: the logger is injected through `logger` on `MongoDBConfig` rather than
taken from the SDK's global `configureLogging`, because a store is configured by the application that
built it, and the three barrels export nothing marked `@internal`, so the public surface is what
`typescript/src/__tests__/exports.test.ts` lists and nothing else.

Spans go through `traced`, `span` or `open` in `typescript/src/telemetry.ts`, and an attribute is recorded
only if it is in `ATTRIBUTES`, the same allow-list as Python's. The README's observability section lists
every span, attribute and event, and `typescript/src/__tests__/readme.test.ts` fails until a new one is
named there. No em dash anywhere under `typescript/`, nor in this file or `CONTRIBUTING.md`; the
conventions test checks.

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
  compared against the renderers in `src/strands_mongodb/_indexes.py` and `typescript/src/indexes.ts` that
  produce them, so an edit there fails a test rather than shipping a command the package does not run.
- **Do not add a runtime dependency to `dependencies`.** It is empty on purpose in both packages. Every Python
  dependency belongs to the extra that needs it, so `pip install 'strands-mongodb[storage]'` never pulls
  vector-search machinery; every TypeScript dependency the application also holds an instance of, the SDK,
  the driver and the OpenTelemetry API, is a peer dependency.
- **Do not skip a test to get to green.** A skip and a pass are the same colour.
