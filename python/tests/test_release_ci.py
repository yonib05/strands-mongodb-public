"""The release workflow, asserted by reading it, because nothing in this suite can run it.

Same principle as ``test_ci.py``: a workflow is a YAML document on disk, so these are unit-tier tests with no tier and
no network, and they read the file the way ``test_packaging.py`` reads ``pyproject.toml``.

**Why this file is worth more than the CI one.** ``ci-python.yml`` is wrong for as long as it takes
somebody to open a pull request. This file is wrong until a tag is pushed, and the failure it
produces is either a release that does not happen or, at greater cost, a wheel on PyPI that cannot be
replaced, only yanked. There is no rehearsal: the first execution of this workflow is a real upload
of a real version number that is then permanently spent.

**What this file cannot tell you.** It asserts the workflow says what it should say. Whether the
``pypi`` environment exists, whether it has required reviewers, and whether PyPI has a trusted
publisher bound to this repository and this filename are all settings outside the repository, and no
test here can see any of them. A green run of this file means the workflow is correct and says
nothing about whether an upload would succeed.
"""

from __future__ import annotations

import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any

import pytest
import yaml
from test_ci import _DEFAULT_TIMEOUT_MINUTES, _TIMEOUT_CEILING_MINUTES

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised only on the 3.10 floor
    # The same alias `test_examples.py` and `test_migration.py` use, for the same reason.
    import tomli as tomllib

# tests/ -> python/ -> the repository root, which is where `.github/` belongs.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = PROJECT_ROOT.parent
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "release-python.yml"

#: The tag prefix ``pyproject.toml``'s ``[tool.hatch.version.raw-options]`` derives the version from.
#: A second language in the same repository versions independently off its own prefix, and the whole
#: point of a prefix is that one workflow must not answer the other's tag.
TAG_PREFIX = "python-v"

#: The action that performs the upload. Named as data rather than matched loosely, because the
#: assertions below are about what this specific action is and is not handed.
PUBLISH_ACTION = "pypa/gh-action-pypi-publish"


@pytest.fixture(scope="module")
def workflow() -> dict[str, Any]:
    """The parsed release workflow.

    Fails rather than skips when the file is absent, for the reason ``test_ci.py``'s fixture gives:
    absence is the defect these tests exist to catch, and a skip reports the same green as a pass.
    """
    assert WORKFLOW_PATH.is_file(), f"no release workflow at {WORKFLOW_PATH}"
    parsed = yaml.safe_load(WORKFLOW_PATH.read_text())
    assert isinstance(parsed, dict), "the workflow did not parse as a mapping"
    return parsed


@pytest.fixture(scope="module")
def raw() -> str:
    """The unparsed text, for the two questions YAML cannot answer.

    ``yaml.safe_load`` discards comments, and one assertion below is about a string that must not
    appear anywhere at all, including in a comment, where a commented-out ``password:`` is a
    suggestion to the next person rather than a safeguard.
    """
    assert WORKFLOW_PATH.is_file(), f"no release workflow at {WORKFLOW_PATH}"
    return WORKFLOW_PATH.read_text()


def _jobs(workflow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The job mapping, which every assertion here starts from."""
    jobs = workflow.get("jobs")
    assert isinstance(jobs, dict) and jobs, "the workflow defines no jobs"
    return jobs


def _steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    """One job's steps, as mappings."""
    return [step for step in job.get("steps", []) if isinstance(step, dict)]


def _triggers(workflow: dict[str, Any]) -> dict[str, Any]:
    """The ``on:`` block, under whichever key YAML produced for it.

    ``on`` is a YAML 1.1 boolean, so ``safe_load`` turns the unquoted key into ``True``. Handled
    rather than worked around in the workflow file, because quoting the key there to suit a test
    would be the test dictating the document's style.
    """
    for key in ("on", True):
        if key in workflow:
            value = workflow[key]
            assert isinstance(value, dict), f"the `on:` block is {type(value).__name__}, not a mapping"
            return value
    raise AssertionError("the workflow declares no triggers")


def _step_uses(job: dict[str, Any], action: str) -> list[dict[str, Any]]:
    """Every step in ``job`` invoking ``action``, ignoring the version after the ``@``."""
    return [step for step in _steps(job) if str(step.get("uses", "")).split("@")[0] == action]


def _ancestors(jobs: dict[str, dict[str, Any]], name: str) -> set[str]:
    """Every job ``name`` cannot start without, transitively.

    Transitive rather than one edge deep, because that is what a gate's position in the graph means: a
    check two jobs upstream still guards the release, and a job rewired to depend only on its immediate
    neighbour would satisfy a direct-edge assertion while skipping everything behind it.
    """
    needs = jobs[name].get("needs")
    needs = [needs] if isinstance(needs, str) else (needs or [])
    found = set(needs)
    for parent in needs:
        found |= _ancestors(jobs, parent)
    return found


def _jobs_running(jobs: dict[str, dict[str, Any]], fragment: str) -> set[str]:
    """The jobs with a ``run:`` block containing ``fragment``."""
    return {name for name, job in jobs.items() if any(fragment in str(step.get("run", "")) for step in _steps(job))}


class TestOnlyThePythonTagTriggersARelease:
    """AT-134 -- what starts an upload, and everything that must not.

    The repository is laid out to hold a second language beside ``python/``, and the version scheme
    is per-prefix. A trigger broad enough to catch the other language's tag publishes this package
    from a commit nobody released, with a version derived from somebody else's tag.
    """

    def test_a_tag_push_is_the_only_trigger(self, workflow: dict[str, Any]) -> None:
        """No ``workflow_dispatch``, no ``release``, no branch push.

        Each of those is a second way to reach an irreversible upload, and a second way is a second
        thing to reason about when asking "what could have published this".
        """
        triggers = _triggers(workflow)

        assert set(triggers) == {"push"}, f"the only trigger must be a tag push, found {sorted(triggers)}"
        push = triggers["push"]
        assert isinstance(push, dict) and set(push) == {"tags"}, (
            f"the push trigger must be narrowed to tags alone, found {push}"
        )

    def test_every_tag_pattern_carries_the_python_prefix(self, workflow: dict[str, Any]) -> None:
        """The prefix is what keeps two languages' releases independent in one repository."""
        patterns = _triggers(workflow)["push"]["tags"]

        assert patterns, "the tag trigger lists no patterns"
        for pattern in patterns:
            assert pattern.startswith(TAG_PREFIX), (
                f"tag pattern {pattern!r} does not start with {TAG_PREFIX!r}, so a tag for another "
                f"language in this repository could start a Python release"
            )

    def test_another_languages_tag_matches_no_pattern(self, workflow: dict[str, Any]) -> None:
        """Asserted by matching, not by reading the prefix off the front a second time.

        ``fnmatch`` is the semantics GitHub applies to a tag filter, so this asks the question the
        way the platform answers it. The previous test could pass on a pattern like
        ``python-v*`` alongside a stray ``*``; this one could not.
        """
        patterns = _triggers(workflow)["push"]["tags"]
        foreign = ["typescript-v1.0.0", "v1.0.0", "1.0.0", "release-1.0.0"]

        for tag in foreign:
            matched = [p for p in patterns if fnmatch.fnmatch(tag, p)]
            assert matched == [], f"tag {tag!r} would start a Python release via {matched}"

    def test_the_packages_own_tag_does_match(self, workflow: dict[str, Any]) -> None:
        """The control. A filter that matches nothing is airtight and never releases anything."""
        patterns = _triggers(workflow)["push"]["tags"]
        ours = f"{TAG_PREFIX}0.1.0"

        assert any(fnmatch.fnmatch(ours, p) for p in patterns), (
            f"no pattern in {patterns} matches {ours!r}, so no tag would ever publish"
        )


class TestNothingHereIsALongLivedCredential:
    """AT-135 -- publishing uses trusted publishing over OIDC, and no long-lived credential exists.

    Trusted publishing is not "a nicer way to store the token". It is the absence of a token: PyPI
    verifies an OIDC assertion naming this repository, this workflow filename and this environment,
    then mints a credential good for one upload. Nothing in the repository can be stolen, because
    nothing in the repository is a credential.

    The coupling to the filename is a security property rather than an inconvenience, and it is the
    reason renaming this file silently breaks releases until the publisher on PyPI is updated.
    """

    def test_the_publish_action_is_handed_no_password(self, workflow: dict[str, Any]) -> None:
        """A ``password:`` input turns trusted publishing back into a stored token, silently.

        The action accepts one and prefers it. So a token added "temporarily" to debug a failing
        upload does not error, does not warn, and quietly reintroduces exactly what OIDC removed.
        """
        for name, job in _jobs(workflow).items():
            for step in _step_uses(job, PUBLISH_ACTION):
                supplied = step.get("with", {}) or {}
                assert "password" not in supplied, (
                    f"job {name!r} hands {PUBLISH_ACTION} a `password:`, which overrides trusted "
                    f"publishing with a stored token"
                )

    def test_no_step_reads_a_secret(self, raw: str) -> None:
        """``secrets.*`` appears nowhere, comments included.

        Read from the raw text rather than the parsed document on purpose: a commented-out secret
        reference is a recipe the next person under release pressure will uncomment.
        """
        references = re.findall(r"secrets\.[A-Za-z_][A-Za-z0-9_]*", raw)

        assert references == [], (
            f"the release workflow references {sorted(set(references))}; publishing here is over OIDC "
            f"and no long-lived credential should exist to reference"
        )

    def test_every_job_holding_oidc_is_bound_to_an_environment(self, workflow: dict[str, Any]) -> None:
        """``id-token: write`` is what exchanges for a cloud credential, so every job holding it must
        name an environment.

        An environment is what keeps a job from minting a credential unsupervised: it is the binding
        PyPI verifies, the place required reviewers live, and the scope an org admin can revoke in one
        action. This asserts that at least one job raises the permission -- a workflow where nothing
        can authenticate publishes nothing -- and that each one that does names an environment.

        This replaces ``test_the_oidc_permission_is_raised_on_exactly_one_job`` because four jobs now
        assume a role over OIDC -- signing, publishing, the SBOM and the authorized-publication report
        -- so a count of holders no longer distinguishes a correct workflow from a careless one. The
        count stood in for supervision; naming the environment states it directly, and states it of
        every holder rather than leaving the one holder's binding unchecked.
        """
        holders = {
            name: job
            for name, job in _jobs(workflow).items()
            if (job.get("permissions") or {}).get("id-token") == "write"
        }

        assert holders, "no job raises `id-token: write`, so nothing here can authenticate to PyPI or AWS"
        for name, job in holders.items():
            environment = job.get("environment")
            bound = environment if isinstance(environment, str) else (environment or {}).get("name")
            assert bound, (
                f"job {name!r} raises `id-token: write` without naming an environment, so the token it "
                f"mints is scoped by nothing a repository administrator can see or revoke"
            )

    def test_the_workflow_default_grants_no_write(self, workflow: dict[str, Any]) -> None:
        """The top-level default is read-only, so a job that raises nothing inherits nothing."""
        default = workflow.get("permissions")

        assert default == {"contents": "read"}, (
            f"the workflow-level permissions are {default!r}; they should be read-only so that raising "
            f"a permission is always a visible, per-job decision"
        )

    def test_the_publishing_job_is_bound_to_an_environment(self, workflow: dict[str, Any]) -> None:
        """The environment is half of what PyPI verifies, and where required reviewers live.

        This is the step that makes a tag insufficient on its own: a human approves the deployment
        before the upload runs. It is the last reversible moment in the whole process.
        """
        publishers = [(name, job) for name, job in _jobs(workflow).items() if _step_uses(job, PUBLISH_ACTION)]
        assert publishers, f"no job uses {PUBLISH_ACTION}"

        for name, job in publishers:
            environment = job.get("environment")
            assert environment, f"job {name!r} publishes to PyPI without an `environment:` to gate it"
            declared = environment.get("name") if isinstance(environment, dict) else environment
            assert declared, f"job {name!r} declares an environment with no name"


class TestThePublishedArtifactIsTheVerifiedArtifact:
    """AT-136 -- the uploaded wheel's version equals the tag, checked at the only moment it still matters.

    A version on PyPI is spent permanently: yanking hides it, nothing replaces it. So the check that
    the wheel's version equals the tag has to sit between the build and the upload, and the upload
    has to consume the artifact that check ran against rather than rebuilding one of its own.

    The failure this prevents is specific and quiet. ``hatch-vcs`` derives the version from git
    metadata; a shallow clone has no tags, so the version falls back rather than failing, and the
    artifact that reaches PyPI is a ``0.0.0`` or a ``.dev`` that can never be taken back.
    """

    def test_the_upload_runs_only_after_the_build(self, workflow: dict[str, Any]) -> None:
        """``needs:`` is what serialises them; without it both jobs start at once."""
        jobs = _jobs(workflow)
        publishers = [name for name, job in jobs.items() if _step_uses(job, PUBLISH_ACTION)]

        for name in publishers:
            needs = jobs[name].get("needs")
            needs = [needs] if isinstance(needs, str) else (needs or [])
            assert needs, f"job {name!r} publishes without depending on any other job"

    def test_every_job_reaches_the_upload_through_the_gate(self, workflow: dict[str, Any]) -> None:
        """Walk ``needs:`` from the publishing job and require the gate to be an ancestor.

        Asserted transitively rather than as one edge, because the chain is what carries the
        property: the gate can be two jobs away and still hold, and a publishing job rewired to
        depend only on the build would pass a direct-edge check while skipping every gate.
        """
        jobs = _jobs(workflow)
        publishers = [name for name, job in jobs.items() if _step_uses(job, PUBLISH_ACTION)]
        assert publishers, f"no job uses {PUBLISH_ACTION}"

        # Every gate, not merely the first one: the floors and the contract tier live in separate jobs,
        # and an ancestry check that accepts either would pass on a chain that skips the other.
        required = {
            "the coverage floors": _jobs_running(jobs, "hatch run cov"),
            "the contract tier": _jobs_running(jobs, "-m contract"),
        }
        for label, owners in required.items():
            assert owners, f"no job runs {label}"

        for name in publishers:
            reachable = _ancestors(jobs, name)
            for label, owners in required.items():
                assert reachable & owners, (
                    f"job {name!r} can publish without {label} ({sorted(owners)}) having run: its "
                    f"ancestors are {sorted(reachable)}"
                )

    def test_the_checkout_that_builds_is_not_shallow(self, workflow: dict[str, Any]) -> None:
        """``fetch-depth: 0``, because a shallow clone is how the version silently becomes wrong.

        Asserted on every checkout in the file rather than on the build job's alone: the gate
        computes coverage on the same tree, and a version fallback there would be just as invisible.
        """
        for name, job in _jobs(workflow).items():
            for step in _step_uses(job, "actions/checkout"):
                depth = (step.get("with") or {}).get("fetch-depth")
                assert depth == 0, (
                    f"job {name!r} checks out with fetch-depth {depth!r}; hatch-vcs reads the tag from "
                    f"git metadata and a shallow clone has none, so the version falls back instead of failing"
                )

    def test_the_version_check_compares_versions_rather_than_strings(self, workflow: dict[str, Any]) -> None:
        """``Version(...)``, so ``python-v0.1.0-rc1`` and ``python-v0.1.0rc1`` are one answer.

        A string comparison is the tempting shape and it is wrong in both directions: it fails a
        release over PEP 440 spelling, and a maintainer who has just been failed over spelling is
        the person most likely to replace the check with something weaker.
        """
        # Located by what the step does, not merely by the variable it reads. `GITHUB_REF_NAME` alone
        # matched every step that derives a version from the tag -- the authorized-publication report
        # does that too, and has no artifact to parse -- which made this fail for a step it was never
        # about.
        runs = [str(step.get("run", "")) for job in _jobs(workflow).values() for step in _steps(job)]
        checks = [block for block in runs if "GITHUB_REF_NAME" in block and "parse_wheel_filename" in block]

        assert checks, "no step compares the built artifact against the tag"
        for block in checks:
            assert "Version(" in block, (
                "the tag check does not parse either side as a PEP 440 version, so it is comparing strings"
            )
            assert TAG_PREFIX in block, f"the tag check does not strip the {TAG_PREFIX!r} prefix before comparing"


class TestTheReleaseGateIsNoWeakerThanCI:
    """AT-137 -- a tag must clear at least what a pull request clears.

    The gate exists because the two runs answer different questions. CI answers "is this branch
    healthy" and can be re-run on a fix. The release gate answers "is this the artifact we are about
    to spend a version number on", and a failure discovered afterwards has no re-run.

    So every gate that guards a pull request guards a tag, and the contract tier is among them. The
    contract tier needs no credential: its server is a service container, and the tier's own definition
    admits a plain ``mongod``.
    """

    def test_the_gate_runs_every_static_check(self, workflow: dict[str, Any]) -> None:
        """Formatting, linting and typing, by the script names ``pyproject.toml`` defines."""
        runs = "\n".join(str(step.get("run", "")) for job in _jobs(workflow).values() for step in _steps(job))

        for script in ("format-check", "lint", "typecheck"):
            assert f"hatch run {script}" in runs, f"no step runs `hatch run {script}`"

    def test_nothing_runs_the_rewriting_formatter(self, workflow: dict[str, Any]) -> None:
        """``hatch run format`` rewrites the checkout and exits 0, so a gate built on it cannot fail."""
        runs = [str(step.get("run", "")) for job in _jobs(workflow).values() for step in _steps(job)]
        offenders = [block for block in runs if re.search(r"hatch run format(?!-check)", block)]

        assert offenders == [], f"these steps run the rewriting formatter instead of the checking one: {offenders}"

    def test_the_gate_enforces_both_coverage_floors(self, workflow: dict[str, Any]) -> None:
        """``hatch run cov`` is the aggregate floor and the per-module floor, and it runs the unit tier."""
        runs = "\n".join(str(step.get("run", "")) for job in _jobs(workflow).values() for step in _steps(job))

        assert "hatch run cov" in runs, "no step enforces the coverage floors"

    def test_the_gate_runs_the_contract_tier(self, workflow: dict[str, Any]) -> None:
        """The tier that needs a real server, which a tag clears before spending a version.

        Selected rather than implied: ``hatch run test`` without ``-m contract`` reports the tier as
        skipped when no deployment answers, and a skip reads as green. The selector is what makes an
        absent server fail the release instead of quietly passing it.
        """
        runs = [str(step.get("run", "")) for job in _jobs(workflow).values() for step in _steps(job)]
        selected = [block for block in runs if re.search(r"hatch run test\b.*-m\s+(\"|')?contract", block)]

        assert selected, "no step runs `hatch run test -m contract`, so a tag never touches a real server"

    def test_the_contract_tier_gets_its_server_from_a_container(self, workflow: dict[str, Any]) -> None:
        """Every job that sets ``MONGODB_URI`` gets the value from a ``services:`` container.

        The same assertion ``ci-python.yml`` carries, for the same reason: a release workflow holding
        a cluster credential is the long-lived secret this whole design removes, arriving by the back
        door as a convenience.
        """
        for name, job in _jobs(workflow).items():
            uri = (job.get("env") or {}).get("MONGODB_URI")
            if uri is None:
                continue
            assert "secrets." not in str(uri), f"job {name!r} takes MONGODB_URI from a secret: {uri!r}"
            assert job.get("services"), (
                f"job {name!r} sets MONGODB_URI to {uri!r} but declares no `services:` container to answer it"
            )


#: The two tools that check the artifact rather than the code in it. Named as data because both have a
#: reporting form that exits 0 on the failure they exist to find, and the assertions below are about
#: which form is invoked.
MANIFEST_CHECK = "validate-pyproject"
ARTIFACT_CHECK = "twine check"


def _published_artifact(workflow: dict[str, Any]) -> str:
    """The artifact name the publishing job downloads: the one whose contents reach PyPI.

    Several artifacts move between jobs now. Rules about what PyPI receives apply to this one, and
    naming it here keeps them from being asserted of the signatures by accident.
    """
    for job in workflow.get("jobs", {}).values():
        if not _step_uses(job, PUBLISH_ACTION):
            continue
        for step in _steps(job):
            if str(step.get("uses", "")).startswith(DOWNLOAD_ACTION):
                name = (step.get("with") or {}).get("name")
                if name:
                    return str(name)
    raise AssertionError("no publishing job downloads a named artifact, so nothing reaches PyPI")


#: The action that hands the built files to the publisher, and the one that wrote them.
DOWNLOAD_ACTION = "actions/download-artifact"
UPLOAD_ACTION = "actions/upload-artifact"


class TestTheArtifactIsCheckedAndNotOnlyTheCodeInIt:
    """``AT-183`` -- the manifest and the rendered description are checked before the upload.

    ``TestThePublishedArtifactIsTheVerifiedArtifact`` and ``TestTheReleaseGateIsNoWeakerThanCI`` are about
    the code the artifact contains: the gate is no weaker than CI, and the version equals the tag. Neither
    looks at the distribution. Without these checks, whether the manifest satisfies the schemas packaging
    tools validate against, and whether the description PyPI renders actually renders, would first be
    answered by the upload: after a person has approved a deployment, and against a version number that is
    spent whatever happens next.
    """

    def test_the_manifest_is_validated_against_the_packaging_schemas(self, workflow: dict[str, Any]) -> None:
        """Not `hatch build` succeeding, which tolerates a manifest PyPI's own validators refuse."""
        jobs = _jobs(workflow)

        assert _jobs_running(jobs, MANIFEST_CHECK), f"no job runs {MANIFEST_CHECK}, so the manifest is unchecked"

    def test_the_built_artifacts_are_checked_for_a_description_pypi_can_render(self, workflow: dict[str, Any]) -> None:
        """A description that does not render is part of the version, and a version cannot be replaced."""
        jobs = _jobs(workflow)

        assert _jobs_running(jobs, ARTIFACT_CHECK), (
            f"no job runs {ARTIFACT_CHECK}, so the first render of this package's description happens on PyPI"
        )

    def test_the_artifact_check_is_the_strict_one(self, workflow: dict[str, Any]) -> None:
        """``twine check`` warns and exits 0; ``twine check --strict`` fails.

        The same distinction this file already asserts for ``ruff format`` against ``ruff format --check``,
        asserted again because the two tools make the same mistake available: a check whose failing case
        exits 0 cannot stop a release.
        """
        invocations = [
            block
            for job in _jobs(workflow).values()
            for step in _steps(job)
            if ARTIFACT_CHECK in (block := str(step.get("run", "")))
        ]

        assert invocations, f"no step runs {ARTIFACT_CHECK}"
        for block in invocations:
            assert re.search(rf"{re.escape(ARTIFACT_CHECK)}\s+--strict", block), (
                f"this step runs the reporting form rather than the checking one, so an unrenderable "
                f"description passes it: {block!r}"
            )

    def test_the_artifact_check_runs_before_the_artifact_leaves_the_job(self, workflow: dict[str, Any]) -> None:
        """Order within the job, not merely presence somewhere in the file.

        A check after the upload still reports the failure and the artifact has already been handed to a
        job whose next action is irreversible. Asserted by step index, because ``needs:`` says nothing
        about the order of steps inside one job.
        """
        # Only the job that uploads what PyPI will receive. `sign` uploads detached signatures and a
        # checksum file, which `twine check` cannot read and which are never offered to PyPI; requiring
        # it there would be requiring a check of the wrong thing.
        published = _published_artifact(workflow)
        for name, job in _jobs(workflow).items():
            steps = _steps(job)
            uploads = [
                i
                for i, step in enumerate(steps)
                if str(step.get("uses", "")).startswith(UPLOAD_ACTION)
                and (step.get("with") or {}).get("name") == published
            ]
            if not uploads:
                continue
            checks = [i for i, step in enumerate(steps) if ARTIFACT_CHECK in str(step.get("run", ""))]
            assert checks, f"job {name!r} uploads the artifact and never runs {ARTIFACT_CHECK} on it"
            assert min(checks) < min(uploads), (
                f"job {name!r} runs {ARTIFACT_CHECK} at step {min(checks)} and uploads at step "
                f"{min(uploads)}; the check has to happen before the artifact is handed on"
            )

    def test_the_manifest_check_guards_the_release_rather_than_reporting_on_it(self, workflow: dict[str, Any]) -> None:
        """It runs in a job the publisher cannot start without, which is what makes it a gate."""
        jobs = _jobs(workflow)
        publishers = [name for name, job in jobs.items() if _step_uses(job, PUBLISH_ACTION)]
        assert publishers, f"no job uses {PUBLISH_ACTION}"
        owners = _jobs_running(jobs, MANIFEST_CHECK)

        for name in publishers:
            assert owners & _ancestors(jobs, name), (
                f"job {name!r} can publish without {MANIFEST_CHECK} ({sorted(owners)}) having run: its "
                f"ancestors are {sorted(_ancestors(jobs, name))}"
            )


class TestTheArtifactTheUploadWroteIsTheOneThePublisherReads:
    """``AT-184`` -- three strings that have to match, and nothing else in the workflow checks them.

    The upload's ``name`` and the download's ``name``; the download's ``path`` and the publish action's
    ``packages-dir``. A typo in any of them produces a publish job that downloads nothing and hands an
    empty directory to the uploader, after somebody has already approved the deployment.

    ``test_every_job_reaches_the_upload_through_the_gate`` walks ``needs:`` from the publishing job and would
    not see it. That graph is about which
    jobs run in what order and it is correct; this is about whether the payload arrives.
    """

    def _uploads(self, workflow: dict[str, Any]) -> dict[str, dict[str, Any]]:
        """Every upload step's ``with:`` mapping, keyed by the artifact name it writes.

        One name may be written only once. Two uploads under one name is the shape where a download
        resolves to whichever the walk reaches first, which is the ambiguity the old pair-counting
        guarded against and the only part of it that still needs guarding.
        """
        uploads: dict[str, dict[str, Any]] = {}
        for name, job in _jobs(workflow).items():
            for step in _steps(job):
                if not str(step.get("uses", "")).startswith(UPLOAD_ACTION):
                    continue
                supplied = step.get("with") or {}
                artifact = supplied.get("name")
                assert artifact, f"job {name!r} uploads without naming an artifact, so nothing can ask for it"
                assert artifact not in uploads, (
                    f"artifact {artifact!r} is uploaded by more than one job; a download of that name "
                    f"resolves to whichever ran last, which is not a thing the file states"
                )
                uploads[artifact] = supplied
        return uploads

    def _downloads(self, workflow: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        """Every download step, as ``(job name, with-mapping)``."""
        return [
            (name, step.get("with") or {})
            for name, job in _jobs(workflow).items()
            for step in _steps(job)
            if str(step.get("uses", "")).startswith(DOWNLOAD_ACTION)
        ]

    def test_every_download_names_an_artifact_some_upload_wrote(self, workflow: dict[str, Any]) -> None:
        """The replacement for counting one upload and one download.

        The counts held while the only artifact was the distribution. Signing adds a second artifact
        and two more downloads, so the counts are wrong without anything being wrong. What they were
        protecting is the string agreement: a download that names an artifact nothing wrote receives
        an empty directory, and in the publish job that happens after somebody has approved the
        deployment. That is asserted here directly, for every download rather than for one.
        """
        uploads = self._uploads(workflow)
        downloads = self._downloads(workflow)

        assert uploads, "nothing uploads an artifact"
        assert downloads, "nothing downloads an artifact"
        for job, download in downloads:
            artifact = download.get("name")
            assert artifact in uploads, (
                f"job {job!r} downloads {artifact!r}, which no job uploads (uploaded: {sorted(uploads)}); "
                f"it would receive an empty directory and the failure would arrive after the approval"
            )

    def test_the_directory_handed_to_the_publisher_is_the_one_the_download_wrote_into(
        self, workflow: dict[str, Any]
    ) -> None:
        """``packages-dir`` against the download's ``path``, compared as paths rather than as strings.

        ``dist/`` and ``dist`` are the same directory and a string comparison calls them different, which
        is the kind of failure that gets a real assertion replaced with a weaker one.
        """
        publishing = {name: job for name, job in _jobs(workflow).items() if _step_uses(job, PUBLISH_ACTION)}
        assert publishing, f"no step uses {PUBLISH_ACTION}"

        for name, job in publishing.items():
            # The download in the publishing job, not any download in the file: other jobs download the
            # same artifact to other paths, and only this one feeds the uploader.
            local = [
                step.get("with") or {} for step in _steps(job) if str(step.get("uses", "")).startswith(DOWNLOAD_ACTION)
            ]
            assert len(local) == 1, (
                f"job {name!r} runs {PUBLISH_ACTION} and {len(local)} downloads; which directory reaches "
                f"the uploader has to be unambiguous"
            )
            download = local[0]

        for step in [step for job in publishing.values() for step in _step_uses(job, PUBLISH_ACTION)]:
            packages = (step.get("with") or {}).get("packages-dir")
            assert packages, f"{PUBLISH_ACTION} is handed no packages-dir, so it reads wherever it defaults to"
            assert PurePosixPath(str(packages)) == PurePosixPath(str(download.get("path"))), (
                f"the download writes into {download.get('path')!r} and the publisher reads "
                f"{packages!r}; one of the two is the wrong directory and the artifact is nowhere"
            )

    def test_an_upload_that_finds_nothing_fails_rather_than_succeeding_empty(self, workflow: dict[str, Any]) -> None:
        """``if-no-files-found`` defaults to ``warn``, which is a green job and an empty artifact.

        The build step could fail to produce a wheel for a reason the version check never reaches, such as
        a renamed output directory or a hatch configuration change, and the default turns that into a
        release that uploads nothing to PyPI rather than into a red job.
        """
        uploads = self._uploads(workflow)

        for artifact, upload in uploads.items():
            assert upload.get("if-no-files-found") == "error", (
                f"the upload of {artifact!r} sets if-no-files-found to {upload.get('if-no-files-found')!r}; "
                f"anything but `error` lets an empty artifact through to the job that consumes it"
            )


#: The release document, beside the package README rather than at the repository root: it is about
#: releasing the Python distribution, and a second language in this repository releases on its own tag.
RELEASING_PATH = PROJECT_ROOT / "RELEASING.md"

#: The changelog, in the same place and for the same reason. ``pyproject.toml`` points ``readme`` at
#: ``python/README.md``, and these two are that document's neighbours.
CHANGELOG_PATH = PROJECT_ROOT / "CHANGELOG.md"

#: The marker both READMEs carry above their install blocks while nothing is on PyPI. It is the
#: repository's own statement about its publication state, and
#: ``TestTheChangelogAndTheRepositoryAgreeAboutWhatExists`` makes the changelog answer to it.
UNPUBLISHED_MARKER = "<!-- skip: these reach PyPI for a package that is not published yet -->"

#: ``## [Unreleased]`` or ``## [0.1.0] - 2026-09-16``. The bracketed form is Keep a Changelog's, and the
#: date group is what distinguishes a section that describes a release from one that describes a plan.
_CHANGELOG_HEADING = re.compile(r"^##\s+\[(?P<version>[^\]]+)\](?:\s*-\s*(?P<date>\S+))?\s*$", re.MULTILINE)

#: What a reader of a red run needs to be told, once, in the first line.
_RELEASING_DEFECT = "the release workflow exists and is asserted, but nothing in this tree tells a person how to run it"
_CHANGELOG_DEFECT = "the repository publishes a version table and describes no version"


def _document(path: Path, requirement: str) -> str:
    """Read a release document, failing with the defect named rather than with a ``FileNotFoundError``.

    A fixture would do this too, and the ``workflow`` fixture above is one. The difference matters while
    the file is absent: a fixture that fails reports every test in the class as an *error*, and an error
    reads as "the suite is broken" where a failure reads as "the thing under test is missing". When a
    document is missing, the first line of the run should say which file and what that leaves undone.
    """
    assert path.is_file(), f"{requirement}: no document at {path}"
    return path.read_text()


class TestSomebodyCanActuallyPerformARelease:
    """AT-163 -- the release document, held to the workflow rather than to itself.

    The classes above assert that ``release-python.yml`` says what it must say. This one asserts that a
    person can follow it. Four jobs run on a tag and only the last one does anything irreversible,
    which means the cost of not knowing the order is paid exactly once, at the only moment it cannot be
    undone.

    Every assertion here reads its expectation out of the parsed workflow. A document that restates the
    workflow passes the day it is written and drifts silently afterwards.
    """

    def test_it_names_every_job_the_workflow_runs(self, workflow: dict[str, Any]) -> None:
        """AT-163 -- job names come from the YAML, so a fifth job fails here instead of being forgotten."""
        releasing = _document(RELEASING_PATH, _RELEASING_DEFECT)
        jobs = _jobs(workflow)
        missing = sorted(
            name for name, job in jobs.items() if name not in releasing and str(job.get("name", "")) not in releasing
        )

        assert missing == [], (
            f"the release document does not mention these jobs: {missing}. A reader following it would "
            f"not know they run, and one of them is the last gate before an upload that can only be yanked"
        )

    def test_it_names_the_tag_that_starts_a_release(self, workflow: dict[str, Any]) -> None:
        """AT-163 -- the prefix is read from the trigger, not from this file's own constant."""
        releasing = _document(RELEASING_PATH, _RELEASING_DEFECT)
        patterns = [str(tag) for tag in (_triggers(workflow).get("push") or {}).get("tags") or []]
        assert patterns, (
            "the workflow declares no tag trigger, which TestOnlyThePythonTagTriggersARelease should have caught first"
        )

        for pattern in patterns:
            prefix = pattern.rstrip("*")
            assert prefix in releasing, (
                f"the release document never mentions {prefix!r}, which is the only thing that starts a "
                f"release; a reader has no way to know what to tag"
            )

    def test_it_names_the_environment_the_upload_waits_on(self, workflow: dict[str, Any]) -> None:
        """AT-163 -- the protected environment is where a human approves, and it is a settings artifact.

        It is the one part of the release a reader cannot discover by reading the repository, because
        the environment and its required reviewers live in repository settings rather than in a file.
        A release document that omits it describes a process that stops without explanation.
        """
        releasing = _document(RELEASING_PATH, _RELEASING_DEFECT)
        environments = [
            job["environment"]["name"] if isinstance(job.get("environment"), dict) else job.get("environment")
            for job in _jobs(workflow).values()
            if job.get("environment")
        ]
        assert environments, (
            "no job binds an environment, which TestNothingHereIsALongLivedCredential should have caught first"
        )

        for environment in environments:
            assert str(environment) in releasing, (
                f"the release document never mentions the {environment!r} environment, where the release "
                f"waits for a human and where it stops if nobody is watching"
            )


class TestTheChangelogAndTheRepositoryAgreeAboutWhatExists:
    """AT-164 -- the changelog and the READMEs agree about whether a release exists.

    Both READMEs carry a marker saying the package is not on PyPI. That marker becomes false the moment
    the name is claimed, and the test makes it a gate: the changelog may not date a release while the
    repository says none has happened.
    """

    def test_nothing_is_dated_while_the_repository_says_nothing_is_published(self) -> None:
        """AT-164 -- the install-block marker and the changelog change on the same day or neither does.

        Both directions are asserted. While the marker is present no section may carry a date, and once
        it is gone at least one must, so the test fails whichever half of the pair is forgotten.
        """
        changelog = _document(CHANGELOG_PATH, _CHANGELOG_DEFECT)
        readmes = {
            "README.md": (REPO_ROOT / "README.md").read_text(),
            "python/README.md": (PROJECT_ROOT / "README.md").read_text(),
        }
        unpublished = {name for name, text in readmes.items() if UNPUBLISHED_MARKER in text}
        dated = {
            match.group("version"): match.group("date")
            for match in _CHANGELOG_HEADING.finditer(changelog)
            if match.group("date")
        }

        if unpublished:
            assert dated == {}, (
                f"{sorted(unpublished)} still say the package is not published, and the changelog dates "
                f"{dated} as released. One of the two is wrong, and a dated release nobody can install is "
                f"the more expensive way to be wrong"
            )
        else:
            assert dated, (
                "no README carries the unpublished marker any more, so the package is claimed on PyPI, "
                "and the changelog still dates nothing as released"
            )

    def test_a_source_download_carries_it(self) -> None:
        """AT-164 -- the sdist ships the changelog, on the same argument ``test_migration.py`` makes.

        A changelog that exists only on GitHub is read by people who were already going to find the
        repository. The reader it is written for is the one holding a source download and deciding
        whether to upgrade, and ``include`` is what decides whether they have it.
        """
        include = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text())["tool"]["hatch"]["build"]["targets"][
            "sdist"
        ]["include"]
        assert CHANGELOG_PATH.name in include, (
            f"sdist include is {include}, so a source download of this package contains no changelog and "
            f"its reader has no way to know what changed between the version they have and this one"
        )


class TestNoReleaseJobCanRunForSixHours:
    """AT-165 — the release workflow's half of the job time ceiling, with one job that is not like the others.

    ``TestNoJobCanRunForSixHours`` in ``test_ci.py`` carries the argument; the ceiling is imported from it
    rather than written twice, so the two workflows cannot drift onto different numbers.

    The job worth a sentence is ``publish``. It sits behind the ``pypi`` environment's required reviewers,
    and a budget looks like it would cut the approval off, but it does not. A job pending a deployment
    protection rule has not started, so ``timeout-minutes`` has not begun counting; GitHub cancels an
    unapproved run after thirty days on its own clock, and that is not a number this file can set. The
    budget here bounds the upload once somebody has approved it.
    """

    def test_every_job_declares_one(self, workflow: dict[str, Any]) -> None:
        """AT-165 — every release job, including the ones that run only after an approval."""
        undeclared = sorted(name for name, job in _jobs(workflow).items() if job.get("timeout-minutes") is None)
        assert undeclared == [], (
            f"these release jobs declare no timeout-minutes and so inherit GitHub's "
            f"{_DEFAULT_TIMEOUT_MINUTES}: {undeclared}. A hang here would hold a release open for hours "
            f"after a tag is pushed"
        )

    def test_none_of_them_is_the_default_in_disguise(self, workflow: dict[str, Any]) -> None:
        """AT-165 — the same ceiling, and none of these jobs has a cluster tier's excuse for needing it."""
        for name, job in _jobs(workflow).items():
            budget = job.get("timeout-minutes")
            assert isinstance(budget, int) and not isinstance(budget, bool), (
                f"release job {name!r} declares timeout-minutes {budget!r}, which YAML did not read as an integer"
            )
            assert 0 < budget <= _TIMEOUT_CEILING_MINUTES, (
                f"release job {name!r} budgets {budget} minutes against a ceiling of "
                f"{_TIMEOUT_CEILING_MINUTES}. Nothing here runs a cluster tier, so there is no job in this "
                f"workflow with a reason to approach it"
            )


#: A git object name. What makes a reference immutable is that it names the content rather than a place
#: the content currently sits.
_DIGEST = re.compile(r"\A[0-9a-f]{40}\Z")


class TestTheActionThatUploadsIsPinnedToContentRatherThanToAPlace:
    """``AT-170`` -- the actions in the job holding the upload credential are pinned to a digest.

    A reference such as ``pypa/gh-action-pypi-publish@release/v1`` is a branch: not a tag, not a digest.
    The publish action runs in the only
    job in the repository that raises ``id-token: write``, the token PyPI exchanges for an upload
    credential for ``strands-mongodb``, so whoever controls that branch controls what runs there and the
    blast radius is every install of this package.

    **This is not a repository-wide pinning policy, and must not become one.** MongoDB's own zizmor
    configuration is ``actions/*: ref-pin`` with ``mongodb-labs/drivers-github-tools/*: hash-pin``, so
    ``actions/checkout@v7`` throughout these workflows is correct by that standard and moving it to
    digests would be a deviation from it. PyMongo hash-pins this one action and ref-pins the rest. The
    scope of this gate is therefore the job holding the credential, not the file.

    **What a pin costs.** A digest does not update itself. Dependabot's ``github-actions`` updates keep it
    current, and the pin is worth less without them.
    """

    def test_the_publishing_credential_is_held_by_the_job_that_publishes(self, workflow: dict[str, Any]) -> None:
        """AT-170 -- the vacuity guard, and the premise the scope of this gate rests on.

        This required exactly one holder of ``id-token: write``. Several jobs hold it now, because
        signing and the SBOM authenticate to AWS the same way, so the premise has to be stated as what
        it always meant: the job that runs the publish action is a holder, and the pinning rule below
        applies to every holder rather than to one job that happened to be alone.
        """
        holders = {
            name for name, job in workflow["jobs"].items() if (job.get("permissions") or {}).get("id-token") == "write"
        }
        publishers = {name for name, job in workflow["jobs"].items() if _step_uses(job, PUBLISH_ACTION)}

        assert publishers, f"no job uses {PUBLISH_ACTION}, so this gate is guarding nothing"
        assert publishers <= holders, (
            f"{sorted(publishers - holders)} runs {PUBLISH_ACTION} without `id-token: write`, so it is "
            f"uploading with something other than a trusted-publishing token"
        )

    def test_every_action_it_runs_is_pinned_to_a_digest(self, workflow: dict[str, Any]) -> None:
        """AT-170 -- every action in the credential-holding job is pinned to a digest."""
        for name, job in workflow["jobs"].items():
            if (job.get("permissions") or {}).get("id-token") != "write":
                continue
            uses = [step["uses"] for step in job.get("steps") or [] if step.get("uses")]
            assert uses, f"job {name!r} holds the upload credential and runs no action, which cannot be right"
            unpinned = [reference for reference in uses if not _DIGEST.match(reference.partition("@")[2])]
            assert unpinned == [], (
                f"job {name!r} holds the credential PyPI exchanges for an upload token and runs {unpinned} "
                f"from a mutable reference. A branch or a tag can be moved; a digest names the content"
            )

    def test_the_reader_can_tell_a_digest_from_a_branch(self) -> None:
        """AT-170 -- the matcher, against the two references this repository actually uses."""
        assert _DIGEST.match("dc37677b2e1c63e2034f94d8a5b11f265b73ba33")
        assert not _DIGEST.match("release/v1")
        assert not _DIGEST.match("v7")
        assert not _DIGEST.match("v7.0.0")


class TestAnSbomShipsWhetherOrNotAVendorIsConfigured:
    """``AT-171`` -- the SBOM is generated on every release; only its augmentation is optional.

    Two different things live in the SBOM job. Generating a CycloneDX SBOM is ``cyclonedx-py`` reading
    the installed environment: no credential, no network service, no vendor. Augmenting it is SilkBomb
    talking to Kondukto, which needs an image from MongoDB's ECR and a Kondukto token, and which is
    therefore the part that waits on provisioning.

    Gating the whole job on the Kondukto variable fuses the two, and a release then ships no SBOM at
    all while the variable is unset -- which is the state the repository is in and expects to stay in
    for a while. Product Security owns Kondukto now and has indicated it may be deprecated, so "the
    variable is unset" is not reliably a short-lived condition and may outlive the tool.

    The dependency list is the part an SSDLC reviewer, a downstream consumer and a vulnerability scan
    all actually want, and it costs nothing. So it ships unconditionally, and the annotation arrives
    when the vendor does.
    """

    def test_generating_the_sbom_is_not_gated_on_the_vendor(self, workflow: dict[str, Any]) -> None:
        """AT-171 -- neither the job nor the generation step waits on ``KONDUKTO_SECRET_ID``."""
        jobs = _jobs(workflow)
        producers = {
            name: job
            for name, job in jobs.items()
            if any("cyclonedx-py" in str(step.get("run", "")) for step in _steps(job))
        }
        assert producers, "no job generates an SBOM, so no release can ship one"

        for name, job in producers.items():
            condition = str(job.get("if", ""))
            assert "KONDUKTO" not in condition, (
                f"job `{name}` generates the SBOM but is gated on {condition!r}: while that variable is "
                "unset the release ships no SBOM at all, and generating one needs no Kondukto"
            )
            for step in _steps(job):
                if "cyclonedx-py" in str(step.get("run", "")):
                    assert "KONDUKTO" not in str(step.get("if", "")), (
                        f"the generation step in `{name}` is gated on Kondukto; only the augmentation is"
                    )

    def test_the_augmentation_is_gated_so_an_unprovisioned_vendor_does_not_fail_the_release(
        self, workflow: dict[str, Any]
    ) -> None:
        """AT-171 -- every step that talks to SilkBomb or Kondukto tests the variable first.

        Ungating the job is only safe because of this. A SilkBomb step that ran with no token would
        fail the job, and a failing SBOM job after a successful publish is a red release for a reason
        nobody can act on.
        """
        jobs = _jobs(workflow)
        for name, job in jobs.items():
            for step in _steps(job):
                uses = str(step.get("uses", ""))
                if "abx-release-tools/actions/sbom" not in uses and "KONDUKTO_SECRET_ID" not in str(
                    step.get("with", "")
                ):
                    continue
                assert "KONDUKTO_SECRET_ID" in str(step.get("if", "")), (
                    f"step {step.get('name', uses)!r} in `{name}` needs Kondukto but does not test "
                    "`vars.KONDUKTO_SECRET_ID`, so an unprovisioned vendor fails a successful release"
                )


def _checks_out(job: dict[str, Any]) -> bool:
    """Whether ``job`` puts a working tree on the runner."""
    return bool(_step_uses(job, "actions/checkout"))


def _step_env(workflow: dict[str, Any], job: dict[str, Any], step: dict[str, Any]) -> dict[str, Any]:
    """The environment a step sees, with the nearer scope winning, as Actions resolves it."""
    merged: dict[str, Any] = {}
    for scope in (workflow.get("env"), job.get("env"), step.get("env")):
        if isinstance(scope, dict):
            merged.update(scope)
    return merged


class TestAJobThatChecksNothingOutStillRuns:
    """``AT-172`` -- the three things a checkout-less job silently depends on.

    Five jobs here never check out: they download an artifact, act on it, and upload the result.
    That is deliberate -- a job that signs a wheel has no use for a working tree, and a checkout it
    does not need is a credential and a cache surface it does not need either. But three pieces of
    this workflow's configuration quietly assume a checkout exists, and each of them fails at run
    time on a tag, which is the one trigger that cannot be rehearsed: there is no `workflow_dispatch`
    here, deliberately, so the first run of any of this is a real release of a real version.

    Every assertion below was written against a defect that was in the file, not against a
    hypothetical. None of them is about style.
    """

    def test_every_run_step_in_such_a_job_overrides_the_working_directory(self, workflow: dict[str, Any]) -> None:
        """AT-172 -- the workflow default is a directory that exists only in a checkout.

        ``defaults.run.working-directory: python`` is right for the jobs that build and test, and it
        is inherited by every ``run:`` step in the file, including those in jobs where ``python/``
        was never created. The runner fails such a step before the shell starts, so nothing in the
        script -- including a ``set -e`` trap or an ``if`` guard -- can recover from it.
        """
        default = ((workflow.get("defaults") or {}).get("run") or {}).get("working-directory")
        if not default:
            pytest.skip("no workflow-level working directory to inherit")

        for name, job in _jobs(workflow).items():
            if _checks_out(job):
                continue
            for step in _steps(job):
                if "run" not in step:
                    continue
                assert step.get("working-directory"), (
                    f"step {step.get('name', step['run'][:40])!r} in `{name}` runs a script in the inherited "
                    f"`{default}/`, but `{name}` checks nothing out, so that directory does not exist. "
                    f"Override it with `working-directory: ${{{{ github.workspace }}}}`"
                )

    def test_every_step_calling_gh_is_told_which_repository_it_is_in(self, workflow: dict[str, Any]) -> None:
        """AT-172 -- ``GH_TOKEN`` authenticates; it does not identify a repository.

        ``gh`` resolves the repository from a git remote. A token alone leaves it with nowhere to
        send the request, and it exits with `none of the git remotes configured for this repository
        point to a known GitHub host` -- after the release has already been published, because these
        jobs run downstream of ``publish``.

        Checked for every job rather than only the checkout-less ones: a checkout with
        ``persist-credentials: false`` still leaves a usable remote, so the inference would work, but
        it then depends on a flag set for an unrelated reason three steps earlier.
        """
        for name, job in _jobs(workflow).items():
            for step in _steps(job):
                script = str(step.get("run", ""))
                if not re.search(r"\bgh\s+\w", script):
                    continue
                env = _step_env(workflow, job, step)
                assert "GH_TOKEN" in env, f"step {step.get('name')!r} in `{name}` calls `gh` with no GH_TOKEN"
                assert "GH_REPO" in env, (
                    f"step {step.get('name')!r} in `{name}` calls `gh` but names no repository. Set "
                    "`GH_REPO: ${{ github.repository }}`; GH_TOKEN authenticates but does not point anywhere"
                )

    def test_every_job_that_writes_to_a_release_holds_the_permission_to(self, workflow: dict[str, Any]) -> None:
        """AT-172 -- declaring one scope sets every other to ``none``.

        A job that declares ``permissions: {id-token: write}`` for AWS has, by that act, given up the
        ``contents: write`` the ambient token would otherwise have carried. ``gh release upload``
        then fails with a 403 that reads like a token problem rather than a permissions block.
        """
        for name, job in _jobs(workflow).items():
            writes = [
                step
                for step in _steps(job)
                if re.search(r"\bgh\s+release\s+(create|upload|edit|delete)", str(step.get("run", "")))
            ]
            if not writes:
                continue
            granted = job.get("permissions")
            assert isinstance(granted, dict) and granted.get("contents") == "write", (
                f"`{name}` writes to a GitHub Release but its permissions are {granted!r}. Declaring any "
                "scope sets the rest to `none`, so `contents: write` has to be named explicitly"
            )


class TestTheSbomListsSomethingWorthReading:
    """``AT-173`` -- an SBOM of a package whose dependencies all live in extras.

    ``pyproject.toml`` declares ``dependencies = []`` on purpose: every runtime dependency belongs to
    the extra that needs it, so ``pip install strands-mongodb`` is metadata only. That choice has a
    consequence nobody looking at the SBOM job would guess: ``cyclonedx-py environment`` reports what
    is installed, so an SBOM built after a bare ``pip install .`` lists this package and nothing else.

    It is a valid CycloneDX document, it attaches to the release, every structural test passes, and it
    answers none of the questions an SBOM exists to answer. That is the worst failure available here,
    because it is the one that looks like success.
    """

    def test_the_premise_still_holds(self) -> None:
        """AT-173 -- the base install really is empty, which is the whole reason for the test below.

        If the dependencies ever move back out of the extras this assertion fails, and the next test
        becomes a style preference rather than a correctness one.
        """
        manifest = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text())
        assert manifest["project"]["dependencies"] == [], (
            "the base install now carries dependencies, so a bare `pip install .` would produce a "
            "populated SBOM; re-read the test below before changing it"
        )

    def test_the_project_is_installed_with_its_dependencies(self, workflow: dict[str, Any]) -> None:
        """AT-173 -- the generating job installs an extra, not the bare project."""
        for name, job in _jobs(workflow).items():
            for step in _steps(job):
                script = str(step.get("run", ""))
                if "cyclonedx-py" not in script:
                    continue
                installs = re.findall(
                    r"pip install[^\n]*?((?:'|\")?\.\[[a-z,]+\](?:'|\")?|(?<![\w.\[])\.$)", script, re.M
                )
                assert any("[" in found for found in installs), (
                    f"the SBOM step in `{name}` does not install the project with an extra. With "
                    "`dependencies = []` the resulting SBOM lists only strands-mongodb itself"
                )


class TestAPrereleaseIsNotTheLatestRelease:
    """``AT-174`` -- PEP 440 means nothing to GitHub.

    ``python-v1.0.0.dev1`` is a prerelease to PyPI, which hides it from a plain ``pip install``. The
    GitHub Release created from the same tag carries no such notion: unless it is marked, GitHub
    lists it as the repository's latest release, above the last stable one, and that is what the
    README badge, the releases page and anything reading the API will report.
    """

    @staticmethod
    def _creating_step(workflow: dict[str, Any]) -> tuple[str, str]:
        """The one step that creates the Release, and the job it lives in."""
        found = [
            (name, str(step.get("run", "")))
            for name, job in _jobs(workflow).items()
            for step in _steps(job)
            if "gh release create" in str(step.get("run", ""))
        ]
        assert found, "nothing creates a GitHub Release, so the signatures have nowhere to attach"
        assert len(found) == 1, f"{len(found)} steps create a Release; this test assumes one"
        return found[0]

    @pytest.mark.parametrize(
        ("tag", "marked"),
        [
            ("python-v1.0.0.dev1", True),
            ("python-v1.0.0rc1", True),
            ("python-v1.0.0a2", True),
            ("python-v1.0.0.post1", True),
            ("python-v1.0.0", False),
            ("python-v0.1.0", False),
            ("python-v10.20.30", False),
        ],
    )
    def test_it_marks_exactly_the_versions_that_are_not_final(
        self, workflow: dict[str, Any], tmp_path: Path, tag: str, marked: bool
    ) -> None:
        """AT-174 -- the script is run, not read, because the decision is a shell glob.

        Asserting that the text contains ``--prerelease`` proves nothing: the flag can be computed
        into a variable that is never passed on, which is a single missing line and exactly the shape
        of mistake a substring check cannot see. So the step's own script runs here against a
        recording stand-in for ``gh``, under the same ``set -euo pipefail`` the runner uses, and the
        assertion is about the arguments ``gh release create`` was actually handed.
        """
        _, script = self._creating_step(workflow)

        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        # `view` exits non-zero so the script takes the create branch; everything else records and
        # succeeds. Written to a file rather than echoed, so an argument containing a space survives.
        (bin_dir / "gh").write_text(
            "#!/usr/bin/env bash\n"
            'if [ "$1 $2" = "release view" ]; then exit 1; fi\n'
            'printf "%s\\n" "$@" >> "$RECORD"\n'
            'printf "%s\\n" "=== end of call" >> "$RECORD"\n'
        )
        (bin_dir / "gh").chmod(0o755)

        record = tmp_path / "calls"
        (tmp_path / "release").mkdir()
        result = subprocess.run(  # noqa: S603 - a fixed interpreter on a script this repository owns
            ["bash", "-c", script],
            cwd=tmp_path,
            env={
                "PATH": f"{bin_dir}:/usr/bin:/bin",
                "RECORD": str(record),
                "TAG": tag,
                "GH_TOKEN": "not-a-token",
                "GH_REPO": "mongodb/strands-mongodb",
            },
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"the step failed for {tag}:\n{result.stderr}"

        calls = [call.splitlines() for call in record.read_text().split("=== end of call\n") if call.strip()]
        creates = [call for call in calls if call[:2] == ["release", "create"]]
        assert len(creates) == 1, f"expected one `gh release create` for {tag}, recorded {calls}"

        assert ("--prerelease" in creates[0]) is marked, (
            f"`gh release create` for {tag} was handed {creates[0]}. A version that is not a final "
            f"release must be marked, or GitHub lists it as this repository's latest release"
        )


#: The abx-release-tools actions the trace job is built from, named without the pin so the assertions
#: survive a repin. ``TestTheActionThatUploadsIsPinnedToContentRatherThanToAPlace`` owns the pin.
SETUP_ACTION = "mongodb-labs/abx-release-tools/actions/setup"
AUTHORIZED_PUB_ACTION = "mongodb-labs/abx-release-tools/actions/authorized-pub"
UPLOAD_S3_ACTION = "mongodb-labs/abx-release-tools/actions/upload-s3-assets"

#: The asset name ``sbom-publish`` attaches, augmented or not, and the key it is stored under in S3.
SBOM_ASSET = "cyclonedx.sbom.json"

#: ``gh release upload "$TAG" a b \`` and its continuation lines, up to the end of the command.
_RELEASE_UPLOAD = re.compile(r"\bgh\s+release\s+upload\s+((?:[^\n]*\\\n)*[^\n]*)")


def _attached_to_the_release(workflow: dict[str, Any]) -> dict[str, str]:
    """Every file any job hands ``gh release upload``, as ``{base name or glob: job}``.

    Read out of the scripts rather than listed here, so that an asset added to the Release is an asset
    the trace report has to answer for. Flags start with ``-``, the tag is ``"$TAG"``, and every file is
    passed as a path under the directory the job assembled it in, which is what tells the two apart.
    """
    attached: dict[str, str] = {}
    for name, job in _jobs(workflow).items():
        for step in _steps(job):
            for command in _RELEASE_UPLOAD.finditer(str(step.get("run", ""))):
                for token in command.group(1).replace("\\\n", " ").split():
                    if "/" in token and not token.startswith("-"):
                        attached[PurePosixPath(token).name] = name
    return attached


class TestTheTraceRecordCoversEverythingTheReleasePublished:
    """``AT-245`` -- the authorized-publication report names every file a consumer can download.

    The report is the release's trace record: who published what, from which run, and the checksum of
    each file. The signing guide asks for the signatures and the checksum file to be in it beside the
    artifacts, because the record exists so that a file found in the wild can be matched to the release
    that produced it, and a ``.sig`` or an SBOM is as findable as a wheel.

    The comparison is against the files the workflow actually attaches to the GitHub Release, not a list
    written in this test, so the report cannot fall behind the Release without a red run.
    """

    @staticmethod
    def _trace(workflow: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        """The one job that writes the report."""
        jobs = _jobs(workflow)
        found = [name for name, job in jobs.items() if _step_uses(job, AUTHORIZED_PUB_ACTION)]
        assert len(found) == 1, f"{len(found)} jobs write an authorized-publication report; expected one"
        return found[0], jobs[found[0]]

    @staticmethod
    def _reported(job: dict[str, Any]) -> list[str]:
        """The patterns handed to ``authorized-pub``, one per line, as the action reads them."""
        steps = _step_uses(job, AUTHORIZED_PUB_ACTION)
        assert len(steps) == 1, f"{len(steps)} authorized-pub steps in the trace job; expected one"
        filenames = str((steps[0].get("with") or {}).get("filenames", ""))
        return [line.strip() for line in filenames.splitlines() if line.strip()]

    def test_the_report_names_every_file_the_release_attaches(self, workflow: dict[str, Any]) -> None:
        """AT-245 -- the two sets are equal, so neither can grow without the other."""
        _, job = self._trace(workflow)
        reported = set(self._reported(job))
        attached = _attached_to_the_release(workflow)

        assert attached, "nothing attaches a file to the GitHub Release, so there is nothing to compare against"
        assert reported == set(attached), (
            f"the Release carries {sorted(set(attached) - reported)} that the report does not record, and "
            f"the report records {sorted(reported - set(attached))} that the Release does not carry"
        )

    def test_the_signatures_and_the_checksums_are_in_it(self, workflow: dict[str, Any]) -> None:
        """AT-245 -- the guide's requirement, stated directly, in case the Release ever loses them too."""
        _, job = self._trace(workflow)
        required = {"*.whl.sig", "*.tar.gz.sig", "SHA256SUMS", "SHA256SUMS.sig", SBOM_ASSET}
        missing = required - set(self._reported(job))
        assert not missing, f"the authorized-publication report does not record {sorted(missing)}"

    def test_files_named_rather_than_paths_on_a_runner(self, workflow: dict[str, Any]) -> None:
        """AT-245 -- ``authorized-pub`` records each path exactly as it is handed.

        ``dist/strands_mongodb-1.0.0.tar.gz`` would name a directory on a runner that no longer exists. The
        record is read by someone holding a downloaded file, and the file they hold has a base name. So
        the patterns carry no directory, and the downloads land where the patterns are resolved: the
        workspace root, which is where a composite action's steps start.
        """
        name, job = self._trace(workflow)
        with_directory = [pattern for pattern in self._reported(job) if "/" in pattern]
        assert not with_directory, f"the report in `{name}` records runner paths, not file names: {with_directory}"

        for step in _steps(job):
            if not str(step.get("uses", "")).startswith(DOWNLOAD_ACTION):
                continue
            path = (step.get("with") or {}).get("path")
            assert path in (None, ".", "${{ github.workspace }}"), (
                f"`{name}` downloads {step['with'].get('name')!r} into {path!r}, but the report's patterns "
                f"are resolved in the workspace root and would match nothing there"
            )

    def test_every_artifact_it_reads_is_finished_before_it_starts(self, workflow: dict[str, Any]) -> None:
        """AT-245 -- an artifact exists once the job that uploads it has finished, and not before.

        A download from a job that is not an ancestor races it, and on the run where the trace job wins
        the race it receives an empty directory and fails after the upload to PyPI has happened.
        """
        jobs = _jobs(workflow)
        name, job = self._trace(workflow)
        producers = {
            (step.get("with") or {}).get("name"): producer
            for producer, other in jobs.items()
            for step in _steps(other)
            if str(step.get("uses", "")).startswith(UPLOAD_ACTION)
        }
        ancestors = _ancestors(jobs, name)
        downloads = [
            (step.get("with") or {}).get("name")
            for step in _steps(job)
            if str(step.get("uses", "")).startswith(DOWNLOAD_ACTION)
        ]

        assert downloads, f"`{name}` downloads nothing, so its report could only say `No published artifacts.`"
        for artifact in downloads:
            assert producers.get(artifact) in ancestors, (
                f"`{name}` downloads {artifact!r}, written by `{producers.get(artifact)}`, which it does not "
                f"wait for (it needs {sorted(ancestors)})"
            )

    def test_the_sbom_recorded_is_the_one_the_release_carries(self, workflow: dict[str, Any]) -> None:
        """AT-245 -- the attached SBOM may be augmented, so the generated one is not a substitute.

        ``sbom-publish`` replaces the generated document with SilkBomb's output when Kondukto is
        configured. A trace job reading ``python-sbom`` would then record, and store, a checksum for a
        file nobody can download.
        """
        jobs = _jobs(workflow)
        name, job = self._trace(workflow)
        attaching = _attached_to_the_release(workflow).get(SBOM_ASSET)
        assert attaching, f"no job attaches {SBOM_ASSET} to the Release"

        handed_on = {
            str((step.get("with") or {}).get("name"))
            for step in _steps(jobs[attaching])
            if str(step.get("uses", "")).startswith(UPLOAD_ACTION)
            and PurePosixPath(str((step.get("with") or {}).get("path", ""))).name == SBOM_ASSET
        }
        downloaded = {
            str((step.get("with") or {}).get("name"))
            for step in _steps(job)
            if str(step.get("uses", "")).startswith(DOWNLOAD_ACTION)
        }
        assert handed_on & downloaded, (
            f"`{attaching}` attaches {SBOM_ASSET} but `{name}` never downloads that file; it uploads "
            f"{sorted(handed_on) or 'nothing'} and `{name}` downloads {sorted(downloaded)}"
        )

    def test_the_report_and_the_sbom_both_reach_the_bucket(self, workflow: dict[str, Any]) -> None:
        """AT-245 -- the layout the other ABX packages use: the report and the SBOM, side by side.

        ``upload-s3-assets`` uploads what is in ``$S3_ASSETS``, which ``setup`` creates and
        ``authorized-pub`` writes the report into. The SBOM is downloaded elsewhere, so a step has to put
        it there, after ``setup`` has made the directory and before the upload reads it.
        """
        name, job = self._trace(workflow)
        steps = _steps(job)

        def first(predicate: Any, what: str) -> int:
            found = [index for index, step in enumerate(steps) if predicate(step)]
            assert found, f"`{name}` has no step that {what}"
            return found[0]

        setup = first(lambda step: str(step.get("uses", "")).startswith(SETUP_ACTION), "runs setup")
        staged = first(
            lambda step: SBOM_ASSET in str(step.get("run", "")) and "S3_ASSETS" in str(step.get("run", "")),
            f"copies {SBOM_ASSET} into $S3_ASSETS",
        )
        upload = first(lambda step: str(step.get("uses", "")).startswith(UPLOAD_S3_ACTION), "uploads to S3")
        assert setup < staged < upload, (
            f"in `{name}` setup is step {setup}, the SBOM is staged at {staged} and the upload is {upload}; "
            "the directory has to exist before the copy and hold the SBOM before the upload"
        )

        filenames = str((steps[upload].get("with") or {}).get("filenames", "*")).split()
        assert "*" in filenames or {"authorized-publication.txt", SBOM_ASSET} <= set(filenames), (
            f"the S3 upload in `{name}` is limited to {filenames}, which leaves the report or the SBOM behind"
        )


class TestTheSecretSuppliesTheBucketTheTraceJobWritesTo:
    """``AT-247`` -- ``trace`` takes its bucket from the release secret and does not set it itself.

    ``upload-s3-assets`` writes to ``$AWS_BUCKET``, which ``setup`` fills from ``RELEASE_ASSETS_BUCKET``.
    The release secret already carries that key, and ``setup`` loads the secret into the environment. A
    step that sets ``RELEASE_ASSETS_BUCKET`` first makes the secrets action fail with "The environment name
    'RELEASE_ASSETS_BUCKET' is already in use", which is how ``python-v1.0.0rc1`` failed after it was on PyPI.
    """

    def test_the_setup_step_does_not_set_the_bucket(self, workflow: dict[str, Any]) -> None:
        """AT-247 -- the secret owns ``RELEASE_ASSETS_BUCKET``; setting it here collides with it."""
        jobs = _jobs(workflow)
        name, job = TestTheTraceRecordCoversEverythingTheReleasePublished._trace(workflow)

        setups = _step_uses(job, SETUP_ACTION)
        assert len(setups) == 1, f"{len(setups)} setup steps in `{name}`; expected one"
        env = _step_env(workflow, jobs[name], setups[0])
        assert "RELEASE_ASSETS_BUCKET" not in env, (
            f"`{name}` sets RELEASE_ASSETS_BUCKET before `setup` loads the release secret, which already "
            f"carries it, so the secrets action fails with 'environment name is already in use'"
        )


#: What ``cyclonedx-py environment --pyproject`` writes for this package, cut down to the parts the
#: step under test touches or must not touch. The root has no version and no purl because
#: ``pyproject.toml`` declares the version ``dynamic``, and the tool reads that file statically.
_GENERATED_SBOM: dict[str, Any] = {
    "bomFormat": "CycloneDX",
    "specVersion": "1.6",
    "metadata": {"component": {"bom-ref": "root-component", "name": "strands-mongodb", "type": "library"}},
    "components": [
        {
            "bom-ref": "pymongo==4.15.0",
            "name": "pymongo",
            "purl": "pkg:pypi/pymongo@4.15.0",
            "type": "library",
            "version": "4.15.0",
        }
    ],
    "dependencies": [{"ref": "pymongo==4.15.0"}, {"ref": "root-component"}],
}


class TestTheSbomSaysWhichReleaseItDescribes:
    """``AT-246`` -- the SBOM's root component carries the released version and its package URL.

    ``--pyproject`` makes this package the root component, read from ``pyproject.toml``, where the
    version is ``dynamic`` because hatch-vcs derives it from the tag. ``cyclonedx-py`` has no option to
    supply one, so without a step after generation the root names no version and no ``purl``. The
    document then lists every dependency correctly and cannot say which release it is the SBOM of,
    which is the one question a scanner matching it to a vulnerable version asks first.
    """

    @staticmethod
    def _naming_step(workflow: dict[str, Any]) -> tuple[str, int, str]:
        """The step that names the root, its job, and its index there."""
        found = [
            (name, index, str(step.get("run", "")))
            for name, job in _jobs(workflow).items()
            for index, step in enumerate(_steps(job))
            if "pkg:pypi/" in str(step.get("run", ""))
        ]
        assert len(found) == 1, f"{len(found)} steps write a package URL into the SBOM; expected one"
        return found[0]

    @staticmethod
    def _run(script: str, tmp_path: Path, installed: str) -> subprocess.CompletedProcess[str]:
        """Run the step against a generated SBOM and an environment with ``installed`` in it.

        ``$SBOM_ENV/bin/python`` is the interpreter the project was installed into, so a stand-in for it
        reports the version. ``python`` is the runner's own, which here is this interpreter.
        """
        (tmp_path / "sbom.json").write_text(json.dumps(_GENERATED_SBOM, indent=2))
        env_bin = tmp_path / "sbom-env" / "bin"
        env_bin.mkdir(parents=True)
        (env_bin / "python").write_text(f"#!/usr/bin/env bash\nprintf '%s\\n' {installed!r}\n")
        (env_bin / "python").chmod(0o755)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        (bin_dir / "python").write_text(f'#!/usr/bin/env bash\nexec {sys.executable!r} "$@"\n')
        (bin_dir / "python").chmod(0o755)

        return subprocess.run(  # noqa: S603 - a fixed interpreter on a script this repository owns
            ["bash", "-c", script],
            cwd=tmp_path,
            env={"PATH": f"{bin_dir}:/usr/bin:/bin", "SBOM_ENV": str(tmp_path / "sbom-env")},
            capture_output=True,
            text=True,
        )

    def test_it_runs_after_generation_in_the_job_that_generates(self, workflow: dict[str, Any]) -> None:
        """AT-246 -- before the upload, so the artifact every later job reads is the named one."""
        name, index, _ = self._naming_step(workflow)
        steps = _steps(_jobs(workflow)[name])
        generated = [i for i, step in enumerate(steps) if "cyclonedx-py" in str(step.get("run", ""))]
        uploaded = [i for i, step in enumerate(steps) if str(step.get("uses", "")).startswith(UPLOAD_ACTION)]
        assert generated and uploaded, f"`{name}` names the root but does not both generate and upload the SBOM"
        assert generated[0] < index < uploaded[0], (
            f"in `{name}` the SBOM is generated at step {generated[0]}, named at {index} and uploaded at "
            f"{uploaded[0]}; naming it anywhere else names a file nobody reads"
        )

    @pytest.mark.parametrize("version", ["1.0.0", "1.0.0rc1", "0.1.0.dev1"])
    def test_the_root_names_the_version_that_was_installed(
        self, workflow: dict[str, Any], tmp_path: Path, version: str
    ) -> None:
        """AT-246 -- the script is run, not read, against the shape ``cyclonedx-py`` writes."""
        _, _, script = self._naming_step(workflow)
        result = self._run(script, tmp_path, version)
        assert result.returncode == 0, f"the step failed for {version}:\n{result.stderr}"

        bom = json.loads((tmp_path / "sbom.json").read_text())
        root = bom["metadata"]["component"]
        assert root.get("version") == version
        assert root.get("purl") == f"pkg:pypi/strands-mongodb@{version}"

    def test_nothing_but_the_root_is_rewritten(self, workflow: dict[str, Any], tmp_path: Path) -> None:
        """AT-246 -- ``bom-ref`` is what the dependency graph points at, so it must not move."""
        _, _, script = self._naming_step(workflow)
        result = self._run(script, tmp_path, "1.0.0")
        assert result.returncode == 0, result.stderr

        bom = json.loads((tmp_path / "sbom.json").read_text())
        root = bom["metadata"].pop("component")
        expected = json.loads(json.dumps(_GENERATED_SBOM))
        expected_root = expected["metadata"].pop("component")
        assert bom == expected, "the step changed something other than the root component"
        assert {k: v for k, v in root.items() if k not in ("version", "purl")} == expected_root

    def test_a_version_not_built_from_the_tag_is_refused(self, workflow: dict[str, Any], tmp_path: Path) -> None:
        """AT-246 -- a local segment is what hatch-vcs produces when it cannot see the tag.

        ``fetch-depth: 0`` is what prevents it, and it is one line in a checkout block. An SBOM filed
        under ``1.0.1.dev3+g1a2b3c4`` would describe a version that was never published.
        """
        _, _, script = self._naming_step(workflow)
        result = self._run(script, tmp_path, "1.0.1.dev3+g1a2b3c4")
        assert result.returncode != 0, "the step accepted a version that hatch-vcs derived without the tag"
