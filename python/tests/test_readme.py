"""The two READMEs and the migration guide, read as source rather than as prose.

Every test here reads ``python/README.md``, the repository-root ``README.md`` or ``python/MIGRATION.md``
and compares it against something that cannot drift silently: a running interpreter, a ``TypedDict``, a
command renderer, a deployment, or ``pyproject.toml``.

The migration guide shares this sweep rather than having one of its own, so its procedures obey the same
directive rule as a quickstart. ``test_migration.py`` covers what the guide claims; this file covers what
it runs.

Each fenced block declares what happens to it in an HTML comment on the line above the fence:

======================================  ===================================================================
Directive                               Means
======================================  ===================================================================
``<!-- run: unit -->``                  executed with every tier variable emptied, so no deployment
                                        is reachable
``<!-- run: contract -->``              executed against ``MONGODB_URI``
``<!-- run: autoembed -->``             executed against ``MONGODB_AUTOEMBED_URI``, which needs a
                                        registered Atlas embedding model
``<!-- run: mongosh -->``               a ``db.runCommand`` line, compared against the renderer that
                                        produces it and sent to the deployment where it is cheap
``<!-- skip: <reason> -->``             not executed, and the reason is part of the document
======================================  ===================================================================

A block with an executable language and no directive fails ``TestEveryBlockDeclaresWhatHappensToIt``.
That is the point of the mechanism: executing a snippet is the default, and not executing one is a
decision written down where a reviewer can see it.

Snippets read their deployment and database from the environment, which is what makes them runnable
here and also keeps credentials out of the documents: a literal connection string in a document is how a
password gets published.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import os
import re
import subprocess
import sys
import time
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any, get_args

import pytest
from conftest import skip_if_search_is_unreachable
from pymongo import AsyncMongoClient, monitoring
from pymongo.auth import MECHANISMS
from pymongo.errors import OperationFailure
from strands.types.exceptions import StorageError

from strands_mongodb import _client, _indexes, _pipeline, _telemetry
from strands_mongodb.memory_store import DEFAULT_COLLECTION, MongoDBMemoryStore
from strands_mongodb.storage import MAX_DOCUMENT_BYTES, MAX_KEY_BYTES, MongoDBStorage
from strands_mongodb.types import (
    DEFAULT_MAX_SEARCH_RESULTS,
    DEFAULT_OVERSAMPLING_FACTOR,
    RESERVED_METADATA_KEYS,
    MongoDBConfig,
    MongoDBMemoryStoreConfig,
    MongoDBSearchQuery,
)

# tests/ -> python/ -> the repository root, which holds the landing-page README.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_PACKAGE_README = _PROJECT_ROOT / "README.md"
_ROOT_README = _PROJECT_ROOT.parent / "README.md"
_PYPROJECT = _PROJECT_ROOT / "pyproject.toml"

# Languages a reader can paste into something that runs it. `bash` is on the list on purpose: exempting
# it by language would put the exemption in this file, where a reader of the README cannot see it. `text`
# and an unlabelled fence are not, since neither claims to run anywhere.
_EXECUTABLE_LANGUAGES = frozenset({"python", "py", "bash", "sh", "shell", "javascript", "js"})

_DIRECTIVE = re.compile(r"^<!--\s*(?P<kind>run|skip):\s*(?P<value>[^>]+?)\s*-->$")
_FENCE = re.compile(r"^```(?P<language>[A-Za-z0-9_+-]*)\s*$")

# A credential in a document, in any file, in any language. Matches `test_examples.py`'s guard on the
# example output for the same reason: the redaction placeholder is the only thing allowed in the
# userinfo position, and a partial redaction still reads as a leak.
_CREDENTIALED_URI = re.compile(r"mongodb(\+srv)?://(?!<redacted>@)[^\s/`]*@")

# What a documented `db.runCommand(...)` line looks like, so the argument can be compared as JSON
# rather than as text. `_indexes` renders it with `json.dumps`, so the spacing is fixed, but comparing
# parsed arguments means a reader may reformat the block without breaking the test.
_RUN_COMMAND = re.compile(r"^db\.runCommand\((?P<argument>.+)\)$")


@dataclass(frozen=True)
class Block:
    """One fenced code block, with the directive that governs it.

    Attributes:
        path: File the block came from.
        line: 1-based line of the opening fence, so a failure message points at it.
        language: Fence language, lowercased. ``""`` for an unlabelled fence.
        kind: ``"run"``, ``"skip"``, or ``""`` when the block carries no directive.
        value: Tier name for ``run``, reason for ``skip``, ``""`` for neither.
        body: The block's contents, without the fences.
    """

    path: Path
    line: int
    language: str
    kind: str
    value: str
    body: str

    @property
    def where(self) -> str:
        """Return a clickable location for a failure message.

        Returns:
            ``<path>:<line>``, with the path relative to the repository root.
        """
        return f"{self.path.relative_to(_ROOT_README.parent)}:{self.line}"

    @property
    def executable(self) -> bool:
        """Whether this block's language is one a reader can run.

        Returns:
            ``True`` for a language in :data:`_EXECUTABLE_LANGUAGES`.
        """
        return self.language in _EXECUTABLE_LANGUAGES


def _blocks(path: Path) -> tuple[Block, ...]:
    """Parse every fenced code block out of one Markdown file.

    A hand-rolled scan rather than a Markdown library, because the thing being read is a directive in
    an HTML comment immediately above a fence, which is a document convention rather than Markdown
    structure. It also keeps the test suite's dependency set as it is.

    Args:
        path: The Markdown file.

    Returns:
        Every block in document order, each carrying the directive that preceded it, if any.
    """
    found: list[Block] = []
    directive: tuple[str, str] | None = None
    language: str | None = None
    body: list[str] = []
    opened_at = 0

    for number, line in enumerate(path.read_text().splitlines(), start=1):
        fence = _FENCE.match(line)
        if language is None:
            if fence:
                language, opened_at = fence.group("language").lower(), number
                continue
            match = _DIRECTIVE.match(line.strip())
            # A directive only governs the fence directly below it. Anything else between the two
            # resets it, so a comment left behind by an edit cannot silently adopt the next block.
            directive = (match.group("kind"), match.group("value")) if match else None
            continue
        if fence and not fence.group("language"):
            kind, value = directive or ("", "")
            found.append(
                Block(
                    path=path,
                    line=opened_at,
                    language=language,
                    kind=kind,
                    value=value,
                    body="\n".join(body) + "\n",
                )
            )
            directive, language, body = None, None, []
            continue
        body.append(line)

    assert language is None, f"{path.name} has an unclosed fence opened at line {opened_at}"
    return tuple(found)


_PACKAGE_BLOCKS = _blocks(_PACKAGE_README)
_ROOT_BLOCKS = _blocks(_ROOT_README)

# The migration guide joins the sweep rather than getting its own copy of it. Its procedures are the
# snippets in this repository most likely to be run against real data, so the directive rule, the
# credential rule and the tier runners apply to them by inheritance. What the guide *says* is
# `test_migration.py`'s subject; what it *runs* is this file's.
_MIGRATION_GUIDE = _PROJECT_ROOT / "MIGRATION.md"
_MIGRATION_BLOCKS = _blocks(_MIGRATION_GUIDE)

_DOCUMENTS = (_PACKAGE_README, _ROOT_README, _MIGRATION_GUIDE)
_ALL_BLOCKS = _PACKAGE_BLOCKS + _ROOT_BLOCKS + _MIGRATION_BLOCKS


def _selected(tier: str) -> list[Block]:
    """Return every block whose directive runs it on one tier.

    Args:
        tier: ``"unit"``, ``"contract"``, ``"autoembed"`` or ``"mongosh"``.

    Returns:
        The blocks, in document order across both files.
    """
    return [block for block in _ALL_BLOCKS if block.kind == "run" and block.value == tier]


def _identifiers(blocks: list[Block]) -> list[str]:
    """Return parametrize ids naming the file and line of each block.

    Args:
        blocks: Blocks about to be parametrized over.

    Returns:
        One id per block, so a failure names the location rather than an index.
    """
    return [block.where for block in blocks]


def _run(body: str, environment: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Execute one snippet in a child interpreter.

    ``check=False``, so a failing snippet is reported with its own traceback rather than as a
    ``CalledProcessError`` whose message hides it.

    Args:
        body: The snippet, exactly as the README carries it.
        environment: Full environment for the child.

    Returns:
        The completed process.
    """
    return subprocess.run(
        [sys.executable, "-c", body],
        capture_output=True,
        text=True,
        env=environment,
        cwd=_PROJECT_ROOT,
        check=False,
    )


def _unconfigured() -> dict[str, str]:
    """Return an environment with every tier variable emptied.

    A ``unit`` snippet has to run where nothing is reachable, and this process inherits a live
    ``MONGODB_URI`` whenever ``.env`` holds one, so emptying is the only way to test what a reader
    with no cluster sees. Empty rather than unset, matching the suite's own opt-out.

    Returns:
        A copy of this environment with the three tier variables set to ``""``.
    """
    return {**os.environ, "MONGODB_URI": "", "MONGODB_ATLAS_URI": "", "MONGODB_AUTOEMBED_URI": ""}


def _documented_keys(marker: str) -> dict[str, str]:
    """Read one configuration table out of the package README.

    The table is found by an HTML comment naming the type it documents, so a reordering of the README
    cannot make the test read the wrong table.

    Args:
        marker: The type name in ``<!-- keys: <name> -->``.

    Returns:
        Key name to the verbatim ``Required`` cell, for every row of that table.
    """
    lines = _PACKAGE_README.read_text().splitlines()
    try:
        start = lines.index(f"<!-- keys: {marker} -->")
    except ValueError:  # pragma: no cover - the failure is asserted by the caller
        return {}

    rows: dict[str, str] = {}
    for line in lines[start + 1 :]:
        if not line.startswith("|"):
            if rows:
                break
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 3 or cells[0] in {"Key", ""} or set(cells[0]) <= {"-", ":"}:
            continue
        rows[cells[0].strip("`")] = cells[2]
    return rows


def _annotation_text(annotation: object) -> str:
    """Return one annotation as the source text the module wrote.

    Three shapes reach here for the same declaration. Under ``from __future__ import annotations`` on
    3.10 through 3.13 the value is a string; on 3.14 PEP 649 hands back a ``ForwardRef`` wrapping that
    string; and an eagerly evaluated annotation is the object itself.

    Args:
        annotation: A value from ``__annotations__``.

    Returns:
        Text containing ``Required[`` when the key was declared required.
    """
    if isinstance(annotation, str):
        return annotation
    return str(getattr(annotation, "__forward_arg__", annotation))


def _annotated_keys(typed_dict: Any) -> tuple[frozenset[str], frozenset[str]]:
    """Return the key set and the required subset of one ``TypedDict``.

    ``__annotations__`` rather than ``get_type_hints``, because ``types.py`` imports
    ``AsyncMongoClient`` under ``TYPE_CHECKING`` and resolving the annotations therefore raises
    ``NameError``. ``TypedDict`` merges ``__annotations__`` across bases, so this still sees the five
    keys ``MongoDBMemoryStoreConfig`` inherits from the SDK, which are part of what a caller passes and
    so part of what the README owes them.

    Required-ness comes from the annotation text and not from ``__required_keys__``, which
    ``test_types.py`` measured as an empty frozenset for all three of these classes: postponed
    evaluation means ``TypedDict`` never sees the ``Required[...]`` wrapper at class creation. Type
    checkers read the source and disagree with the runtime here, and the README documents what the type
    checker enforces.

    Args:
        typed_dict: The class.

    Returns:
        Every key, then the ones declared ``Required``.
    """
    annotations = dict(typed_dict.__annotations__)
    required = {name for name, value in annotations.items() if "Required[" in _annotation_text(value)}
    return frozenset(annotations), frozenset(required)


class TestEveryBlockDeclaresWhatHappensToIt:
    """``AT-097`` -- the sweep that makes every other test in this file mandatory rather than optional.

    Executing the snippets proves the executed ones work. It says nothing about the next snippet added,
    which is the one most likely to be wrong. So the default is execution and an exemption has to be
    written down.
    """

    def test_every_executable_block_carries_a_directive(self) -> None:
        """AT-097 -- a ``python`` or ``javascript`` block with no directive fails here."""
        undeclared = [block.where for block in _ALL_BLOCKS if block.executable and not block.kind]
        assert undeclared == [], (
            f"these code blocks declare neither a run tier nor a skip reason: {undeclared}. Add "
            f"'<!-- run: unit -->', '<!-- run: contract -->', '<!-- run: autoembed -->', "
            f"'<!-- run: mongosh -->' or '<!-- skip: <reason> -->' on the line above the fence."
        )

    def test_every_skip_states_a_reason(self) -> None:
        """AT-097 -- ``skip`` with an empty or placeholder reason is the same as no directive."""
        unexplained = [block.where for block in _ALL_BLOCKS if block.kind == "skip" and len(block.value.split()) < 3]
        assert unexplained == [], f"these skips do not say why in a sentence: {unexplained}"

    def test_every_run_directive_names_a_tier_the_suite_runs(self) -> None:
        """AT-097 -- a typo in a tier name would silently exempt a block from every test below."""
        known = {"unit", "contract", "autoembed", "mongosh"}
        unknown = [
            (block.where, block.value) for block in _ALL_BLOCKS if block.kind == "run" and block.value not in known
        ]
        assert unknown == [], f"unrecognised run tiers, which no test below would pick up: {unknown}"

    def test_no_document_in_the_sweep_carries_a_credential(self) -> None:
        """AT-097 -- no document carries a connection string with credentials in it.

        Over the whole file rather than over the code blocks, because prose is where a URI gets pasted
        while explaining what a URI looks like. The migration guide carries the most risk of the three:
        its reader has an old deployment and a new one, so it is the document most likely to have both
        written out.
        """
        for path in _DOCUMENTS:
            found = _CREDENTIALED_URI.findall(path.read_text())
            assert found == [], f"{path.name} contains a connection string with credentials in it"

    def test_every_connecting_snippet_reads_its_deployment_from_the_environment(self) -> None:
        """AT-097 -- the positive half: the snippets show the habit, not just avoid the leak.

        A reader copies the snippet before reading the paragraph above it, so where the URI comes from is
        the snippet's job to demonstrate.
        """
        for block in _ALL_BLOCKS:
            if block.language != "python":
                continue
            if "connection_string" not in block.body and "AsyncMongoClient(" not in block.body:
                continue
            assert "os.environ" in block.body, (
                f"{block.where} builds a connection without reading the URI from the environment"
            )


class TestTheQuickstartsRun:
    """``AT-092`` -- the quickstart is executed from the README text, not transcribed.

    A quickstart is the one snippet every reader runs, so it is the one snippet that must not be stale.
    Copying it into a test file would only prove the copy works.
    """

    def test_there_is_a_quickstart_for_each_backend(self) -> None:
        """AT-092 -- both backends need one, and an empty parametrize below would pass silently."""
        bodies = "\n".join(block.body for block in _ALL_BLOCKS if block.kind == "run")
        assert "MongoDBStorage" in bodies, "no executed snippet constructs a MongoDBStorage"
        assert "MongoDBMemoryStore" in bodies, "no executed snippet constructs a MongoDBMemoryStore"

    @pytest.mark.parametrize("block", _selected("unit"), ids=_identifiers(_selected("unit")))
    def test_the_unit_blocks_run_with_nothing_reachable(self, block: Block) -> None:
        """AT-092 -- import-only and construction-only snippets, run where no deployment answers."""
        completed = _run(block.body, _unconfigured())
        assert completed.returncode == 0, f"{block.where} failed:\n{completed.stderr}"

    @pytest.mark.contract
    @pytest.mark.parametrize("block", _selected("contract"), ids=_identifiers(_selected("contract")))
    def test_the_contract_blocks_run_against_a_deployment(
        self, block: Block, contract_uri: str, test_database_name: str
    ) -> None:
        """AT-092 -- run against ``MONGODB_URI``, in the throwaway database ``conftest`` drops."""
        environment = {**os.environ, "MONGODB_URI": contract_uri, "MONGODB_DATABASE": test_database_name}
        completed = _run(block.body, environment)
        assert completed.returncode == 0, f"{block.where} failed:\n{completed.stderr}"

    @pytest.mark.autoembed
    @pytest.mark.parametrize("block", _selected("autoembed"), ids=_identifiers(_selected("autoembed")))
    def test_the_autoembed_blocks_run_against_a_registered_model(
        self, block: Block, autoembed_uri: str, test_database_name: str
    ) -> None:
        """AT-092 -- the memory quickstart takes the AutoEmbeddings default, so it needs a model.

        Which is also why it is gated: ``MONGODB_AUTOEMBED_URI`` is the narrowest tier in the suite, and
        the snippet a reader is most likely to run is the one this repository can least often run.
        """
        environment = {
            **os.environ,
            "MONGODB_URI": autoembed_uri,
            "MONGODB_AUTOEMBED_URI": autoembed_uri,
            "MONGODB_DATABASE": test_database_name,
        }
        completed = _run(block.body, environment)
        assert completed.returncode == 0, f"{block.where} failed:\n{completed.stderr}"


class TestTheTwoReadmesAgree:
    """``AT-093`` -- the drift guard between the landing page and the package reference.

    Two files stating one fact is the arrangement that drifts, and it drifts asymmetrically: the file
    people edit stays right and the other one keeps its old number. So the shared facts are compared, and the
    version floors are compared against ``pyproject.toml`` rather than against each other, because two
    files agreeing on a stale number is the failure this is meant to catch.
    """

    def test_the_install_section_is_identical_in_both(self) -> None:
        """AT-093 -- the whole ``## Install`` section, compared verbatim rather than one block out of it.

        The whole section rather than one block, because the section holds more than one install block,
        and comparing only the first would keep matching while another one drifted. A block comparison
        would also miss the prose between the blocks, where the reason for each command is written, such
        as the caveat about quoting brackets.

        The section rather than the file, because these are not the same document: the root file is a
        landing page and ``python/README.md`` is the reference, and the reference carries a
        ``pip install -e`` line for contributors that the landing page has no reason to repeat. What the
        two are required to agree on is what they tell a reader to install, and that is this section.
        """
        sections = {}
        for path in (_PACKAGE_README, _ROOT_README):
            text = path.read_text()
            start = text.find("\n## Install\n")
            assert start != -1, f"{path.name} has no '## Install' section, so nothing here is comparing it"
            end = text.find("\n## ", start + 1)
            sections[path] = text[start:end] if end != -1 else text[start:]

        assert sections[_PACKAGE_README] == sections[_ROOT_README], (
            "the two READMEs' Install sections differ. They are the one passage both files carry in full, "
            "so a reader who arrives at either is told the same thing:\n"
            f"--- python/README.md ---\n{sections[_PACKAGE_README]}\n"
            f"--- README.md ---\n{sections[_ROOT_README]}"
        )

    @pytest.mark.parametrize(
        ("row", "declaration"),
        [
            ("Python", 'requires-python = ">=3.10"'),
            ("`strands-agents`", '"strands-agents>=1.54.0"'),
        ],
    )
    def test_both_files_state_the_floor_pyproject_declares(self, row: str, declaration: str) -> None:
        """AT-093 -- the package README's floor, checked against the one place that enforces it."""
        assert declaration in _PYPROJECT.read_text(), (
            f"pyproject.toml no longer contains {declaration!r}, so this test is checking the READMEs "
            f"against a floor nothing enforces"
        )
        floor = declaration.split(">=")[1].strip('" ')
        stated = [line for line in _PACKAGE_README.read_text().splitlines() if line.startswith(f"| {row} |")]
        assert stated, f"{_PACKAGE_README.name} has no requirements row for {row}"
        assert f">= {floor}" in stated[0], f"{_PACKAGE_README.name} states {stated[0]!r}, not >= {floor}"

    def test_the_landing_page_points_at_the_reference(self) -> None:
        """AT-093 -- what the root file does instead of repeating the reference: it links to it."""
        assert "python/README.md" in _ROOT_README.read_text(), (
            "the root README does not link to python/README.md, so nothing leads a reader to the reference"
        )

    def test_the_reference_links_only_to_absolute_urls(self) -> None:
        """AT-093 -- ``python/README.md`` is the PyPI long description, where a relative link is broken.

        PyPI resolves a relative link against pypi.org, not the repository, so ``MIGRATION.md`` there is a
        404. In-page ``#anchors`` still work and are allowed.
        """
        relative = re.findall(r"\]\((?!https?://|#)([^)]+)\)", _PACKAGE_README.read_text())
        assert relative == [], f"python/README.md has relative links that break on PyPI: {relative}"


class TestTheConfigurationTablesMatchTheTypes:
    """``AT-094`` -- every key of the three configuration ``TypedDict``s is documented.

    A configuration key added to a type without a README row is invisible to a caller who reads the
    documentation first, so the tables are compared against the declarations in both directions.
    """

    @pytest.mark.parametrize(
        ("marker", "typed_dict"),
        [
            ("MongoDBConfig", MongoDBConfig),
            ("MongoDBMemoryStoreConfig", MongoDBMemoryStoreConfig),
            ("MongoDBSearchQuery", MongoDBSearchQuery),
        ],
    )
    def test_the_table_lists_every_key_and_no_others(self, marker: str, typed_dict: Any) -> None:
        """AT-094 -- both directions, because a key documented and then removed misleads just as well."""
        documented = _documented_keys(marker)
        assert documented, f"no table marked '<!-- keys: {marker} -->' in {_PACKAGE_README.name}"
        keys, _ = _annotated_keys(typed_dict)
        assert set(documented) == set(keys), (
            f"{marker}: undocumented {sorted(keys - set(documented))}, "
            f"documented but gone {sorted(set(documented) - keys)}"
        )

    @pytest.mark.parametrize(
        ("marker", "typed_dict"),
        [
            ("MongoDBConfig", MongoDBConfig),
            ("MongoDBMemoryStoreConfig", MongoDBMemoryStoreConfig),
            ("MongoDBSearchQuery", MongoDBSearchQuery),
        ],
    )
    def test_the_required_column_matches_the_declaration(self, marker: str, typed_dict: Any) -> None:
        """AT-094 -- required-ness read from the annotation text, for the reason in :func:`_annotated_keys`."""
        documented = _documented_keys(marker)
        _, required = _annotated_keys(typed_dict)
        for key, cell in documented.items():
            claimed = cell.strip().lower().startswith("yes")
            assert claimed == (key in required), (
                f"{marker}.{key}: the README says required={claimed!r}, the declaration says {key in required!r}"
            )
        assert required <= set(documented), f"{marker}: required keys missing from the table"


# Every value the limits and defaults sections quote, and the renderings a cell may use for it. Derived
# rather than typed, so a change to the constant changes what the README has to say. `MAX_DOCUMENT_BYTES`
# gets two forms because nobody writes 16777216 in a document and nobody should have to.
_TRACEABLE_VALUES: dict[str, tuple[str, ...]] = {
    "MAX_KEY_BYTES": (str(MAX_KEY_BYTES),),
    "MAX_DOCUMENT_BYTES": (f"{MAX_DOCUMENT_BYTES // 1024 // 1024} MB", str(MAX_DOCUMENT_BYTES)),
    "DEFAULT_MAX_SEARCH_RESULTS": (str(DEFAULT_MAX_SEARCH_RESULTS),),
    "DEFAULT_OVERSAMPLING_FACTOR": (str(DEFAULT_OVERSAMPLING_FACTOR),),
    "DEFAULT_EMBEDDING_MODEL": (_indexes.DEFAULT_EMBEDDING_MODEL,),
    "DEFAULT_VECTOR_INDEX_NAME": (_indexes.DEFAULT_VECTOR_INDEX_NAME,),
    "DEFAULT_TEXT_INDEX_NAME": (_indexes.DEFAULT_TEXT_INDEX_NAME,),
    "MAX_DIMENSIONS": (str(_indexes.MAX_DIMENSIONS),),
    "MAX_NUM_CANDIDATES": (str(_pipeline.MAX_NUM_CANDIDATES),),
    "READY_TIMEOUT_SECONDS": (f"{_indexes.READY_TIMEOUT_SECONDS:g}",),
    "POLL_INTERVAL_SECONDS": (f"{_indexes.POLL_INTERVAL_SECONDS:g}",),
}

# The limits with no constant behind them. A row cites the public API it is about instead.
_TRACEABLE_IDS = frozenset(
    {
        "MongoDBConfig",
        "MongoDBStorage.close()",
        "MongoDBMemoryStore.close()",
        "MongoDBMemoryStore.add()",
        "MongoDBMemoryStore.search()",
        "MongoDBStorage.search()",
        "Storage.list()",
        "MongoDBStorage.ensure_indexes()",
    }
)
"""The sources the limits rows cite that are not package constants.

Each is a public API name, so a reader can act on the row without leaving the document. The storage TTL
row, for example, cites ``MongoDBStorage.ensure_indexes()``, the call that creates the index.
"""


def _limit_rows() -> list[tuple[str, str, str]]:
    """Read the limits table out of the package README.

    Returns:
        One ``(limit, value, source)`` triple per row, in document order.
    """
    lines = _PACKAGE_README.read_text().splitlines()
    try:
        start = lines.index("<!-- limits -->")
    except ValueError:  # pragma: no cover - the failure is asserted by the caller
        return []

    rows: list[tuple[str, str, str]] = []
    for line in lines[start + 1 :]:
        if not line.startswith("|"):
            if rows:
                break
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 3 or cells[0] == "Limit" or set(cells[0]) <= {"-", ":"}:
            continue
        rows.append((cells[0], cells[1], cells[2].strip("`")))
    return rows


class TestTheDocumentedValuesAreTheValues:
    """``AT-095`` -- one limits section, every row traceable to the thing that sets it.

    The third column is what makes this testable. A limits section is prose about numbers, and prose
    about numbers is exactly what goes stale; naming the symbol beside each number turns the section into
    something a test can walk.
    """

    def test_the_limits_section_exists_and_every_row_names_its_source(self) -> None:
        """AT-095 -- a row nobody can trace fails, since an untraceable limit cannot be rechecked."""
        rows = _limit_rows()
        assert rows, f"no table marked '<!-- limits -->' in {_PACKAGE_README.name}"
        untraceable = [
            (limit, source)
            for limit, _, source in rows
            if source not in _TRACEABLE_VALUES and source not in _TRACEABLE_IDS
        ]
        assert untraceable == [], (
            f"these limits name a source this test cannot resolve: {untraceable}. Name a constant from "
            f"the package or a public API, and add it to _TRACEABLE_VALUES or _TRACEABLE_IDS."
        )

    def test_every_limit_requirement_e_095_names_is_present(self) -> None:
        """AT-095 -- the coverage direction: every limit with no constant behind it is a row."""
        cited = {source for _, _, source in _limit_rows()}
        assert _TRACEABLE_IDS <= cited, f"limits dropped from the section: {sorted(_TRACEABLE_IDS - cited)}"

    def test_every_row_quoting_a_constant_quotes_its_current_value(self) -> None:
        """AT-095 -- the drift direction: a ceiling raised in code and not in the document fails here."""
        for limit, value, source in _limit_rows():
            if source not in _TRACEABLE_VALUES:
                continue
            accepted = _TRACEABLE_VALUES[source]
            assert any(form in value for form in accepted), (
                f"the {limit!r} row says {value!r}, and {source} is now one of {accepted}"
            )

    def test_the_defaults_the_readme_quotes_are_the_defaults(self) -> None:
        """AT-095 -- the values a reader plans around, checked wherever in the document they appear."""
        text = _PACKAGE_README.read_text()
        for name in (
            "DEFAULT_EMBEDDING_MODEL",
            "DEFAULT_VECTOR_INDEX_NAME",
            "DEFAULT_TEXT_INDEX_NAME",
            "DEFAULT_MAX_SEARCH_RESULTS",
            "DEFAULT_OVERSAMPLING_FACTOR",
        ):
            assert any(form in text for form in _TRACEABLE_VALUES[name]), (
                f"the README does not state the current {name}, {_TRACEABLE_VALUES[name][0]!r}"
            )
        assert DEFAULT_COLLECTION in text, "the README does not name the default memory collection"
        storage_collection = inspect.signature(MongoDBStorage.__init__).parameters["collection"].default
        assert storage_collection in text, "the README does not name the default storage collection"

    def test_the_reserved_metadata_keys_are_all_listed(self) -> None:
        """AT-095 -- a caller cannot avoid a reserved key that the document does not name."""
        text = _PACKAGE_README.read_text()
        missing = sorted(key for key in RESERVED_METADATA_KEYS if f"`{key}`" not in text)
        assert missing == [], f"reserved metadata keys the README never mentions: {missing}"

    def test_the_authentication_mechanisms_are_the_drivers(self) -> None:
        """AT-095 -- the supported mechanisms, taken from the installed driver rather than from memory.

        ``DEFAULT`` is excluded: it is how the driver is told to negotiate, not a mechanism an operator
        configures on a user.
        """
        text = _PACKAGE_README.read_text()
        expected = {name for name in MECHANISMS if name != "DEFAULT"}
        missing = sorted(name for name in expected if f"`{name}`" not in text)
        assert missing == [], f"the driver supports these and the README does not name them: {missing}"


def _privilege_rows() -> list[tuple[str, dict[str, bool]]]:
    """Read the privileges table out of the package README.

    The header row names one built-in role per column from the third onwards, and each body row claims
    whether that role grants the action in the first column. Both are read from the document so that the
    test checks what the README says rather than what this file remembers it saying.

    Returns:
        One ``(action, {role: granted})`` pair per row, in document order.
    """
    lines = _PACKAGE_README.read_text().splitlines()
    try:
        start = lines.index("<!-- privileges -->")
    except ValueError:  # pragma: no cover - the failure is asserted by the caller
        return []

    roles: list[str] = []
    rows: list[tuple[str, dict[str, bool]]] = []
    for line in lines[start + 1 :]:
        if not line.startswith("|"):
            if roles:
                break
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if set("".join(cells)) <= {"-", ":"}:
            continue
        if not roles:
            roles = [cell.strip("`") for cell in cells[2:]]
            continue
        claims = {role: cells[2 + offset].lower().startswith("yes") for offset, role in enumerate(roles)}
        rows.append((cells[0].strip("`"), claims))
    return rows


def _documented_commands() -> list[str]:
    """Return every ``db.runCommand`` line from the README's ``mongosh`` blocks.

    Returns:
        The lines, in document order, with blank lines and comments dropped.
    """
    lines: list[str] = []
    for block in _selected("mongosh"):
        for line in block.body.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("//"):
                lines.append(stripped)
    return lines


def _rendered_commands() -> list[str]:
    """Render the commands ``initialize()`` would need, in the order the README documents them.

    The storage collection first, then the memory collection's ordinary indexes, then its two search
    indexes under the zero-configuration defaults. ``memory_search_specs`` is given an empty config
    beyond the database name, which resolves to the AutoEmbeddings path, matching what the memory
    quickstart does.

    Returns:
        One ``db.runCommand({...})`` string per index the package creates.
    """
    storage_collection = inspect.signature(MongoDBStorage.__init__).parameters["collection"].default
    config: MongoDBConfig = {"database": "agents"}
    return [
        *(spec.creation_command(storage_collection) for spec in _indexes.storage_specs()),
        *(spec.creation_command(DEFAULT_COLLECTION) for spec in _indexes.memory_specs()),
        *(spec.creation_command(DEFAULT_COLLECTION) for spec in _indexes.memory_search_specs(config)),
    ]


# The privilege actions each command the package can send requires, for
# `test_the_package_needs_no_action_the_documented_role_withholds`. An empty set means the
# server authorizes the command without any privilege, which is true of the handshake, the session calls
# and the cursor calls: a client that could not run them could not connect at all, so no role has to
# grant them.
#
# A set rather than one action per command, because the command name and the action are not one to one in
# either direction. `update` is the case that matters here: `write` and `add` always upsert, and on
# MongoDB 8.3.8 a user holding only `find` and `update` is refused an upsert with `Unauthorized` while a
# plain update succeeds. So this package needs `insert` without ever
# sending an `insert` command, which is why the README table lists that action for `write` and `add`.
#
# The two directions are checked separately: a command absent from this mapping fails the test as
# unmapped, and an action absent from the README fails it as undocumented. Adding a command here without
# adding its action to the README therefore does not silence anything.
_COMMAND_ACTIONS: dict[str, frozenset[str]] = {
    "aggregate": frozenset({"find"}),  # `search` and the memory pipelines; reads, so `find`
    "buildInfo": frozenset(),
    "count": frozenset({"find"}),
    # Sent only where search exists, and only just before `createSearchIndexes`, which fails with code 26
    # against a missing namespace where `createIndexes` would have created it implicitly.
    "create": frozenset({"createCollection"}),
    "createIndexes": frozenset({"createIndex"}),  # the wire name is plural, the action is not
    "createSearchIndexes": frozenset({"createSearchIndexes"}),
    "delete": frozenset({"remove"}),  # the wire name and the action differ here too
    "endSessions": frozenset(),
    "find": frozenset({"find"}),
    "getMore": frozenset(),  # continuing a cursor the `find` or `aggregate` already authorized
    "hello": frozenset(),
    "insert": frozenset({"insert"}),
    "killCursors": frozenset(),
    "listCollections": frozenset({"listCollections"}),
    "listIndexes": frozenset({"listIndexes"}),
    "listSearchIndexes": frozenset({"listSearchIndexes"}),
    "ping": frozenset(),
    # The SCRAM handshake. No role grants these and none could usefully: authentication is what decides
    # which roles the connection has, so it necessarily runs before any of them apply. `saslStart` is
    # often folded into `hello` as speculative authentication and so does not always appear on the wire.
    "saslContinue": frozenset(),
    "saslStart": frozenset(),
    "update": frozenset({"update", "insert"}),  # every write this package sends is an upsert
}


class _CommandNames(monitoring.CommandListener):
    """Record the name of every command the driver sends.

    A listener rather than a proxy or a patched method, because it observes the wire rather than the call
    site: a command the package sends indirectly, through an index helper or a cursor continuation, is
    recorded the same as one it sends directly. The privileges check depends on that, since the commands
    a reviewer forgets are the indirect ones.
    """

    def __init__(self) -> None:
        self.names: set[str] = set()

    def started(self, event: Any) -> None:
        """Record a command as it goes out.

        Args:
            event: The driver's ``CommandStartedEvent``.
        """
        self.names.add(event.command_name)

    def succeeded(self, event: Any) -> None:
        """Ignore the reply, since only the request needs a privilege.

        Args:
            event: The driver's ``CommandSucceededEvent``.
        """

    def failed(self, event: Any) -> None:
        """Ignore the failure, which still tells us the command was sent and so needed its action.

        Args:
            event: The driver's ``CommandFailedEvent``.
        """


def _fused_score_examples() -> dict[str, str]:
    """The two fused scores worth writing down, computed rather than remembered.

    Both documents quote these, and quoting a number is how a document goes stale. Deriving them from
    :data:`_pipeline.RANK_FUSION_PENALTY` here means the test fails when the constant moves, instead of
    passing against prose that is now wrong.

    Returns:
        Each score, rounded the way the documents write it, mapped to what it describes.
    """
    penalty = _pipeline.RANK_FUSION_PENALTY
    both = 2 / (penalty + 1)
    one = 1 / (penalty + 1)
    return {f"{both:.3f}": "ranked first by both tiers", f"{one:.3f}": "ranked first by one tier"}


class TestTheFusedScaleIsStatedWhereABoundIsChosen:
    """AT-151 -- the number a caller needs in order to pick a bound for the hybrid tier.

    Under ``"auto"`` the package declines fusion when a bound is set. A caller who asks for ``"hybrid"``
    by name gets fusion with their bound applied, so they need a number they have no way to derive.
    Reciprocal rank fusion is not a similarity, there is no 0-to-1 range to reason from, and the ceiling
    depends on a rank constant that lives in the server.

    So both documents state it, and both are checked against :data:`_pipeline.RANK_FUSION_PENALTY` rather
    than against 60. If the constant ever stops being 60, a document that still says 60 fails here rather
    than leading a caller to a floor that empties their result set.
    """

    def test_the_readme_explains_the_fused_scale_and_quotes_the_live_penalty(self) -> None:
        """AT-151 -- the operator half, in the passage a reader reaches from the tier table."""
        text = _PACKAGE_README.read_text()
        assert "<!-- rrf -->" in text, f"no passage marked '<!-- rrf -->' in {_PACKAGE_README.name}"
        section = text.split("<!-- rrf -->", 1)[1].split("\n## ", 1)[0]

        assert str(_pipeline.RANK_FUSION_PENALTY) in section, (
            f"the RRF passage does not state the rank constant, now {_pipeline.RANK_FUSION_PENALTY}"
        )
        for number, describes in _fused_score_examples().items():
            assert number in section, f"the RRF passage does not state {number}, the score of a document {describes}"
        assert "min_score" in section and "max_score" in section, (
            "the RRF passage does not name the two keys whose values this scale governs"
        )

    def test_the_config_docstring_explains_it_where_the_bound_is_set(self) -> None:
        """AT-151 -- the API half. A caller typing ``min_score=`` is in an editor, not in the README."""
        doc = inspect.getdoc(MongoDBMemoryStoreConfig) or ""
        bounds = doc.split("min_score:", 1)
        assert len(bounds) == 2, "MongoDBMemoryStoreConfig no longer documents min_score"

        assert "RANK_FUSION_PENALTY" in bounds[1], (
            "the min_score documentation does not name the constant holding the rank penalty, so a "
            "reader has to find the scale somewhere else or guess it"
        )
        assert all(number in bounds[1] for number in _fused_score_examples()), (
            "the min_score documentation states no worked value, which is the part that makes the "
            "difference between the two scales obvious rather than merely mentioned"
        )


class TestTheIndexAndPrivilegesReference:
    """``AT-096`` -- the block an operator pastes, generated rather than written.

    The README carries copy-pasteable creation commands so a DBA can provision before first run. A
    command block that does not paste is worse than no block, because it fails in the operator's terminal.
    So the block is compared against the renderers the package uses, and the ordinary commands are also
    sent to a real deployment.
    """

    def test_the_documented_commands_are_the_rendered_commands(self) -> None:
        """AT-096 -- exact equality, in order, against ``creation_command()``."""
        assert _documented_commands() == _rendered_commands(), (
            "the README's command block is not what the package renders. It is generated content: copy "
            "the output of _rendered_commands() rather than editing the block by hand."
        )

    def test_every_index_the_package_creates_has_a_documented_command(self) -> None:
        """AT-096 -- the coverage direction, by name, so a new index cannot ship undocumented."""
        text = _PACKAGE_README.read_text()
        storage_collection = inspect.signature(MongoDBStorage.__init__).parameters["collection"].default
        config: MongoDBConfig = {"database": "agents"}
        names = [
            *(spec.name for spec in _indexes.storage_specs()),
            *(spec.name for spec in _indexes.memory_specs()),
            *(spec.name for spec in _indexes.memory_search_specs(config)),
        ]
        missing = sorted({name for name in names if name not in text})
        assert missing == [], f"indexes this package creates and the README never names: {missing}"
        assert storage_collection in text and DEFAULT_COLLECTION in text

    @pytest.mark.contract
    async def test_the_documented_ordinary_commands_run_on_a_deployment(self, contract_database: Any) -> None:
        """AT-096 -- the strongest form of the claim: the server accepts the lines as written.

        Ordinary indexes only. ``createSearchIndexes`` needs mongot, which the contract tier does not
        promise, and the Atlas integration tier covers that path.
        """
        for command in _documented_commands():
            match = _RUN_COMMAND.match(command)
            assert match, f"not a runCommand line: {command}"
            argument = json.loads(match.group("argument"))
            if "createIndexes" not in argument:
                continue
            result = await contract_database.command(argument)
            assert result.get("ok") == 1, f"the deployment rejected a documented command: {command}"

    @pytest.mark.contract
    async def test_the_privileges_table_matches_the_deployment(self, contract_database: Any) -> None:
        """AT-096b -- the privileges table, rechecked against the deployment rather than trusted.

        On Atlas 8.0.30 a ``readWrite`` user can create indexes, including search indexes, and the README
        says so. The claim is about a specific server's role definitions, and role definitions are the
        server's to change, so the test reads them back.

        Skips rather than fails where ``rolesInfo`` goes unanswered, since a deployment may withhold it
        from the credential the tier was given, and that is not a documentation defect.
        """
        rows = _privilege_rows()
        assert rows, f"no table marked '<!-- privileges -->' in {_PACKAGE_README.name}"

        granted: dict[str, set[str]] = {}
        for role in sorted({role for _, claims in rows for role in claims}):
            try:
                answer = await contract_database.command(
                    {"rolesInfo": {"role": role, "db": contract_database.name}, "showPrivileges": True}
                )
            except OperationFailure as error:
                pytest.skip(f"this deployment does not answer rolesInfo for {role!r}: {error}")
            definitions = answer.get("roles") or []
            if not definitions or "privileges" not in definitions[0]:
                pytest.skip(f"this deployment returns no privilege list for {role!r}")
            granted[role] = {
                action for privilege in definitions[0]["privileges"] for action in privilege.get("actions", ())
            }

        for action, claims in rows:
            for role, claimed in claims.items():
                assert claimed == (action in granted[role]), (
                    f"the README says {role} {'grants' if claimed else 'does not grant'} {action!r}, and "
                    f"this deployment says otherwise"
                )

    @pytest.mark.contract
    async def test_the_package_needs_no_action_the_documented_role_withholds(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """AT-116 -- every command the package sends is one ``readWrite`` authorizes.

        The table above says what each action is needed for. This says the converse, which is the half
        that drifts: nothing the package sends needs an action the table omits. A new command that needed
        an extra action would otherwise fail at a customer's deployment, not here, so the property is
        asserted against the commands the driver actually sends.

        Outcomes are deliberately not asserted. Which of these calls succeeds depends on the deployment,
        and a contract-tier deployment promises no search process, so ``search`` on either surface may
        raise. What the test observes is the set of command names the driver sent.
        """
        observed = _CommandNames()
        client: AsyncMongoClient[Any] = AsyncMongoClient(contract_uri, event_listeners=[observed])
        config: MongoDBConfig = {"client": client, "database": test_database_name}
        storage = MongoDBStorage(config, collection=unique_collection_name)
        store = MongoDBMemoryStore(
            name="at116",
            config=config,
            collection=f"{unique_collection_name}_memory",
            scope="at116",
            writable=True,
        )
        try:
            await storage.write("session/at116", b'{"kind": "snapshot"}')
            await storage.read("session/at116")
            await storage.list("session/")
            await storage.search("snapshot")
            await storage.delete("session/at116")
            with contextlib.suppress(StorageError):
                await store.add("a memory this test writes")
            with contextlib.suppress(StorageError):
                await store.search("memory")
        finally:
            await storage.close()
            await store.close()
            await client.close()

        assert observed.names, "the listener saw no commands, so this test proved nothing"
        unmapped = sorted(name for name in observed.names if name not in _COMMAND_ACTIONS)
        assert unmapped == [], (
            f"commands this package sent that {Path(__file__).name} has no privilege mapping for: "
            f"{unmapped}. Add each one with the action it needs, then check the README table still "
            f"covers it"
        )

        documented = {action for action, _ in _privilege_rows()}
        needed = {action for name in observed.names for action in _COMMAND_ACTIONS[name]}
        missing = sorted(action for action in needed if action not in documented)
        assert missing == [], (
            f"the package needs these privilege actions and the README privileges table names none of them: {missing}"
        )


# The nine subjects the README has to cover for the package to count as documented. Each pair is
# (subject, what locates it), and the locator is a heading rather than a phrase so that a section renamed
# fails here and a sentence reworded does not. Six of the nine are asserted only
# as present, because whether their prose is right is asserted by the tests above, against the code.
_REQUIRED_SUBJECTS: tuple[tuple[str, str], ...] = (
    ("install", "## Install"),
    ("quickstart", "## Quickstart"),
    ("index creation commands", "### Creating them by hand"),
    ("the search tiers", "## Search: what answers a query"),
    ("reserved metadata keys", "### Reserved metadata keys"),
    ("the tenancy models", "## Tenancy"),
    ("the support matrix", "## Requirements"),
    ("the 16 MB document ceiling", "## Limits"),
    ("the erasure path", "## Erasing memories"),
)


class TestTheReadmeCoversEverySubjectTheRequirementNames:
    """``AT-120`` -- the README covers nine required subjects, each checked as a section.

    Without this, a deleted section would take a subject with it and no test would notice. Deliberately
    the weakest assertion in this file: presence of a section, plus one value check where the subject is a
    number the code owns. Whether the prose is *correct* is asserted elsewhere, against the code, and
    repeating it here would be a second place for the same fact to drift.
    """

    def test_every_subject_has_a_section(self) -> None:
        """A subject with no section is an undocumented subject, whatever the rest of the file says."""
        headings = {line.rstrip() for line in _PACKAGE_README.read_text().splitlines() if line.startswith("#")}
        absent = {subject: heading for subject, heading in _REQUIRED_SUBJECTS if heading not in headings}

        assert absent == {}, f"required subjects whose section is gone from {_PACKAGE_README.name}: {absent}"

    def test_the_nine_subjects_are_nine(self) -> None:
        """The list above is maintained by hand, so its length and uniqueness are checked."""
        assert len(_REQUIRED_SUBJECTS) == 9
        assert len({heading for _, heading in _REQUIRED_SUBJECTS}) == 9

    def test_the_document_ceiling_is_stated_as_a_number(self) -> None:
        """The subject is the caveat, not the heading. 16 MB is the one subject that is a value.

        The value comes from the package rather than from this file, so a ceiling changed in code and not
        in the document fails here. This duplicates the limits-table check in
        ``TestTheDocumentedValuesAreTheValues`` on purpose: that one reads the table by its marker, and
        this one reads the section, so deleting the table fails one and deleting the section fails the
        other.
        """
        section = _PACKAGE_README.read_text().split("## Limits", 1)[1].split("\n## ", 1)[0]
        megabytes = MAX_DOCUMENT_BYTES // (1024 * 1024)

        assert f"{megabytes} MB" in section, (
            f"the limits section does not state the {megabytes} MB ceiling that MAX_DOCUMENT_BYTES sets"
        )


def _marked_section(marker: str) -> str:
    """Return the lines following an HTML marker comment, up to the next heading.

    The marker is what makes a passage addressable. A test that searched the whole document for a
    sentence would pass when the sentence drifted into an unrelated section, and a test that searched by
    heading would fail the day somebody rewords the heading.

    Args:
        marker: The comment's inner text, without the ``<!--`` and ``-->``.

    Returns:
        The section body, or ``""`` when the marker is absent.
    """
    lines = _PACKAGE_README.read_text().splitlines()
    try:
        start = lines.index(f"<!-- {marker} -->")
    except ValueError:
        return ""
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("#"):
            break
        body.append(line)
    return "\n".join(body)


def _verify_rows() -> list[tuple[str, str, str]]:
    """Read the ensure-versus-verify table out of the package README.

    Returns:
        One ``(index kind, what ensure does, what verify does)`` triple per row, in document order.
    """
    rows: list[tuple[str, str, str]] = []
    for line in _marked_section("verify").splitlines():
        if not line.startswith("|"):
            if rows:
                break
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 3 or set("".join(cells)) <= {"-", ":"} or cells[0].startswith("Index"):
            continue
        rows.append((cells[0], cells[1], cells[2]))
    return rows


class TestTheManualVectorPathIsDocumentedAtItsRealWidth:
    """``AT-128`` -- the manual vector path: the package indexes and queries a vector, and never writes one.

    A `vector` keyword on `add` would be reachable only by a caller who has already stepped around
    `MemoryManager`, and that caller can write the document. What a reader needs is the documentation:
    `embedding_dimensions` and `similarity` configure an index over a field that nothing in this package
    fills, and the README has to say so.

    So both directions are asserted. The README has to *say* it, and the fact it states has to still be
    true of the code: if `add` gains a vector parameter, the passage is out of date and this class fails.
    """

    def test_the_readme_names_the_field_the_index_covers(self) -> None:
        """AT-128 -- the name comes from the package, so renaming the field fails here.

        A reader who has to supply the vector needs the field name above everything else:
        `embedding_dimensions` is a config key, not a path.
        """
        section = _marked_section("manual-vectors")
        assert section, f"no passage marked '<!-- manual-vectors -->' in {_PACKAGE_README.name}"
        assert f"`{_indexes.VECTOR_FIELD}`" in section, (
            f"the manual-vector passage never names {_indexes.VECTOR_FIELD!r}, the field "
            f"_indexes.VECTOR_FIELD makes the index cover"
        )

    def test_the_readme_says_what_writes_the_vector(self) -> None:
        """AT-128 -- the statement itself, read as separate clauses rather than one sentence."""
        section = _marked_section("manual-vectors").lower()
        for clause, phrases in (
            ("that this package indexes and queries the field", ("index", "quer")),
            ("that an `embedder` produces the vectors", ("`embedder`",)),
            ("that without one this package never produces a vector", ("never",)),
            ("that writing the field is then the caller's", ("you", "caller")),
        ):
            assert any(phrase in section for phrase in phrases), f"the manual-vector passage does not state {clause}"

    def test_add_has_no_vector_parameter_for_the_readme_to_offer(self) -> None:
        """AT-128 -- the negative half, asserted against the signature it is about.

        The README must not present ``embedding_dimensions`` as something ``add`` can fill. The prose is
        correct because the parameter does not exist, and if one is added the document has to change
        with it.
        """
        parameters = set(inspect.signature(MongoDBMemoryStore.add).parameters)

        assert not parameters & {"vector", "embedding", "embeddings"}, (
            f"MongoDBMemoryStore.add now takes {sorted(parameters & {'vector', 'embedding', 'embeddings'})}, "
            f"so the package can now write a vector and the README's manual-vector passage is out of date"
        )

    def test_the_passage_sits_where_a_reader_configuring_the_manual_path_will_be(self) -> None:
        """AT-128 -- placement, because a true sentence in the wrong section goes unread.

        The two keys that select the path are in the `MongoDBConfig` table; the consequence of selecting
        it belongs with the search tiers, which is where a reader goes to find out what answers a query.
        """
        text = _PACKAGE_README.read_text()
        search = text.index("## Search: what answers a query")
        marker = text.index("<!-- manual-vectors -->")
        following = text.index("\n## ", search + 1)

        assert search < marker < following, (
            "the manual-vector passage is outside the search section, where a reader who has just set "
            "embedding_dimensions is not looking"
        )


class TestBothHalvesOfVerifyModeAreStated:
    """``AT-129`` -- the README states which missing indexes make verify mode raise and which only warn.

    ``_ensure_ordinary`` raises on a missing ordinary index, and ``_ensure_search`` raises too; what is
    tolerant is one level up, in ``_ensure_search_tiers``, and only under ``search_type: "auto"``, where a
    failed tier is dropped because another one may answer. A reader planning a no-DDL deployment needs to
    know which of their indexes stops startup and which one only degrades it.

    The search half's *behaviour* is asserted in ``test_memory_store.py``, where the warning is raised;
    this class asserts the document, plus the one fact the document promises about the ordinary half that
    can be computed here without a deployment.
    """

    def test_the_table_covers_every_index_kind_verify_mode_treats_differently(self) -> None:
        """AT-129 -- three behaviours, so a two-row table has folded two of them together."""
        rows = _verify_rows()
        assert rows, f"no table marked '<!-- verify -->' in {_PACKAGE_README.name}"
        kinds = [kind.lower() for kind, _, _ in rows]

        assert len(rows) == 3, f"verify mode has three behaviours and the table has {len(rows)}: {kinds}"
        assert any("ordinary" in kind for kind in kinds), f"no row for ordinary indexes: {kinds}"
        assert sum("search" in kind for kind in kinds) == 2, (
            f"the two search rows are what separate 'auto' from a named search_type: {kinds}"
        )

    def test_the_ordinary_row_says_it_raises_and_the_auto_row_says_it_warns(self) -> None:
        """AT-129 -- the statement itself, read per row rather than as a search of the whole section."""
        rows = {kind.lower(): verify.lower() for kind, _, verify in _verify_rows()}
        ordinary = next((verify for kind, verify in rows.items() if "ordinary" in kind), "")
        auto = next((verify for kind, verify in rows.items() if "auto" in kind), "")
        named = next((verify for kind, verify in rows.items() if "search" in kind and "auto" not in kind), "")

        assert "rais" in ordinary, f"the ordinary row does not say a missing index raises: {ordinary!r}"
        assert "warn" in auto, f"the auto search row does not say a missing index warns: {auto!r}"
        assert "rais" in named, f"the named search_type row does not say a missing index raises: {named!r}"
        assert "warn" not in ordinary, (
            f"the ordinary row describes the search half's warning, but a missing ordinary index raises: {ordinary!r}"
        )

    def test_the_sentence_that_said_verify_never_raises_is_gone(self) -> None:
        """AT-129 -- no paragraph claims verify mode cannot raise, which would contradict the table.

        A reader who reaches the paragraph first stops there. Phrased against the claim rather than the
        wording, so a reworded version of the same wrong claim fails too.
        """
        text = _PACKAGE_README.read_text().lower()
        wrong = [phrase for phrase in ("never raises", "does not raise", "never fails") if phrase in text]

        assert wrong == [], f"the README still claims verify mode cannot raise: {wrong}"

    def test_the_ordinary_rows_promised_message_is_the_message_the_code_builds(self) -> None:
        """AT-129 -- the fact check: the row promises a work order, and this is the work order.

        Computed rather than quoted. ``_missing_ordinary_message`` is what a caller in verify mode reads,
        and if it ever stops carrying the creation commands the row's promise is empty.
        """
        specs = _indexes.storage_specs()
        message = _indexes._missing_ordinary_message("storage", "appdb.storage", specs)

        assert "ensure_indexes is False" in message
        for spec in specs:
            assert spec.creation_command("storage") in message, (
                f"the verify-mode message omits the command that creates {spec.name!r}, so the README's "
                f"ordinary row promises something the package does not send"
            )


class TestTheTtlCaveatNamesTheMethodThatCreatesTheIndex:
    """``AT-128`` -- the storage TTL rows name ``MongoDBStorage.ensure_indexes()``, the call that creates the index.

    Two rows in the README cover the storage TTL index: one in the limits table and one in the index
    table. Both name the method, so a reader whose ``ttl_seconds`` documents are not expiring has
    something to call.
    """

    def test_the_limits_row_cites_the_method(self) -> None:
        """AT-128 -- the limits row cites the method as its source."""
        sources = {source for _, _, source in _limit_rows()}

        assert "MongoDBStorage.ensure_indexes()" in sources, (
            "no limits row names ensure_indexes(), so a reader whose ttl_seconds documents are not "
            "expiring has nothing to call"
        )

    def test_the_method_the_readme_names_is_a_method(self) -> None:
        """AT-128 -- a citation to a name that does not resolve is worth less than no citation."""
        assert callable(getattr(MongoDBStorage, "ensure_indexes", None)), (
            "the README names MongoDBStorage.ensure_indexes() and the class does not have it"
        )

    def test_the_index_table_row_no_longer_says_nothing_creates_it(self) -> None:
        """AT-128 -- the index table's storage TTL row names the method and does not say nothing creates it."""
        text = _PACKAGE_README.read_text()
        section = text.split("### What gets created", 1)[1].split("\n### ", 1)[0]
        ttl = next(line for line in section.splitlines() if "strands_expires_at_ttl" in line)

        assert "nothing creates this one for you" not in ttl, (
            f"the index table still says nothing creates the storage TTL index: {ttl!r}"
        )
        assert "ensure_indexes()" in ttl, f"the index table's TTL row does not name the method: {ttl!r}"


class TestTheReadmeSaysWhichSurfaceCreatesTheTtlIndex:
    """``AT-158`` -- the README says which surface creates its TTL index and how.

    The two surfaces differ. On ``MongoDBStorage`` the caller calls ``ensure_indexes()``. On
    ``MongoDBMemoryStore``, ``initialize()`` creates the index whether or not any store sets a
    ``ttl_seconds``. An unscoped statement is true of one surface and wrong about the other: a reader who
    applies the storage rule to the memory store looks for a method it does not have, and a reader who
    applies the memory rule to storage leaves storage documents that never expire. So both rows name their
    surface.
    """

    def test_the_limits_row_scopes_itself_and_names_the_other_surface(self) -> None:
        """AT-158 -- the caveat is about `MongoDBStorage`, and it says so before it says anything else."""
        row = next((limit, value) for limit, value, _ in _limit_rows() if "ttl_seconds" in limit and "index" in limit)
        limit, value = row

        assert "MongoDBStorage" in limit, (
            f"the limits row reads as a claim about both surfaces, and it is only true of storage: {limit!r}"
        )
        assert "initialize()" in value, (
            f"the row does not say the memory store creates its own TTL index, so a reader goes looking "
            f"for an ensure_indexes() that surface does not have: {value!r}"
        )

    def test_the_memory_index_row_names_the_method_that_creates_it(self) -> None:
        """AT-158 -- the index table's memory row says what creates the index, not only what expires."""
        text = _PACKAGE_README.read_text()
        section = text.split("### What gets created", 1)[1].split("\n### ", 1)[0]
        rows = [line for line in section.splitlines() if "strands_expires_at_ttl" in line]

        assert len(rows) == 2, f"expected a TTL row per collection, found {len(rows)}: {rows!r}"
        memory = next(line for line in rows if line.lstrip("| ").startswith("`memory`"))

        assert "initialize()" in memory, f"the memory TTL row does not say initialize() creates it: {memory!r}"


class TestWhereCallerTextGoesIsStated:
    """``AT-198`` to ``AT-200`` -- where caller text goes: the data flow a security review asks for.

    On the default path the deployment embeds what is stored and what is asked, on the manual path
    nothing does, and erasure stops at the live deployment. The README states all three where a
    customer's privacy team will look, so the data flow does not have to be inferred from the index
    definition. These tests read the marked passages, so the statements cannot drift into an unrelated
    section, and they read the model name from the package, so a new default fails here.
    """

    def test_the_section_names_both_paths_and_what_each_sends(self) -> None:
        """AT-198 -- the default path sends content and query text to a named model; the manual path sends none."""
        section = _marked_section("data-flow")
        assert section, f"no passage marked '<!-- data-flow -->' in {_PACKAGE_README.name}"
        lowered = section.lower()

        assert "`embedding_model`" in section and f"`{_indexes.DEFAULT_EMBEDDING_MODEL}`" in section, (
            "the data-flow passage does not name the key that picks the model, or the default it picks"
        )
        assert "`content`" in section and "query" in lowered, (
            "the data-flow passage does not say that both stored content and query text reach the model"
        )
        assert "manual path" in lowered and "no model" in lowered, (
            "the data-flow passage does not say that the manual path sends text to no model"
        )
        assert "both paths" in lowered and "stored" in lowered, (
            "the data-flow passage does not say that content is stored in the deployment on both paths"
        )

    def test_the_section_assigns_residency_and_claims_no_confidentiality(self) -> None:
        """AT-199 -- region and retention are the deployment's; no guarantee is made for the model."""
        lowered = _marked_section("data-flow").lower()

        for subject in ("region", "retention"):
            assert subject in lowered, f"the data-flow passage does not say who governs {subject}"
        assert "atlas deployment" in lowered and "not by this package" in lowered, (
            "the data-flow passage does not assign residency and retention to the deployment"
        )
        assert "makes no" in lowered and "confidentiality" in lowered, (
            "the data-flow passage does not disclaim a confidentiality guarantee for the embedding model"
        )
        assert "boundary" in lowered and "manual path" in lowered, (
            "the data-flow passage does not name the manual path for text that must stay in the boundary"
        )

    def test_erasure_says_what_it_does_not_reach(self) -> None:
        """AT-200 -- backups, snapshots and the oplog follow the deployment, not ``delete_all()``."""
        section = _marked_section("erasure-reach")
        assert section, f"no passage marked '<!-- erasure-reach -->' in {_PACKAGE_README.name}"
        lowered = section.lower()

        for copy in ("backup", "snapshot", "oplog"):
            assert copy in lowered, f"the erasure passage does not say that erasure leaves {copy}s alone"
        assert "`delete()`" in section and "`delete_all()`" in section and "retention" in lowered, (
            "the erasure passage does not name both calls and say whose retention the copies follow"
        )

    def test_both_passages_sit_where_a_reader_looks(self) -> None:
        """AT-198, AT-200 -- the data flow before erasure, and the erasure limit inside its section."""
        text = _PACKAGE_README.read_text()
        flow = text.index("<!-- data-flow -->")
        erasing = text.index("## Erasing memories")
        reach = text.index("<!-- erasure-reach -->")
        following = text.index("\n## ", erasing + 1)

        assert text.index("## Tenancy") < flow < erasing, "the data-flow section is not between Tenancy and Erasing"
        assert erasing < reach < following, "the erasure limit is outside the Erasing memories section"


def _span_names() -> set[str]:
    """Every span name the two stores can record, read off the decorated methods rather than listed here."""
    return {
        member.__dict__["strands_mongodb_span"]
        for cls in (MongoDBStorage, MongoDBMemoryStore)
        for member in vars(cls).values()
        if inspect.isfunction(member) and "strands_mongodb_span" in member.__dict__
    }


class TestTheDriverInfoPassageMatchesTheCode:
    """AT-230 -- a reader learns from here what the server records about this package."""

    def test_the_passage_names_the_entry_and_leaves_app_name_alone(self) -> None:
        """AT-231 -- and that the application's ``appName`` is never touched."""
        section = _marked_section("driver-info")
        assert section, f"no passage marked '<!-- driver-info -->' in {_PACKAGE_README.name}"
        lowered = section.lower()

        assert f"`{_client._DRIVER_NAME}`" in section, "the driver-info passage does not name the driver entry"
        assert "`client`" in section and "append_metadata" in section, (
            "the driver-info passage does not say how an injected client is attributed"
        )
        assert "`appname`" in lowered and "never" in lowered, (
            "the driver-info passage does not say that the package leaves appName alone"
        )

    def test_the_passage_sits_in_the_connecting_section(self) -> None:
        text = _PACKAGE_README.read_text()

        assert (
            text.index("## Connecting to a deployment")
            < text.index("<!-- driver-info -->")
            < text.index("### Authentication mechanisms")
        )


def _named_by_telemetry() -> set[str]:
    """Every index span, attribute and event name ``_telemetry`` allows, read off its ``Literal`` types."""
    return (
        set(get_args(_telemetry.SpanName)) | set(get_args(_telemetry.Attribute)) | set(get_args(_telemetry.EventName))
    )


class TestTheObservabilitySectionMatchesTheCode:
    """AT-213 -- every span, event and attribute the code can emit is named, and nothing else is.

    Both lists are read from the code. A span added in a later change fails here until the README names
    it, and a name the README keeps after the code drops it fails the reverse check.
    """

    def test_every_span_event_and_attribute_is_named(self) -> None:
        section = _marked_section("observability")
        assert section, f"no passage marked '<!-- observability -->' in {_PACKAGE_README.name}"

        spans = _span_names()
        assert len(spans) == 12, sorted(spans)
        expected = spans | _named_by_telemetry()
        missing = sorted(name for name in expected if f"`{name}`" not in section)
        assert missing == [], f"the observability section does not name {missing}"
        assert "`error.type`" in section

    def test_it_names_nothing_the_code_does_not_emit(self) -> None:
        section = _marked_section("observability")
        expected = _span_names() | _named_by_telemetry()

        named = set(re.findall(r"`(strands_mongodb\.[a-z_.]+)`", section))

        assert named - expected == set(), f"the section names {sorted(named - expected)}, which nothing emits"

    def test_it_states_the_exclusions_and_how_to_turn_it_on(self) -> None:
        lowered = _marked_section("observability").lower()

        for value in ("key", "content", "metadata", "query", "filter", "scope", "memory id", "connection string"):
            assert value in lowered, f"the observability section does not say that {value!r} is never recorded"
        assert "message" in lowered and "type" in lowered, "it does not say failures record a type, not a message"
        assert "strandstelemetry" in lowered and "tracerprovider" in lowered, "it does not say how to enable export"
        assert "configures nothing" in lowered, "it does not say the package installs no provider of its own"
        assert "first operation" in lowered, "it does not say where the connection cost lands"
        assert "a few microseconds" in lowered, "it does not say what an operation costs with no provider"
        assert "`memory.initialize`" in _marked_section("observability"), (
            "it does not say that a memory store's first pool event lands on the initialize span"
        )

    def test_the_timed_out_wait_is_explained(self) -> None:
        lowered = _marked_section("observability").lower()

        assert "`timed_out`" in lowered and "unset" in lowered, "it does not say a timed-out wait is not an error"

    def test_every_log_event_and_field_is_named(self) -> None:
        """AT-210 -- the event names are a contract a log pipeline indexes on, so they are listed."""
        section = _marked_section("observability")

        missing = sorted(name for name in get_args(_telemetry.LogEvent) if f"`{name}`" not in section)
        assert missing == [], f"the observability section does not name the log events {missing}"
        for field in ("strands_mongodb_event", "strands_mongodb_namespace", "strands_mongodb_tier"):
            assert f"`{field}`" in section, field


_VOYAGE_WORDS = ("dark", "mode", "coffee", "tea")


class _FakeVoyageClient:
    """Stands in for ``voyageai.AsyncClient``: bag-of-words vectors at the README's 1024 dimensions."""

    calls: list[tuple[list[str], str | None]] = []

    async def embed(self, texts: list[str], model: str | None = None, **kwargs: Any) -> Any:
        self.calls.append((texts, model))
        vectors = []
        for text in texts:
            words = text.lower().split()
            vectors.append([0.01 + words.count(word) for word in _VOYAGE_WORDS] + [0.01] * 1020)
        return types.SimpleNamespace(embeddings=vectors)


def _voyage_block() -> Block:
    """Return the README block that defines ``VoyageEmbedder``."""
    blocks = [block for block in _PACKAGE_BLOCKS if "class VoyageEmbedder" in block.body]
    assert len(blocks) == 1, f"expected one block defining VoyageEmbedder in {_PACKAGE_README.name}"
    return blocks[0]


def _exec_voyage_block(monkeypatch: pytest.MonkeyPatch, connection: dict[str, Any]) -> dict[str, Any]:
    """Execute the block with ``voyageai`` stubbed, returning its namespace."""
    _FakeVoyageClient.calls = []
    monkeypatch.setitem(sys.modules, "voyageai", types.SimpleNamespace(AsyncClient=_FakeVoyageClient))
    namespace: dict[str, Any] = {"connection": connection, "MongoDBMemoryStore": MongoDBMemoryStore}
    exec(_voyage_block().body, namespace)  # noqa: S102 - the README's own snippet
    return namespace


class TestTheVoyageEmbedderSnippet:
    """The ``VoyageEmbedder`` the README defines is an embedder the store accepts."""

    async def test_it_embeds_one_text_with_the_named_model(self, monkeypatch: pytest.MonkeyPatch) -> None:
        namespace = _exec_voyage_block(monkeypatch, {"connection_string": "mongodb://localhost:1", "database": "d"})
        store = namespace["store"]

        pending = store._embedder.embed("dark mode")
        assert inspect.isawaitable(pending)
        vector = await pending

        assert len(vector) == store._mode.dimensions
        assert all(isinstance(value, float) for value in vector)
        assert _FakeVoyageClient.calls == [(["dark mode"], "voyage-4-lite")]

    def test_it_calls_the_real_client_as_it_is_shaped(self) -> None:
        voyageai = pytest.importorskip("voyageai")
        embed = voyageai.AsyncClient.embed

        assert inspect.iscoroutinefunction(embed)
        assert list(inspect.signature(embed).parameters)[1:3] == ["texts", "model"]
        assert "embeddings" in vars(voyageai.object.embeddings.EmbeddingsObject())

    @pytest.mark.integration
    async def test_its_store_finds_a_memory_by_meaning(
        self, monkeypatch: pytest.MonkeyPatch, atlas_uri: str, test_database_name: str
    ) -> None:
        database = f"{test_database_name}_voyage"
        namespace = _exec_voyage_block(monkeypatch, {"connection_string": atlas_uri, "database": database})
        store: MongoDBMemoryStore = namespace["store"]
        try:
            await store.add("the user prefers dark mode")
            await store.add("the user drinks coffee and tea")

            found: list[Any] = []
            deadline = time.monotonic() + 60
            while len(found) < 2 and time.monotonic() < deadline:
                try:
                    found = list(await store.search("dark mode"))
                except StorageError as error:
                    skip_if_search_is_unreachable(error)
                    raise
                await asyncio.sleep(0.5)

            assert [entry.content for entry in found][:1] == ["the user prefers dark mode"]
        finally:
            await store.close()
            client: AsyncMongoClient[Any] = AsyncMongoClient(atlas_uri)
            await client.drop_database(database)
            await client.close()
