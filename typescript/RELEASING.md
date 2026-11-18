# Releasing

A release is one push of one tag. `.github/workflows/release-typescript.yml` runs on a `typescript-v*`
tag, and a published version cannot be replaced: it can be deprecated, or unpublished within 72 hours.

The Python package releases separately, on `python-v` tags. See
[`python/RELEASING.md`](../python/RELEASING.md).

## The version comes from the tag

`package.json` carries `0.0.1-development` on `main` and that never changes. The release run writes the
version from the tag with `npm version --no-git-tag-version`: `typescript-v0.1.0` becomes `0.1.0`. The
build that follows copies it into `src/version.ts`, which is what the package reports in the driver
handshake and the tracer scope. Nothing is committed back.

## The first release

The first version goes through the same workflow as every later one, so the tarball that is published
is the one the jobs tested. Three things have to exist first.

1. The `npm` environment in the repository settings, with required reviewers. A job that names a missing
   environment makes GitHub create one with no reviewers.
2. `NPM_TOKEN` in that environment. A granular token cannot be scoped to a package that does not exist,
   so create a short-lived one with read and write access to all packages of the account or
   organisation that is to own `strands-mongodb`. After the first publish, replace it with one scoped to
   the package. npm limits the lifetime of a write token, so check its expiry before each later tag.
3. The name. `strands-mongodb` is unclaimed on npm today (`npm view strands-mongodb` answers E404), and
   the first publish claims it for the token's owner. Anyone can take it until then. To claim it before
   `0.1.0` is ready, tag a prerelease such as `typescript-v0.1.0-rc.1`: it runs the same workflow and
   lands on the `next` dist-tag.

In the commit you tag, delete what describes the package as unpublished: the "Installing the TypeScript
package before its first release" section of the root `CONTRIBUTING.md`, the sentence in the root
`README.md` that links to it, and the words "is unreleased too, and" in the root `README.md`, leaving
"It releases on its own `typescript-v` tag". `npm run check` stays green. Then follow [Before you tag](#before-you-tag) and [Tagging](#tagging).

While the repository is private, the links in `README.md` and the `repository`, `homepage` and `bugs`
URLs in `package.json` do not resolve for npm users. Nothing in the package depends on them.

## Before you tag

1. Be on `main`, at the commit you intend to release.
2. Update [CHANGELOG.md](CHANGELOG.md): rename `## [Unreleased]` to `## [<version>] - <date>` and add an
   empty `## [Unreleased]` above it.
3. Run `npm run check`, then `STRANDS_MONGODB_BUILD_TIER=1 npm run test:build`. CI runs both on every
   pull request, so this confirms the commit, not the branch.
4. Run the release gate against an Atlas CLI local deployment (`mongodb/mongodb-atlas-local:8`), with
   `MONGODB_URI` and `MONGODB_ATLAS_URI` set to it:
   `npm run test:contract && npm run test:integration && npm run test:gate:release`.
5. Run `npm run test:autoembed` against an Atlas cluster with a registered embedding model. No workflow
   runs it on a tag, and it covers the default search mode.

## Tagging

```bash
git tag typescript-v0.1.0
git push origin typescript-v0.1.0
```

A `python-v` tag releases only the Python package. A plain `v0.1.0` tag does nothing.

## What the workflow runs

The first two jobs run side by side. Each later job needs the ones before it.

| Job | What it does |
|---|---|
| `Release gate` | `npm ci`, then `npm run check` |
| `Contract tier` | Against a `mongodb/mongodb-atlas-local:8` service container: `npm run test:contract`, `npm run test:integration`, then `npm run test:gate:release`, which fails unless every release-gate item passed in those two tiers. Then checks the working tree is clean |
| `Build and verify the artifact` | Checks the tag carries a semantic version, writes it into `package.json`, and checks `npm pack` reports it. Packs the tarball once, runs `npm run test:build` on that tarball, and uploads it |
| `Publish to npm` | Waits for approval in the `npm` environment, downloads the tarball and runs `npm publish`. A prerelease such as `0.1.0-rc.1` goes to the `next` dist-tag |

The publish job reads `NPM_TOKEN` as `NODE_AUTH_TOKEN`. No other job sees a secret.

`--provenance` is off. Provenance needs a public source repository, and this one is private, so the
flag would make the publish fail. Turning it on when the repository is public takes `--provenance` on
both `npm publish` lines and `permissions: id-token: write` beside `contents: read` on the publish job.
Two assertions in `test/__tests__/ci.test.ts` forbid exactly that: "grants read access only, and raises
no permission on any job", and the `--provenance` line of "publishes only from the npm environment,
after the gated tiers, without provenance". Change both in the same commit as the workflow, so they
allow `id-token: write` on the publish job and nowhere else. Trusted publishing over OIDC, which can
replace the token once the package exists on npm, needs the same permission and the same two changes.

## When it goes wrong

| Symptom | Cause | What to do |
|---|---|---|
| No run started | The tag did not match `typescript-v*` | Delete the tag locally and on the remote, and tag again |
| `Release gate` or `Contract tier` is red | The commit is not releasable | Fix on `main`, delete the tag on the remote, tag the new commit |
| `The tag must be a semantic version` is red | The text after `typescript-v` is not a version | Delete the tag and tag again. Nothing was published |
| `The packed version must equal the tag` is red | `npm version` did not write the version | Read the step's log. Nothing was published |
| `npm publish` fails with ENEEDAUTH or E401 | `NPM_TOKEN` is missing or expired | Replace the secret and re-run the failed job |
| `npm publish` fails with E403 | The token cannot publish, or the version exists | Fix the token, or release a new patch |
| The wrong artifact was published | It is on npm | `npm deprecate` it and publish a new patch. Unpublishing is possible for 72 hours and burns the version number |
