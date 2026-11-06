# Releasing

A release is one push of one tag. Everything before it can be undone; the upload at the end cannot be:
a version published to npm can be deprecated or, within 72 hours, unpublished, never replaced. This
document gives the order of the steps, and says which of them do not exist yet.

The procedure will be `.github/workflows/release-typescript.yml`. **That workflow is not written yet**,
so today the first publish is a manual `npm publish` by a maintainer, following the same steps by hand.
The Python half of this repository releases from `release-python.yml` on `python-v` tags, and
[`python/RELEASING.md`](../python/RELEASING.md) is the model this one follows.

## What a release is made of

`package.json` carries `0.0.1-development` and that value never changes on `main`. The version is
written at publish time from the tag: `typescript-v0.1.0` becomes `0.1.0` through
`npm version --no-git-tag-version`, run on the checkout the tag points at, inside the release run or
the maintainer's shell. Nothing is committed back, so there is no version bump commit and nothing to keep
in sync. A tarball built from a tree with no tag applied carries `0.0.1-development`, which cannot be
mistaken for a release.

The tag is the whole decision: tag the commit you mean, because the artifact is built from it and from
nothing else.

## Before you tag

1. **Be on `main`, at the commit you intend to release.** `git log -1` and read it.
2. **Update [CHANGELOG.md](CHANGELOG.md).** Move everything under `## [Unreleased]` into a heading for
   the version you are about to tag, and give that heading the release date. Nothing else in the
   repository records what a version contains.
3. **If this is the first release ever**, remove the
   `<!-- skip: these reach npm for a package that is not published yet -->` marker from
   `README.md` here and from the npm block in the repository-root `README.md`, in the same commit.
4. **Run the gate locally.** `npm run check` is the whole of it: formatting, lint, types, the unit tier
   with both coverage floors, and the release gate over the recorded results. Then
   `STRANDS_MONGODB_BUILD_TIER=1 npm run test:build`, which packs the tarball and installs it into
   empty ES module and CommonJS projects.
5. **Run the tiers that need a deployment.** `npm run test:contract` and `npm run test:integration`
   against an Atlas CLI local deployment, and `npm run test:autoembed` against an Atlas cluster with a
   registered embedding model. The last one is the package's default search mode and nothing runs it on
   a merge.

## Tagging

```bash
git tag typescript-v0.1.0
git push origin typescript-v0.1.0
```

The `typescript-v` prefix is what distinguishes this package's releases. A `python-v` tag releases the
Python package and nothing here; a plain `v0.1.0` tag does nothing. The two packages share one history
and version independently, which is the reason for the prefixes.

## What runs, in order

When the workflow exists, it runs these in order on a `typescript-v*` tag. Until then they are the steps
a maintainer runs by hand, in the same order, from `typescript/`:

| Step | What it does |
|---|---|
| Gate | `npm ci`, then `npm run check` |
| Version | `npm version --no-git-tag-version "${GITHUB_REF_NAME#typescript-v}"`, so `package.json` says what the tag says |
| Build | `npm pack`, which runs `prepack` and so `npm run build`; then `npm run test:build` against that tarball |
| Publish | `npm publish` of the tarball, in the `npm` environment |

`--provenance` is off. npm provenance links a published package to a public source repository and a
public workflow run, and this repository is private; turning it on before the repository is public makes
the publish fail. The release workflow will carry that condition as a comment beside the flag, and the
flag goes on when the repository goes public.

## The approval

`Publish` will be bound to the `npm` environment, with required reviewers, so a tag does not publish: the
run stops and waits for a human to approve the deployment in the Actions UI. That pause is the last stop
before the irreversible step, and it is the one part of this process you cannot discover by reading the
repository: the environment and its reviewer list live in repository settings, not in a file.

**Neither exists yet.** There is no `npm` environment in the repository settings and no trusted publisher
on npm. Do not push a `typescript-v` tag expecting a release until both are configured; today the tag
marks the commit and a maintainer publishes.

## Credentials

Trusted publishing is not configured. The first publish uses a granular npm access token held by the
maintainer who publishes, scoped to this package and to publishing, with two-factor authentication on
the account. It is used once and revoked. The workflow, when it exists, reads `NODE_AUTH_TOKEN` from the
`npm` environment's secrets; trusted publishing over OIDC replaces it once the repository is public and
the package exists on npm to bind a publisher to.

## When it goes wrong

| Symptom | What happened | What to do |
|---|---|---|
| No run started | The tag did not match `typescript-v*` | Delete the tag locally and on the remote, tag again with the prefix |
| The gate is red | The commit was not releasable | Fix on `main`, delete the tag from the remote, tag the new commit |
| `package.json` still says `0.0.1-development` in the tarball | The version step did not run before `npm pack` | Run it, pack again. Nothing was published |
| `npm publish` refused with E403 | The token lacks publish rights, or the version already exists | Fix the token, or release a new patch. A published version is permanent |
| Wrong artifact published | It is on npm | `npm deprecate` it with a message pointing at the fix, publish a new patch. Unpublishing is possible for 72 hours only and leaves the version number burned |
