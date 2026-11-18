# Contributing

Thanks for your interest in this project. Contributions of any size are welcome: a bug report, a fix, a
documentation correction, a new feature.

Read this first, and read [AGENTS.md](AGENTS.md) before you write code. This file is the process. That one
is the conventions the code has to follow, the commands, the test tiers, and the reasoning behind the
layout. It also lists what not to do, which is the shorter and more useful list.

## Reporting a bug

Search the existing issues first, including closed ones. When you open a new one, include:

- A reproducible test case or a sequence of steps.
- The version of this package, of `strands-agents` and Python, or of `@strands-agents/sdk` and Node.js.
- Which MongoDB deployment you are on: Atlas, an Atlas CLI local deployment, or a self-managed server, and
  its version. Behaviour differs across the three, and the search tiers differ most.
- Anything unusual about the environment, and whether you have already tried the latest release.

Please do not report a security vulnerability in a public issue. See [Security](#security).

## Asking for a feature

Open an issue describing the problem before the solution. Say what you are trying to do and what is in the
way. If the request is about an API this package exposes, say which SDK surface you are wiring it into,
because both surfaces here implement protocols owned by the Strands Agents SDK and what they can do is
bounded by those.

## Setting up an environment

You need Python 3.10 or newer and, for anything beyond the default tier, a MongoDB deployment.

```bash
git clone git@github.com:mongodb/strands-mongodb.git
cd strands-mongodb/python
pip install hatch
hatch run test
```

That is where the repository lives today. It is expected to move to a MongoDB-owned organisation before the
first release, and the URLs in `pyproject.toml` already point at the intended home rather than at this one,
with a note beside them recording that the organisation is unconfirmed. Clone from wherever you found this
file.

Hatch builds the environment from `pyproject.toml`, so there is nothing else to install. If you would
rather use a plain virtualenv:

```bash
cd python
python -m venv .venv && source .venv/bin/activate
pip install -e ".[all,dev]"
python -m pytest
```

Either way, every command runs from `python/`, not from the repository root.

The TypeScript package needs Node.js 22 or newer and nothing else installed:

```bash
cd typescript
npm ci
npm run check
```

Every `npm` command runs from `typescript/`. `npm run check` is everything a pull request is checked for
without a deployment. `npm test` alone is the unit project.

### Installing the TypeScript package before its first release

The package is not on npm yet. To use it in another project, build a clone and install the folder:

```bash
git clone git@github.com:mongodb/strands-mongodb.git
cd strands-mongodb/typescript && npm ci && npm run build
cd /path/to/your/app && npm install /path/to/strands-mongodb/typescript
```

`npm install <folder>` links the folder, so the clone has to stay built. For a copy, run `npm pack` in
`typescript/` and install the `.tgz` it writes. Either way the version is `0.0.1-development`: the real
version is written at publish time, as [`typescript/RELEASING.md`](typescript/RELEASING.md) describes.

## Running the tests

Most of the suite needs no deployment at all. The tiers that need one are gated on an environment
variable and skip when it is empty, so a first run on a laptop with no cluster is green.

| Tier | Gate | Needs |
|---|---|---|
| default | none | Nothing |
| `contract` | `MONGODB_URI` | Any MongoDB deployment |
| `integration` | `MONGODB_ATLAS_URI` | Atlas, or an Atlas CLI local deployment with `mongot` |
| `autoembed` | `MONGODB_AUTOEMBED_URI` | A cluster with an Atlas embedding model registered |
| `build` | `STRANDS_MONGODB_BUILD_TIER` | Network only. Builds a wheel and installs it into an empty venv |

The TypeScript suite reads the same variables and skips the same way; `npm run test:contract` and its
siblings select one tier each.

Put the URIs in a `.env` file at the repository root, which is gitignored. Never commit one, and never
paste a connection string into an issue, a test or a document: a test in the suite walks every Markdown
file in the repository looking for exactly that.

Because `.env` is loaded automatically, a bare test run on a machine that has one starts the contract tier.
`AGENTS.md` explains how to opt out, and how long an index build and an embedding can take, which is worth
reading before you conclude that a cluster test has hung.

## What a pull request has to pass

Run this before pushing. It is the same four checks the first two CI jobs run, in the same order, except
that it formats the tree in place where CI only reads it:

```bash
hatch run prepare
```

Then the jobs in `.github/workflows/ci-python.yml`. Five gate a change, one of them twice over two
deployments, so six checks have to go green; two more jobs run on the weekly cron, or whenever a maintainer
starts the workflow by hand from the Actions tab:

| Job | Runs |
|---|---|
| `Lint` | `hatch run format-check`, `hatch run lint`, `hatch run typecheck` |
| `Test - Python <version>` | The default tier on 3.10, 3.11, 3.12, 3.13 and 3.14. No deployment, so no secrets |
| `Contract tier (<deployment>)` | `hatch run test -m contract` twice, against a `mongo:8` service container and against a `mongodb/mongodb-atlas-local:8` one that carries a search process. The second leg also runs `hatch run test -m integration`, which needs that search process. No secret either time |
| `Coverage floors` | `hatch run cov`: 90% aggregate and 70% per module, both enforced |
| `Dependency floors` | Installs the oldest version of every dependency the manifest declares, on the oldest Python it claims, then runs the default tier against them |
| `Latest SDK compatibility` | Weekly or on demand, against the newest published `strands-agents` rather than the pinned one. Typechecks, then runs `compat`, then runs `contract` |
| `Atlas tiers` | Weekly, or on demand. Creates an Atlas cluster for the run, runs `hatch run test -m "integration or autoembed"` against it, and deletes it |

![Where each test tier runs: the unit and contract tiers and the integration tier on every change, the Atlas tiers on a throwaway cluster weekly or on demand](docs/images/ci-tiers.png)

The TypeScript package has its own workflow, `.github/workflows/ci-typescript.yml`, which runs on a change
under `typescript/` or to a file its tests read. Six jobs gate a change, one of them once per Node
version, and two more run on the weekly cron or on demand. `npm run check` from `typescript/` is the local form of
the first two, without the build tier:

| Job | Runs |
|---|---|
| `Lint` | `npm run format:check`, `npm run lint`, `npm run type-check` |
| `Test - Node <version>` | On Node 22 and 24: `npm run test:coverage`, which enforces both coverage floors (90% aggregate, 70% per file), then `npm run test:docs`, then `npm run test:gate`. On Node 24 also the build tier, `npm run test:build`, which packs the tarball and installs it into empty ESM and CommonJS projects. No deployment, so no secrets |
| `Dependency floors` | `node scripts/pin-floors.mjs --install` puts the lowest version of every peer range in place, on Node 22, then `npm test` and `npm run type-check` run against them |
| `Contract tier - mongod alone` | `npm run test:contract` against a `mongo:8` service container, which has no search process. No secret |
| `Release gate tiers - Atlas local` | Against a `mongodb/mongodb-atlas-local:8` service container: `npm run test:contract`, `npm run test:integration`, then `npm run test:gate:release` over both. No secret |
| `Python interop - Atlas local` | Against the same image: installs hatch, lints the Python scripts under `typescript/scripts/`, regenerates the parity fixtures and fails if they changed, then runs `npm run test:interop`. No secret |
| `Latest SDK compatibility` | Weekly or on demand, against the newest published `@strands-agents/sdk`. Type-checks, then runs `npm run test:compat`, then `npm run test:contract` against the Atlas local image |
| `Atlas tiers` | Weekly, or on demand. Creates an Atlas cluster with `python/scripts/atlas_ci_cluster.py`, runs `npm run test:integration` and `npm run test:autoembed` against it, and deletes it |

There is no TypeScript `Coverage floors` job: `Test - Node <version>` enforces both floors on every run.

Every change gets the `integration` tier, from a fork as readily as from a branch, because the Atlas local
container carries the search process it needs. Only `autoembed` needs a real Atlas cluster: automated
embedding runs on Atlas, on an M10 or larger with storage auto-scaling on. So the `Atlas tiers` job creates
one for each run, on the newest MongoDB release, and deletes it when the run ends, pass or fail. It runs on
the weekly cron and when a maintainer starts the workflow by hand, never on a pull request: a fork receives no
secret, and every run is billed for the hour or so its cluster exists. A pull request that changes automated
embedding should say whether the author ran `autoembed` locally.

### The cluster the `Atlas tiers` job creates

The job runs [`python/scripts/atlas_ci_cluster.py`](python/scripts/atlas_ci_cluster.py), which you can also
run yourself. `up` creates an M10 named `sm-ci-<suffix>`, a database user and an access-list entry for
the machine running it (both expire after three hours), waits until the search process answers, and prints
the connection string. `down <name>` deletes the cluster and the user. `up` also deletes any `sm-ci-`
cluster older than three hours, in case a run stopped before its teardown.

It authenticates the way the Atlas CLI does: a logged-in `atlas auth login` session locally, and in CI a
service account with the Project Owner role on one Atlas project, which is what creating a cluster takes. The
workflow reads three repository secrets:

- `ATLAS_CLIENT_ID`: the service account's client ID.
- `ATLAS_CLIENT_SECRET`: its client secret.
- `ATLAS_PROJECT_ID`: the project the cluster is created in.

## Sending the pull request

1. Work against `main` and keep the change focused on one thing.
2. **Add or update a test** that fails without your change.
3. **Update the documentation if behaviour changed.** `python/README.md` and `typescript/README.md` are
   the references a user reads, one per package.
4. Use a conventional commit subject: `feat:`, `fix:`, `docs:`, `test:`, `refactor:` or `chore:`, with
   the `(typescript)` scope for a change under `typescript/`.
5. Run `hatch run prepare`, or `npm run check` from `typescript/`, and make sure it is clean.
6. Open the pull request against `main`, describe what changed and why, and mention any issue it closes.
7. Stay engaged with review. Squash and rebase if asked.

## Code of conduct

This project follows the [MongoDB Code of Conduct](https://www.mongodb.com/community-code-of-conduct). The
short version is the ordinary standard: be respectful, assume good faith, and keep discussion on the work.

Report a violation to community@mongodb.com, which is the address that document names. Not in an issue and
not in a pull request review, because neither is private and neither reaches anybody who can act on it.

## Security

**Do not open a public issue for a security vulnerability.** A public report discloses the vulnerability
before a fix exists.

Report it privately to mongodb-partners@mongodb.com instead. [SECURITY.md](SECURITY.md) is the same address
with the detail beside it: what to put in the report, what to expect back, and what is out of scope here,
including MongoDB Server, Atlas and the drivers, which go through MongoDB's own process rather than through
this repository.

## Licensing

This project is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Contributions are accepted under the same license. Larger changes may need a Contributor License Agreement,
and a maintainer will say so on the pull request if it applies.
