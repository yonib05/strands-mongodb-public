"""The CI configuration, asserted by reading it, because nothing in this suite can run it.

There is no tier here and no network: a workflow is a YAML document on disk, so these are unit-tier tests
that read it the way ``test_packaging.py`` reads ``pyproject.toml``.

``TestTheTriggerWatchesEverythingTheSuiteReads`` reads in the opposite direction. The others ask what the
workflow says; it asks what this suite reads, and then whether the workflow's path filters cover the answer.
That answer is not a list held here. It is walked out of the test modules, because a file joins it the moment
somebody writes a ``Path`` expression naming it, and nothing about writing one prompts opening a workflow.

**What this file cannot tell you.** It asserts the workflow says what it should say. Whether GitHub then
runs it, whether a runner has ``hatch``, and whether the matrix resolves are all unobservable from here; a
pull request's own checks answer those.

What it does catch is a gate that is described and present in no file. A workflow asserted by tests cannot
go missing quietly.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path
from typing import Any, Final

import pytest
import yaml
from conftest import ChecklistGate

# Imported rather than reimplemented, for the reason its own docstring gives: "was this run narrowed?" has
# one right answer, and a copy of it drifts the first time pytest grows another selection flag.
from test_gate import _narrowing

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised only on the 3.10 floor
    # `tomli` is the parser `tomllib` was adopted from, and 2.x is the API `tomllib` shipped, so the
    # alias makes the two interchangeable and every caller below reads one name. It is a dev dependency
    # declared without a version marker on purpose; `pyproject.toml` says why, and the reason is mypy
    # rather than this branch.
    import tomli as tomllib

# tests/ -> python/ -> the repository root, which is where `.github/` belongs.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = PROJECT_ROOT.parent
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "ci-python.yml"
PYPROJECT_PATH = PROJECT_ROOT / "pyproject.toml"

#: Every directory ``pyproject.toml``'s ``files`` key hands to mypy, which is also everything the matrix's
#: oldest interpreter has to be able to compile.
SOURCE_ROOTS = ("src", "tests", "scripts", "examples")

#: The comprehension expressions. A ``comprehension`` node is the ``for`` clause inside one of these, and its
#: ``is_async`` flag is what ``async for`` sets.
_COMPREHENSION_TYPES = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)

#: The weekly canary slot the Strands extension template ships
#: (``extension-template/.github/workflows/ci-python.yml``). Kept identical rather than moved to a
#: quieter hour: the point of matching is that a maintainer who knows the template knows this file.
CANARY_CRON = "0 6 * * 1"

#: The two conformance checks the canary runs against the newest SDK, one per protocol. Written as data
#: here, never in a docstring in this file: the gate in ``conftest.py`` indexes ids out of docstrings, so an
#: id in one of these would register a test about YAML as a carrier of a protocol check.
PROTOCOL_CHECK_IDS = ("AT-034", "AT-052")


@pytest.fixture(scope="module")
def workflow() -> dict[str, Any]:
    """The parsed workflow.

    Fails rather than skips when the file is absent, which is the whole point: absence is the defect these
    tests catch, and a skip would report the same green as a passing gate.
    """
    assert WORKFLOW_PATH.is_file(), f"no CI configuration at {WORKFLOW_PATH}"
    parsed = yaml.safe_load(WORKFLOW_PATH.read_text())
    assert isinstance(parsed, dict), "the workflow did not parse as a mapping"
    return parsed


def _run_blocks(node: Any) -> list[str]:
    """Every ``run:`` string anywhere in the document, found by walking rather than by regex.

    A regex over the raw text would also match the word inside a comment or a step name, and the claims
    below are about what executes.
    """
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "run" and isinstance(value, str):
                found.append(value)
            else:
                found.extend(_run_blocks(value))
    elif isinstance(node, list):
        for item in node:
            found.extend(_run_blocks(item))
    return found


def _values_under(node: Any, wanted: str) -> list[str]:
    """Every string value stored under ``wanted``, at any depth."""
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == wanted:
                if isinstance(value, str):
                    found.append(value)
                elif isinstance(value, dict):
                    found.extend(str(item) for item in value.values())
            found.extend(_values_under(value, wanted))
    elif isinstance(node, list):
        for item in node:
            found.extend(_values_under(item, wanted))
    return found


def _all_strings(node: Any) -> list[str]:
    """Every string anywhere in the document, keys included.

    Used instead of reading the raw text where the claim is about the whole file, so that a word inside a
    ``#`` comment cannot fail a test about what the workflow does.
    """
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(key, str):
                found.append(key)
            found.extend(_all_strings(value))
    elif isinstance(node, list):
        for item in node:
            found.extend(_all_strings(item))
    elif isinstance(node, str):
        found.append(node)
    return found


def _triggers(workflow: dict[str, Any]) -> dict[str, Any]:
    """The ``on:`` block, looked up under both spellings it can arrive as.

    YAML 1.1 resolves a bare ``on`` key to the boolean ``True``, so ``workflow["on"]`` raises ``KeyError``
    against an idiomatic workflow file. GitHub's own parser has the same heritage and reads the key as the
    trigger name anyway, so the file keeps the unquoted spelling every other workflow uses and the quirk is
    absorbed here. Worth a helper rather than a one-line ``get``: the failure it prevents is a test that
    looks broken while the workflow is correct.
    """
    for key in ("on", True):
        if key in workflow:
            block = workflow[key]
            assert isinstance(block, dict), f"the triggers parsed as {type(block).__name__}, not a mapping"
            return block
    raise AssertionError(f"the workflow declares no triggers; its keys are {sorted(map(str, workflow))}")


def _pyproject() -> dict[str, Any]:
    """The manifest, parsed.

    Returns:
        The parsed document.
    """
    return tomllib.loads(PYPROJECT_PATH.read_text())


#: Every module the suite collects, walked for the paths it names. ``conftest.py`` is included: it reads
#: ``.env`` from two locations, and one of them is above the package directory.
_TEST_MODULES = sorted(Path(__file__).resolve().parent.glob("*.py"))

#: The prefix both change triggers watch. A path under it needs nothing from
#: ``TestTheTriggerWatchesEverythingTheSuiteReads``; a path outside it is what that class is about.
_PACKAGE_DIRECTORY = "python"

#: Paths outside ``python/`` the walk is known to find today, checked as a subset of what it returns so
#: that a walk which silently resolved nothing cannot pass as a clean result. Not an equality: adding a
#: read should fail the test below, which demands the trigger be extended, rather than this one.
_READ_AT_LEAST = (
    ".github/workflows/ci-python.yml",
    ".github/workflows/release-python.yml",
    ".github/dependabot.yml",
    ".github/workflows/zizmor.yml",
    ".github/zizmor.yml",
    "AGENTS.md",
    "CONTRIBUTING.md",
    ".gitignore",
)


def _glob_to_regex(pattern: str) -> str:
    """One GitHub path filter, as the regular expression it stands for.

    Two wildcards with different reach, which is the whole reason this is not ``fnmatch``: ``*`` stops at a
    separator and ``**`` crosses them, so ``python/*`` and ``python/**`` are different filters and only the
    second one watches ``python/tests/test_ci.py``.
    """
    out: list[str] = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            crosses = pattern[index + 1 : index + 2] == "*"
            out.append(".*" if crosses else "[^/]*")
            index += 2 if crosses else 1
        elif char == "?":
            out.append("[^/]")
            index += 1
        else:
            out.append(re.escape(char))
            index += 1
    return "".join(out)


def _watched(path: str, patterns: list[str]) -> bool:
    """Whether a trigger declaring ``patterns`` runs on a change to ``path``.

    A directory is asked about through a probe child rather than about itself, because a filter is written
    about files: ``docs/**`` matches ``docs/a.md`` and does not match the string ``docs``. Anything the
    walk names that is not a directory on disk is asked about directly.
    """
    probed = f"{path}/a-file-underneath" if (REPO_ROOT / path).is_dir() else path
    return any(re.fullmatch(_glob_to_regex(pattern), probed) for pattern in patterns)


def _paths_named_by(module: Path) -> set[str]:
    """Every repository-relative path one test module names, resolved from its syntax rather than run.

    The module is parsed, its module-level names are resolved to paths, and every complete ``/`` chain
    anywhere in it is evaluated against them. Four forms carry all of it: ``Path(__file__)``, ``.resolve()``,
    ``.parent``, and ``/`` with a string on the right.

    Two results are dropped rather than returned, and both are dropped because no trigger could watch them.
    A chain that walks above the repository root, as ``test_migration.py`` does to reach a checkout beside
    this one, resolves to nothing. So does the root itself, which is a directory a name is built from and not a
    file anything reads.

    Returns:
        Repository-relative paths, slash-separated, with no leading slash.
    """
    tree = ast.parse(module.read_text())
    here = (_PACKAGE_DIRECTORY, "tests", module.name)
    known: dict[str, tuple[str, ...] | None] = {}

    def evaluate(node: ast.AST) -> tuple[str, ...] | None:
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            left = evaluate(node.left)
            right = node.right
            if left is None or not isinstance(right, ast.Constant) or not isinstance(right.value, str):
                return None
            return left + tuple(part for part in right.value.split("/") if part)
        if isinstance(node, ast.Attribute) and node.attr == "parent":
            base = evaluate(node.value)
            return None if not base else base[:-1]
        if isinstance(node, ast.Call):
            called = node.func
            if isinstance(called, ast.Attribute) and called.attr == "resolve":
                return evaluate(called.value)
            is_this_file = (
                isinstance(called, ast.Name)
                and called.id == "Path"
                and len(node.args) == 1
                and isinstance(node.args[0], ast.Name)
                and node.args[0].id == "__file__"
            )
            return here if is_this_file else None
        if isinstance(node, ast.Name):
            return known.get(node.id)
        return None

    for statement in tree.body:
        if isinstance(statement, ast.Assign):
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    known[target.id] = evaluate(statement.value)
        elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            known[statement.target.id] = evaluate(statement.value) if statement.value else None

    chains = [node for node in ast.walk(tree) if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div)]
    # The left operand of a longer chain is a prefix of it. `_ROOT / ".github"` is a step towards a file
    # rather than a path anything opens, and demanding the trigger watch `.github` would be a different
    # requirement from the one this module enforces.
    partial = {id(node.left) for node in chains}
    resolved = {evaluate(node) for node in chains if id(node) not in partial}
    return {"/".join(parts) for parts in resolved if parts}


def _paths_outside_the_package() -> set[str]:
    """Every path the suite names that ``python/**`` does not already cover.

    One exemption, and it is derived rather than listed: a path ``.gitignore`` accounts for cannot be in a
    commit, so no change to it can trigger anything. ``conftest.py`` names ``.env`` beside the repository
    root, and a contributor creates that file or does not.
    """
    ignored = (REPO_ROOT / ".gitignore").read_text()
    named: set[str] = set()
    for module in _TEST_MODULES:
        named |= _paths_named_by(module)
    return {path for path in named if path.split("/")[0] != _PACKAGE_DIRECTORY and Path(path).name not in ignored}


#: The triggers only somebody with write access to this repository can cause. An allowlist rather than a
#: list of the dangerous ones, so a trigger nobody has thought about counts as reachable by a stranger
#: until somebody decides otherwise. ``push`` and ``workflow_dispatch`` both require write access;
#: ``schedule`` is pulled by a clock and by no party at all.
TRIGGERS_NEEDING_WRITE_ACCESS = frozenset({"push", "schedule", "workflow_dispatch"})

#: The triggers a change arrives on. A job gated off both of these does not gate a merge, and a job gated
#: on either of them runs on somebody's commit rather than on a decision to run it.
CHANGE_TRIGGERS = frozenset({"pull_request", "push"})

#: One comparison of ``github.event_name`` against a quoted event name. The whole grammar this workflow
#: uses, joined by ``||``; anything else is refused rather than guessed at.
_EVENT_COMPARISON = re.compile(r"github\.event_name\s*(==|!=)\s*'([a-z_]+)'\Z")


def _admitted_events(condition: str | None, triggers: frozenset[str]) -> frozenset[str]:
    """Which of the declared triggers actually reach a job carrying this ``if:`` expression.

    An interpreter rather than a string comparison, because that is the question every caller below has.
    A literal can only answer "is this condition still spelled the way somebody spelled it when they
    wrote the test down", which is a different question with the same green.

    Refuses what it cannot read. A condition outside the grammar raises here instead of being treated as
    reachable, because an unread condition is exactly the case where a wrong answer is most expensive:
    the two readings differ by whether a secret-holding job is open to a fork.
    """
    if condition is None:
        return triggers

    admitted: set[str] = set()
    for term in str(condition).split("||"):
        match = _EVENT_COMPARISON.fullmatch(term.strip())
        assert match is not None, (
            f"this reader does not understand {term.strip()!r} in {condition!r}. Extend it rather than "
            "letting a condition nothing reads count as reachable"
        )
        operator, event = match.groups()
        admitted |= {t for t in triggers if (t == event) == (operator == "==")}
    return frozenset(admitted)


#: One ``${{ ... }}`` interpolation. The two concurrency keys are the only place this workflow computes a
#: value instead of stating one, so the grammar below stays as small as they are.
_INTERPOLATION = re.compile(r"\$\{\{(.+?)\}\}")

#: A context read: ``github.`` and a dotted path. The paths this workflow reads are a closed set, and one
#: it does not read is refused rather than rendered as the empty string -- an unknown key quietly becoming
#: "" is precisely how a group expression collapses two events into one group with nobody the wiser.
_CONTEXT_READ = re.compile(r"github\.([a-z_.]+)\Z")

#: ``github.x == 'literal'``, the only comparison either concurrency key performs.
_CONTEXT_EQUALITY = re.compile(r"github\.([a-z_.]+)\s*==\s*'([a-z_]+)'\Z")


def _context_read(term: str, context: dict[str, str]) -> str:
    """One ``github.x`` lookup, refusing a key this reader holds no value for."""
    match = _CONTEXT_READ.fullmatch(term.strip())
    assert match is not None, (
        f"this reader does not understand {term.strip()!r}. Extend it rather than letting an expression "
        "nothing reads decide which runs share a group"
    )
    key = match.group(1)
    assert key in context, f"{term.strip()!r} reads a context key this reader has no value for: {sorted(context)}"
    return context[key]


def _render(template: object, context: dict[str, str]) -> str:
    """Render a workflow expression against one run's context.

    The same reasoning as :func:`_admitted_events`, applied to the other half of the file that decides
    whether a job runs. Comparing the expression to the string somebody typed answers "is this still
    spelled that way". What the tests below ask is "do these two runs land in the same group", and
    nothing but evaluating it answers that.
    """

    def one(match: re.Match[str]) -> str:
        terms = match.group(1).split("||")
        if len(terms) == 1:
            equality = _CONTEXT_EQUALITY.fullmatch(terms[0].strip())
            if equality is not None:
                key, literal = equality.groups()
                assert key in context, f"{terms[0].strip()!r} reads a key this reader has no value for"
                return "true" if context[key] == literal else "false"
            return _context_read(terms[0], context)
        # ``||`` is first-non-empty in a workflow expression, and only a lookup can be empty. An equality
        # inside one would be read as its truthy spelling "false", so the reader refuses it in _context_read.
        for term in terms:
            value = _context_read(term, context)
            if value:
                return value
        return ""

    return _INTERPOLATION.sub(one, str(template))


class TestTheGatesEveryChangeMustPass:
    """AT-104 -- the four things a pull request has to clear before anyone reads it.

    Three static gates and the unit tier, each run through the hatch script ``pyproject.toml`` defines, so
    CI runs what a contributor runs locally with ``hatch run prepare``.
    """

    def test_the_three_static_gates_all_run(self, workflow: dict[str, Any]) -> None:
        """Formatting, linting and typing, each by the script name ``pyproject.toml`` defines."""
        runs = "\n".join(_run_blocks(workflow))

        for script in ("format-check", "lint", "typecheck"):
            assert f"hatch run {script}" in runs, f"no step runs `hatch run {script}`"

    def test_nothing_runs_the_rewriting_formatter(self, workflow: dict[str, Any]) -> None:
        """``format-check`` rather than ``format``, because only one of the two can fail.

        ``hatch run format`` is ``ruff format``: it rewrites the files in place and exits 0, so a job built
        on it reports success on unformatted code and leaves the changes in a runner that is about to be
        thrown away. ``format-check`` is ``ruff format --check``, which exits 1 and changes nothing. Only
        one of the two is a gate.
        """
        offenders = [block for block in _run_blocks(workflow) if re.search(r"hatch run format(?!-check)", block)]

        assert offenders == [], (
            f"these steps run the rewriting formatter instead of the checking one: {offenders}; "
            f"`ruff format` exits 0 after rewriting, so the step can never fail"
        )

    def test_a_job_runs_the_unit_tier(self, workflow: dict[str, Any]) -> None:
        """``hatch run test`` with no selector, which is the unit tier plus whatever tiers have variables.

        No tier variable is set for this job, so `conftest.py`'s gate skips the three that need a backend
        and the run is the unit tier. The contract tier has a job of its own, beside this one, with
        a service container and ``MONGODB_URI`` pointed at it.
        """
        assert any("hatch run test" in block for block in _run_blocks(workflow)), "no step runs the test suite"

    def test_both_change_triggers_watch_the_package_directory(self, workflow: dict[str, Any]) -> None:
        """A push or a pull request that touches ``python/`` runs the gates.

        Asserted for both triggers rather than one: a repository that only gates pull requests gates
        nothing on a branch that is pushed to directly.
        """
        triggers = _triggers(workflow)

        for event in ("pull_request", "push"):
            assert event in triggers, f"no {event} trigger; the file declares {sorted(map(str, triggers))}"
            paths = triggers[event]["paths"]
            assert any(entry.startswith("python/") for entry in paths), (
                f"the {event} trigger watches {paths}, which does not include the package directory"
            )

    def test_the_workflow_watches_itself(self, workflow: dict[str, Any]) -> None:
        """A path filter that omits the workflow file means changes to the gates are ungated.

        It is also what makes a pull request that changes only this file run the gates it changes.
        """
        triggers = _triggers(workflow)
        relative = str(WORKFLOW_PATH.relative_to(REPO_ROOT))

        for event in ("pull_request", "push"):
            paths = triggers[event]["paths"]
            assert relative in paths, f"the {event} trigger watches {paths}, which does not include {relative}"


class TestTheTriggerWatchesEverythingTheSuiteReads:
    """``AT-138`` -- every file outside ``python/`` that this suite asserts about is watched by a change trigger.

    ``release-python.yml`` is read by tests under ``python/``, but a change to the workflow alone would
    match neither declared filter if it were not listed, and its own trigger is a pushed tag. A pull
    request with no checks looks the same as one whose checks passed.

    The same holds for ``AGENTS.md``, ``CONTRIBUTING.md`` and ``.gitignore``. ``test_conventions.py``
    resolves every command, variable, marker, version and path those documents name against the
    repository, and without these filters it could only catch a stale claim on a change that also touched
    ``python/``.

    The list is found rather than held. A file enters the suite's reach when somebody writes one ``Path``
    expression in a test module, and nothing about writing it prompts opening the workflow, so a curated
    list would be extended by exactly the person who forgot to extend the filter.
    """

    def test_the_walk_finds_the_files_the_suite_is_known_to_read(self) -> None:
        """AT-138 -- the vacuity guard: a walk that resolved nothing would pass the test below.

        A subset rather than an equality. Adding a read is supposed to fail the trigger test, which names
        the fix, rather than this one, which would only say the constant is out of date.
        """
        found = _paths_outside_the_package()
        missing = [path for path in _READ_AT_LEAST if path not in found]
        assert missing == [], f"the walk did not resolve paths the suite reads: {missing}. It found {sorted(found)}"

    def test_both_change_triggers_watch_every_file_the_suite_reads(self, workflow: dict[str, Any]) -> None:
        """AT-138 -- a file the suite makes a claim about has a job to check the claim.

        Both triggers, for the reason the package-directory test gives: a repository that gates only pull
        requests gates nothing on a branch pushed to directly.
        """
        triggers = _triggers(workflow)
        found = sorted(_paths_outside_the_package())

        for event in ("pull_request", "push"):
            patterns = triggers[event]["paths"]
            unwatched = [path for path in found if not _watched(path, patterns)]
            assert unwatched == [], (
                f"the {event} trigger watches {patterns}, so a change to {unwatched} runs no test, "
                "and the suite asserts something about each of them"
            )

    def test_the_matcher_reads_a_filter_the_way_github_does(self) -> None:
        """AT-138 -- the test above passes on everything if the matcher answers yes to everything.

        The two wildcards and the boundary between them, plus the prefix that looks like a match and is a
        different directory.
        """
        assert _watched("AGENTS.md", ["AGENTS.md"])
        assert _watched("python/tests/test_ci.py", ["python/**"])
        assert not _watched("AGENTS.md", ["python/**"])
        assert not _watched("python-notes/x.md", ["python/**"]), "`python/**` is not a prefix match on the name"
        assert not _watched("a/b/c.md", ["a/*/x.md"]), "`*` does not cross a separator"
        assert not _watched("AGENTS.md", []), "an empty filter watches nothing"


_GATE_JOBS: Final = ("lint", "test", "floors", "contract", "coverage")

_EXPECT_SEARCH: Final = "STRANDS_MONGODB_EXPECT_SEARCH"
"""The promise one leg of the contract tier makes about its deployment.

See ``TestTheContractTierRunsAgainstADeploymentThatCanSearch``.
"""


_MONGODB_IMAGES: Final = frozenset({"mongo", "mongodb/mongodb-atlas-local"})
"""The container images that are a MongoDB deployment.

Two, because the contract tier needs a deployment with a search process and one without. ``mongo`` has no
mongot at all; ``mongodb/mongodb-atlas-local`` is the image the Atlas CLI runs locally, mongot included.
"""


def _matrix_entries(job: dict[str, Any], dimension: str) -> list[Any]:
    """The values of one dimension of a job's matrix, or an empty list where there is none."""
    strategy = job.get("strategy") or {}
    entries = (strategy.get("matrix") or {}).get(dimension) or []
    return list(entries) if isinstance(entries, list) else []


def _matrix_values(job: dict[str, Any], declared: str) -> list[str]:
    """Every concrete value one declared string can take, with a matrix reference resolved.

    Args:
        job: The job the string was read from, which is where its matrix lives.
        declared: The string as the workflow writes it.

    Returns:
        One value per matrix entry where the string names a matrix key, so a job running two deployments
        reports two values. A string naming anything else is returned as itself, unchanged, which fails the
        caller's assertion rather than being quietly dropped.
    """
    reference = re.search(r"\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*\}\}", declared)
    if reference is None:
        return [declared]
    dimension, key = reference.group(1), reference.group(2)
    return [str(entry[key]) for entry in _matrix_entries(job, dimension) if isinstance(entry, dict) and key in entry]


def _service_images(job: dict[str, Any]) -> list[str]:
    """Every concrete image a job's service containers can run, with matrix references resolved."""
    return [
        image
        for service in (job.get("services") or {}).values()
        for image in _matrix_values(job, str(service.get("image", "")))
    ]


def _contract_deployments(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """The contract job's matrix entries, one per deployment it runs against.

    Args:
        workflow: The parsed CI workflow.

    Returns:
        The list under the matrix's one dimension. Empty where the job has no matrix at all, which the
        tests report as a failure rather than as a ``KeyError``.
    """
    entries = _matrix_entries(workflow["jobs"]["contract"], "deployment")
    return [entry for entry in entries if isinstance(entry, dict)]


class TestEveryPullRequestReachesTheGatesWhateverItsBaseIs:
    """``AT-182`` -- a pull request reaches the gate jobs whatever branch it is based on.

    A pull request proposed against another open pull request's branch has a base that is not ``main``. A
    ``pull_request`` trigger narrowed on ``branches: [ main ]`` runs no gate job for it at all, and its
    checks list shows only whatever checks run outside this workflow.

    ``paths`` and ``branches`` narrow the same trigger independently, and
    ``TestTheTriggerWatchesEverythingTheSuiteReads`` reads only the first, so a filter can watch every file
    a change touches and still exclude the change. Retargeting does not rescue it either: GitHub moves a stacked base to
    ``main`` on its own, but the ``pull_request`` event for that is ``edited``, which is not one of the three
    activity types a workflow receives by default.
    """

    def test_the_pull_request_trigger_narrows_on_no_branch(self, workflow: dict[str, Any]) -> None:
        """A change proposed against any branch is graded, because a stack is a base that is not ``main``."""
        pull_request = _triggers(workflow)["pull_request"]

        assert "branches" not in pull_request, (
            f"the pull_request trigger narrows on branches {pull_request['branches']}, so a pull request "
            "based on anything else runs no gate job and reports the same green as one that passed"
        )

    def test_the_push_trigger_still_narrows_on_main_alone(self, workflow: dict[str, Any]) -> None:
        """The asymmetry is the point, so it is asserted rather than left to whoever reads the file next.

        A push to a topic branch is already graded by that branch's pull request. Dropping this filter too
        would run the whole matrix twice on the same commit for the same verdict, and the concurrency group
        keys a push on the run id rather than the ref, so neither run would supersede the other.
        """
        push = _triggers(workflow)["push"]

        assert push.get("branches") == ["main"], (
            f"the push trigger narrows on {push.get('branches')}; every branch push with an open pull "
            "request would be graded twice, and the concurrency group does not collapse the pair"
        )

    def test_dropping_the_branch_filter_did_not_take_the_path_filter_with_it(self, workflow: dict[str, Any]) -> None:
        """The two narrowings are separate keys and the neighbouring classes depend on the other one.

        Deleting the whole filter block would satisfy the first test here and quietly widen every trigger to
        every file in the repository, which is the opposite of what
        ``TestTheTriggerWatchesEverythingTheSuiteReads`` establishes.
        """
        triggers = _triggers(workflow)

        for event in ("pull_request", "push"):
            paths = triggers[event].get("paths")
            assert paths, f"the {event} trigger declares no paths, so it now matches every file in the tree"

    def test_the_workflow_this_reads_is_the_one_with_the_gates_in_it(self, workflow: dict[str, Any]) -> None:
        """The vacuity guard: a file with no triggers and no jobs would pass the first test on a technicality."""
        jobs = workflow["jobs"]
        missing = [job for job in _GATE_JOBS if job not in jobs]

        assert missing == [], f"{missing} are not jobs in this workflow; its jobs are {sorted(jobs)}"


class TestTheContractTierRunsAgainstADeploymentThatCanSearch:
    """``AT-187`` -- the leg that makes the tier-resolution assertions mean something.

    Every rule about which search tier a store resolves is satisfied on a deployment with no search
    process, because the store resolves no tier there and each branch takes its quiet side. So the same
    contract tier runs twice, over one deployment without a search process and one with, and both sides of
    every branch are read on every change rather than only on the cron after the merge.

    What is asserted here is the shape of that arrangement, since the runtime half cannot see it: two
    deployments, different images, exactly one promising a search process, and the promise reaching the
    tests as an environment variable they can fail on. The runtime half is in ``test_tier_gating.py``.
    """

    def test_the_contract_job_runs_over_more_than_one_deployment(self, workflow: dict[str, Any]) -> None:
        """``AT-187`` -- a matrix, and two entries in it, because one deployment reads one side of each branch."""
        deployments = _contract_deployments(workflow)

        assert len(deployments) >= 2, (
            f"the contract tier runs against {len(deployments)} deployment(s), so half of what it "
            "asserts about search tiers is true for the trivial reason that nothing can search"
        )

    def test_the_deployments_are_not_the_same_image_twice(self, workflow: dict[str, Any]) -> None:
        """``AT-187`` -- the vacuity guard, and the likeliest way this decays: a copied matrix entry."""
        images = [deployment.get("image") for deployment in _contract_deployments(workflow)]

        assert all(images), f"a matrix entry names no image: {images}"
        assert len(set(images)) == len(images), f"the same deployment twice is one deployment: {images}"

    def test_the_service_and_the_promise_both_come_from_the_matrix(self, workflow: dict[str, Any]) -> None:
        """``AT-187`` -- a matrix nothing reads is a list of strings.

        Both halves. The service image has to vary with the matrix or every leg gets the same deployment,
        and the promise has to vary with it or every leg makes the same claim about a deployment that
        differs.
        """
        contract = workflow["jobs"]["contract"]
        image = str(contract["services"]["mongodb"]["image"])
        promise = str((contract.get("env") or {}).get(_EXPECT_SEARCH, ""))
        uri = str((contract.get("env") or {}).get("MONGODB_URI", ""))

        assert "matrix." in image, f"the service image does not vary with the matrix: {image!r}"
        assert "matrix." in promise, (
            f"{_EXPECT_SEARCH} does not vary with the matrix, so every leg makes the same promise about a "
            f"different deployment: {promise!r}"
        )
        assert "matrix." in uri, (
            f"MONGODB_URI does not vary with the matrix, so both legs are handed one connection string and "
            f"only one of these deployments is a replica set: {uri!r}"
        )

    def test_the_leg_with_a_replica_set_is_told_not_to_discover_the_topology(self, workflow: dict[str, Any]) -> None:
        """``AT-187`` -- without it this leg spends its whole timeout in server selection.

        ``mongodb/mongodb-atlas-local`` is a single-node replica set that initiates itself with the
        container's hostname as its member's host. A driver that discovers the topology therefore learns
        one member named something the runner cannot resolve, and every operation ends in server selection:
        thirty seconds per test, no error a reader can act on, and a job cancelled at its timeout with every
        test failed. ``directConnection=true``, the connection string MongoDB's Docker instructions give
        for this image, says talk to the address you were handed.

        Asserted because the failure it prevents does not look like a missing parameter. It looks like the
        deployment being broken, and the natural response to it is to widen the timeout.
        """
        promising = [
            deployment
            for deployment in _contract_deployments(workflow)
            if str(deployment.get("expect_search", "")).strip()
        ]
        assert promising, "no deployment promises a search process, which another test in this class owns"

        uri = str(promising[0].get("uri", ""))

        assert "directConnection=true" in uri, (
            f"the leg running a replica set connects with {uri!r}, so the driver will discover a member "
            "host only resolvable inside the container network and spend the job in server selection"
        )

    def test_exactly_one_deployment_promises_a_search_process(self, workflow: dict[str, Any]) -> None:
        """``AT-187`` -- and it is a promise the tests can fail on, not a comment.

        One, not "at least one". Two legs promising search would leave nothing reading the branches for a
        deployment that cannot search, which is the deployment this package's own error paths are mostly
        about; none would leave the search branches unread.
        """
        promising = [
            deployment
            for deployment in _contract_deployments(workflow)
            if str(deployment.get("expect_search", "")).strip()
        ]

        assert len(promising) == 1, (
            f"{len(promising)} of the contract tier's deployments promise a search process, and the "
            "arrangement needs one of each: "
            f"{[(d.get('image'), d.get('expect_search')) for d in _contract_deployments(workflow)]}"
        )

    def test_the_leg_with_a_search_process_keeps_that_images_own_health_check(self, workflow: dict[str, Any]) -> None:
        """``AT-187`` -- a ping answers before mongot does, and the options replace rather than extend.

        GitHub's ``--health-cmd`` overrides whatever HEALTHCHECK the image declares, so a service given a
        ``mongod`` ping is reported healthy as soon as ``mongod`` answers. On the leg that exists for the
        search process, that is the one thing worth waiting for: the tests would come up against a
        deployment whose mongot was still starting, take every quiet branch, and pass.
        """
        promising = [
            deployment
            for deployment in _contract_deployments(workflow)
            if str(deployment.get("expect_search", "")).strip()
        ]
        assert promising, "no deployment promises a search process, which another test in this class owns"

        health = str(promising[0].get("health", ""))

        assert "healthcheck" in health, (
            "the leg that promises a search process is health-checked with "
            f"{health!r}, which answers as soon as mongod does and not when the search process is ready"
        )


class TestTheManifestIsCheckedByAPullRequestAndNotOnlyByARelease:
    """``AT-183`` -- the half of the manifest check that runs on a pull request.

    ``test_release_ci.py`` holds the rest: the release gate validates the manifest and checks
    the built artifacts before the upload. This asks the cheaper question. A manifest defect found by the
    release is found after a tag exists; found by a pull request it is a comment on a diff, and the check
    costs a `pip install` and a subsecond run in a job that already exists.
    """

    def test_a_change_is_validated_against_the_packaging_schemas(self, workflow: dict[str, Any]) -> None:
        """``validate-pyproject``, which asks what packaging tools ask and what `hatch build` does not."""
        runs = "\n".join(_run_blocks(workflow))

        assert "validate-pyproject" in runs, (
            "no step validates pyproject.toml, so a manifest the packaging schemas refuse reaches the "
            "release gate as the first thing that notices"
        )


class TestEveryJobCanBeStartedOnDemand:
    """``AT-139`` -- the mirror of the trigger-path tests, asked about jobs instead of files.

    ``TestTheTriggerWatchesEverythingTheSuiteReads`` asks whether a change to an asserted file reaches a
    job. This asks whether a declared job can be started by a person, and whether a declared trigger
    reaches anything at all.

    A job gated on the weekly cron alone reports ``skipping`` on every pull request, which sits in the
    checks list beside a pass in the same colour, and it can be run only by waiting. On demand rather than
    merely reachable, because a job you can only reach by waiting cannot be debugged: the answer to "did
    that fix it" is another week away.
    """

    #: The one trigger no person can pull. Everything else in an ``on:`` block is caused by somebody.
    UNPULLABLE = "schedule"

    def _declared(self, workflow: dict[str, Any]) -> frozenset[str]:
        return frozenset(str(key) for key in _triggers(workflow))

    def test_every_job_can_be_started_by_a_person(self, workflow: dict[str, Any]) -> None:
        """AT-139 -- a job only the clock reaches is a job nobody can use to answer a question."""
        declared = self._declared(workflow)
        on_demand = declared - {self.UNPULLABLE}

        stranded = {
            name: job.get("if")
            for name, job in workflow["jobs"].items()
            if not (_admitted_events(job.get("if"), declared) & on_demand)
        }
        assert stranded == {}, (
            f"the triggers a person can pull are {sorted(on_demand)}, and these jobs answer to none of "
            f"them: {stranded}. Each can only be run by waiting for the cron, once"
        )

    def test_every_trigger_reaches_some_job(self, workflow: dict[str, Any]) -> None:
        """AT-139 -- the other direction, and a guard rather than a finding.

        A trigger gating no job still produces a run, and that run is green because it did nothing. An
        absent check is a hole; a green one over an empty job list is a wrong answer.
        """
        declared = self._declared(workflow)
        conditions = [job.get("if") for job in workflow["jobs"].values()]

        idle = sorted(
            trigger
            for trigger in declared
            if not any(trigger in _admitted_events(condition, declared) for condition in conditions)
        )
        assert idle == [], f"these triggers start a run in which every job is skipped: {idle}"

    def test_the_reader_interprets_the_condition_rather_than_matching_it(self) -> None:
        """AT-139 -- the vacuity guard. Both tests above pass on everything if the reader admits everything."""
        declared = frozenset({"push", "pull_request", "schedule", "workflow_dispatch"})

        assert _admitted_events(None, declared) == declared, "an ungated job runs on every declared trigger"
        assert _admitted_events("github.event_name == 'schedule'", declared) == {"schedule"}
        assert _admitted_events("github.event_name != 'schedule'", declared) == declared - {"schedule"}
        assert _admitted_events(
            "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'", declared
        ) == {"schedule", "workflow_dispatch"}
        assert _admitted_events("github.event_name == 'release'", declared) == frozenset(), (
            "an event no trigger declares reaches nothing, which is the shape of the defect above"
        )

    def test_the_reader_refuses_a_condition_it_cannot_read(self) -> None:
        """AT-139 -- the failure mode of a reader is answering anyway, and a wrong yes here reads as green."""
        for condition in ("success()", "github.ref == 'refs/heads/main'", "github.event_name == 'push' && true"):
            with pytest.raises(AssertionError, match="does not understand"):
                _admitted_events(condition, frozenset({"push", "schedule"}))


class TestOneRunNeverCancelsAnUnrelatedOne:
    """``AT-159`` -- the concurrency group keeps unrelated events apart.

    ``github.ref`` is ``refs/heads/main`` for a push to ``main``, for a dispatch against ``main`` and for
    the weekly cron alike. Keying the group on it would put all three in one group, and
    ``cancel-in-progress: true`` would then make whichever started last cancel the others.

    The job that would lose is always the same one. ``Atlas tiers`` is the longest job here and the only
    one that cannot be re-run cheaply, and the two events that start it, the cron and a dispatch, are
    exactly the two with no second chance: the cron's is a week away, and a dispatch is a button somebody
    pressed because they wanted an answer now. A cancelled run sits in the checks list looking like a
    failure.

    Superseding is right for a pull request and wrong everywhere else, which is the asymmetry these tests
    pin. A second push to a branch makes the first run's verdict worthless, because it grades a commit
    nobody will merge. A push, a dispatch and a cron each grade a commit that is already on ``main``, where the
    cancelled run is the only verdict that commit was ever going to get.
    """

    #: One run's context. A push to ``main`` and a dispatch against ``main`` agree on every value here
    #: except ``event_name`` and ``run_id``, which is why a group keyed on ``ref`` alone would merge them.
    BASE_CONTEXT = {
        "workflow": "CI - Python",
        "event_name": "push",
        "ref": "refs/heads/main",
        "run_id": "35076582911",
        "sha": "eb9ac2d6",
        "event.pull_request.number": "",
    }

    def _context(self, **overrides: str) -> dict[str, str]:
        return {**self.BASE_CONTEXT, **overrides}

    def _group(self, workflow: dict[str, Any], **overrides: str) -> str:
        return _render(workflow["concurrency"]["group"], self._context(**overrides))

    def _pull_request(self, number: str, run_id: str) -> dict[str, str]:
        return self._context(
            event_name="pull_request",
            ref=f"refs/pull/{number}/merge",
            run_id=run_id,
            **{"event.pull_request.number": number},
        )

    def _supersedes(self, workflow: dict[str, Any], context: dict[str, str]) -> bool:
        """Whether a newer run cancels an in-progress one, for a run in this context."""
        rendered = _render(workflow["concurrency"]["cancel-in-progress"], context)
        assert rendered in {"true", "false"}, (
            f"cancel-in-progress rendered {rendered!r} for a {context['event_name']} run. A literal there "
            "applies one answer to every event, and the events differ: see this class's docstring"
        )
        return rendered == "true"

    def test_no_two_events_against_main_share_a_group(self, workflow: dict[str, Any]) -> None:
        """AT-159 -- three events against one ref, and none of them shares a group with another."""
        groups = {
            event: self._group(workflow, event_name=event, run_id=str(index))
            for index, event in enumerate(("push", "workflow_dispatch", "schedule"), start=1)
        }
        assert len(set(groups.values())) == len(groups), (
            f"these events against main share a concurrency group: {groups}. A dispatch or the weekly "
            "cron is cancelled by any merge that lands while it runs, and Atlas tiers is the longest job here"
        )

    def test_two_dispatches_do_not_share_a_group(self, workflow: dict[str, Any]) -> None:
        """AT-159 -- two presses of a "run CI now" button are two questions, not one asked twice."""
        first = self._group(workflow, event_name="workflow_dispatch", run_id="1")
        second = self._group(workflow, event_name="workflow_dispatch", run_id="2")
        assert first != second, f"both dispatches land in {first!r}, so the second cancels the first"

    def test_two_runs_of_one_pull_request_do_share_a_group(self, workflow: dict[str, Any]) -> None:
        """AT-159 -- the other direction, and the reason the key is not simply unique per run.

        Coalescing a pull request's runs is the behaviour worth keeping. Losing it would run the full
        matrix against every intermediate commit of a branch somebody is still pushing to.
        """
        first = _render(workflow["concurrency"]["group"], self._pull_request("20", run_id="1"))
        second = _render(workflow["concurrency"]["group"], self._pull_request("20", run_id="2"))
        assert first == second, f"two runs of one pull request landed in {first!r} and {second!r}"

    def test_two_pull_requests_do_not_share_a_group(self, workflow: dict[str, Any]) -> None:
        """AT-159 -- the guard on the test above, which a constant group expression also passes."""
        twenty = _render(workflow["concurrency"]["group"], self._pull_request("20", run_id="1"))
        twenty_one = _render(workflow["concurrency"]["group"], self._pull_request("21", run_id="2"))
        assert twenty != twenty_one, f"both pull requests land in {twenty!r}, so one cancels the other"

    def test_only_a_pull_request_run_is_superseded(self, workflow: dict[str, Any]) -> None:
        """AT-159 -- the asymmetry, asserted in both directions."""
        assert self._supersedes(workflow, self._pull_request("20", run_id="1")), (
            "a second push to a pull request should cancel the first run, which grades a commit nobody will merge"
        )
        kept = [
            event
            for event in ("push", "workflow_dispatch", "schedule")
            if self._supersedes(workflow, self._context(event_name=event))
        ]
        assert kept == [], (
            f"a newer run cancels an in-progress one for {kept}, and each of those grades a commit "
            "already on main, where the cancelled run is the only verdict that commit will ever get"
        )

    def test_the_reader_resolves_the_fallback_rather_than_the_first_term(self) -> None:
        """AT-159 -- the vacuity guard. Every test above passes if the reader renders everything to ""."""
        template = "${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}"

        on_a_pull_request = _render(template, {**self.BASE_CONTEXT, "event.pull_request.number": "20"})
        assert on_a_pull_request == "CI - Python-20", on_a_pull_request

        on_a_push = _render(template, self.BASE_CONTEXT)
        assert on_a_push == "CI - Python-35076582911", on_a_push

        assert _render("${{ github.event_name == 'push' }}", self.BASE_CONTEXT) == "true"
        assert _render("${{ github.event_name == 'pull_request' }}", self.BASE_CONTEXT) == "false"

    def test_the_reader_refuses_an_expression_it_cannot_read(self) -> None:
        """AT-159 -- a reader that answers anyway turns an unread expression into a green test."""
        for template in (
            "${{ github.head_ref }}",
            "${{ contains(github.ref, 'main') }}",
            "${{ github.event.pull_request.number || github.ref || github.sha }}-x",
        ):
            with pytest.raises(AssertionError, match="does not understand|no value for"):
                _render(template, {"workflow": "CI - Python", "event_name": "push", "run_id": "1"})


class TestTheMatrixCoversEveryVersionTheClassifiersClaim:
    """AT-105 -- the matrix and the classifiers, compared as sets in both directions.

    Equality rather than containment. A matrix narrower than the claim ships support for an untested
    interpreter; a matrix wider than the claim tests one the package says it does not support, and the
    right fix for that is a new classifier, not a quieter test.
    """

    def test_the_matrix_equals_the_versions_the_classifiers_claim(self, workflow: dict[str, Any]) -> None:
        """Read from both files, so neither list can be edited alone."""
        claimed = {
            classifier.rsplit(" :: ", 1)[1]
            for classifier in _pyproject()["project"]["classifiers"]
            if classifier.startswith("Programming Language :: Python :: 3.")
        }
        assert claimed, "pyproject.toml claims no specific Python versions, so there is nothing to match"

        matrix = {str(version) for version in workflow["jobs"]["test"]["strategy"]["matrix"]["python-version"]}

        assert matrix == claimed, (
            f"the matrix tests {sorted(matrix)} and the classifiers claim {sorted(claimed)}; "
            f"untested but claimed: {sorted(claimed - matrix)}, tested but unclaimed: {sorted(matrix - claimed)}"
        )

    def test_every_version_in_the_matrix_is_quoted(self, workflow: dict[str, Any]) -> None:
        """Unquoted ``3.10`` is the float ``3.1`` in YAML, and ``setup-python`` would resolve it to 3.1.

        This is the one way the matrix can be wrong while looking right, and it is invisible in a diff. It
        gets its own test rather than riding on the set comparison above, because the set comparison would
        report it as a missing version and send the reader looking for the wrong mistake.
        """
        entries = workflow["jobs"]["test"]["strategy"]["matrix"]["python-version"]

        unquoted = [entry for entry in entries if not isinstance(entry, str)]
        assert unquoted == [], f"quote these, YAML read them as numbers: {unquoted}"


class TestBothCoverageFloorsAreEnforced:
    """AT-106 -- the aggregate floor and the per-module floor, in the one job that measures once.

    The job sets no connection string, so the floors of 90% aggregate and 70% per module are met by the
    tiers that need no deployment. The aggregate moves by a line or two with the interpreter, so the number
    that counts is the one this job measures.
    """

    def test_a_job_runs_the_coverage_gate(self, workflow: dict[str, Any]) -> None:
        assert any("hatch run cov" in block for block in _run_blocks(workflow)), (
            "no step runs `hatch run cov`, so neither coverage floor is enforced anywhere automatic"
        )

    def test_the_coverage_script_is_still_both_floors(self, workflow: dict[str, Any]) -> None:
        """The workflow delegates, so the delegate is asserted here too.

        ``hatch run cov`` is two commands. If someone drops the second, the workflow still says `cov` and
        the per-module floor silently stops being enforced, with nothing in the diff to notice. Reading the
        script definition is what closes that.
        """
        script = _pyproject()["tool"]["hatch"]["envs"]["default"]["scripts"]["cov"]

        assert any("--cov-fail-under=90" in command for command in script), (
            f"the `cov` script no longer carries the aggregate floor: {script}"
        )
        assert any("check_module_coverage.py" in command for command in script), (
            f"the `cov` script no longer runs the per-module floor: {script}"
        )

    def test_the_coverage_job_measures_once_rather_than_per_interpreter(self, workflow: dict[str, Any]) -> None:
        """One run per interpreter would produce one number and several copies of it."""
        job = workflow["jobs"]["coverage"]

        assert "strategy" not in job, f"the coverage job has a matrix: {job['strategy']}"


class TestTheWeeklyCanaryAgainstTheLatestSDK:
    """AT-107 -- a weekly cron runs the suite against the newest published ``strands-agents``.

    The pinned SDK is the one version in which upstream drift cannot show. The protocol conformance checks
    carry the ``compat`` marker so that this cron selects them, and without the cron they would only ever
    run against the pinned SDK.
    """

    def test_the_schedule_is_the_weekly_slot_the_template_uses(self, workflow: dict[str, Any]) -> None:
        crons = [entry["cron"] for entry in _triggers(workflow)["schedule"]]

        assert crons == [CANARY_CRON], f"the schedule is {crons}, not the template's weekly {CANARY_CRON!r}"

    def test_the_canary_never_runs_on_a_change(self, workflow: dict[str, Any]) -> None:
        """Otherwise every pull request resolves the latest SDK and the pinned floor is never the thing tested.

        Off the change triggers rather than on the cron alone. Those are different claims, and it is the
        first one that carries the reason: a maintainer starting the canary by hand has decided to resolve
        the latest SDK, which is the job's entire point, while a contributor pushing a commit has not.
        """
        declared = frozenset(str(key) for key in _triggers(workflow))
        on_a_change = sorted(_admitted_events(workflow["jobs"]["sdk-compat"].get("if"), declared) & CHANGE_TRIGGERS)

        assert on_a_change == [], (
            f"the canary runs on {on_a_change}, so an ordinary change resolves the latest SDK and the "
            "pinned floor is never the version under test"
        )

    def test_the_change_triggered_jobs_sit_out_the_schedule(self, workflow: dict[str, Any]) -> None:
        """The mirror of the above. A cron that also runs the pinned jobs reports nothing new, weekly."""
        declared = frozenset(str(key) for key in _triggers(workflow))

        for name in ("lint", "test", "coverage"):
            admitted = _admitted_events(workflow["jobs"][name].get("if"), declared)
            assert "schedule" not in admitted, (
                f"the {name} job's condition is {workflow['jobs'][name].get('if')!r}, so the weekly cron "
                "runs it too and reports the same answer it reported on the commit"
            )

    def test_the_canary_upgrades_the_sdk_before_it_tests_anything(self, workflow: dict[str, Any]) -> None:
        """Order is the assertion. Upgrading after the tests run tests the pinned version and reports green."""
        runs = _run_blocks(workflow["jobs"]["sdk-compat"])

        upgrades = [index for index, block in enumerate(runs) if "--upgrade strands-agents" in block]
        assert upgrades, f"no step upgrades strands-agents; the canary's steps run {runs}"

        selects = [index for index, block in enumerate(runs) if "-m compat" in block]
        assert selects, f"no step selects the compat tier; the canary's steps run {runs}"

        assert min(upgrades) < min(selects), (
            f"the upgrade happens at step {min(upgrades)} and the compat tier runs at step {min(selects)}, "
            f"so the tier ran against the pinned SDK"
        )

    def test_the_canary_typechecks_against_the_upgraded_sdk(self, workflow: dict[str, Any]) -> None:
        """The memory store's conformance check asserts a mypy result, so mypy has to see the new version.

        That check lives in ``test_memory_store.py``, and its id is deliberately kept out of this docstring.
        The gate in ``conftest.py`` indexes ids out of first paragraphs and lets a test's own declaration
        override a class's, per id and across the whole suite, so the id in this summary line would make
        this test about a YAML file the only carrier of the protocol check.

        The Protocol subset is satisfied by assignment under mypy. A member added upstream surfaces there and
        nowhere else, which makes the typecheck the load-bearing half of the canary rather than a formality.
        """
        runs = _run_blocks(workflow["jobs"]["sdk-compat"])

        assert any("hatch run typecheck" in block for block in runs), (
            f"the canary never typechecks, so an added Protocol member goes unreported; its steps run {runs}"
        )

    def test_the_canary_runs_the_contract_tier_against_the_upgraded_sdk(self, workflow: dict[str, Any]) -> None:
        """The weekly canary runs the contract tier beside both protocol checks.

        Its server is a service container, so this costs no repository secret and no provisioned cluster.

        Asserted after the upgrade for the same reason the compat selector is: a tier that runs before
        ``pip install --upgrade`` tests the pinned SDK and reports green about the wrong version.
        """
        job = workflow["jobs"]["sdk-compat"]
        runs = _run_blocks(job)

        assert "MONGODB_URI" in (job.get("env") or {}), (
            "the canary sets no MONGODB_URI, so every contract test in it skips and the cron reports a pass"
        )

        upgrades = [index for index, block in enumerate(runs) if "--upgrade strands-agents" in block]
        selects = [index for index, block in enumerate(runs) if "-m contract" in block]
        assert selects, f"the canary never selects the contract tier; its steps run {runs}"
        assert min(upgrades) < min(selects), (
            f"the upgrade happens at step {min(upgrades)} and the contract tier runs at step {min(selects)}, "
            f"so the tier ran against the pinned SDK"
        )


class TestTheCompatTierSelectsBothProtocolChecks:
    """AT-119 -- the canary runs ``-m compat``, so a check without that marker never runs.

    The canary runs two conformance checks against the newest published SDK, one per protocol. A check
    without the marker would leave a job meant to catch upstream drift in both protocols able to see it in
    only one. The marker is the selection, which is why it is asserted here rather than left to a reader of
    two decorator lines.

    Its own class rather than a method of the canary class above, because the gate's precedence rule works
    per id over the whole suite: inside that class this test would also have been indexed as a carrier of
    the canary's own id, and a failure about markers would have been reported against the cron.
    """

    def test_both_protocol_checks_carry_the_marker(
        self, checklist_gate: ChecklistGate, request: pytest.FixtureRequest
    ) -> None:
        """Read from the collected session rather than by grepping for a decorator line.

        The question is which tests ``-m compat`` selects, and the marker as pytest resolved it is the only
        thing that answers it. Reading the marker also covers the case a grep would miss, where the id moves
        to a test outside the marked class.
        """
        if narrowing := _narrowing(request.config):
            pytest.skip(f"this run collected a subset ({narrowing}), so an absent marker cannot be told apart")

        collected = {item.nodeid: item for item in request.session.items}
        unmarked: dict[str, list[str]] = {}
        for identifier in PROTOCOL_CHECK_IDS:
            carriers = checklist_gate.by_id.get(identifier, ())
            assert carriers, f"no collected test declares {identifier}, so the canary has nothing to select"
            missing = [
                node
                for node in carriers
                if node not in collected or collected[node].get_closest_marker("compat") is None
            ]
            if missing:
                unmarked[identifier] = sorted(missing)

        assert unmarked == {}, (
            f"tests carrying a protocol-check id that '-m compat' does not select, so the weekly canary "
            f"never runs them against the newest published SDK: {unmarked}"
        )


class TestTheContractTierRunsOnEveryChange:
    """AT-130 -- the tier a service container satisfies, gated on every change rather than on a secret.

    ``conftest.py`` defines the tier as "any real MongoDB, including a plain ``mongod``", and this package
    opens no transaction, no session and no change stream, so nothing in it needs a replica set. A GitHub
    Actions service container is therefore a real MongoDB by the tier's own definition, and it needs no
    secret, no provisioning step and no access list.

    The value of running it here is arrival time: a test that relies on more than a plain deployment fails
    on the pull request that introduces it, rather than on a later run against a cluster.
    """

    @staticmethod
    def _jobs_setting(workflow: dict[str, Any], variable: str) -> dict[str, dict[str, Any]]:
        """Every job whose ``env:`` block sets ``variable``, keyed by job name."""
        return {name: job for name, job in workflow["jobs"].items() if variable in (job.get("env") or {})}

    def test_every_job_setting_the_contract_variable_runs_the_tier(self, workflow: dict[str, Any]) -> None:
        """Both halves, because either alone is a job that reports green without asserting anything.

        A job that sets the variable and never selects the tier runs the unit tier twice. A job that selects
        the tier with no variable set reports every contract test as skipped, which a green check reads as
        passed, which is the failure ``tests/test_tier_gating.py`` guards against.

        Two jobs set it: the one that gates a change, and the weekly canary, which runs the same tier
        against the newest published SDK. Asserted over all of them rather than over a count, so a third
        cannot arrive half-wired.
        """
        setting = self._jobs_setting(workflow, "MONGODB_URI")
        assert setting, "no job sets MONGODB_URI, so the contract tier runs nowhere"

        silent = {name: _run_blocks(job) for name, job in setting.items()}
        silent = {name: runs for name, runs in silent.items() if not any("-m contract" in block for block in runs)}
        assert silent == {}, f"these jobs set MONGODB_URI and never select the tier it is for: {silent}"

    def test_every_deployment_is_a_service_container_rather_than_a_credential(self, workflow: dict[str, Any]) -> None:
        """The half that makes this free, and the half a future edit is most likely to undo.

        A maintainer who wanted the tier run against a cluster would reach for a repository secret, which
        puts a live cluster credential in the repository for a tier that needs none. The container is the answer
        that needs no such decision, so the image is asserted rather than left as a comment.

        Every image rather than any image, and the matrix is resolved before reading them. The contract
        tier runs against two deployments and the second one arrives through ``matrix.deployment.image``,
        so a walk that read the literal would see one expression and no MongoDB at all.
        """
        for name, job in self._jobs_setting(workflow, "MONGODB_URI").items():
            images = _service_images(job)
            assert images, f"the {name} job declares no service container; its services are {job.get('services')}"
            foreign = [image for image in images if image.split(":")[0] not in _MONGODB_IMAGES]
            assert foreign == [], (
                f"the {name} job runs the contract tier against {foreign}, which is not one of the MongoDB "
                f"images this tier is written for: {sorted(_MONGODB_IMAGES)}"
            )

            declared = str(job["env"]["MONGODB_URI"])
            assert "secrets." not in declared, (
                f"the {name} job reaches for a credential rather than the container beside it: {declared!r}"
            )
            for uri in _matrix_values(job, declared):
                assert "localhost" in uri or "127.0.0.1" in uri, (
                    f"the {name} job's connection string is {uri!r}, which does not point at that container"
                )

    def test_the_tier_gates_a_change_rather_than_only_the_cron(self, workflow: dict[str, Any]) -> None:
        """Pull requests are gated on this tier, so weekly alone is the wrong cadence.

        The canary runs it too, and that is a different claim: weekly against the newest SDK, which is
        ``TestTheWeeklyCanaryAgainstTheLatestSDK``'s subject rather than this one's. What this asserts is that
        a change does not merge without it.
        """
        declared = frozenset(str(key) for key in _triggers(workflow))
        conditions = {name: job.get("if") for name, job in self._jobs_setting(workflow, "MONGODB_URI").items()}
        on_a_change = {
            name: sorted(_admitted_events(condition, declared) & CHANGE_TRIGGERS)
            for name, condition in conditions.items()
        }

        assert any(on_a_change.values()), (
            f"no job runs the contract tier on a change; the jobs that set MONGODB_URI are {conditions}"
        )


#: Names that carry a cloud credential or a connection string to a real cluster. A job holds one when the
#: value comes from a secret or from an earlier step, never when it is a literal such as a container's URI.
_CREDENTIAL_VARIABLES: Final = (
    "MONGODB_ATLAS_CLIENT_ID",
    "MONGODB_ATLAS_CLIENT_SECRET",
    "MONGODB_ATLAS_URI",
    "MONGODB_AUTOEMBED_URI",
)


def _environments(job: dict[str, Any]) -> list[dict[str, Any]]:
    """The job's own ``env`` and every step's, since a credential can be scoped to either."""
    return [job.get("env") or {}, *((step.get("env") or {}) for step in job.get("steps") or [])]


def _holds_credential(job: dict[str, Any]) -> bool:
    """Whether any ``env`` in the job hands a credential variable a secret or a generated value."""
    return any(
        name in env and any(source in str(env[name]) for source in ("secrets.", "steps."))
        for env in _environments(job)
        for name in _CREDENTIAL_VARIABLES
    )


class TestTheTiersThatNeedAClusterAreNeverHandedToAStranger:
    """AT-131, and ``AT-140`` -- where a secret is unavoidable and a pull request is the wrong trigger.

    ``autoembed`` needs automated embedding, which only an Atlas cluster has, so the ``Atlas tiers`` job
    holds cloud credentials, creates a throwaway cluster and runs both cluster tiers against it. That job
    stays off ``pull_request`` for two reasons that point the same way: a pull request from a fork
    receives no secret, so the tiers would skip on exactly the contributions that most need checking and
    report the skip as a pass; and a run against a cloud cluster takes far longer than a gate anybody
    keeps on every change.

    The assertion is about who can pull the trigger rather than about the spelling of ``if:``. A literal
    comparison would fail on a second trigger that is exactly as safe, such as ``push`` to ``main``, which
    needs write access, and would pass a condition naming some other safe-sounding event that a stranger
    can in fact cause.
    """

    def _exposure(self, workflow: dict[str, Any]) -> dict[str, list[str]]:
        """Per secret-holding job, the declared triggers a party without write access can cause."""
        declared = frozenset(str(key) for key in _triggers(workflow))
        reachable_by_a_stranger = declared - TRIGGERS_NEEDING_WRITE_ACCESS

        exposed = {}
        for name, job in workflow["jobs"].items():
            if not _holds_credential(job):
                continue
            through = _admitted_events(job.get("if"), declared) & reachable_by_a_stranger
            if through:
                exposed[name] = sorted(through)
        return exposed

    def test_no_trigger_a_stranger_can_cause_reaches_a_cluster_secret(self, workflow: dict[str, Any]) -> None:
        """AT-140 -- one condition per job rather than per variable: a second job is as exposed as a second key."""
        holders = [name for name, job in workflow["jobs"].items() if _holds_credential(job)]
        assert holders, f"no job supplies any of {_CREDENTIAL_VARIABLES}, so neither tier runs on a cluster"

        assert self._exposure(workflow) == {}, (
            f"these jobs supply a cluster credential under a trigger somebody without write access to this "
            f"repository can cause: {self._exposure(workflow)}"
        )

    def test_the_exposure_check_can_actually_see_an_exposure(self, workflow: dict[str, Any]) -> None:
        """AT-140 -- the vacuity guard, because the test above asserts that something is empty.

        Two conditions that would hand a key to a stranger, and the second is the one worth writing down:
        it never mentions a pull request at all. ``!=`` against the cron admits every other declared
        trigger, which is how this would arrive: somebody copying the gate off ``lint``.
        """
        for condition in (None, "github.event_name != 'schedule'"):
            rigged = {
                **workflow,
                "jobs": {name: {**job, "if": condition} for name, job in workflow["jobs"].items()},
            }
            assert self._exposure(rigged) != {}, (
                f"a cluster job gated on {condition!r} is reachable from a pull request, and this missed it"
            )

    def test_both_cluster_tiers_are_actually_selected(self, workflow: dict[str, Any]) -> None:
        """A secret supplied and a marker never selected is a credential in a repository for nothing."""
        holders = [job for job in workflow["jobs"].values() if _holds_credential(job)]
        runs = "\n".join(block for job in holders for block in _run_blocks(job))

        for marker in ("integration", "autoembed"):
            assert marker in runs, f"no step in a cluster job selects the {marker} tier; they run {runs!r}"

    def test_no_trigger_hands_a_fork_the_secrets(self, workflow: dict[str, Any]) -> None:
        """``pull_request_target`` runs a fork's pull request with the base repository's secrets.

        It is the one trigger that would defeat everything above, and it is easy to reach for: it is what
        somebody adds when they want a fork's pull request to see a check that needs a secret. Asserted on
        the trigger list rather than left to review.
        """
        triggers = sorted(str(key) for key in _triggers(workflow))

        assert "pull_request_target" not in triggers, (
            f"the workflow triggers on {triggers}, and pull_request_target runs a fork's code with our secrets"
        )


class TestNoCredentialReachesACommandLine:
    """AT-108 -- a secret is only ever an ``env`` value, never part of a command or a step name.

    GitHub masks secrets in logs on a best-effort basis. The ``Atlas tiers`` job holds cloud credentials,
    and these tests keep them out of the commands a public build log echoes.
    """

    def test_no_command_or_step_name_interpolates_a_secret(self, workflow: dict[str, Any]) -> None:
        """GitHub echoes a step's command above its output, and masking there is best effort."""
        for scope, values in (("run", _run_blocks(workflow)), ("name", _values_under(workflow, "name"))):
            offenders = [value for value in values if "secrets." in value]
            assert offenders == [], f"these {scope} values interpolate a secret: {offenders}"

    def test_every_secret_reference_sits_under_env(self, workflow: dict[str, Any]) -> None:
        """The positive form of the rule: a secret may appear, in exactly one kind of place.

        Checked against the parsed document rather than the file's text, so a secret named in a comment
        cannot fail a test about what the workflow does.
        """
        referenced = [value for value in _all_strings(workflow) if "secrets." in value]
        permitted = set(_values_under(workflow, "env"))

        stray = [value for value in referenced if value not in permitted]
        assert stray == [], f"these secret references are not env values: {stray}"

    def test_every_tier_variable_the_workflow_sets_is_set_under_env(self, workflow: dict[str, Any]) -> None:
        """No `export` in a shell line, which is how a value ends up in a log with no masking at all.

        Covers the four names `conftest.py` and `test_packaging.py` read between them, whether or not this
        workflow sets each of them.
        """
        tier_variables = (
            "MONGODB_URI",
            "MONGODB_ATLAS_URI",
            "MONGODB_AUTOEMBED_URI",
            "STRANDS_MONGODB_BUILD_TIER",
        )
        commands = _run_blocks(workflow)
        environments = set(_values_under(workflow, "env"))

        for name in tier_variables:
            in_commands = [block for block in commands if name in block]
            assert in_commands == [], f"{name} appears in a command rather than under env:: {in_commands}"

        assert any("STRANDS_MONGODB_BUILD_TIER" in key for key in _all_strings(workflow)), (
            "no job switches the build tier on"
        )
        assert environments, "the workflow declares no env: block at all"


class TestTheBuildTierRunsSomewhere:
    """AT-109 -- the build tier runs in exactly one CI job.

    ``BUILD_TIER_VARIABLE`` in ``test_packaging.py`` turns it off by default because it builds a wheel and
    resolves dependencies from PyPI. The variable is the one tier gate that is not a connection string, so a
    runner with network is all it needs.
    """

    def test_exactly_one_job_switches_the_build_tier_on(self, workflow: dict[str, Any]) -> None:
        """One, because the artifact is the same artifact on every interpreter."""
        enabling = [
            name for name, job in workflow["jobs"].items() if "STRANDS_MONGODB_BUILD_TIER" in (job.get("env") or {})
        ]

        assert len(enabling) == 1, f"the build tier is switched on in {enabling}, and it should be in exactly one"

    def test_the_build_tier_is_not_in_the_matrix_job(self, workflow: dict[str, Any]) -> None:
        """One wheel per interpreter from the same commit, and all but one discarded unread."""
        matrix_job = workflow["jobs"]["test"]

        assert "STRANDS_MONGODB_BUILD_TIER" not in (matrix_job.get("env") or {}), (
            "the matrix job builds the same artifact once per interpreter"
        )

    def test_the_tier_is_switched_on_with_a_value_the_gate_reads_as_set(self, workflow: dict[str, Any]) -> None:
        """The gate is ``not os.environ.get(...)``, so an empty string reads as off and a skip looks like a pass."""
        values = [
            job["env"]["STRANDS_MONGODB_BUILD_TIER"]
            for job in workflow["jobs"].values()
            if "STRANDS_MONGODB_BUILD_TIER" in (job.get("env") or {})
        ]

        assert values, "no job switches the build tier on"
        for value in values:
            assert str(value).strip(), f"the build tier is set to {value!r}, which the gate reads as unset"


class TestNothingNeedsMoreThanTheOldestInterpreterInTheMatrix:
    """AT-110 — the floor's grammar, checked from whatever interpreter is running.

    ``TestTheMatrixCoversEveryVersionTheClassifiersClaim`` asserts the matrix equals the classifiers, which
    claim 3.10 as the floor. This asserts that the tree can be *parsed* there. An ``async for``
    comprehension nested inside a plain one is legal from 3.11 and a ``SyntaxError`` on 3.10, and inside a
    triple-quoted string that a child interpreter runs, no linter parses it and no type checker sees it, so
    the first thing to compile it would be Python 3.10 itself.

    **Why the obvious guard is not the one used here.** ``ast.parse(source, feature_version=(3, 10))`` reads
    like the answer and is not: measured on 3.14, it accepts the nested form, because ``feature_version``
    gates a short list of constructs and this is not among them. The floor's grammar is not reachable from a
    newer interpreter through the standard library, so this checks the one construct structurally instead.

    It catches this construct and no other, and the 3.10 leg of the matrix remains the check for any other.
    """

    @staticmethod
    def _has_async_clause(comprehension: ast.expr) -> bool:
        generators = getattr(comprehension, "generators", [])
        return any(generator.is_async for generator in generators)

    @classmethod
    def _rejected_by_the_floor(cls, tree: ast.AST) -> list[int]:
        """Line numbers of comprehensions Python 3.10 refuses to compile.

        The rule is exact rather than conservative, measured on 3.10.11 against all four shapes: an
        asynchronous comprehension is rejected when the comprehension enclosing it is synchronous, because
        that outer comprehension is its own synchronous scope. Enclosed by an *asynchronous* comprehension it
        is accepted, and unenclosed inside an ``async def`` it is accepted.
        """
        offenders: list[int] = []

        def visit(node: ast.AST, enclosing: ast.expr | None) -> None:
            if isinstance(node, _COMPREHENSION_TYPES):
                if cls._has_async_clause(node) and enclosing is not None and not cls._has_async_clause(enclosing):
                    offenders.append(node.lineno)
                enclosing = node
            for child in ast.iter_child_nodes(node):
                visit(child, enclosing)

        visit(tree, None)
        return offenders

    def test_the_detector_matches_what_the_floor_actually_rejects(self) -> None:
        """The sweep below reports nothing once the tree is clean, so this is what keeps it from being vacuous.

        All four shapes were compiled on 3.10.11 to fix the rule. Only the first is an error there.
        """
        # Joined at runtime rather than written whole, because the sweep below walks the string literals in
        # this file too and this one is precisely what it looks for. Explicit ``+`` rather than adjacency:
        # adjacent literals are folded during parsing, so the sweep would see one string and flag it. Each
        # half alone is a ``SyntaxError``, which the sweep skips.
        rejected = "async def m():\n    return [[e async for e in s()] " + "for _ in r()]\n"
        accepted = (
            "async def m():\n"
            "    a = [[e async for e in s()] async for _ in t()]\n"
            "    b = [e async for e in s()]\n"
            "    c = [[e for e in s()] for _ in r()]\n"
            "    return a, b, c\n"
        )

        assert self._rejected_by_the_floor(ast.parse(rejected)) == [2]
        assert self._rejected_by_the_floor(ast.parse(accepted)) == []

    def test_no_module_uses_a_construct_the_floor_rejects(self) -> None:
        """Every ``.py`` file mypy is pointed at, parsed as itself."""
        for root in SOURCE_ROOTS:
            for path in sorted((PROJECT_ROOT / root).rglob("*.py")):
                offenders = self._rejected_by_the_floor(ast.parse(path.read_text()))

                assert not offenders, f"{path.relative_to(PROJECT_ROOT)} lines {offenders} will not compile on 3.10"

    def test_no_embedded_script_uses_a_construct_the_floor_rejects(self) -> None:
        """And every multi-line string in those files that happens to be Python, which is the half that broke.

        Prose docstrings mostly fail to parse and are skipped, so the count is not the point; the three script
        constants handed to ``python -c`` are (``test_examples.py``, ``test_extras.py``, ``test_tier_gating.py``).
        The detector's own test above is what proves a clean sweep means something.
        """
        for root in SOURCE_ROOTS:
            for path in sorted((PROJECT_ROOT / root).rglob("*.py")):
                for node in ast.walk(ast.parse(path.read_text())):
                    if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                        continue
                    if "\n" not in node.value:
                        continue
                    try:
                        embedded = ast.parse(node.value)
                    except SyntaxError:
                        continue

                    offenders = self._rejected_by_the_floor(embedded)

                    assert not offenders, (
                        f"{path.relative_to(PROJECT_ROOT)}: the string at line {node.lineno} will not compile "
                        f"on 3.10, at its own lines {offenders}"
                    )


#: GitHub's default job timeout, in minutes. Not a setting anybody chose — it is what a workflow gets when
#: it declares nothing, and six hours of a hung runner is what it costs.
_DEFAULT_TIMEOUT_MINUTES = 360

#: The ceiling this repository holds itself to. `Atlas tiers` is the long pole: about ten minutes to create its
#: cluster and up to forty for the two tiers. A budget above this would let a hung job run longer than any job
#: here needs.
_TIMEOUT_CEILING_MINUTES = 75


class TestNoJobCanRunForSixHours:
    """AT-165 — every job declares how long it is allowed to take.

    A job that declares no ``timeout-minutes`` inherits GitHub's 360. The failure that matters is not a
    slow job; it is a *hung* one, which looks identical to a running one until the six hours are up. This
    repository has three places where that is a real shape: ``initialize()`` polls a search index until it
    is queryable, the cluster tiers talk to Atlas over the network, and a mongot that is unreachable rather
    than absent can stall a call.

    The budgets are per job rather than one number at the top, because the jobs are not alike: most finish
    in a few minutes, while ``Atlas tiers`` creates a cluster and then runs two tiers against it. One
    ceiling above the slowest would give the fastest job a margin so wide the budget never fires.
    """

    def test_every_job_declares_one(self, workflow: dict[str, Any]) -> None:
        """AT-165 — read from the job mapping, so a job added later has to answer the question too."""
        jobs = workflow["jobs"]
        assert jobs, "the workflow defines no jobs, so this test proves nothing"

        undeclared = sorted(name for name, job in jobs.items() if job.get("timeout-minutes") is None)
        assert undeclared == [], (
            f"these jobs declare no timeout-minutes and so inherit GitHub's {_DEFAULT_TIMEOUT_MINUTES}: "
            f"{undeclared}. A job that hangs rather than fails holds a runner for six hours, and on a "
            f"cluster tier that is indistinguishable from one that is merely waiting on a search index"
        )

    def test_none_of_them_is_the_default_in_disguise(self, workflow: dict[str, Any]) -> None:
        """AT-165 — a budget has to be a number somebody chose, which means it has to be small enough to fire."""
        budgets = {name: job.get("timeout-minutes") for name, job in workflow["jobs"].items()}

        for name, budget in budgets.items():
            assert isinstance(budget, int) and not isinstance(budget, bool), (
                f"job {name!r} declares timeout-minutes {budget!r}, which YAML did not read as an integer"
            )
            assert 0 < budget <= _TIMEOUT_CEILING_MINUTES, (
                f"job {name!r} budgets {budget} minutes. The slowest job in this workflow is the Atlas tier, "
                f"cluster creation included, so anything above {_TIMEOUT_CEILING_MINUTES} is the "
                f"{_DEFAULT_TIMEOUT_MINUTES}-minute default with a different number on it"
            )


#: The other workflow. Three of the four gates below are about a property no single file can have on its
#: own: a credential left in a checkout is left in whichever job checked out, and there are nine of them
#: across the two files.
RELEASE_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "release-python.yml"

#: The automated update source for the actions these workflows run. Outside ``python/``, so
#: ``TestTheTriggerWatchesEverythingTheSuiteReads`` requires both change triggers to watch it.
DEPENDABOT_PATH = REPO_ROOT / ".github" / "dependabot.yml"

#: The static analysis of the workflows themselves, and the file holding its argued exceptions. Also
#: outside ``python/``, so both change triggers have to watch them too.
ZIZMOR_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "zizmor.yml"
ZIZMOR_CONFIG_PATH = REPO_ROOT / ".github" / "zizmor.yml"

#: A commit digest, as an action reference. Forty hexadecimal characters and nothing else: a tag or a
#: branch name names a place that can be moved, and a digest names the content that was reviewed.
#: ``test_release_ci.py`` holds its own copy, deliberately -- the two files are read separately, and a
#: shared constant would let one suite's edit weaken the other's gate.
_DIGEST = re.compile(r"\A[0-9a-f]{40}\Z")


def _checkout_steps(parsed: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Every ``actions/checkout`` step in a parsed workflow, paired with the job that runs it.

    Matched on the action rather than the reference, so a version bump does not quietly empty the walk.
    """
    found: list[tuple[str, dict[str, Any]]] = []
    for job_name, job in (parsed.get("jobs") or {}).items():
        for step in job.get("steps") or []:
            uses = step.get("uses")
            if isinstance(uses, str) and uses.split("@")[0] == "actions/checkout":
                found.append((job_name, step))
    return found


def _every_checkout() -> list[tuple[str, str, dict[str, Any]]]:
    """Every checkout in the repository, as ``(workflow file, job, step)``."""
    out: list[tuple[str, str, dict[str, Any]]] = []
    for path in (WORKFLOW_PATH, RELEASE_WORKFLOW_PATH):
        parsed = yaml.safe_load(path.read_text())
        assert isinstance(parsed, dict), f"{path.name} did not parse as a mapping"
        out.extend((path.name, job, step) for job, step in _checkout_steps(parsed))
    return out


class TestNoCheckoutLeavesACredentialBehind:
    """``AT-169`` -- the token ``actions/checkout`` writes into ``.git/config``.

    By default the action stores an ``http.extraheader`` carrying the job's ``GITHUB_TOKEN`` in the
    checked-out repository's config and leaves it there for the rest of the job. Nothing in either
    workflow pushes, tags or comments, so no step after a checkout has any use for it, and the contract
    tier runs a shipped example as a subprocess in an environment where ``pip`` has just resolved a
    dependency tree.

    **What this is worth, stated plainly.** Both workflows declare ``permissions: contents: read``, so the
    persisted credential is read-scoped, and the one job that raises ``id-token: write`` checks nothing
    out. This is defence in depth.
    """

    def test_the_walk_actually_finds_the_checkouts(self) -> None:
        """AT-169 -- a gate over an empty list is a gate that passes for the wrong reason."""
        checkouts = _every_checkout()
        assert len(checkouts) >= 9, (
            f"the walk found {len(checkouts)} checkouts across the two workflows, and the two hold at least "
            f"nine; a matcher that resolves nothing reports a clean result"
        )

    def test_every_checkout_refuses_to_persist_the_credential(self) -> None:
        """AT-169 -- read from the step, so a checkout added later has to answer the question too."""
        offenders = [
            f"{file}:{job}"
            for file, job, step in _every_checkout()
            if (step.get("with") or {}).get("persist-credentials") is not False
        ]
        assert offenders == [], (
            f"these checkouts leave the job's GITHUB_TOKEN readable in .git/config for every later step: "
            f"{offenders}. Nothing in either workflow pushes, so set `persist-credentials: false`"
        )


def _cluster_jobs(workflow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every job that hands itself a cluster credential, keyed by job name.

    Identified by what it holds rather than by its key, so renaming the job does not silently empty this gate.
    """
    return {name: job for name, job in workflow["jobs"].items() if _holds_credential(job)}


class TestWhereEachClusterTierRuns:
    """AT-171 -- ``integration`` on every change, ``autoembed`` on a throwaway cluster weekly.

    ``integration`` needs mongot, which the Atlas local image carries, so it runs on every pull request and
    merge in the contract job's search leg, with no secret. ``autoembed`` needs automated embedding, which
    only an Atlas cluster has, so it runs on the weekly cron and on demand, against a cluster created for
    the run and deleted after it. A release is preceded by a dispatched run, which ``RELEASING.md`` says.
    """

    def test_there_is_a_job_that_needs_a_cluster(self, workflow: dict[str, Any]) -> None:
        """AT-171 -- the vacuity guard. Every assertion below is over this set."""
        assert _cluster_jobs(workflow), f"no job holds any of {_CREDENTIAL_VARIABLES}, so autoembed runs nowhere"

    def test_the_cluster_job_runs_only_on_the_cron_and_on_demand(self, workflow: dict[str, Any]) -> None:
        """AT-171 -- every run creates a billed cluster, so no change trigger may start one."""
        triggers = frozenset(_triggers(workflow))
        for name, job in _cluster_jobs(workflow).items():
            admitted = _admitted_events(job.get("if"), triggers)
            assert admitted == {"schedule", "workflow_dispatch"}, f"job {name!r} runs on {sorted(admitted)}"

    def test_integration_runs_on_every_change_without_a_secret(self, workflow: dict[str, Any]) -> None:
        """AT-171 -- the tier a merge must not wait a week for, graded against a container."""
        triggers = frozenset(_triggers(workflow))
        graded = [
            name
            for name, job in workflow["jobs"].items()
            if not _holds_credential(job)
            and {"pull_request", "push"} <= _admitted_events(job.get("if"), triggers)
            and any("-m integration" in block for block in _run_blocks(job))
            and any("MONGODB_ATLAS_URI" in env for env in _environments(job))
        ]
        assert graded, "no job without a secret runs the integration tier on a pull request and a push"

    def test_they_stay_off_the_trigger_a_fork_can_pull(self, workflow: dict[str, Any]) -> None:
        """AT-171 -- widening this job must not widen it to the one event that hands a stranger the wheel."""
        triggers = frozenset(_triggers(workflow))
        for name, job in _cluster_jobs(workflow).items():
            admitted = _admitted_events(job.get("if"), triggers)
            assert "pull_request" not in admitted, (
                f"job {name!r} admits pull_request. A fork's pull request receives no secret, so both "
                f"tiers would skip and report the same green as a run that passed"
            )

    def test_a_person_can_still_start_them(self, workflow: dict[str, Any]) -> None:
        """AT-171 -- the property AT-139 holds workflow-wide, asserted here because this gate edits the condition."""
        triggers = frozenset(_triggers(workflow))
        for name, job in _cluster_jobs(workflow).items():
            admitted = _admitted_events(job.get("if"), triggers)
            assert "workflow_dispatch" in admitted, (
                f"job {name!r} no longer admits workflow_dispatch, so the only way to ask this question "
                f"is to merge something or wait for Monday"
            )


#: The ecosystem whose versions nothing in this repository raises by hand.
_ACTIONS_ECOSYSTEM = "github-actions"

#: The ecosystem this repository deliberately does not configure. `pyproject.toml` declares floors with no
#: upper bounds and a paragraph of rationale for each; an automated pull request that raises one would
#: narrow the range this package promises to work on while looking like housekeeping.
_REFUSED_ECOSYSTEMS = frozenset({"pip", "uv", "poetry"})


@pytest.fixture(scope="module")
def dependabot() -> dict[str, Any]:
    """The parsed update configuration.

    Fails rather than skips when absent, for the reason the workflow fixture gives: absence is the defect.
    """
    assert DEPENDABOT_PATH.is_file(), f"no update configuration at {DEPENDABOT_PATH}"
    parsed = yaml.safe_load(DEPENDABOT_PATH.read_text())
    assert isinstance(parsed, dict), "the update configuration did not parse as a mapping"
    return parsed


class TestTheActionsHaveAnUpdateSourceAndTheFloorsDoNot:
    """``AT-172`` -- two halves, and the second one is a refusal.

    Without an update source nothing raises an action version, and the digest the publish job is pinned to
    will not raise itself. Dependabot watches ``github-actions`` with a seven-day cooldown, the window in
    which a yanked or compromised release is usually caught.

    The refusal is the half specific to this package. A library ships its floors: ``strands-agents>=1.54.0``
    and the three beside it are the contract, not an artefact of how a requirements file was written. A
    bot that raises one revokes a promise, so the Python ecosystems are asserted *absent* rather than
    merely left out, because leaving something out is not a decision anybody can see.
    """

    def test_it_watches_the_actions(self, dependabot: dict[str, Any]) -> None:
        """AT-172 -- the first half. Nine checkouts and a digest, and nothing raising any of them."""
        ecosystems = [entry.get("package-ecosystem") for entry in dependabot.get("updates") or []]
        assert _ACTIONS_ECOSYSTEM in ecosystems, (
            f"the update configuration watches {ecosystems} and not {_ACTIONS_ECOSYSTEM!r}, so the action "
            f"references in both workflows, including the digest the publish job is pinned to, go stale unwatched"
        )

    def test_every_entry_waits_before_proposing_a_release(self, dependabot: dict[str, Any]) -> None:
        """AT-172 -- a cooldown, because the day a release lands is the day a bad one is still a release."""
        for entry in dependabot.get("updates") or []:
            ecosystem = entry.get("package-ecosystem")
            cooldown = (entry.get("cooldown") or {}).get("default-days")
            assert isinstance(cooldown, int) and cooldown >= 7, (
                f"the {ecosystem!r} entry declares default-days {cooldown!r}. Seven days is the window a "
                f"yanked release is usually caught in"
            )

    def test_nothing_proposes_a_new_dependency_floor(self, dependabot: dict[str, Any]) -> None:
        """AT-172 -- the refusal, asserted rather than assumed."""
        configured = {entry.get("package-ecosystem") for entry in dependabot.get("updates") or []}
        overreach = sorted(configured & _REFUSED_ECOSYSTEMS)
        assert overreach == [], (
            f"the update configuration watches {overreach}, which proposes new dependency floors. The "
            f"floors in pyproject.toml are the range this package promises to work on and each one has a "
            f"reason written beside it; raising one is a decision, not maintenance"
        )


#: The marker expression that selects the tier which runs a shipped example as a subprocess.
_CONTRACT_SELECTION = "-m contract"

#: What the gate has to run. `--porcelain` is the machine-readable form and, unlike a bare `git status`,
#: it is empty on a clean tree, which is what makes it usable as a condition.
_TREE_QUERY = "git status --porcelain"


def _jobs_running_shipped_code() -> list[tuple[str, str, dict[str, Any]]]:
    """Every job in the repository that selects the contract tier, as ``(workflow file, job, job body)``.

    Found by what the job runs rather than by its name, because two of the three are not called
    ``contract``.
    """
    out: list[tuple[str, str, dict[str, Any]]] = []
    for path in (WORKFLOW_PATH, RELEASE_WORKFLOW_PATH):
        parsed = yaml.safe_load(path.read_text())
        for name, job in (parsed.get("jobs") or {}).items():
            if any(_CONTRACT_SELECTION in block for block in _run_blocks(job)):
                out.append((path.name, name, job))
    return out


class TestTheTierThatRunsShippedCodeLeavesNothingBehind:
    """``AT-173`` -- every job that runs a shipped example checks that it left no file behind.

    ``-m contract`` selects the storage quickstart alongside the tier, so one of the two examples in
    ``examples/`` is executed as a subprocess against a real server on every change rather than merely
    linted. A shipped example that leaves a file behind is a defect every reader inherits by copying it.

    **Every job that selects the tier, not just the one called ``contract``.** Three do: the contract job
    here, the SDK canary, and the release gate's own contract job.

    **What it cannot catch.** ``--porcelain`` respects ``.gitignore``, so the caches and coverage files
    that file already names stay invisible. What is left is a path nobody declared, which is the shape a
    stray artifact actually has.
    """

    def test_there_are_jobs_that_run_shipped_code(self) -> None:
        """AT-173 -- the vacuity guard: the contract job, the SDK canary and the release gate's contract job."""
        found = _jobs_running_shipped_code()
        assert len(found) >= 3, (
            f"the walk found {len(found)} jobs selecting {_CONTRACT_SELECTION!r} and at least three are "
            f"expected; a matcher that resolves nothing reports a clean result"
        )

    def test_each_of_them_asks_whether_the_tree_is_still_clean(self) -> None:
        """AT-173 -- the gate itself."""
        offenders = [
            f"{file}:{name}"
            for file, name, job in _jobs_running_shipped_code()
            if not any(_TREE_QUERY in block for block in _run_blocks(job))
        ]
        assert offenders == [], (
            f"these jobs run a shipped example as a subprocess and never ask what it left behind: "
            f"{offenders}. Add a step running `{_TREE_QUERY}` and failing on any output"
        )

    def test_the_question_is_asked_after_the_tier_rather_than_before(self) -> None:
        """AT-173 -- a clean tree before the run is the state every job starts in and proves nothing."""
        for file, name, job in _jobs_running_shipped_code():
            steps = job.get("steps") or []
            ran = next(
                (index for index, step in enumerate(steps) if _CONTRACT_SELECTION in (step.get("run") or "")),
                None,
            )
            asked = next(
                (index for index, step in enumerate(steps) if _TREE_QUERY in (step.get("run") or "")),
                None,
            )
            assert ran is not None and asked is not None, f"{file}:{name} is missing one of the two steps"
            assert asked > ran, (
                f"{file}:{name} checks the working tree at step {asked} and runs the tier at step {ran}. "
                f"Asked first, it reports the state the runner handed the job"
            )


#: The two extras that ship. ``all`` is a self-reference to these and declares no floor of its own; ``dev``
#: is not installed by any user, so a floor there is a fact about this repository and not about the package.
_SHIPPED_EXTRAS = ("storage", "memory")

#: A requirement specifier that states a floor, e.g. ``strands-agents>=1.54.0``. Anything without ``>=`` is
#: either a self-reference (``strands-mongodb[memory,storage]``) or a pin, and neither has a floor to check.
_FLOOR = re.compile(r"\A(?P<name>[A-Za-z0-9._-]+)>=(?P<version>[0-9][0-9A-Za-z.]*)\Z")


def _declared_floors() -> dict[str, str]:
    """Every runtime floor the manifest declares, as ``{distribution: version}``.

    Read out of ``pyproject.toml`` rather than listed here, which is the whole point: a floor added to an
    extra and not to the job below is a floor nothing installs, which is what the floor job exists to
    prevent.

    Returns:
        The floors, keyed by distribution name.
    """
    extras = _pyproject()["project"]["optional-dependencies"]
    floors: dict[str, str] = {}
    for extra in _SHIPPED_EXTRAS:
        for specifier in extras[extra]:
            matched = _FLOOR.match(specifier.strip())
            if matched:
                floors[matched["name"]] = matched["version"]
    return floors


def _floor_job(workflow: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """The job that installs the floors, identified by what it does rather than by its key.

    A job that pins a declared distribution with ``==`` is doing the one thing no other job in this file
    does. Finding it that way means renaming it changes nothing here.

    Args:
        workflow: The parsed workflow.

    Returns:
        The job's key and body.
    """
    floors = _declared_floors()
    found = [
        (name, job)
        for name, job in workflow["jobs"].items()
        if any(f"{distribution}==" in _job_text(job) for distribution in floors)
    ]
    assert len(found) == 1, (
        f"expected exactly one job pinning a declared floor with `==`; found {[name for name, _ in found]}"
    )
    return found[0]


def _job_text(job: dict[str, Any]) -> str:
    """Every ``run:`` script in a job, concatenated.

    Args:
        job: The parsed job.

    Returns:
        The scripts, newline-joined.
    """
    return "\n".join(str(step.get("run", "")) for step in job.get("steps", []))


class TestSomethingInstallsTheFloorsThePackageShips:
    """``AT-174`` -- a CI job installs every declared floor and runs the suite on it.

    ``sdk-compat`` resolves the newest ``strands-agents`` every Monday, which checks one end of the range
    this package promises. This job checks the other end, so a floor below the release that introduced a
    module the package imports fails on the change rather than on a user's install.

    **Read out of the manifest, not restated.** ``_declared_floors`` parses ``pyproject.toml``, so the
    assertion is against whatever is declared today rather than against a copy kept here. A new runtime
    dependency fails here on the change that adds it.

    **Found by behaviour, not by key.** ``_floor_job`` looks for the job that pins a declared distribution
    with ``==``. No other job in this file does that, and renaming this one breaks nothing.
    """

    def test_the_manifest_actually_declares_floors_to_check(self) -> None:
        """AT-174 -- the vacuity guard, and it guards a regex against a manifest it does not own."""
        floors = _declared_floors()
        assert len(floors) >= 4, (
            f"parsed {floors} out of the shipped extras, and at least four are expected; a "
            f"matcher that resolves nothing reports a clean result"
        )

    def test_a_job_installs_them(self, workflow: dict[str, Any]) -> None:
        """AT-174 -- that the job exists at all."""
        name, _ = _floor_job(workflow)
        assert name, "no job pins a declared floor"

    def test_every_declared_floor_is_pinned_there(self, workflow: dict[str, Any]) -> None:
        """AT-174 -- each one, at the version declared, so the resolver cannot lift one quietly.

        ``>=`` rewritten as ``==``. Installing the extras and hoping is not this: a resolver handed
        ``strands-agents>=1.54.0`` returns the newest release, which is what every other job already tests.
        """
        _, job = _floor_job(workflow)
        script = _job_text(job)
        for distribution, version in sorted(_declared_floors().items()):
            assert f"{distribution}=={version}" in script, (
                f"pyproject.toml declares {distribution}>={version} and the floor job does not install "
                f"{distribution}=={version}, so that floor is a promise nothing checks"
            )

    def test_it_runs_the_tests_rather_than_only_resolving(self, workflow: dict[str, Any]) -> None:
        """AT-174 -- a job that installs and stops asserts that pip can solve, which is not the claim."""
        _, job = _floor_job(workflow)
        assert "hatch run test" in _job_text(job), (
            "the floor job installs the floors and never runs the suite against them, so it checks that "
            "the versions resolve and not that the package works on them"
        )

    def test_it_runs_on_a_change_rather_than_on_the_schedule(self, workflow: dict[str, Any]) -> None:
        """AT-174 -- the mirror of ``AT-107``: a floor breaks when the code moves, not when time passes."""
        _, job = _floor_job(workflow)
        declared = frozenset(str(key) for key in _triggers(workflow))
        admitted = _admitted_events(job.get("if"), declared)
        assert {"pull_request", "push"} <= admitted, (
            f"the floor job runs on {sorted(admitted)}. An import added to a module is what invalidates a "
            f"floor, and that arrives in a pull request"
        )

    def test_it_runs_the_oldest_interpreter_the_package_claims(self, workflow: dict[str, Any]) -> None:
        """AT-174 -- because a resolver that hands back a floor is usually one an old Python constrained.

        Compared against ``requires-python`` rather than against a literal, for the same reason the floors
        are: raising the interpreter floor and leaving this job on 3.10 would test a combination the package
        no longer claims.
        """
        _, job = _floor_job(workflow)
        declared = str(_pyproject()["project"]["requires-python"])
        oldest = declared.removeprefix(">=").strip()

        versions = [
            str(step["with"]["python-version"])
            for step in job.get("steps", [])
            if isinstance(step.get("with"), dict) and "python-version" in step["with"]
        ]
        assert versions, "the floor job pins no interpreter, so it runs whatever the runner defaults to"
        assert versions == [oldest], (
            f"the floor job runs Python {versions} and pyproject.toml declares requires-python "
            f"{declared!r}; the floors describe the environment an old interpreter produces"
        )


def _typecheck_script() -> str:
    """The name of the hatch script that runs mypy, read from the scripts table rather than assumed.

    Found by what the script does, for the same reason ``_floor_job`` finds a job that way: the name
    ``typecheck`` is a convention and renaming it should change this file not at all.

    Returns:
        The script's key.
    """
    scripts = _pyproject()["tool"]["hatch"]["envs"]["default"]["scripts"]
    running = sorted(str(name) for name, body in scripts.items() if "mypy" in str(body))

    assert running, f"no hatch script runs mypy, so nothing here can find the type checker: {sorted(scripts)}"
    return running[0]


def _typecheck_jobs(workflow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every job that runs that script, keyed by job name.

    Args:
        workflow: The parsed workflow.

    Returns:
        The jobs, which is more than one: linting type-checks the tree and the SDK-compatibility job
        type-checks the Protocol assignment against an upgraded SDK.
    """
    script = _typecheck_script()
    return {name: job for name, job in workflow["jobs"].items() if f"hatch run {script}" in _job_text(job)}


class TestTheTypeCheckerAnalysesTheFloorAndRunsOnIt:
    """``AT-189`` -- two declarations about the oldest interpreter, both held to ``requires-python``.

    ``mypy`` analyses whatever ``[tool.mypy].python_version`` names, on whatever interpreter the job
    installed, and those are two separate numbers that both mean "the floor" today. Raising the floor and
    leaving one behind analyses a version the package no longer claims; lowering it and leaving one ahead
    ships a floor nothing analyses. Both are silent, and one of them is silent in a job whose whole purpose
    is a type-check.

    The interpreter matters as well as the target because dependency stubs come from the interpreter that
    installed them: the manifest's ``tomli`` entry is unmarked precisely so a checker analysing 3.10 finds
    the parser it would import there, and that only holds while the job runs the version it analyses.
    """

    def test_the_manifest_declares_a_version_to_analyse(self) -> None:
        """``AT-189`` -- the vacuity guard. With no target configured, mypy uses the running interpreter."""
        assert "python_version" in _pyproject()["tool"]["mypy"], (
            "pyproject.toml configures no `[tool.mypy].python_version`, so the analysis target is whichever "
            "interpreter the job happened to install and the two tests below compare nothing"
        )

    def test_the_type_checker_analyses_the_declared_floor(self) -> None:
        """``AT-189`` -- the floor is a support claim, and a checker aimed elsewhere never tests it."""
        declared = str(_pyproject()["project"]["requires-python"])
        oldest = declared.removeprefix(">=").strip()
        target = str(_pyproject()["tool"]["mypy"]["python_version"])

        assert target == oldest, (
            f"mypy analyses {target} and pyproject.toml declares requires-python {declared!r}. A syntax or "
            f"a typing feature the floor does not have passes the type check and fails on install"
        )

    def test_every_job_that_type_checks_runs_on_that_version(self, workflow: dict[str, Any]) -> None:
        """``AT-189`` -- found by behaviour, so a third job that type-checks is covered the day it lands."""
        target = str(_pyproject()["tool"]["mypy"]["python_version"])
        jobs = _typecheck_jobs(workflow)
        assert len(jobs) >= 2, (
            f"found {sorted(jobs)} running the type checker, and at least two are expected: "
            f"linting and SDK compatibility. A matcher that resolves nothing reports a clean result"
        )

        for name, job in sorted(jobs.items()):
            versions = [
                str(step["with"]["python-version"])
                for step in job.get("steps", [])
                if isinstance(step.get("with"), dict) and "python-version" in step["with"]
            ]
            running = versions or ["whatever the runner defaults to"]
            assert versions == [target], (
                f"job {name!r} runs the type checker on Python {running} while mypy analyses {target}; the "
                f"stubs a checker resolves are the interpreter's, not the target's"
            )


#: Which contexts GitHub makes available at each job-level key, transcribed from the "Context
#: availability" table in the Actions documentation. Only the keys these two workflows actually put an
#: expression under are listed, and a key that is missing fails this gate rather than passing it: the
#: right answer for a row nobody transcribed is "go and read the table", not "assume it is allowed".
#:
#: The four contexts that make this worth checking are ``runner``, ``job``, ``env`` and ``steps``. None
#: of them appears in any row below, and all four are available in every step key -- which is exactly why
#: the mistake is easy to make and impossible to see by reading. They are not blanket step-only: the table
#: does admit them at ``environment.url``, ``outputs.<id>``, ``container.env.<id>``, ``container.credentials``
#: and the two ``services`` equivalents. Neither workflow uses any of those keys today, so none is
#: transcribed; adding one lands here as a missing row rather than as a false failure.
_JOB_LEVEL_CONTEXTS: dict[str, frozenset[str]] = {
    "env": frozenset({"github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"}),
    "if": frozenset({"github", "needs", "vars", "inputs"}),
    "name": frozenset({"github", "needs", "strategy", "matrix", "vars", "inputs"}),
    "runs-on": frozenset({"github", "needs", "strategy", "matrix", "vars", "inputs"}),
    "timeout-minutes": frozenset({"github", "needs", "strategy", "matrix", "vars", "inputs"}),
    "concurrency": frozenset({"github", "needs", "strategy", "matrix", "vars", "inputs"}),
    "strategy": frozenset({"github", "needs", "vars", "inputs"}),
    # No `secrets`, which is the one difference from `env` above and the reason this is its own row rather
    # than a shared frozenset: a service image pulled from a secret is a plausible edit and GitHub refuses
    # to start the run for it.
    #
    # Read against the bare `jobs.<job_id>.services` row. This gate attributes an expression to the
    # top-level job key it was found under, and the table gives `services.<service_id>.env.<env_id>` a
    # wider row of its own -- `job`, `runner`, `env` and `steps` are all admitted there. Nothing puts an
    # expression under a service's `env` or `credentials` today; the first thing that does will fail here
    # falsely, and the remedy is to make the walk read the path rather than to widen this row.
    "services": frozenset({"github", "needs", "strategy", "matrix", "vars", "inputs"}),
}

#: Every context name GitHub defines. Used to filter the matcher below, because the same syntax that
#: introduces a context also introduces a field of one: in ``github.event.pull_request.number`` only
#: ``github`` is the context and the rest is a path through it. A name outside this set is a function
#: call or a nested field, and either way it is not what this gate is about.
_CONTEXT_NAMES = frozenset(
    {"github", "env", "vars", "job", "jobs", "steps", "runner", "secrets", "strategy", "matrix", "needs", "inputs"}
)

#: An expression, and the contexts named at the head of a path inside one. The lookbehind is what
#: distinguishes a context from a field: ``runner`` in ``runner.temp`` matches, ``event`` in
#: ``github.event.pull_request`` does not, and ``hashFiles`` in ``hashFiles('x')`` is followed by a
#: bracket this does not accept.
_EXPRESSION = re.compile(r"\$\{\{(.*?)\}\}", re.DOTALL)
_CONTEXT_HEAD = re.compile(r"(?<![\w.])([A-Za-z][A-Za-z0-9_-]*)\s*[.\[]")


def _expressions_in(value: Any) -> list[str]:
    """Every ``${{ ... }}`` body anywhere inside a parsed YAML value, at any depth."""
    if isinstance(value, str):
        return [match.group(1) for match in _EXPRESSION.finditer(value)]
    if isinstance(value, dict):
        return [found for item in value.values() for found in _expressions_in(item)]
    if isinstance(value, list):
        return [found for item in value for found in _expressions_in(item)]
    return []


def _every_job() -> list[tuple[str, str, dict[str, Any]]]:
    """Every job in the repository, as ``(workflow file, job key, job)``."""
    out: list[tuple[str, str, dict[str, Any]]] = []
    for path in (WORKFLOW_PATH, RELEASE_WORKFLOW_PATH):
        parsed = yaml.safe_load(path.read_text())
        assert isinstance(parsed, dict), f"{path.name} did not parse as a mapping"
        out.extend((path.name, str(name), job) for name, job in (parsed.get("jobs") or {}).items())
    return out


def _job_level_expressions() -> list[tuple[str, str, str, str, frozenset[str]]]:
    """Every expression outside ``steps``, as ``(file, job, job key, expression, contexts named)``.

    Keyed by the job-level key rather than by the full path, because that is the granularity the
    documented table has: ``jobs.<job_id>.env`` admits one set of contexts and every value under it
    admits the same set.
    """
    found: list[tuple[str, str, str, str, frozenset[str]]] = []
    for file_name, job_name, job in _every_job():
        for key, value in job.items():
            if key == "steps":
                continue
            # `if` is the one key whose value is an expression without being wrapped in one, and it is
            # also the job-level key most likely to carry a context: all seven jobs in ci-python.yml
            # choose their events with it. A walk that only looked for `${{` would have found three
            # expressions across the two files and reported them clean.
            bare = [str(value)] if key == "if" and "${{" not in str(value) else []
            for expression in _expressions_in(value) + bare:
                named = frozenset(_CONTEXT_HEAD.findall(expression)) & _CONTEXT_NAMES
                found.append((file_name, job_name, str(key), expression.strip(), named))
    return found


class TestNoJobLevelKeyNamesAContextThatIsNotThere:
    """``AT-175`` -- an expression GitHub refuses to start the run for.

    A value such as ``PIP_CONSTRAINT: ${{ runner.temp }}/floors.txt`` in a job-level ``env:`` block is one.
    ``runner`` is not one of the contexts available to ``jobs.<job_id>.env``; it exists only once a runner
    has been assigned, which is after the point the workflow file is parsed. The result is not a failing
    job. It is a failing *run*, which completes in zero seconds with no jobs, no annotations and no log,
    under the message "This run likely failed because of a workflow file issue."

    **Why the structural gates in this module cannot see it.** They parse the file with PyYAML and assert
    on the structure, and such a file is structurally fine: valid YAML, correct keys, the pins present, the
    tests invoked. Only GitHub's expression evaluator rejects the value. The whole class is checkable from a
    transcribed table, which is what ``_JOB_LEVEL_CONTEXTS`` is.

    **And why it matters more than a broken job would.** A startup failure takes every gate down at once
    and reports as a single red entry beside whatever other checks the repository runs, so a pull
    request whose entire test suite never ran looks, at a glance, like a pull request with one unrelated
    problem.
    """

    def test_the_walk_reads_every_job_in_both_files(self) -> None:
        """AT-175 -- a table lookup over an empty list is a clean report about nothing.

        Two bounds rather than one, because the two failure modes are different. Reading no jobs is a
        renamed file or a changed schema; reading every job and finding no expression would be a broken
        matcher, and the ``if`` handling above is exactly the kind of thing that silently stops matching.
        """
        assert len({file for file, _, _ in _every_job()}) == 2, (
            "the walk read one of the two workflow files, or neither; both paths are asserted to exist "
            "elsewhere in this module, so this is the schema changing under it"
        )
        assert len(_every_job()) >= 11, f"the walk found {len(_every_job())} jobs and at least eleven are expected"

        found = _job_level_expressions()
        assert len(found) >= 10, (
            f"the walk found {len(found)} job-level expressions and at least ten are expected; "
            f"a matcher that resolves nothing passes"
        )

    def test_every_job_level_key_it_finds_has_a_transcribed_row(self) -> None:
        """AT-175 -- the gate is a lookup, so an untranscribed key must fail rather than be skipped."""
        missing = sorted({key for _, _, key, _, _ in _job_level_expressions() if key not in _JOB_LEVEL_CONTEXTS})
        assert missing == [], (
            f"these job-level keys carry an expression and are not in _JOB_LEVEL_CONTEXTS: {missing}. "
            f"Read the row out of the Actions 'Context availability' table and add it, rather than "
            f"leaving a key this gate silently has no opinion about"
        )

    def test_every_expression_names_only_contexts_available_where_it_sits(self) -> None:
        """AT-175 -- every job-level expression in both files names only contexts available at its key."""
        offenders = [
            f"{file}:{job}:{key} -> ${{{{ {expression} }}}} names {sorted(named - _JOB_LEVEL_CONTEXTS[key])}"
            for file, job, key, expression, named in _job_level_expressions()
            if key in _JOB_LEVEL_CONTEXTS and not named <= _JOB_LEVEL_CONTEXTS[key]
        ]
        assert offenders == [], (
            f"these expressions name a context GitHub does not provide at that key, which fails the whole "
            f"run at startup rather than the job: {offenders}. A value needing `runner`, `job`, `env` or "
            f"`steps` belongs in a step: write it into $GITHUB_ENV from one, as the floor job does"
        )

    def test_the_floor_job_exports_the_constraint_it_writes(self) -> None:
        """AT-175 -- the outcome, not the side effect: an unexported constraint file constrains nothing.

        Moving the two variables into a step is only a fix if they still reach the install. Written as a
        gate rather than left to review because the failure is silent in the direction that matters:
        ``pip`` with no ``PIP_CONSTRAINT`` resolves the newest of everything and the job passes, having
        tested the same combination the matrix already tests.
        """
        _, job = _floor_job(yaml.safe_load(WORKFLOW_PATH.read_text()))
        exported = "\n".join(
            str(step.get("run") or "") for step in job.get("steps") or [] if "$GITHUB_ENV" in str(step.get("run") or "")
        )
        for variable in ("PIP_CONSTRAINT", "UV_CONSTRAINT"):
            assert f"{variable}=" in exported, (
                f"the floor job never puts {variable} into $GITHUB_ENV, so the constraint file it writes "
                f"is read by nothing and `hatch run test` resolves whatever the `>=` specifiers allow"
            )


class TestTheThrowawayClusterIsAlwaysDeleted:
    """AT-234 -- the cluster job's own shape, because each run is billed until it is deleted."""

    @staticmethod
    def _job(workflow: dict[str, Any]) -> dict[str, Any]:
        (job,) = _cluster_jobs(workflow).values()
        return job

    def test_teardown_runs_whatever_happened_before_it(self, workflow: dict[str, Any]) -> None:
        """AT-234 -- a failed or cancelled run must still delete what it created."""
        steps = self._job(workflow)["steps"]
        teardown = [step for step in steps if "atlas_ci_cluster.py down" in str(step.get("run", ""))]

        assert len(teardown) == 1, f"expected one teardown step, found {len(teardown)}"
        assert teardown[0].get("if") == "always()", f"the teardown runs only if {teardown[0].get('if')!r}"
        assert steps[-1] is teardown[0], "a step after the teardown would run against a deleted cluster"

    def test_the_cluster_is_named_before_it_is_created(self, workflow: dict[str, Any]) -> None:
        """AT-234 -- so the teardown can find a cluster that ``up`` created and then failed on."""
        name = str((self._job(workflow).get("env") or {}).get("ATLAS_CI_CLUSTER", ""))

        assert name.startswith("sm-ci-") and "github.run_id" in name and "github.run_attempt" in name

    def test_the_cloud_credentials_reach_only_the_steps_that_create_and_delete(self, workflow: dict[str, Any]) -> None:
        """AT-234 -- the test step needs a connection string, not the power to create clusters."""
        job = self._job(workflow)
        assert not any(
            name in (job.get("env") or {}) for name in ("MONGODB_ATLAS_CLIENT_ID", "MONGODB_ATLAS_CLIENT_SECRET")
        )
        for step in job["steps"]:
            holds = any(
                name in (step.get("env") or {}) for name in ("MONGODB_ATLAS_CLIENT_ID", "MONGODB_ATLAS_CLIENT_SECRET")
            )
            manages = "atlas_ci_cluster.py" in str(step.get("run", ""))
            assert holds == manages, (
                f"step {step.get('name')!r}: holds the credential {holds}, manages the cluster {manages}"
            )

    def test_one_run_at_a_time(self, workflow: dict[str, Any]) -> None:
        """AT-234 -- ``up`` deletes stale clusters, which is only safe when no other run owns one."""
        concurrency = self._job(workflow).get("concurrency") or {}

        assert "${{" not in str(concurrency.get("group", "${{")), "the group must be one fixed name"
        assert concurrency.get("cancel-in-progress") is False, "cancelling a run would skip its teardown"

    def test_the_cli_is_a_pinned_release_checked_against_its_checksum(self, workflow: dict[str, Any]) -> None:
        """AT-234 -- the binary that holds the credentials is the one MongoDB published, byte for byte."""
        (install,) = [step for step in self._job(workflow)["steps"] if "mongodb-atlas-cli" in str(step.get("run", ""))]

        assert re.fullmatch(r"\d+\.\d+\.\d+", str(install["env"]["ATLAS_CLI_VERSION"]))
        assert re.fullmatch(r"[0-9a-f]{64}", str(install["env"]["ATLAS_CLI_SHA256"]))
        assert "sha256sum --check" in install["run"]


class TestEveryMongoDBContainerRunsOnAKernelItAccepts:
    """AT-235 / ``REQ-E-227`` -- MongoDB 8.x refuses to start on Linux kernel 6.19 and newer.

    ``ubuntu-latest`` moved to such a kernel with runner image 20261025, and a service container that cannot
    start fails its job before a test runs. Until MongoDB lifts the guard (SERVER-125742), every job that starts
    a MongoDB container runs on ``ubuntu-22.04``, whose kernel is 6.8.
    """

    def test_jobs_with_a_mongodb_container_avoid_the_newest_kernel(self) -> None:
        for path in (WORKFLOW_PATH, RELEASE_WORKFLOW_PATH):
            for name, job in yaml.safe_load(path.read_text())["jobs"].items():
                if job.get("services"):
                    assert job.get("runs-on") == "ubuntu-22.04", f"{path.name}:{name} runs on {job.get('runs-on')}"


@pytest.fixture(scope="module")
def zizmor_workflow() -> dict[str, Any]:
    """The parsed security-analysis workflow.

    Fails rather than skips when absent, like the other workflow fixtures: a scan that is not there is
    indistinguishable, from a passing pull request, from a scan that found nothing.
    """
    assert ZIZMOR_WORKFLOW_PATH.is_file(), f"no workflow security analysis at {ZIZMOR_WORKFLOW_PATH}"
    parsed = yaml.safe_load(ZIZMOR_WORKFLOW_PATH.read_text())
    assert isinstance(parsed, dict), "the security-analysis workflow did not parse as a mapping"
    return parsed


class TestTheWorkflowsAreThemselvesScanned:
    """``AT-244`` -- the rest of this file reads the workflows for what they say; zizmor reads them as code.

    The two do not overlap. This suite knows what it thought to assert, and the gaps are the interesting
    part: template injection into a ``run:`` block, a token broader than its job, a mutable action
    reference, a credential persisted into ``.git/config``. Those are classes of defect nobody writes a
    bespoke assertion for, which is the argument for a scanner rather than another test class here.

    What is asserted is that the scan runs, that it runs on the workflows' own changes, and that it does
    not quietly become weaker than the thing it is checking. An analysis job pulling an action from a
    mutable tag would be exactly the finding it exists to report.
    """

    def test_the_scan_runs_on_a_change_to_a_workflow(self, zizmor_workflow: dict[str, Any]) -> None:
        """AT-244 -- a scan nothing triggers is a file, not a gate."""
        triggers = _triggers(zizmor_workflow)
        assert set(triggers) >= {"pull_request", "push"}, (
            f"the security analysis triggers on {sorted(triggers)}. A change to a workflow arrives as a "
            f"pull request, so a scan that does not run on one reports nothing until after the merge"
        )
        for event in ("pull_request", "push"):
            paths = (triggers.get(event) or {}).get("paths") or []
            assert any(entry.startswith(".github/workflows/") for entry in paths), (
                f"the {event!r} trigger watches {paths}, none of which covers .github/workflows/. The scan "
                f"would not run on a change to the very files it reads"
            )

    def test_the_scan_is_pinned_to_a_digest(self, zizmor_workflow: dict[str, Any]) -> None:
        """AT-244 -- the analysis job holds the strictest version of the rule it enforces."""
        for job_name, job in (zizmor_workflow.get("jobs") or {}).items():
            for step in job.get("steps") or []:
                uses = step.get("uses")
                if not uses:
                    continue
                reference = uses.rpartition("@")[2]
                assert _DIGEST.fullmatch(reference), (
                    f"zizmor.yml:{job_name} runs {uses}, whose reference {reference!r} is not a "
                    f"40-character digest. A tag moves, including onto a compromised release, and this is "
                    f"the job that would otherwise have reported that"
                )

    def test_the_scan_takes_only_the_permission_it_files_results_with(self, zizmor_workflow: dict[str, Any]) -> None:
        """AT-244 -- least privilege, asserted on the job that checks other jobs for it.

        ``security-events: write`` is the permission a SARIF upload needs. This repository has Code
        Security disabled, so there is no upload and the permission would be unused -- which is itself
        a zizmor finding. What is asserted is that the two agree: the token the job holds and the way
        it reports findings are one decision, and enabling either without the other is the bug.
        """
        assert zizmor_workflow.get("permissions") == {"contents": "read"}, (
            f"the security-analysis workflow declares top-level permissions "
            f"{zizmor_workflow.get('permissions')!r} rather than {{'contents': 'read'}}"
        )
        for job_name, job in (zizmor_workflow.get("jobs") or {}).items():
            granted = job.get("permissions") or {}
            assert set(granted) <= {"contents", "security-events"}, (
                f"zizmor.yml:{job_name} grants {sorted(granted)}. Filing code scanning alerts needs "
                f"security-events, and reading the tree needs contents; anything further is unexplained"
            )
            for step in job.get("steps") or []:
                if "zizmor-action" not in (step.get("uses") or ""):
                    continue
                uploads = str((step.get("with") or {}).get("advanced-security", "true")).lower() == "true"
                assert uploads == (granted.get("security-events") == "write"), (
                    f"zizmor.yml:{job_name} sets advanced-security={uploads} but "
                    f"security-events={granted.get('security-events')!r}. Uploading SARIF without the "
                    f"permission fails the job on the upload rather than on the findings; holding the "
                    f"permission without uploading is a token the job cannot use"
                )
                if not uploads:
                    assert str((step.get("with") or {}).get("annotations", "")).lower() == "true", (
                        f"zizmor.yml:{job_name} neither uploads to code scanning nor emits annotations, "
                        f"so a finding would appear only in the job log"
                    )

    def test_the_scanner_itself_is_pinned_to_a_version(self, zizmor_workflow: dict[str, Any]) -> None:
        """AT-244 -- a gate whose version floats is a gate that changes without review.

        The action resolves ``latest`` at run time by default. zizmor 1.32.0 promoted ``unpinned-uses``
        to a default audit; on a floating version that arrives as an unexplained red build on an
        unrelated pull request. Raising the pin is a change someone reads.
        """
        for job_name, job in (zizmor_workflow.get("jobs") or {}).items():
            for step in job.get("steps") or []:
                if "zizmor-action" not in (step.get("uses") or ""):
                    continue
                version = str((step.get("with") or {}).get("version", "latest"))
                assert re.fullmatch(r"\d+\.\d+\.\d+", version), (
                    f"zizmor.yml:{job_name} runs zizmor {version!r} rather than an exact release. A new "
                    f"zizmor version then changes what this gate enforces with no change to this file"
                )

    def test_every_suppression_is_argued(self) -> None:
        """AT-244 -- an exception file is only worth having if nothing lands in it silently."""
        assert ZIZMOR_CONFIG_PATH.is_file(), f"no zizmor configuration at {ZIZMOR_CONFIG_PATH}"
        parsed = yaml.safe_load(ZIZMOR_CONFIG_PATH.read_text()) or {}
        commentary = [line for line in ZIZMOR_CONFIG_PATH.read_text().splitlines() if line.lstrip().startswith("#")]
        for rule, body in (parsed.get("rules") or {}).items():
            ignored = (body or {}).get("ignore") or []
            assert ignored, f"the configuration names rule {rule!r} but ignores nothing under it"
            assert len(commentary) >= 3 * len(ignored), (
                f"the configuration suppresses {len(ignored)} finding(s) under {rule!r} with "
                f"{len(commentary)} comment lines in the whole file. A suppression is an argument about "
                f"why the rule is right in general and wrong here, and an unargued one is just a silenced "
                f"finding"
            )
