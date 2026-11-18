# Releasing

A release is one push of one tag. Everything after that is automatic except a single approval, and
everything before it can be undone. This document gives the order of those steps, because the upload
at the end cannot be reversed: an upload to PyPI can be yanked, never replaced.

The procedure is `.github/workflows/release-python.yml`. That file is the authority; this one is the
part a person needs to follow it. A test checks that the two agree about the jobs, the tag and the
environment, so a job added to the workflow and not described here fails the suite.

## What a release is made of

The version is not written down anywhere. `hatch-vcs` derives it from the git tag, matching
`^python-v(?P<version>.+)$`, so `python-v0.1.0` builds `0.1.0`. A build from a tree with no such tag
gets a development version numbered from the last tag, of the form `<next minor>.devN+g<sha>`
(setuptools-scm's `release-branch-semver` scheme, because the default cannot number a commit after a
`.dev` tag and fails the build), and a build
with no git metadata at all falls back to `0.0.0`. Neither can be mistaken for a release.

This means there is no version bump commit and nothing to keep in sync. It also means the tag is the
whole decision: tag the commit you mean, because the artifact is built from it and from nothing else.

## Before you tag

1. **Be on `main`, at the commit you intend to release.** `git log -1` and read it.
2. **Update [CHANGELOG.md](CHANGELOG.md).** Move everything under `## [Unreleased]` into a heading for
   the version you are about to tag, and give that heading the release date. Nothing else in the
   repository records what a version contains, and after the upload nobody can add it retroactively to
   the artifact.
3. **Run the gate locally.** `hatch run format-check`, `hatch run lint`, `hatch run typecheck`,
   `hatch run cov`. The release workflow runs all four again and a failure there wastes only time, but
   it wastes it after you have already pushed a tag, and a tag pointing at a commit that cannot be
   released has to be deleted from the remote by hand.
4. **Run the Atlas tiers on that commit.** Start `CI - Python` by hand from the Actions tab on `main` and
   wait for `Atlas tiers`. It is the only job that runs `autoembed`, the package's default search mode,
   against Atlas, and it does not run on a merge.

## Tagging

```bash
git tag -s python-v0.1.0 -m 'strands-mongodb 0.1.0'
git push origin python-v0.1.0
```

The `python-v` prefix is what starts a release. A plain `v0.1.0` tag does nothing. The prefix
exists because this repository is a monorepo: a future `typescript/` versions independently off the
same history, and its tags must not reach this workflow.

`-s`, not a lightweight tag. The tag is what authorises everything downstream — it is the only input
to a release, there is no `workflow_dispatch` to fall back on, and the OIDC claim PyPI trusts is
minted because *this* tag was pushed. An annotated, signed tag records who asked for that and can be
verified afterwards with `git tag -v`; a lightweight tag records nothing but a commit id. It needs a
GPG or SSH signing key configured locally (`git config --get user.signingkey`); without one, `-s`
fails rather than quietly producing an unsigned tag.

A prerelease is tagged the same way: `python-v1.0.0.dev1` yields version `1.0.0.dev1`, which `pip
install strands-mongodb` will not resolve to unless asked with `--pre`, once any final version exists. The GitHub Release for such
a tag is marked as a prerelease, so it does not displace the last stable one.

## What runs, in order

| Job | Name in the Actions UI | What it does |
|---|---|---|
| `gate` | Release gate | `validate-pyproject` on the manifest, then formatting, lint, types and both coverage floors, with `STRANDS_MONGODB_BUILD_TIER` set |
| `contract` | Contract tier | The contract tests against a real `mongo:8` service container |
| `build` | Build and verify the artifact | `hatch build`, then the check below, then `twine check --strict` on what PyPI will render, then uploads `python-dist` |
| `sign` | Sign the artifact | Checksums the wheel and the sdist, signs all three with Garasign, uploads `python-signatures` |
| `publish` | Publish to PyPI | Downloads `python-dist` and uploads it |
| `github-release` | Attach the signatures to the GitHub Release | Creates the Release for the tag if it does not exist, attaches the artifacts, the `.sig` files and `SHA256SUMS` |
| `sbom` | Generate the SBOM | Installs the project with its `all` extra into a clean virtualenv, runs `cyclonedx-py` against it, writes the released version and `pkg:pypi/strands-mongodb@<version>` into its root component, uploads `python-sbom`. Always runs. Holds no credential |
| `sbom-publish` | Augment and attach the SBOM | Downloads `python-sbom` and attaches it to the Release as `cyclonedx.sbom.json`, then uploads that file as `python-sbom-attached`. Always runs. Augments it through SilkBomb/Kondukto first **only** if `KONDUKTO_SECRET_ID` is set |
| `trace` | Record the authorized publication | Writes the authorized-publication report over every file on the Release (artifacts, `.sig` files, `SHA256SUMS`, the SBOM) and uploads the report and the SBOM to `s3://<bucket>/strands-mongodb/<version>/`. **Skipped** unless `AWS_RELEASE_BUCKET` is set |

`gate` and `contract` run in parallel; `build` needs both; `sign` needs `build`; `publish` needs
`sign`; `github-release` needs `publish`; `sbom` needs `github-release`; `sbom-publish` needs
`sbom`; `trace` needs `publish` and `sbom-publish`.

`trace` runs last because its report covers the SBOM, which is attached last. A red `sbom-publish`
therefore leaves `trace` skipped as well; **Re-run failed jobs** runs both, and neither touches PyPI.

`publish` needs `sign` rather than `build` on purpose: an artifact that was not signed cannot reach
PyPI, because the job that uploads it does not start until the job that signs it has succeeded.

`trace` is gated on a repository variable and is skipped, not failed, while that variable is empty.
A skipped job is green. It becomes live the moment the variable is set, with no change to this file
or to the workflow. The variable only switches the job on, so any non-empty value works. It has to be a
repository variable rather than one on `release-signing`: a job's `if:` is evaluated before its
environment is, so an environment variable would leave `trace` skipped forever. The bucket itself comes
from the release secret, which holds a `release-assets-bucket` key. The workflow must not set
`RELEASE_ASSETS_BUCKET` as well: the secrets action refuses a name that is already set. The role `trace`
assumes needs `s3:PutObject` on that bucket.

`sbom` is **not** gated. Generating a CycloneDX SBOM needs no credential and no vendor, so every
release ships one. Only the SilkBomb/Kondukto augmentation waits on `KONDUKTO_SECRET_ID`, step by
step inside `sbom-publish`. The asset is called `cyclonedx.sbom.json` either way, so there is one
place to look; whether it was augmented shows in its contents, not in its name. An unaugmented SBOM
still lists every dependency -- what it lacks is the vulnerability and licence annotation Kondukto
adds.

Generation and attachment are two jobs because generating means installing this package and every
dependency of the `all` extra, which runs their build hooks on the runner. `sbom` therefore holds
`contents: read` and nothing else, and the OIDC credential lives in `sbom-publish`, which installs
nothing. The two interpreters inside `sbom` are for the same reason of hygiene: `cyclonedx-py`
reports whichever environment it is given, so scanning the one it is installed in would list its own
dependency tree as components of this package.

The check inside `build` compares versions: the built wheel's version must equal the
tag, compared as PEP 440 objects rather than as strings, so `python-v0.1.0-rc1` and `python-v0.1.0rc1`
are the same answer while a genuinely different version still fails. A mismatch means `hatch-vcs` saw
a dirty tree or no tag, and publishing that would put a `.dev` or `0.0.0` artifact on PyPI forever.

## The two environments

`sign`, `sbom-publish` and `trace` are bound to the `release-signing` environment. It carries **no
required reviewers**: it is a credential scope rather than an approval gate, naming the AWS role those jobs
may assume over OIDC. `pypi` is where a person approves, and two prompts for one release would teach
everybody to click through both.

Signing is required rather than gated, because the Garasign credentials behind it are provisioned:
the `drivers-test-secrets-role` trust policy names this repository and the
`drivers/strands-mongodb/release-signing` vault exists. If that ever stops being true, a tag fails at
`sign` — loudly, and before anything reaches PyPI.

## The approval

`publish` is bound to the `pypi` environment, and that environment has required reviewers. A tag does
not publish: the run stops at `publish` and waits for a human to approve the deployment in the
Actions UI. That pause is the last stop before the irreversible step, and it is the one part of this
process you cannot discover by reading the repository: the environment and its reviewer list live in
repository settings, not in a file.

**Both environments exist, and `pypi` has required reviewers.** That mattered to get right up
front, because GitHub creates a missing environment on first reference *with no reviewers* — a tag
pushed before `pypi` existed would have reached the upload unapproved rather than failing. Both are
scoped to `tag python-v*`, so a branch cannot deploy to either.

The PyPI trusted publisher **is** registered: project `strands-mongodb`, owner `mongodb`, repository
`strands-mongodb`, workflow `release-python.yml`, environment `pypi`. The owner is what makes the tag
have to be pushed to `mongodb/strands-mongodb`: the OIDC claim carries the repository the workflow
ran in, so a tag pushed to a fork mints a claim PyPI will reject.

If the run appears to hang at `publish`, it is not hung. It is waiting for somebody, and if nobody
who can approve is watching, it waits until the run expires.

## Credentials

There are none. The upload uses PyPI's trusted publishing over OIDC: no API token exists in this
repository, so there is nothing to leak or rotate. PyPI verifies the identity of that workflow file,
in that repository, running in the `pypi` environment, and mints a token good for one upload.

Rename the workflow file or the environment and the upload stops working until the publisher on PyPI
is updated to match. That coupling is intended: it is what ties the upload to this workflow.

## When it goes wrong

| Symptom | What happened | What to do |
|---|---|---|
| No run started | The tag did not match `python-v*` | Delete the tag locally and on the remote, tag again with the prefix |
| `gate` or `contract` red | The commit was not releasable | Fix on `main`, delete the tag from the remote, tag the new commit |
| `wheel is X, tag says Y` | `hatch-vcs` saw a dirty tree or no tag | Tag an exact commit on a clean checkout |
| Stuck at `publish` | Waiting for a required reviewer | Approve the deployment, or find somebody who can |
| `sign` red, AWS "not authorized to perform sts:AssumeRoleWithWebIdentity" | The trust policy does not cover this repository | Ask DevProd Release Infrastructure to add it; nothing has reached PyPI |
| `trace` skipped, or the Kondukto steps inside `sbom-publish` skipped | Their repository variable is empty | Expected while the credentials behind them are unprovisioned. An SBOM is generated and attached either way |
| `sbom-publish` red on `gh release upload` with a 403 | The job lacks `contents: write` | A permissions block sets every scope it does not name to `none`; the SBOM is the only asset missing, the release stands |
| A `.dev` or `rc` release shows as *Latest* on the releases page | It was created without `--prerelease` | Edit the release and tick *Set as a pre-release*; nothing on PyPI is affected |
| Wrong artifact uploaded | It is on PyPI permanently | Yank that version on PyPI and release a new patch. There is no replace |
