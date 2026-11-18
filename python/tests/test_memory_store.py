"""``MongoDBMemoryStore``'s ``MemoryStore`` surface: protocol shape, scope, dedup, search tiers.

Split across three tiers by what each claim has to be observed against:

* **unit** for what is decided before any round trip: the protocol shape, the limit chain, the
  reserved-key merge, the ``writable`` gate, the score-bound pair, and a source-level tripwire on the
  regex tier.
* **contract** for writes, ordinary indexes, the dedup constraint and the no-search-support path. A
  plain ``mongod`` runs all of those, and answers no query at all (see ``conftest.py``), so nothing in
  this tier searches.
* **integration** for every read, because no search tier runs without mongot and a query gets one of
  three server error codes instead.

**Most of what this file claims needs a server, unlike ``test_storage.py`` and ``test_indexes.py``.**
Both of those hand-write a fake collection because their claims are about the pipeline or the command
this package emits, which a server would answer identically whether or not the emission was right. Most
claims here are about what the server then *does*: one document instead of two, a scope predicate that
excludes, a tier that answers. A fake asserting those would be asserting its own implementation.

**The unit tier holds one fake collection anyway, and it is the ``test_storage.py`` case rather than
an exception to it.** What it records is the ``$match`` this package composes and the ``MemoryEntry``
it builds back out of a document. Both are this package's own code, and a deployment makes neither
more real: mongot answers a predicate that lost the store's configured filter with *results* rather
than with an error, so only the recorded stage shows that the term is there. The fake is fixed
documents in, recorded stages out. It resolves nothing, matches nothing and ranks nothing, so every
claim about matching or ranking is still on a tier below.

``TestAddMessagesStaysAbsentAndAddDoesNot`` overlaps ``test_construction.py``'s
``TestTheHooksThatMustStayAbsent``, which already pins ``not hasattr(store, "add_messages")`` and
``_has_method(...) is False``. The pair is completed here because its second half,
``_has_method(store, "add") is True``, is what makes the first half mean anything: a store missing
*both* methods passes the absence check and routes nowhere. ``TestNoRegexTierIsReachable`` sits beside
``test_types.py``'s ``TestTheSearchTierVocabulary`` the same way.
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import datetime
import hashlib
import inspect
import logging
import math
import re
import time
import traceback
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

import bson
import pytest
from bson import ObjectId
from conftest import skip_if_search_is_unreachable
from pymongo import AsyncMongoClient
from pymongo.errors import DuplicateKeyError, OperationFailure
from strands.memory import MemoryManager
from strands.memory.types import MemoryEntry, _has_method
from strands.types.exceptions import StorageError

import strands_mongodb
from strands_mongodb import _client, _indexes, _pipeline
from strands_mongodb import storage as storage_module
from strands_mongodb.memory_store import UNSCOPED, MongoDBMemoryStore, _merge_metadata, _resolve_limit
from strands_mongodb.storage import MongoDBStorage
from strands_mongodb.types import DEFAULT_MAX_SEARCH_RESULTS, RESERVED_METADATA_KEYS

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Iterator

    from strands_mongodb.types import MongoDBConfig, MongoDBMemoryStoreConfig

# Same reserved port and the same reason as in ``test_construction.py``: a unit-tier test that reaches
# the network fails on the timeout instead of finding a stray local mongod and passing for the wrong
# reason. The 50 ms selection timeout keeps that failure fast.
UNREACHABLE = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=50"

# A URI whose inline password must not appear anywhere, for the memory store's credential tests. Deliberately not a
# plausible-looking secret, so a grep over a failure report finds it.
LEAKY_URI = "mongodb://u:SUPERSECRET@127.0.0.1:1/?serverSelectionTimeoutMS=50"
SECRET = "SUPERSECRET"


@pytest.fixture(autouse=True)
def _clear_registry() -> Iterator[None]:
    """Isolate each test from the process-global connection registry.

    Same justification as the fixture of this name in ``test_client.py`` and
    ``test_construction.py``: the registry is module-level by design, so a test that
    constructs a store otherwise leaves a connection behind for the next one.
    """
    _client._REGISTRY.clear()
    yield
    _client._REGISTRY.clear()


def _connection_config(**overrides: Any) -> MongoDBConfig:
    """Build a minimal valid connection config pointing at nothing.

    Args:
        **overrides: Fields to set or replace.

    Returns:
        A config with ``database`` and ``connection_string`` set.
    """
    config: dict[str, Any] = {"database": "appdb", "connection_string": UNREACHABLE}
    config.update(overrides)
    return config  # type: ignore[return-value]


def _store_config(**overrides: Any) -> MongoDBMemoryStoreConfig:
    """Build a minimal valid memory-store config, nesting the connection half under ``config``.

    Args:
        **overrides: Top-level store fields to set or replace. Pass ``config=`` to replace the
            connection half.

    Returns:
        A config with ``name`` and a valid nested ``config``.
    """
    store: dict[str, Any] = {"name": "facts", "config": _connection_config()}
    store.update(overrides)
    return store  # type: ignore[return-value]


def _store(**overrides: Any) -> MongoDBMemoryStore:
    """Build a store on an unreachable deployment: constructs fully, answers nothing.

    Args:
        **overrides: Top-level store fields, as for :func:`_store_config`.

    Returns:
        The store.
    """
    return MongoDBMemoryStore(**_store_config(**overrides))


def _real_store(uri: str, database: str, collection: str, **overrides: Any) -> MongoDBMemoryStore:
    """Build a store on a real deployment, in a collection the caller owns.

    Takes a URI rather than a fixture's client, following ``test_storage.py``'s ``contract_storage``:
    the package builds and owns the client, so ``close()`` is exercised on the path a user takes
    rather than short-circuited by the rule that a store never closes an injected client.

    Args:
        uri: Connection string for the deployment.
        database: Database to use, normally this session's throwaway one.
        collection: Collection to use, normally this test's own.
        **overrides: Top-level store fields. Pass ``connection=`` to add connection-level keys such
            as ``search_type`` or ``filter_fields``.

    Returns:
        The store. The caller closes it.
    """
    connection: dict[str, Any] = {"connection_string": uri, "database": database}
    connection.update(overrides.pop("connection", {}))
    store: dict[str, Any] = {"name": "facts", "config": connection, "collection": collection}
    store.update(overrides)
    return MongoDBMemoryStore(**store)


def _package_sources() -> dict[str, str]:
    """Read every module in the installed package as text.

    Returns:
        Module file name to source, for the source-level tripwires.
    """
    root = Path(strands_mongodb.__file__).parent
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(root.rglob("*.py"))}


def _string_literals(source: str) -> list[str]:
    """Return every string literal in a module except its docstrings.

    Docstrings are excluded because two of the tripwires below scan for an operator name, and the place
    an operator name most legitimately appears is a docstring explaining why the module does not use
    it. ``storage.py`` has exactly that: ``{"_id": {"$regex": "^prefix"}}`` in prose, arguing for a
    range query instead. A raw ``in source`` scan reads that as the operator being emitted, which would
    make ``TestNoRegexTierIsReachable`` fail on a comment and pass on a regression once the comment was
    deleted.

    Args:
        source: Module source.

    Returns:
        Every non-docstring string constant, in source order.
    """
    tree = ast.parse(source)
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        first = node.body[0] if node.body else None
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
            docstrings.add(id(first.value))
    return [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings
    ]


def _raised_names(source: str) -> set[str]:
    """Return the exception names a module raises.

    Read from ``ast.Raise`` nodes rather than from the text, so prose describing an exception this
    package deliberately does not raise cannot trip ``TestNoMethodStandsInForAbsence``. ``test_construction.py``'s own
    docstring contains that exact sentence about ``NotImplementedError``.

    Args:
        source: Module source.

    Returns:
        The bare names raised, with any module path stripped.
    """
    names: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Raise) or node.exc is None:
            continue
        target = node.exc.func if isinstance(node.exc, ast.Call) else node.exc
        if isinstance(target, ast.Name):
            names.add(target.id)
        elif isinstance(target, ast.Attribute):
            names.add(target.attr)
    return names


SUBSET_PROTOCOL_SNIPPET = '''
"""The nine ``MemoryStore`` members the SDK actually calls, declared here rather than imported."""

from __future__ import annotations

from typing import Any, Protocol

from strands.memory.extraction.types import ExtractionConfig
from strands.memory.types import MemoryEntry, Metadata, SearchOptions
from strands.types.tools import AgentTool

from strands_mongodb.memory_store import MongoDBMemoryStore


class MemoryStoreSubset(Protocol):
    name: str
    description: str | None
    max_search_results: int | None
    writable: bool
    extraction: ExtractionConfig | bool | None

    async def search(self, query: str, options: SearchOptions | None = None) -> list[MemoryEntry]: ...

    async def add(self, content: str, metadata: Metadata | None = None) -> Any: ...

    async def initialize(self) -> None: ...

    def get_tools(self) -> list[AgentTool]: ...


store: MemoryStoreSubset = MongoDBMemoryStore(
    name="facts", config={"database": "appdb", "connection_string": "mongodb://127.0.0.1:1"}
)
'''


@pytest.mark.compat
class TestTheProtocolMembersTheSDKCalls:
    """AT-052 — the SDK's ``MemoryStore`` surface, asserted by assignment because ``isinstance`` is not available.

    ``MemoryStore`` is a plain ``Protocol``, not ``runtime_checkable``, so ``isinstance`` against it
    raises ``TypeError`` rather than returning ``False``; and it declares ten members while this store
    deliberately omits ``add_messages``, so no SDK-authored check can pass. What is left is the strongest
    check available: a nine-member Protocol declared in this file, satisfied by assignment under mypy,
    plus the SDK's own runtime detector on the four methods the manager dispatches through.

    Marked ``compat`` and it still runs in an ordinary session. The marker selects it for the CI cron
    that resolves the latest published ``strands-agents`` instead of the pinned one, so a tenth member
    the manager starts calling shows up as a mypy failure here rather than in a user's traceback. The
    gate in ``conftest.py`` covers the three tiers that need a backend, and this needs none, so nothing
    skips it locally.
    """

    def test_the_store_satisfies_a_nine_member_subset_protocol_under_mypy(self, run_mypy: Any) -> None:
        """Assignment to the Protocol is the assertion; mypy reports the gap if a member is missing.

        A missing attribute, a wrong parameter name or a narrowed return type all surface as an error
        on the assignment line, which is the whole point of writing it as an assignment rather than as
        a set of ``hasattr`` checks.
        """
        result = run_mypy(SUBSET_PROTOCOL_SNIPPET)

        assert result.returncode == 0, result.stdout
        assert "error:" not in result.stdout, result.stdout

    def test_the_subset_omits_exactly_one_member_of_the_sdk_protocol(self) -> None:
        """The subset is nine of ten, and the tenth is ``add_messages``, which this store omits on purpose.

        Derived from the SDK's own annotations rather than hard-coded, so a member added upstream makes
        this fail on the pinned SDK too, not only on the compat cron. Without it the subset could drift
        into asserting a protocol the SDK no longer has.
        """
        from strands.memory.types import MemoryStore

        attributes = {name for name in MemoryStore.__annotations__ if not name.startswith("_")}
        methods = {name for name, value in vars(MemoryStore).items() if not name.startswith("_") and callable(value)}

        assert attributes | methods == {
            "name",
            "description",
            "max_search_results",
            "writable",
            "extraction",
            "search",
            "add",
            "add_messages",
            "initialize",
            "get_tools",
        }
        assert "add_messages" not in SUBSET_PROTOCOL_SNIPPET

    @pytest.mark.parametrize("method", ["search", "add", "initialize", "get_tools"])
    def test_the_sdk_detector_finds_each_method_the_manager_dispatches_through(self, method: str) -> None:
        """``_has_method`` reads ``getattr(type(store), name)``, so this is a claim about the class."""
        assert _has_method(_store(), method) is True


class TestTheHookThatReturnsNothing:
    """AT-052a — ``get_tools`` is present and empty, and presence changes nothing.

    None of the three vended stores defines ``get_tools``, so there is no precedent for the return
    value, while the detector above has to report it present. Both hold at once
    because ``MemoryManager._build_tools`` reads
    ``if _has_method(store, "get_tools"): tools.extend(store.get_tools())``
    (``memory_manager.py:252-254``): a present method returning ``[]`` extends the list by nothing.

    That is the asymmetry with ``add_messages``, whose presence decides *which extractor runs*. A
    method whose presence changes routing is a hazard; one whose presence changes nothing is where a
    store's own tools can be added later without a compatibility event.
    """

    def test_get_tools_returns_an_empty_list(self) -> None:
        """An empty ``list``, not ``None`` and not a tuple: the manager calls ``extend`` on it."""
        tools = _store().get_tools()

        assert tools == []
        assert isinstance(tools, list)

    def test_a_manager_holding_the_store_registers_only_its_own_two_tools(self) -> None:
        """The observable form of "identical to absence": the tool list the agent would see.

        ``add_tool_config=True`` and a writable store, because the manager disables the add tool by
        default and the interesting count is the one where both of its own tools are live. A store
        contributing anything would show up as a third entry.
        """
        store = _store(writable=True)

        # The store deliberately does not satisfy the ten-member `MemoryStore`, so the SDK's own
        # annotation rejects it while `_has_method` accepts it at runtime. The ignore is the omitted
        # `add_messages` being visible at the call site, and it stays.
        manager = MemoryManager(stores=[store], add_tool_config=True)  # type: ignore[list-item]

        assert [tool.tool_name for tool in manager.tools] == ["search_memory", "add_memory"]


class TestAddMessagesStaysAbsentAndAddDoesNot:
    """AT-044a, AT-044b — the SDK routes extraction through ``add``, the pair rather than the half.

    ``test_construction.py`` already asserts the absence. What it cannot assert on its own is that the
    absence routes anywhere: ``_has_method(store, "add_messages") is False`` also holds for a store with
    no write path at all, and the manager's fallback is ``ModelExtractor`` feeding ``add``. So the two
    probes belong together here.
    """

    def test_add_messages_is_absent_by_both_probes(self) -> None:
        """``hasattr`` and the SDK's detector agree, because this class inherits no Protocol.

        Both are asserted because they would disagree if this class ever inherited
        ``MemoryStore``: the inherited stub satisfies ``hasattr`` while ``_has_method`` still reports it
        absent, and that divergence is what would silently reintroduce the raising-stub hazard.
        """
        store = _store()

        assert not hasattr(store, "add_messages")
        assert _has_method(store, "add_messages") is False

    def test_add_is_present_by_the_same_detector(self) -> None:
        """The half that makes the absence mean something rather than mean nothing."""
        assert _has_method(_store(), "add") is True

    def test_a_writable_store_satisfies_the_managers_write_sink_check(self) -> None:
        """The manager's own reading of the pair, which is where a wrong answer would surface.

        ``MemoryManager.__init__`` raises *"is writable but has no add or add_messages method"* for a
        writable store it cannot write to (``memory_manager.py:130-133``). Constructing the manager is
        the assertion; it raises ``ValueError`` if either probe above is wrong in the direction that
        matters.
        """
        manager = MemoryManager(stores=[_store(writable=True)])  # type: ignore[list-item]

        assert manager.tools[0].tool_name == "search_memory"


class TestNoMethodStandsInForAbsence:
    """AT-044d — a stub that raises is present, and presence is what the SDK reads.

    ``_has_method`` and ``hasattr`` both report a ``raise NotImplementedError`` body as a member the
    caller may use, so the SDK routes to it and every call fails. That converts "the SDK picks another
    path" into "the SDK crashes", for ``add_messages`` on this class and for ``for_sandbox`` on
    ``MongoDBStorage`` (``test_storage.py``'s ``TestTheProtocolIsSatisfiedStructurally``). Asserted over
    both public classes and then over the whole package, because the hazard is the pattern rather than
    the two names.
    """

    @pytest.mark.parametrize("cls", [MongoDBMemoryStore, MongoDBStorage])
    def test_neither_public_class_raises_not_implemented_error(self, cls: type) -> None:
        """Read from the class body's ``raise`` statements, so a docstring mentioning it is fine."""
        assert "NotImplementedError" not in _raised_names(inspect.getsource(cls))

    def test_no_module_in_the_package_raises_not_implemented_error(self) -> None:
        """The tripwire, one level wider: an internal module could hold the same stub.

        ``_client.resolve`` and ``_indexes.ensure`` are both places where "not supported here" is a real
        condition, and both already answer it with ``ValueError`` or ``StorageError`` carrying the
        server's own message. This fails if either one starts raising ``NotImplementedError`` instead.
        """
        sources = _package_sources()
        offenders = {
            name: sorted(_raised_names(source))
            for name, source in sources.items()
            if "NotImplementedError" in _raised_names(source)
        }

        assert offenders == {}


class TestTheResultLimit:
    """AT-041 — a four-link chain and a floor, both asserted where they are decided.

    The resolver is tested directly rather than through a result count: the observable outcome of a
    limit is *how many documents come back*, which needs a search-capable deployment, and there the
    count is also shaped by the corpus and by the score bounds. So the chain is asserted here as
    arithmetic and the count is asserted on the integration tier (``TestWhatASearchHandsBack``,
    ``TestTheScoreBoundDropsResults``), which is the split the two tiers exist for.

    ``query["limit"]`` sits above ``options`` because a ``MongoDBSearchQuery`` can only arrive on a
    direct call: ``MemoryStore.search`` is declared ``query: str``, and both SDK call sites pass a
    ``str``. Below ``options`` the key would be unreachable rather than lower priority, since
    ``MemoryManager.search`` always passes ``options`` with ``max_search_results`` already resolved.
    """

    def test_a_query_limit_wins_over_everything_below_it(self) -> None:
        """All four links supplied, and the topmost one is the answer."""
        assert _resolve_limit(query=3, options=7, instance=11) == 3

    def test_options_win_over_the_instance_default(self) -> None:
        """What the manager-driven path resolves to: no query limit, options carrying its own chain."""
        assert _resolve_limit(query=None, options=7, instance=11) == 7

    def test_the_instance_value_wins_over_the_package_default(self) -> None:
        """The store's own ``max_search_results``, which is where a per-store ceiling belongs."""
        assert _resolve_limit(query=None, options=None, instance=11) == 11

    def test_nothing_supplied_resolves_to_the_package_default(self) -> None:
        """Ten, from ``types.DEFAULT_MAX_SEARCH_RESULTS``, matching both shipped stores."""
        assert _resolve_limit(query=None, options=None, instance=None) == DEFAULT_MAX_SEARCH_RESULTS
        assert DEFAULT_MAX_SEARCH_RESULTS == 10

    def test_a_limit_below_one_is_rejected_at_construction(self) -> None:
        """``__init__``, because a store whose ceiling is zero can never answer anything.

        ``BedrockKnowledgeBaseStore`` raises in the same place for the same value, so the shape is
        precedented rather than invented.
        """
        with pytest.raises(ValueError, match="max_search_results"):
            _store(max_search_results=0)

    async def test_a_limit_below_one_in_options_is_rejected_before_any_round_trip(self) -> None:
        """The store points at a closed port, so a resolver running after the query fails differently.

        That is the assertion, not an accident of the fixture: ``ValueError`` here means the check ran
        before the network, and a connection error would mean it ran after.
        """
        with pytest.raises(ValueError, match="max_search_results"):
            await _store().search("anything", {"max_search_results": 0})

    async def test_a_limit_below_one_in_a_query_is_rejected_before_any_round_trip(self) -> None:
        """The fourth raise site, on the query's own ``limit`` key."""
        with pytest.raises(ValueError, match="limit"):
            await _store().search({"text": "anything", "limit": 0})


class TestReservedMetadataKeysWin:
    """AT-057 — the caller's key is dropped, and the drop is logged.

    Four reserved keys travel out with every result: ``_relevance_score``, ``_id``, ``_search_type`` and
    ``_scope``. A stored document whose ``metadata`` holds one of those names would otherwise decide the
    value of a field the caller is meant to trust, and ``_scope`` is the one where that matters most: a
    document claiming a scope it was not stored in reads as a cross-scope leak.

    Merged by a helper rather than inline, so this tier can assert the merge without a deployment. The
    integration tier then asserts the four keys are populated at all (``TestWhatASearchHandsBack``).
    """

    def test_a_colliding_caller_key_keeps_the_reserved_value(self) -> None:
        """The reserved value survives and the caller's is gone, not renamed and not nested."""
        merged = _merge_metadata(
            {"_scope": "somebody-elses-scope", "topic": "cats"},
            {"_scope": "tenant-a", "_id": "abc", "_search_type": "vector", "_relevance_score": 0.5},
            store_name="facts",
        )

        assert merged["_scope"] == "tenant-a"
        assert merged["topic"] == "cats"
        assert list(merged.values()).count("somebody-elses-scope") == 0

    def test_non_colliding_caller_keys_survive_untouched(self) -> None:
        """The merge is not a filter. Caller metadata is why the field exists."""
        merged = _merge_metadata({"topic": "cats", "source": "chat"}, {"_id": "abc"}, store_name="facts")

        assert merged == {"topic": "cats", "source": "chat", "_id": "abc"}

    def test_the_collision_is_logged_with_the_key_and_the_store(self, caplog: pytest.LogCaptureFixture) -> None:
        """A dropped value with no log record is indistinguishable from a value that never existed.

        ``warning`` rather than ``debug``: a collision is a caller mistake with a fix, and the fix
        cannot be found from an absent field. The store name is in the record because one process holds
        several stores over one collection.
        """
        with caplog.at_level(logging.WARNING, logger="strands_mongodb.memory_store"):
            _merge_metadata({"_id": "spoofed"}, {"_id": "real"}, store_name="facts")

        assert len(caplog.records) == 1
        assert "_id" in caplog.records[0].message
        assert "facts" in caplog.records[0].message

    def test_the_collision_record_carries_the_namespace(self, caplog: pytest.LogCaptureFixture) -> None:
        """Every other event this store logs carries its namespace, so a filter on it would miss this one."""
        with caplog.at_level(logging.WARNING, logger="strands_mongodb.memory_store"):
            _merge_metadata({"_id": "spoofed"}, {"_id": "real"}, store_name="facts", namespace="appdb.memory")

        assert vars(caplog.records[0])["strands_mongodb_namespace"] == "appdb.memory"

    def test_every_reserved_key_is_defended(self) -> None:
        """Parametrized over the constant rather than a hand-written list, so the two cannot drift."""
        for key in RESERVED_METADATA_KEYS:
            merged = _merge_metadata({key: "caller"}, {key: "reserved"}, store_name="facts")

            assert merged[key] == "reserved", key


class TestNoRegexTierIsReachable:
    """AT-055 — a tripwire on a requirement that cannot be satisfied yet.

    Query text has to pass through ``re.escape`` *while a regex tier is active*, and no such tier exists:
    ``SearchType`` accepts ``auto``, ``vector``, ``text`` and ``hybrid``. So the clause is vacuously true,
    which is not the same as satisfied. A contract test of the escaping cannot exist without the tier, and
    a skipped placeholder asserts nothing while looking like coverage.

    What is testable is the vacuity. ``test_types.py``'s ``TestTheSearchTierVocabulary`` pins that neither
    ``SearchType`` nor ``ResolvedSearchType`` admits ``regex``, so no config value and no result value
    selects the tier. These tests add that no module emits the operator either, so there is no
    unselectable back door. The filter validator stops a caller from naming the operator through
    ``filter``, at any depth, and also stops the other route to the same matching: a native
    ``re.Pattern`` or ``bson.Regex`` *value*, which ``$match`` dispatches on exactly as it would the
    operator.

    Both fail as soon as a regex tier is added, which is when ``re.escape`` has to be there.
    """

    def test_no_module_emits_a_regex_match_operator(self) -> None:
        """Every ``$regex``-family token in the package, from string literals only.

        ``$regexFindAll`` is allowed and is not this tier. It is an aggregation *expression* over ``_id``
        in ``MongoDBStorage``'s keyword search, tokenizing a stored key rather than matching a caller's
        query, and it takes no caller input at all. The next test pins where it lives so the allowance
        cannot quietly widen.
        """
        found = {
            token
            for source in _package_sources().values()
            for literal in _string_literals(source)
            for token in re.findall(r"\$regex[A-Za-z]*", literal)
        }

        assert found <= {"$regexFindAll"}, found

    def test_the_one_allowed_regex_expression_stays_where_it_is(self) -> None:
        """``$regexFindAll`` in ``storage.py`` and nowhere else, least of all on a memory query path."""
        modules = {
            name
            for name, source in _package_sources().items()
            if any("$regexFindAll" in literal for literal in _string_literals(source))
        }

        assert modules == {"storage.py"}

    def test_no_module_emits_a_text_search_operator(self) -> None:
        """``$text`` is the other half of the deferred no-mongot tier, so it is the other half of the wire.

        Not a stylistic ban. A ``$text`` index would be a fourth index nobody provisioned and a fifth
        scoring scale ``_search_type`` has no value for.
        """
        found = {
            name
            for name, source in _package_sources().items()
            for literal in _string_literals(source)
            if "$text" in literal
        }

        assert found == set()


class TestWritable:
    """AT-058 — defaults to ``False``, and ``add`` on a read-only store says which key.

    Two precedents disagree: ``FileMemoryStore`` defaults it to ``True``,
    ``BedrockKnowledgeBaseStore`` and the official extension template both to ``False``. Two of three,
    including the template this package is modelled on, decides it. The cost is asymmetric in the same
    direction: ``writable`` gates automatic extraction, so ``True`` means a store built for retrieval
    starts accepting model-distilled writes nobody asked for.
    """

    def test_the_default_is_read_only(self) -> None:
        """Absent from the config means ``False``, not ``None`` and not truthy-by-omission."""
        assert _store().writable is False

    def test_configuring_it_makes_the_store_writable(self) -> None:
        """The opt-in has to actually arrive, or the default is the only behavior."""
        assert _store(writable=True).writable is True

    async def test_add_on_a_read_only_store_names_the_key_that_enables_it(self) -> None:
        """``ValueError`` naming ``writable``, before any round trip.

        A message that says only "not writable" leaves the caller reading source to find the key. The
        error arrives before the network for the same reason as the limit checks: this is caller
        configuration, and a connection error would hide it.
        """
        with pytest.raises(ValueError, match="writable"):
            await _store().add("a fact nobody asked to store")


class TestScoreBounds:
    """AT-059a — the mutually exclusive pair, rejected at construction.

    ``MongoDBMemoryStoreConfig``'s ``max_score`` docstring promises *"Mutually exclusive with
    ``min_score``"*, and this is what holds the public type to it. ``BedrockKnowledgeBaseStore`` raises
    for the same pair in ``__init__``. ``__init__`` rather than ``search``, because the pair is store
    configuration and a constructor that accepts a contradiction only defers the error to a query.

    What the bounds then *do* to a result set is ``TestTheScoreBoundDropsResults``, on the integration
    tier, against real scores.
    """

    def test_both_bounds_together_are_rejected_naming_both_keys(self) -> None:
        """Both names in the message, because either one is the one the caller meant to keep."""
        with pytest.raises(ValueError) as error:
            _store(min_score=0.1, max_score=0.9)

        assert "min_score" in str(error.value)
        assert "max_score" in str(error.value)

    @pytest.mark.parametrize("bound", ["min_score", "max_score"])
    def test_either_bound_alone_constructs(self, bound: str) -> None:
        """The rejection is of the pair, not of the feature."""
        store = _store(**{bound: 0.5})

        assert getattr(store, bound) == 0.5


class TestEveryCallerInputIsCheckedBeforeTheNetwork:
    """AT-076 — the query and filter guards, on a closed port.

    Same premise and the same reserved port as ``TestTheResultLimit``'s last two tests: a check that
    reached the network would time out instead of raising, so the ``ValueError`` is evidence of the
    ordering as well as of the check.

    ``test_pipeline.py`` and ``test_filter.py`` already close both guards over their own functions. What
    these tests add is that the memory store *calls* them, and calls them first: the ``check_query_keys``
    call in ``search``, the per-query ``_filter.validate`` call and the configured-filter one in
    ``__init__``. Without those calls a guard can pass its own unit tests while the store sends an
    undeclared filter path or an operator key to the server, which is how a cross-scope read happens.

    The positive control for all four rejections is the first test of
    ``TestWhatTheStoreSendsAndWhatItMapsBack``, which puts a declared path in both filter positions and
    asserts the predicate that comes out.
    """

    @pytest.mark.parametrize(
        ("query", "expected"),
        [
            ({"text": "dark mode", "vector": [1.0, 0.0, 0.0, 0.0]}, "both"),
            ({"limit": 5}, "neither"),
        ],
        ids=["both-keys", "neither-key"],
    )
    async def test_a_query_setting_both_or_neither_vector_key_is_rejected(self, query: Any, expected: str) -> None:
        """The one-vector-key rule at this surface, which is the only surface a caller reaches.

        ``limit`` is set on the neither-key case so the limit chain is not what raises, and the message
        substrings are the two words that distinguish the pair.
        """
        with pytest.raises(ValueError, match=expected):
            await _store().search(query)

    @pytest.mark.parametrize(
        ("bad_filter", "expected"),
        [({"metadata.tier": "gold"}, "filter_fields"), ({"$where": "sleep(1000)"}, r"\$where")],
        ids=["undeclared-path", "operator-key"],
    )
    async def test_a_per_query_filter_is_validated_before_the_query_runs(
        self, bad_filter: dict[str, Any], expected: str
    ) -> None:
        """Declared paths only and no operator keys, on the filter that arrives with a single query."""
        with pytest.raises(ValueError, match=expected):
            await _store().search({"text": "dark mode", "filter": bad_filter})

    @pytest.mark.parametrize(
        ("bad_filter", "expected"),
        [({"metadata.tier": "gold"}, "filter_fields"), ({"$where": "sleep(1000)"}, r"\$where")],
        ids=["undeclared-path", "operator-key"],
    )
    def test_a_configured_filter_is_validated_at_construction(self, bad_filter: dict[str, Any], expected: str) -> None:
        """The same two guards, one query earlier.

        A store filter applies to every query this store will ever run, so a constructor that accepts one
        the index cannot serve defers the error to whichever search happens first and reports it as that
        search's problem.
        """
        with pytest.raises(ValueError, match=expected):
            _store(filter=bad_filter)


class _RecordingCollection:
    """A collection that records what it was handed and answers with documents the test wrote.

    The one fake collection in this file, and the module docstring says why it is here. It resolves
    nothing: ``documents`` come back in the order given, whatever the stages ask for. That makes it
    usable for the two claims it serves, which are the stages this package emits and the entries it
    builds out of a document, and useless for anything about matching, ranking or counting.

    Attributes:
        documents: What ``aggregate`` answers with.
        failure: A driver error to raise instead of answering, for the driver-error tests.
        pipelines: Every pipeline handed to ``aggregate``, in call order.
        upserts: Every ``(selector, update)`` pair handed to ``update_one``.
        deletes: Every filter handed to ``delete_one`` or ``delete_many``, in call order.
        deleted: The count the two delete methods report back, which a test sets to a number no real
            deletion of its documents could produce.
    """

    def __init__(self, documents: list[dict[str, Any]], *, failure: Exception | None = None) -> None:
        self.documents = documents
        self.failure = failure
        self.pipelines: list[list[dict[str, Any]]] = []
        self.upserts: list[tuple[dict[str, Any], dict[str, Any]]] = []
        self.deletes: list[dict[str, Any]] = []
        self.deleted = 0

    async def aggregate(self, pipeline: Any, *args: Any, **kwargs: Any) -> Any:
        """Record the stages, then answer or fail.

        Args:
            pipeline: The stages the store composed.
            *args: Ignored, so a signature change downstream does not fail here for the wrong reason.
            **kwargs: Ignored, as above.

        Returns:
            An async iterator over :attr:`documents`, which is what the driver returns.

        Raises:
            Exception: :attr:`failure`, if one was set.
        """
        self.pipelines.append([dict(stage) for stage in pipeline])
        if self.failure is not None:
            raise self.failure
        return _cursor(self.documents)

    async def update_one(self, selector: Any, update: Any, *args: Any, **kwargs: Any) -> Any:
        """Record the upsert, then fail.

        There is no success path here on purpose. What ``add`` does with an ``UpdateResult`` is a document
        count, which ``TestDedupAgainstTheUniqueIndex`` asserts against a deployment; a hand-written result would be
        this fake asserting its own return value.

        Args:
            selector: The upsert filter.
            update: The update document.
            *args: Ignored.
            **kwargs: Ignored.

        Raises:
            Exception: :attr:`failure`, if one was set.
            NotImplementedError: Otherwise.
        """
        self.upserts.append((dict(selector), dict(update)))
        if self.failure is not None:
            raise self.failure
        raise NotImplementedError("no test needs a faked UpdateResult; the write path's claims are counts")

    async def delete_one(self, selector: Any, *args: Any, **kwargs: Any) -> Any:
        """Record the filter, then report :attr:`deleted`.

        A fabricated count here, where ``update_one`` above refuses to fabricate one, and the difference
        is what the count is being read for. ``add`` turns an ``UpdateResult`` into a document count, so a
        faked result would be this fake asserting its own arithmetic. ``delete`` passes the driver's
        number straight through, so a fake returning a number no real deletion could produce is exactly
        what catches a method that returns ``1`` on its own authority.

        Args:
            selector: The delete filter.
            *args: Ignored.
            **kwargs: Ignored.

        Returns:
            An object exposing ``deleted_count``, which is the one field of the driver's ``DeleteResult``
            this package reads.

        Raises:
            Exception: :attr:`failure`, if one was set.
        """
        self.deletes.append(dict(selector))
        if self.failure is not None:
            raise self.failure
        return _DeleteResult(self.deleted)

    async def delete_many(self, selector: Any, *args: Any, **kwargs: Any) -> Any:
        """Record the filter, then report :attr:`deleted`, as :meth:`delete_one` does.

        Args:
            selector: The delete filter.
            *args: Ignored.
            **kwargs: Ignored.

        Returns:
            An object exposing ``deleted_count``.

        Raises:
            Exception: :attr:`failure`, if one was set.
        """
        self.deletes.append(dict(selector))
        if self.failure is not None:
            raise self.failure
        return _DeleteResult(self.deleted)

    @property
    def stages(self) -> list[dict[str, Any]]:
        """The one recorded pipeline.

        Returns:
            The stages, failing the test if ``aggregate`` was not called exactly once.
        """
        assert len(self.pipelines) == 1, f"expected one aggregate call, got {len(self.pipelines)}"
        return self.pipelines[0]


class _DeleteResult:
    """The one field of ``pymongo.results.DeleteResult`` this package reads.

    Attributes:
        deleted_count: How many documents the server removed.
    """

    def __init__(self, deleted_count: int) -> None:
        self.deleted_count = deleted_count


async def _cursor(documents: list[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
    """Yield each document, as the driver's cursor does.

    An async generator rather than a list, because ``search`` consumes the result with ``async for`` and a
    fake that returned a list would let a synchronous iteration pass here and fail on a deployment. Copied
    per document, so a test can assert on the dict it wrote afterwards.

    Args:
        documents: What to yield.

    Yields:
        Each document, shallow-copied.
    """
    for document in documents:
        yield dict(document)


def _stage(stages: list[dict[str, Any]], operator: str) -> Any:
    """Return the one stage using this operator.

    Args:
        stages: A recorded pipeline.
        operator: The stage operator to find, such as ``$match``.

    Returns:
        That stage's value, failing the test if there is not exactly one.
    """
    found = [stage[operator] for stage in stages if operator in stage]
    assert len(found) == 1, f"expected one {operator} stage, got {len(found)} in {[tuple(s) for s in stages]}"
    return found[0]


def _prepared(
    store: MongoDBMemoryStore,
    *,
    documents: list[dict[str, Any]] | None = None,
    tiers: tuple[Any, ...] = ("text",),
    failure: Exception | None = None,
) -> _RecordingCollection:
    """Put a store in the state ``initialize()`` would leave it in, without a deployment.

    Three assignments, and each one stands for a round trip: ``_initialized`` for the probe and the index
    calls, ``_tiers`` for what came up, ``_collection`` for the collection itself. Reaching into private
    state rather than patching ``_indexes``, because what these tests are about begins after setup
    finishes. ``TestWhatInitializeDecides`` is the class that patches setup instead and asserts what it did.

    Args:
        store: The store to prepare. Modified in place.
        documents: What ``aggregate`` answers with. Defaults to one scoreless document, since half of
            these tests do not care what comes back.
        tiers: The prepared tiers, in preference order. ``()`` is the state the no-prepared-tier query
            test needs and the one ``initialize()`` refuses to leave a store in.
        failure: A driver error for the collection to raise instead of answering.

    Returns:
        The recording collection the store now resolves to.
    """
    default = [{"_id": "abc", "content": "the user prefers dark mode"}]
    collection = _RecordingCollection(default if documents is None else documents, failure=failure)
    store._initialized = True
    store._tiers = tiers
    store._collection = lambda: collection  # type: ignore[assignment, return-value]
    return collection


class TestWhatTheStoreSendsAndWhatItMapsBack:
    """AT-077 — predicate out, entry back, and no document can claim another scope.

    ``TestTheStoreStampsTheScopeItself`` and ``test_filter.py``'s ``TestScopeCannotBeWidenedByACallerFilter``
    close the scope predicate by observing what a second scope's documents do, which is the stronger
    claim. What they cannot see is a term that narrows nothing they seeded: two of the four terms here are
    the caller's own, and a query that silently dropped one, such as the store's configured filter, still
    returns the documents the test wrote.

    The mapping half is the same shape of gap. A document is whatever the collection holds, so the
    reserved keys are decided here, and a document that could influence them could report a scope it was
    not stored in.
    """

    async def test_the_predicate_carries_the_scope_the_store_and_both_caller_filters(self) -> None:
        """Four terms from four places, in the order ``_filter.compose`` documents.

        Also the positive control for the four rejections in ``TestEveryCallerInputIsCheckedBeforeTheNetwork``:
        a declared path in both filter positions, accepted, and this is where each one went.
        """
        store = _store(
            config=_connection_config(filter_fields=["metadata.tier", "metadata.region"]),
            scope="tenant-a",
            filter={"metadata.tier": "gold"},
        )
        collection = _prepared(store)

        await store.search({"text": "dark mode", "filter": {"metadata.region": "emea"}})

        assert _stage(collection.stages, "$match") == {
            "$and": [
                {"scope": {"$eq": "tenant-a"}},
                {"store_name": {"$eq": "facts"}},
                {"metadata.tier": "gold"},
                {"metadata.region": "emea"},
            ]
        }

    async def test_a_stored_scope_key_cannot_make_a_document_report_another_scope(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The read half of scope isolation: ``_scope`` is read off the store, whatever the document holds.

        ``TestReservedMetadataKeysWin`` closes the same rule over ``_merge_metadata`` directly, where the
        reserved dict is the test's own argument. This is the store deciding what goes into that dict,
        which is the decision a document could reach.
        """
        store = _store(scope="tenant-a")
        _prepared(
            store,
            documents=[
                {
                    "_id": "abc",
                    "content": "the user prefers dark mode",
                    "score": 0.9,
                    "metadata": {"_scope": "tenant-b", "tier": "gold"},
                }
            ],
        )

        with caplog.at_level(logging.WARNING):
            entries = await store.search("dark mode")

        assert _metadata(entries[0])["_scope"] == "tenant-a"
        assert _metadata(entries[0])["tier"] == "gold"
        assert [record for record in caplog.records if "'_scope'" in record.getMessage()] != []

    @pytest.mark.parametrize(
        "document",
        [
            {"_id": "abc", "content": "the user prefers dark mode"},
            {"_id": "abc", "content": "the user prefers dark mode", "score": None},
        ],
        ids=["no-score-field", "score-projected-null"],
    )
    async def test_an_unscored_document_maps_to_zero_rather_than_failing(self, document: dict[str, Any]) -> None:
        """Every pipeline projects a score, and the fallback is for a document that arrives without one.

        Both shapes, because they fail differently and neither is produced by any pipeline this package
        emits: an absent ``score`` is a ``KeyError`` without the fallback, a projected ``null`` is a
        ``TypeError``. Handing the store a document a deployment does not produce is the only way to
        exercise a defensive line like this one.
        """
        store = _store()
        _prepared(store, documents=[document])

        entries = await store.search("dark mode")

        assert _metadata(entries[0])["_relevance_score"] == 0.0

    async def test_only_the_documents_own_metadata_reaches_the_entry(self) -> None:
        """The entry's metadata shape: the caller's nested keys, this package's four, and nothing else.

        The document root holds every field ``add`` writes plus what the search stages add. Mapping from
        the root instead of from ``metadata`` would hand the caller ``content_hash`` and ``score`` as
        if they had stored them, and hands them a ``scope`` key that sits beside the ``_scope`` this
        package reports and disagrees with it whenever a document was moved.
        """
        store = _store(scope="tenant-a")
        _prepared(
            store,
            documents=[
                {
                    "_id": "abc",
                    "content": "the user prefers dark mode",
                    "scope": "tenant-a",
                    "store_name": "facts",
                    "content_hash": "f" * 64,
                    "created_at": datetime.datetime.now(datetime.timezone.utc),
                    "score": 1.5,
                    "metadata": {"tier": "gold"},
                }
            ],
        )

        entries = await store.search("dark mode")

        assert entries[0].content == "the user prefers dark mode"
        assert entries[0].store_name == "facts"
        assert _metadata(entries[0]) == {
            "tier": "gold",
            "_id": "abc",
            "_relevance_score": 1.5,
            "_search_type": "text",
            "_scope": "tenant-a",
        }


class TestDeletingOneMemory:
    """AT-082 — one filter out, and the ids that never reach the wire.

    The filter is asserted whole rather than probed term by term, for the reason
    ``TestWhatTheStoreSendsAndWhatItMapsBack`` gives: a dropped term narrows nothing a test seeded and so
    is invisible to a count. On this tier there is nothing seeded at all, since the fake resolves no
    matching, so the emitted dict is the entire claim here and ``TestDeletionStaysInsideTheStoreThatIssuedIt``
    is what watches another store's document survive.
    """

    async def test_the_filter_is_the_read_paths_predicate_with_the_id_added(self) -> None:
        """`_filter.compose` output, plus ``_id`` as a sibling of ``$and``.

        Sibling rather than a fourth conjunct, which is the same predicate: two top-level keys are an
        implicit conjunction. Asserted in the shape the code emits, so this test fails if the code starts
        building the predicate itself rather than borrowing the read path's.
        """
        store = _store(
            config=_connection_config(filter_fields=["metadata.tier"]),
            scope="tenant-a",
            filter={"metadata.tier": "gold"},
            writable=True,
        )
        collection = _prepared(store)
        collection.deleted = 1
        memory_id = ObjectId()

        deleted = await store.delete(str(memory_id))

        assert deleted == 1
        assert collection.deletes == [
            {
                "$and": [
                    {"scope": {"$eq": "tenant-a"}},
                    {"store_name": {"$eq": "facts"}},
                    {"metadata.tier": "gold"},
                ],
                "_id": memory_id,
            }
        ]

    async def test_the_count_comes_from_the_server_rather_than_from_this_method(self) -> None:
        """Seven, which no single-document delete can return, so a hardcoded ``1`` fails here."""
        store = _store(writable=True)
        collection = _prepared(store)
        collection.deleted = 7

        assert await store.delete(str(ObjectId())) == 7

    @pytest.mark.parametrize(
        "memory_id",
        ["", "nope", "zzzzzzzzzzzzzzzzzzzzzzzz", "6a96a03ca471f4a00187022", 12, None],
        ids=["empty", "short", "non-hex", "23-chars", "int", "none"],
    )
    async def test_an_id_that_is_not_an_object_id_is_rejected_before_the_wire(self, memory_id: Any) -> None:
        """``ValueError`` naming the argument, with nothing sent.

        ``None`` is the case worth having: measured on pymongo 4.17.0, ``ObjectId(None)`` returns a freshly
        generated id rather than failing, so an unchecked ``None`` composes into a well-formed filter that
        matches nothing and returns ``0``, reporting "already gone" for a call that named nothing at all.
        ``12`` is the other shape the annotation does not enforce: ``ObjectId(12)`` raises
        ``TypeError``, which is neither the driver error ``_reporting`` wraps nor the ``ValueError`` a
        caller mistake should be.
        """
        store = _store(writable=True)
        collection = _prepared(store)

        with pytest.raises(ValueError, match="memory_id"):
            await store.delete(memory_id)

        assert collection.deletes == []


class TestDeletingEveryMemoryThisStoreCanSee:
    """AT-083 — the read path's predicate, with nothing added.

    Which is also the scope of the method: the predicate carries ``store_name`` and the store's
    configured filter, so this empties one store's view rather than one scope. Two stores in a scope are
    two calls, and the README says so.
    """

    async def test_the_filter_is_exactly_the_read_paths_predicate(self) -> None:
        """No ``_id``, no extra term, and the configured filter still in it.

        The configured filter is the term that could go missing unnoticed: this class's count comes from
        the fake, and on a deployment a store with no configured filter deletes the same documents either
        way.
        """
        store = _store(
            config=_connection_config(filter_fields=["metadata.tier"]),
            scope="tenant-a",
            filter={"metadata.tier": "gold"},
            writable=True,
        )
        collection = _prepared(store)

        await store.delete_all()

        assert collection.deletes == [
            {
                "$and": [
                    {"scope": {"$eq": "tenant-a"}},
                    {"store_name": {"$eq": "facts"}},
                    {"metadata.tier": "gold"},
                ]
            }
        ]

    async def test_the_count_comes_from_the_server(self) -> None:
        """Passed through, which is what makes the return worth reading in an erasure log."""
        store = _store(writable=True)
        collection = _prepared(store)
        collection.deleted = 12

        assert await store.delete_all() == 12


class TestDeletionIsAWrite:
    """AT-084 — ``writable`` gates both deletes, and it gates them before setup runs.

    The error half is in the parametrize of ``TestADriverErrorArrivesNamingTheNamespaceAndNothingElse``
    below, since a wrapped driver error is the same claim for four methods and that class already builds
    a store on ``LEAKY_URI``.
    """

    @pytest.mark.parametrize("call", ["delete", "delete_all"])
    async def test_a_read_only_store_refuses_before_it_initializes(self, call: str) -> None:
        """``ValueError`` naming the key, from a store that has opened nothing.

        The store points at a reserved port with a 50 ms selection timeout, so a refusal that arrived after
        ``initialize()`` would be a ``StorageError`` rather than this. ``_initialized`` is asserted as well,
        because that is the claim rather than a symptom of it: a read-only store must turn a delete down
        without having created an index to do it, exactly as ``add`` does.
        """
        store = _store()

        with pytest.raises(ValueError, match="writable"):
            if call == "delete":
                await store.delete(str(ObjectId()))
            else:
                await store.delete_all()

        assert store._initialized is False


class TestTheScoreBoundOnScoresThisTestChose:
    """AT-079 — the inclusive boundary and the ceiling, which real scores cannot reach.

    ``TestTheScoreBoundDropsResults`` closes the floor on the integration tier against real BM25 scores,
    and it sets its bound to the midpoint between two of them, which is the only bound a test can pick
    when it does not know what the scores will be. Two things follow from that, and this class covers
    both. A result scoring *exactly* the bound is never on either side of a midpoint, and it is the
    ordinary case rather than a corner: a caller who read a bound off an earlier result's
    ``_relevance_score`` lands on it every time. And the midpoint test never applies ``max_score`` to a
    result set at all, so the ceiling branch needs a test of its own.

    Fixed scores cost nothing the live tier was providing. The bound is applied in Python over a list, so a
    deployment contributes the numbers and nothing else.
    """

    @staticmethod
    def _documents() -> list[dict[str, Any]]:
        """Three documents scoring 0.9, 0.5 and 0.1.

        Returns:
            The documents, in the order a search would return them.
        """
        return [
            {"_id": str(index), "content": f"fact {index}", "score": score}
            for index, score in enumerate((0.9, 0.5, 0.1))
        ]

    @pytest.mark.parametrize(
        ("bound", "kept"),
        [
            ({"min_score": 0.5}, ["fact 0", "fact 1"]),
            ({"max_score": 0.5}, ["fact 1", "fact 2"]),
            ({"min_score": 0.1}, ["fact 0", "fact 1", "fact 2"]),
        ],
        ids=["floor", "ceiling", "floor-at-the-lowest-score"],
    )
    async def test_a_bound_equal_to_a_results_score_keeps_that_result(
        self, bound: dict[str, float], kept: list[str]
    ) -> None:
        """Both bounds are inclusive, and each one drops only its own side.

        One parametrization per bound rather than three tests, because this is one rule read three times
        and the interesting result is the same document in the first two rows: ``fact 1`` scores the bound
        exactly and survives either way. The third row is the same boundary at the end of the list, where a
        bound that dropped what it equals empties a result set a caller was told to expect in full.
        """
        store = _store(**bound)
        _prepared(store, documents=self._documents())

        entries = await store.search("dark mode")

        assert [entry.content for entry in entries] == kept


_PRETEND_REASON = "no embedding model is registered (a stand-in for that failure, not a server message)"
"""Reason a refused index build carries, worded so a failure report cannot be read as a real server error."""


class _SetupRecorder:
    """A stand-in for the two ``_indexes`` calls ``initialize()`` makes, which can refuse a named index.

    Patched over the module attributes rather than driven from a collection, because what ``initialize()``
    decides is which specs it passes and in which order, and every one of those is settled before a command
    is built. ``test_indexes.py``'s ``TestOrdinaryIndexesAgainstARealDeployment`` is what tests the real
    ``ensure`` against a deployment.

    Refusing by index name rather than by tier, so the refusal is expressed the way the deployment expresses
    it: a deployment with no registered embedding model has one index that will not build, and which tier
    that removes is what the store decides.

    Attributes:
        probes: The collection name for each capability probe.
        ordinary: One entry per ordinary ``ensure`` call, holding the spec names it carried.
        search: The name of each search index that was created, in creation order.
        timeouts: The ``timeout`` keyword of every call, ordinary and search alike, in call order.
            ``None`` for a call that passed none, which is the failure
            ``TestTheIndexReadyBudgetComesFromTheConfig`` exists to catch.
        failing: Index names to refuse.
        building: Index names to report as still building, as ``ensure`` does when ``timeout`` runs out.
        available: What the capability probe answers.
        rank_fusion: What the ``$rankFusion`` probe answers.
        fusion_probes: The collection name for each ``$rankFusion`` probe. Separate from ``probes``
            because the count that matters is per probe, not per initialize: on a deployment with no
            search, ``probes`` has one entry and this one must have none.
        collations: The collection name for each collation preflight, in call order. Its own list for the
            same reason ``fusion_probes`` is: what is bounded is how many times *this* call happens, and a
            count folded into ``probes`` could not tell the two apart.
        refuse_collation: Whether the preflight should refuse, standing in for a collection created with
            a case-folding collation.
        absent_until_provisioned: Whether the first collation read should report a collection that is not
            there yet, as an empty database does. Later reads report one that is, because between them
            ``initialize()`` ensures the indexes and that creates it.
    """

    def __init__(
        self,
        *,
        available: bool = True,
        failing: frozenset[str] = frozenset(),
        rank_fusion: bool = False,
        refuse_collation: bool = False,
        absent_until_provisioned: bool = False,
    ) -> None:
        self.rank_fusion = rank_fusion
        self.refuse_collation = refuse_collation
        self.building: set[str] = set()
        self.absent_until_provisioned = absent_until_provisioned
        self.collations: list[str] = []
        self.fusion_probes: list[str] = []
        self.probes: list[str] = []
        self.ordinary: list[tuple[str, ...]] = []
        self.search: list[str] = []
        self.timeouts: list[float | None] = []
        self.failing = failing
        self.available = available

    async def require_binary_comparison(self, collection: Any) -> bool:
        """Stand in for ``_indexes.require_binary_comparison``, the collation preflight.

        Suspends for the reason :meth:`probe` does. It is also the first thing ``initialize()`` calls, so a
        fake that returned without yielding would let two concurrent initializes interleave differently
        here than they do against a deployment.

        Args:
            collection: The collection being checked. Its name is what is recorded: the requirement is
                one preflight per collection, not per store.

        Returns:
            Whether a collection was there to verify. ``True`` unless :attr:`absent_until_provisioned`
            says the collection does not exist yet, in which case the first call answers ``False`` and
            every later one answers ``True``, which is what a deployment does, because the ``ensure``
            between them creates it.

        Raises:
            StorageError: If :attr:`refuse_collation`, in the shape the real function raises it. The
                word ``collation`` is in the message because callers of this fake assert on it.
        """
        self.collations.append(collection.name)
        await asyncio.sleep(0)
        if self.refuse_collation:
            raise StorageError(
                f"strands_mongodb: the collection appdb.{collection.name} was created with the collation "
                f"'en', and this package cannot store keys in a collection whose string comparison is "
                f"not binary."
            )
        if self.absent_until_provisioned and len(self.collations) == 1:
            return False
        return True

    async def probe(self, collection: Any) -> _indexes.SearchSupport:
        """Stand in for ``_indexes.search_support``.

        Yields to the event loop once, which is the one behaviour of the real function that matters to a
        caller here: it is a round trip, so it suspends, and a fake that never suspends would make every
        concurrency claim in this class pass by running sequentially.

        Returns the real ``SearchSupport`` rather than a two-field fake of its own, so the invariant the
        production code relies on holds here too: a code is present exactly when search is absent. The
        code is 6047401, one of the three a deployment without Atlas Search can answer, chosen because it
        is not 31082, the most familiar of them, so nothing here can pass by assuming that one.

        Args:
            collection: The collection being probed.

        Returns:
            :attr:`available`, wrapped, with a measured code when it is ``False``.
        """
        self.probes.append(collection.name)
        await asyncio.sleep(0)
        return _indexes.SearchSupport(available=self.available, code=None if self.available else 6047401)

    async def probe_fusion(self, collection: Any) -> bool:
        """Stand in for ``_indexes.rank_fusion_support``.

        Suspends for the same reason :meth:`probe` does: it is a round trip, and a fake that never
        suspends would let a sequential implementation pass a concurrency claim.

        Args:
            collection: The collection being probed.

        Returns:
            :attr:`rank_fusion`.
        """
        self.fusion_probes.append(collection.name)
        await asyncio.sleep(0)
        return self.rank_fusion

    async def ensure(self, collection: Any, *, ordinary: Any = (), search: Any = (), **kwargs: Any) -> None:
        """Stand in for ``_indexes.ensure``, recording what it was asked for.

        Args:
            collection: Ignored; the index specs are the claim.
            ordinary: Ordinary index specs.
            search: Search index specs, one per call from ``_ensure_search_tiers``.
            **kwargs: ``create``, ``timeout`` and ``interval``. ``timeout`` is recorded for the
                index-ready budget tests; the other two are not asserted here.

        Raises:
            StorageError: If a search spec's name is in :attr:`failing`, which is how the real function
                reports a build the server refused.
        """
        self.timeouts.append(kwargs.get("timeout"))
        if ordinary:
            self.ordinary.append(tuple(spec.name for spec in ordinary))
        for spec in search:
            if spec.name in self.failing:
                raise StorageError(f"strands_mongodb: creating {spec.name} failed: {_PRETEND_REASON}")
            if spec.name in self.building:
                raise _indexes.SearchIndexNotReady(f"strands_mongodb: {spec.name} is still building")
            self.search.append(spec.name)


def _patch_setup(
    monkeypatch: pytest.MonkeyPatch,
    *,
    available: bool = True,
    failing: frozenset[str] = frozenset(),
    rank_fusion: bool = False,
    refuse_collation: bool = False,
    absent_until_provisioned: bool = False,
) -> _SetupRecorder:
    """Replace every call ``initialize()`` makes, so it runs to completion with no deployment.

    Patched on the module rather than on the store, which is what makes the count meaningful:
    ``initialize()`` reaches all of them through ``_indexes`` deliberately, so one store doing the work
    twice and ten stores doing it once each are both visible here, as in ``TestTenStoresShareOneSetup``.

    Args:
        monkeypatch: The fixture, so both patches are undone with the test.
        available: What the capability probe answers.
        failing: Search index names to refuse.
        refuse_collation: Whether the collation preflight refuses. Defaults to ``False``, which is what
            a collection created without a collation reports.
        absent_until_provisioned: Whether the first collation read reports a collection that is not there
            yet. Defaults to ``False``, which is an established deployment.
        rank_fusion: What the ``$rankFusion`` probe answers. Defaults to ``False``, which is the one
            place in this file a fake's default deliberately does not match the common deployment:
            Atlas runs MongoDB 8.0 and would answer ``True``. It is ``False`` here because the tests that
            leave it at the default assert the vector-first resolution *of a deployment without fusion*,
            and that resolution has to stay covered on its own. Every test about hybrid passes ``True``
            and says so in its name.

    Returns:
        The recorder, holding what was asked for once the test has run.
    """
    recorder = _SetupRecorder(
        available=available,
        failing=failing,
        rank_fusion=rank_fusion,
        refuse_collation=refuse_collation,
        absent_until_provisioned=absent_until_provisioned,
    )
    monkeypatch.setattr(_indexes, "require_binary_comparison", recorder.require_binary_comparison)
    monkeypatch.setattr(_indexes, "search_support", recorder.probe)
    monkeypatch.setattr(_indexes, "rank_fusion_support", recorder.probe_fusion)
    monkeypatch.setattr(_indexes, "ensure", recorder.ensure)
    return recorder


class TestTheIndexReadyBudgetComesFromTheConfig:
    """AT-126 — the memory store's half of one config key, at both call sites.

    ``initialize()`` calls ``_indexes.ensure`` once for the ordinary specs and once per search tier. The
    ordinary call always carries the configured budget. The search calls carry it only for a named
    ``search_type``; under ``auto`` they carry ``0``, so constructing an ``Agent`` never waits on a build.

    The default case matters as much as the override. The module constant is the one default, and a
    store that read the key with a hard-coded fallback of its own would keep a second number alive in a
    second place.
    """

    @pytest.mark.parametrize("search_type", ["text", "vector"])
    async def test_a_named_tier_carries_the_configured_budget_on_every_call(
        self, monkeypatch: pytest.MonkeyPatch, search_type: str
    ) -> None:
        recorder = _patch_setup(monkeypatch)
        store = _store(config=_connection_config(index_ready_timeout=7, search_type=search_type))

        await store.initialize()

        assert recorder.timeouts == [7, 7]

    async def test_auto_waits_only_on_the_ordinary_indexes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """AT-242. The search calls read build status and return, under the shared connection lock."""
        recorder = _patch_setup(monkeypatch)
        store = _store(config=_connection_config(index_ready_timeout=7))

        await store.initialize()

        assert recorder.timeouts[0] == 7
        assert recorder.timeouts[1:] == [0] * len(recorder.search)

    async def test_absence_resolves_to_the_module_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Read through ``_indexes.READY_TIMEOUT_SECONDS`` rather than compared to a literal, so this
        keeps testing the wiring rather than restating ``AT-125``."""
        recorder = _patch_setup(monkeypatch)
        store = _store(config=_connection_config(search_type="text"))

        await store.initialize()

        assert set(recorder.timeouts) == {_indexes.READY_TIMEOUT_SECONDS}


class TestAutoDoesNotWaitForABuild:
    """AT-242 — under ``auto``, ``initialize()`` returns while indexes build, and the first ``search`` waits
    for the first of them."""

    @staticmethod
    def _finish_on_wait(monkeypatch: pytest.MonkeyPatch, recorder: _SetupRecorder) -> None:
        """Make a call that passes a non-zero ``timeout`` see every build finish, as a real wait would."""

        async def ensure(collection: Any, **kwargs: Any) -> None:
            if kwargs.get("timeout"):
                recorder.building = set()
            await recorder.ensure(collection, **kwargs)

        monkeypatch.setattr(_indexes, "ensure", ensure)

    async def test_every_tier_still_building_initializes_with_no_tiers(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store()

        await store.initialize()

        assert store._tiers == ()

    async def test_search_waits_for_the_build_with_the_configured_budget(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store(config=_connection_config(index_ready_timeout=7))
        await store.initialize()
        self._finish_on_wait(monkeypatch, recorder)
        collection = _RecordingCollection([{"_id": "abc", "content": "dark mode"}])
        store._collection = lambda: collection  # type: ignore[assignment, return-value]

        found = await store.search({"text": "dark"})

        assert recorder.timeouts[-4:-2] == [7, 7]
        assert store._tiers == ("vector", "text")
        assert [(entry.metadata or {}).get("_search_type") for entry in found] == ["vector"]

    async def test_a_retry_picks_up_the_finished_build(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store()
        await store.initialize()

        recorder.building = set()
        store._tier_retry_at = 0
        await store.initialize()

        assert store._tiers == ("vector", "text")
        assert store._tier_retry_at is None

    async def test_a_refusal_alongside_a_build_waits_for_the_build(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """An Atlas CLI local deployment refuses the AutoEmbeddings vector index while text builds."""
        recorder = _patch_setup(monkeypatch, failing=frozenset({"vector_index"}))
        recorder.building = {"text_index"}
        store = _store()

        await store.initialize()
        assert store._tiers == ()
        self._finish_on_wait(monkeypatch, recorder)
        await store._wait_for_a_tier()

        assert store._tiers == ("text",)

    async def test_only_refusals_still_raise(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A tier the server refused is a configuration to fix, so there is nothing to wait for."""
        _patch_setup(monkeypatch, failing=frozenset({"vector_index", "text_index"}))

        with pytest.raises(StorageError, match="no search tier could be prepared"):
            await _store().initialize()

    async def test_a_build_that_never_finishes_fails_the_search(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store()
        await store.initialize()

        with pytest.raises(StorageError, match="no search tier on .* was ready"):
            await store.search({"text": "dark"})

    async def test_a_ready_tier_is_not_held_behind_one_still_building(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store()
        await store.initialize()
        never = asyncio.Event()

        async def ensure(collection: Any, *, search: Any = (), **kwargs: Any) -> None:
            if kwargs.get("timeout") and search[0].name == "vector_index":
                await never.wait()
            if kwargs.get("timeout"):
                recorder.building.discard(search[0].name)
            await recorder.ensure(collection, search=search, **kwargs)

        monkeypatch.setattr(_indexes, "ensure", ensure)
        collection = _RecordingCollection([{"_id": "abc", "content": "dark mode"}])
        store._collection = lambda: collection  # type: ignore[assignment, return-value]

        found = await asyncio.wait_for(store.search({"text": "dark"}), timeout=5)

        assert store._tiers == ("text",)
        assert [(entry.metadata or {}).get("_search_type") for entry in found] == ["text"]

    @staticmethod
    def _skipped(caplog: pytest.LogCaptureFixture) -> list[tuple[str, str, str]]:
        """The ``(level, event, tier)`` of every skipped-tier record, in order."""
        return [
            (
                record.levelname,
                getattr(record, "strands_mongodb_event", ""),
                getattr(record, "strands_mongodb_tier", ""),
            )
            for record in caplog.records
            if getattr(record, "strands_mongodb_event", None) in ("tier_building", "tier_unavailable")
        ]

    async def test_a_fresh_store_logs_its_building_tiers_at_info(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        caplog.set_level(logging.DEBUG, logger="strands_mongodb")

        await _store().initialize()

        assert self._skipped(caplog) == [("INFO", "tier_building", "vector"), ("INFO", "tier_building", "text")]

    async def test_a_refused_tier_still_warns(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        recorder = _patch_setup(monkeypatch, failing=frozenset({"vector_index"}))
        recorder.building = {"text_index"}
        caplog.set_level(logging.DEBUG, logger="strands_mongodb")

        await _store().initialize()

        assert self._skipped(caplog) == [("WARNING", "tier_unavailable", "vector"), ("INFO", "tier_building", "text")]

    async def test_a_wait_that_runs_out_warns(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store()
        await store.initialize()
        caplog.clear()
        caplog.set_level(logging.DEBUG, logger="strands_mongodb")

        with pytest.raises(StorageError, match="was ready"):
            await store.search({"text": "dark"})

        assert self._skipped(caplog) == [
            ("WARNING", "tier_unavailable", "vector"),
            ("WARNING", "tier_unavailable", "text"),
        ]

    async def test_a_tier_still_building_after_another_came_up_stays_at_info(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store()
        await store.initialize()

        async def ensure(collection: Any, *, search: Any = (), **kwargs: Any) -> None:
            if kwargs.get("timeout"):
                recorder.building.discard("text_index")
            await recorder.ensure(collection, search=search, **kwargs)

        monkeypatch.setattr(_indexes, "ensure", ensure)
        collection = _RecordingCollection([{"_id": "abc", "content": "dark mode"}])
        store._collection = lambda: collection  # type: ignore[assignment, return-value]
        caplog.clear()
        caplog.set_level(logging.DEBUG, logger="strands_mongodb")

        await store.search({"text": "dark"})

        assert store._tiers == ("text",)
        assert self._skipped(caplog) == [("INFO", "tier_building", "vector")]

    @staticmethod
    def _finish_when(monkeypatch: pytest.MonkeyPatch, recorder: _SetupRecorder, gate: asyncio.Event) -> None:
        """Make a call that passes a non-zero ``timeout`` wait for ``gate``, then see every build finish."""

        async def ensure(collection: Any, **kwargs: Any) -> None:
            if kwargs.get("timeout"):
                await gate.wait()
                recorder.building = set()
            await recorder.ensure(collection, **kwargs)

        monkeypatch.setattr(_indexes, "ensure", ensure)

    def test_a_search_on_another_event_loop_still_waits(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The SDK runs ``initialize()`` on one event loop and each sync agent call on a new one."""
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store()
        asyncio.run(store.initialize())
        self._finish_on_wait(monkeypatch, recorder)
        collection = _RecordingCollection([{"_id": "abc", "content": "dark mode"}])
        store._collection = lambda: collection  # type: ignore[assignment, return-value]

        found = asyncio.run(store.search({"text": "dark"}))

        assert [(entry.metadata or {}).get("_search_type") for entry in found] == ["vector"]

    async def test_searches_during_the_wait_share_it(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store(config=_connection_config(index_ready_timeout=7))
        await store.initialize()
        gate = asyncio.Event()
        self._finish_when(monkeypatch, recorder, gate)
        collection = _RecordingCollection([{"_id": "abc", "content": "dark mode"}])
        store._collection = lambda: collection  # type: ignore[assignment, return-value]
        calls = len(recorder.timeouts)

        first = asyncio.ensure_future(store.search({"text": "dark"}))
        second = asyncio.ensure_future(store.search({"text": "dark"}))
        await asyncio.sleep(0)
        gate.set()
        found = await asyncio.gather(first, second)

        assert [len(results) for results in found] == [1, 1]
        assert recorder.timeouts[calls:].count(7) == 2

    async def test_a_cancelled_search_leaves_the_wait_for_the_next(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store()
        await store.initialize()
        gate = asyncio.Event()
        self._finish_when(monkeypatch, recorder, gate)
        collection = _RecordingCollection([{"_id": "abc", "content": "dark mode"}])
        store._collection = lambda: collection  # type: ignore[assignment, return-value]

        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(store.search({"text": "dark"}), 0.01)
        assert store._waited_for_a_tier is False
        following = asyncio.ensure_future(store.search({"text": "dark"}))
        await asyncio.sleep(0)
        gate.set()

        assert len(await following) == 1

    async def test_only_the_first_search_waits(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store(config=_connection_config(index_ready_timeout=7))
        await store.initialize()
        with pytest.raises(StorageError):
            await store.search({"text": "dark"})
        calls = len(recorder.timeouts)

        with pytest.raises(StorageError, match="was ready"):
            await store.search({"text": "dark"})

        assert 7 not in recorder.timeouts[calls:]


class TestWhatInitializeDecides:
    """AT-078 — which indexes, ordered, fatal when.

    What a deployment shows is the outcome: which indexes exist afterwards, and that a warning happened.
    The claims here are the decisions upstream of it. Which spec was asked for, in what order, which
    refusal was re-raised instead of logged, and whether the lock was taken at all are all invisible in
    that outcome, because ``_indexes.ensure`` is idempotent and a store that redoes its setup leaves the
    same indexes behind as one that does not.

    One claim has no deployment at all. "Vector is preferred when both tiers are available" only decides an
    answer on the AutoEmbeddings path, where a plain string fits both tiers, and that is the index an Atlas
    CLI local deployment cannot build, because it registers no embedding model. The manual path does build
    both indexes there, but on it the query key picks the tier and the order never gets a vote.

    Patching ``_indexes`` is what makes the AutoEmbeddings both-available case exist, and the same patch is
    what lets one named index be refused on demand. Everything asserted here is a decision this package
    makes about what to send. What the server does with it is ``test_indexes.py``'s tier.
    """

    async def test_auto_creates_both_tiers_vector_first_and_prefers_the_vector_one(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The preference order, and why it is an order rather than a fallback.

        The tier that answers is the observable half. On the AutoEmbeddings path a plain string fits both
        tiers, so reversing the pair would leave every query answered lexically by a store whose
        vector index exists, was built, and is never queried. Nothing about the result set says so: the
        entries come back scored and ranked, on a different scale, from a different index.
        """
        recorder = _patch_setup(monkeypatch)
        store = _store()

        await store.initialize()

        assert recorder.search == ["vector_index", "text_index"]
        assert store._tiers == ("vector", "text")
        assert store._pick_tier(query_text="dark mode", query_vector=None) == "vector"

    async def test_a_named_search_type_creates_only_its_own_index(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A named ``search_type`` narrows setup: a text store never creates a vector index it will not query.

        A cost claim as much as a correctness one, and on the AutoEmbeddings path the cost is per write:
        an unqueried vector index still embeds every document that lands in the collection.
        """
        recorder = _patch_setup(monkeypatch)
        store = _store(config=_connection_config(search_type="text"))

        await store.initialize()

        assert recorder.search == ["text_index"]
        assert store._tiers == ("text",)

    async def test_a_named_search_types_own_tier_failing_is_fatal_and_says_what_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The other half of a named ``search_type``: one tier by request means nothing to fall through to.

        The assertion is on the message and not only on the type, because skipping the failure would
        fall through to the empty-tier floor two lines below, which raises ``StorageError`` as well. Same
        class, different information: one names the index the server refused and carries its reason, the
        other names ``auto``, which this store is not.
        """
        _patch_setup(monkeypatch, failing=frozenset({"vector_index"}))
        store = _store(config=_connection_config(search_type="vector"))

        with pytest.raises(StorageError) as caught:
            await store.initialize()

        assert "vector_index" in str(caught.value)
        assert _PRETEND_REASON in str(caught.value)
        assert "'search_type' is 'auto'" not in str(caught.value)

    async def test_auto_with_every_tier_refused_warns_per_tier_then_raises(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The floor under ``auto``, and *where* it is raised is the claim.

        Returning an empty tier tuple instead would leave ``initialize()`` succeeding on a store that
        can never answer anything, and moves the first symptom to whichever query runs next, where the
        reason each tier failed is already several log lines behind.
        """
        _patch_setup(monkeypatch, failing=frozenset({"vector_index", "text_index"}))
        store = _store()

        with caplog.at_level(logging.WARNING), pytest.raises(StorageError) as caught:
            await store.initialize()

        assert "no search tier could be prepared" in str(caught.value)
        assert len([record for record in caplog.records if "search tier is not available" in record.getMessage()]) == 2
        assert store._initialized is False

    async def test_the_raise_carries_the_last_tiers_reason_rather_than_pointing_at_the_log(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``AT-166`` -- the reason travels on the exception, not only in a log line.

        Each tier's refusal carries the server's reason and error code, such as code 125 from the index
        management channel when mongot is unreachable. Logging it at ``WARNING`` is not enough: a caller
        without logging configured would see only that no tier could be prepared. So the last tier's
        error is chained as the cause, and the traceback carries the reason itself.
        """
        _patch_setup(monkeypatch, failing=frozenset({"vector_index", "text_index"}))
        store = _store()

        with pytest.raises(StorageError) as caught:
            await store.initialize()

        cause = caught.value.__cause__
        assert cause is not None, (
            "the raise names no cause, so a traceback of it says no tier could be prepared and nothing "
            "about why, which is the whole of what a reader needs"
        )
        assert _PRETEND_REASON in str(cause)

    async def test_auto_landing_on_text_warns_that_answers_became_lexical(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """``auto`` warns when it lands below vector, and that is a second warning, not the first.

        ``TestTheShippedDefaultAgainstADeploymentWithNoModel`` asserts the per-tier line on a real
        deployment where the vector index cannot build, and that line reports what failed. This one
        reports the consequence in the caller's terms: a store still answering, semantically degraded,
        which is the half a reader acts on. It is asserted on its own because the per-tier warning would
        still be found without it.
        """
        _patch_setup(monkeypatch, failing=frozenset({"vector_index"}))
        store = _store()

        with caplog.at_level(logging.WARNING):
            await store.initialize()

        messages = [record.getMessage() for record in caplog.records]
        assert store._tiers == ("text",)
        assert [message for message in messages if "vector search tier is not available" in message] != []
        assert [message for message in messages if "resolve to the text tier" in message] != []

    async def test_a_deployment_that_cannot_search_warns_once_for_ten_stores(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The no-search warning is per connection, which is the half ``AT-053a`` does not count.

        Ten stores built from one config share one ``_Connection``, so the probe runs once and the line
        reporting its result belongs inside that branch. Ten copies of a six-sentence warning on every
        process start is the difference between a log a reader scans and one they filter out, and the
        filter they write is the one that hides it on the eleventh store too.
        """
        recorder = _patch_setup(monkeypatch, available=False)
        stores = [_store(name=f"facts{index}") for index in range(10)]

        with caplog.at_level(logging.WARNING):
            await asyncio.gather(*(store.initialize() for store in stores))

        assert recorder.probes == ["memory"]
        assert len([record for record in caplog.records if "does not run Atlas Search" in record.getMessage()]) == 1
        assert recorder.search == []
        assert all(store._tiers == () for store in stores)

    async def test_the_second_initialize_neither_takes_the_lock_nor_redoes_the_setup(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Idempotent setup, counted rather than inferred from a collection's indexes.

        An index count cannot see this. ``_indexes.ensure`` is idempotent by design, so a store that redid
        the whole setup on every call leaves a collection indistinguishable from one that did it once,
        and a store that only stopped taking the fast path leaves no trace at all. What is
        observable is the work: two calls, one probe, one ordinary ``ensure``, two search ``ensure``s, and
        the lock taken once. The lock is the reason the fast path is unlocked, and ``add`` and ``search``
        both call ``initialize()`` on every agent turn, so it is a lock every operation would queue on.
        """
        recorder = _patch_setup(monkeypatch)
        store = _store()
        real_get_lock = store._connection.get_lock
        locks = 0

        def counting() -> Any:
            nonlocal locks
            locks += 1
            return real_get_lock()

        store._connection.get_lock = counting  # type: ignore[method-assign]

        await store.initialize()
        await store.initialize()

        assert locks == 1
        assert recorder.probes == ["memory"]
        assert len(recorder.ordinary) == 1
        assert recorder.search == ["vector_index", "text_index"]

    async def test_one_store_initializing_twice_at_once_does_the_work_once(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The flag re-read under the lock, which is the half of idempotent setup ten stores cannot reach.

        ``TestTenStoresShareOneSetup``'s ten stores contend on the connection lock and then each does its
        own index work, because ``_initialized`` is per store. One store is the case that arrives on every agent turn:
        ``add`` and ``search`` both call ``initialize()``, so two operations issued together are two
        coroutines inside one flag. The second re-reads it after waiting, and without that read it repeats
        setup the first has already finished, on a store that is already usable.
        """
        recorder = _patch_setup(monkeypatch)
        store = _store()

        await asyncio.gather(store.initialize(), store.initialize())

        assert recorder.probes == ["memory"]
        assert len(recorder.ordinary) == 1
        assert recorder.search == ["vector_index", "text_index"]

    async def test_a_query_with_no_ready_tier_names_the_build_not_a_missing_module(self) -> None:
        """``_pick_tier``'s two messages for two remedies: no Atlas Search, or no tier ready yet.

        This deployment can search, so the other message's advice about pointing ``connection_string`` at
        Atlas would send a reader to replace something that is not broken. Called directly, because
        ``search`` first waits for a tier that is still building, and this is the state that wait ends in
        when the build never finishes.
        """
        store = _store()
        _prepared(store, tiers=())
        store._capabilities = _client.Capabilities(search=True)

        with pytest.raises(StorageError) as caught:
            store._pick_tier(query_text="dark mode", query_vector=None)

        assert "was ready within 'index_ready_timeout'" in str(caught.value)
        # The other message's own words rather than a server code. That code is interpolated from the
        # probe, so `"31082" not in ...` would pass on a message built entirely from the wrong template
        # and prove nothing.
        assert "does not run Atlas Search" not in str(caught.value)

    async def test_a_query_that_no_prepared_tier_fits_names_the_key_to_add(self) -> None:
        """The one-vector-key rule where a manual-vector store meets ``MemoryManager`` (``AT-078``'s third message).

        The shipped call site always sends a plain string, and a manual-vector store asking for
        ``search_type='vector'`` has nothing that can answer one: the deployment does not embed on that path
        and this package does not either. ``ValueError`` rather than ``StorageError``, because the remedy is
        a key on the query rather than anything about the deployment, and the message carries both that key
        and the two config keys that chose the path the caller is fighting.
        """
        store = _store(config=_connection_config(search_type="vector", embedding_dimensions=4, similarity="cosine"))
        _prepared(store, tiers=("vector",))

        with pytest.raises(ValueError) as caught:
            await store.search("dark mode")

        assert "'vector'" in str(caught.value)
        assert "embedding_dimensions" in str(caught.value)


class TestTheMemoryStoreRefusesACollationThatFoldsCase:
    """AT-176 — the second surface's half of one preflight, on the field it isolates by.

    ``test_storage.py`` carries the full reasoning for the storage surface. What is different here is the
    field at stake. The storage surface keeps its namespaces apart in ``_id``; this one keeps its scopes apart in
    ``scope``, because ``_filter.compose`` pins ``{"scope": self.scope, "store_name": self.name}`` on
    every read, update and delete. A collation that folds case therefore turns ``scope="tenant-b"`` into a
    filter that matches documents written under ``Tenant-B``, which is a cross-scope read
    arriving through the collection's comparison rules rather than through a caller's filter, and
    so past every check ``TestEveryCallerInputIsCheckedBeforeTheNetwork`` makes.

    ``initialize()`` is the only place the check needs to be, and that is a claim rather than a
    convenience: ``search``, ``add`` and both deletes call it first, so there is no public
    coroutine on this surface that reaches the collection without passing through here. The storage
    surface has no such funnel and needed seven call sites.

    Where in ``initialize()`` is also a claim. It runs before the capability probe and before any
    ``ensure``, so a refusal leaves no index behind: provisioning a collection that cannot hold the
    scopes apart is work whose only product is a store that must not be used.
    """

    async def test_initialize_refuses_and_says_collation(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The refusal on this surface, and the type is ``StorageError`` because the remedy is the
        deployment's: no argument to this package can make a folded collection safe."""
        _patch_setup(monkeypatch, refuse_collation=True)
        store = _store()

        with pytest.raises(StorageError) as caught:
            await store.initialize()

        assert "collation" in str(caught.value)

    async def test_the_refusal_precedes_the_probe_and_every_index(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Ordering, which is the part no message can show. A preflight that ran after ``ensure`` would
        raise the same error having already created three indexes on a collection nothing may use."""
        recorder = _patch_setup(monkeypatch, refuse_collation=True)
        store = _store()

        with pytest.raises(StorageError):
            await store.initialize()

        assert recorder.collations == ["memory"]
        assert recorder.probes == [], "the capability probe ran on a collection that had been refused"
        assert recorder.ordinary == []
        assert recorder.search == []

    async def test_a_collection_that_compares_bytes_is_checked_once_and_then_set_up(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The vacuity guard for the two tests above: they would both pass against an ``initialize()``
        that refused every collection, and so would every other test in this file that expects a raise."""
        recorder = _patch_setup(monkeypatch)
        store = _store()

        await store.initialize()

        assert recorder.collations == ["memory"]
        assert recorder.ordinary != []

    async def test_a_refusal_is_not_cached_so_the_collection_can_be_fixed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``_initialized`` stays ``False`` through a refusal, so the second call asks again.

        The alternative, a store that remembers it failed, would make a fixed deployment need a
        restarted process, and the flag is set at the end of ``initialize()`` for exactly this reason. The
        second half of the test is what makes it a claim about caching rather than about one call: the
        preflight stops refusing, and the same store initializes.
        """
        recorder = _patch_setup(monkeypatch, refuse_collation=True)
        store = _store()

        with pytest.raises(StorageError):
            await store.initialize()
        assert store._initialized is False

        recorder.refuse_collation = False
        await store.initialize()

        assert store._initialized is True
        assert recorder.collations == ["memory", "memory"]

    async def test_ten_stores_on_one_connection_check_once_between_them(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """One round trip per collection, not per store (``AT-065b``'s precedent, and the reason the cache
        lives on the connection rather than on the store)."""
        recorder = _patch_setup(monkeypatch)
        stores = [_store(name=f"facts{index}") for index in range(10)]

        for store in stores:
            await store.initialize()

        assert recorder.collations == ["memory"]
        assert len(recorder.probes) == 1


class TestAnAbsentCollectionIsNotAVerifiedOne:
    """AT-192 — this surface's half of the absent-collection rule ``test_storage.py`` also covers.

    ``listCollections`` reports a collection with no collation and a collection that is not there at all
    identically: nothing. A preflight that read that nothing as a verification, and a connection that
    cached it, would let a namespace enter ``binary_keys`` having never been checked, and whoever created
    the collection a moment later could give it any collation, with the cache guaranteeing nobody ever
    looked again.

    What makes this surface different from ``MongoDBStorage`` is that it has no later operation to
    re-check from. ``initialize()`` returns early ever after, so declining to cache an absent collection
    would leave the window open for the life of the store rather than closing it on the next write. The
    close is the second read: ``ensure`` has created the collection by then, so there is something to
    verify, and verifying it is both the answer and the thing worth caching. A collation that appeared in
    between is somebody else's, and it fails this call, before ``add`` has written one memory under it.
    """

    async def test_an_absent_collection_is_read_again_once_the_indexes_have_created_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Two reads for the empty database, where the ``AT-176`` preflight alone would cache what it could not read."""
        recorder = _patch_setup(monkeypatch, absent_until_provisioned=True)
        store = _store()

        await store.initialize()

        assert recorder.collations == ["memory", "memory"]
        assert store._initialized is True

    async def test_the_read_that_found_something_is_the_one_that_caches(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The bound on the re-reading: it stops, rather than repeating per store for the connection's life.

        The second store shares the connection and therefore the ``binary_keys`` set, and it adds no third
        read, which is only true because the first store's *second* read is what went into the cache.
        """
        recorder = _patch_setup(monkeypatch, absent_until_provisioned=True)

        await _store().initialize()
        await _store(name="others").initialize()

        assert recorder.collations == ["memory", "memory"]

    async def test_a_collation_that_appears_during_provisioning_fails_initialize(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The window the second read closes, exercised by creating the collection inside it.

        Somebody else creates ``appdb.memory`` with a case-folding collation while this store is
        provisioning: the first read found nothing to object to and the second one finds it. The refusal
        is the point, and so is *when* it arrives: ``_initialized`` is still ``False``, so no caller ever
        held a store over a collection that cannot keep the scopes apart.
        """
        recorder = _patch_setup(monkeypatch, absent_until_provisioned=True)
        provision = recorder.ensure

        async def a_collation_appears(*args: Any, **kwargs: Any) -> None:
            recorder.refuse_collation = True
            await provision(*args, **kwargs)

        monkeypatch.setattr(_indexes, "ensure", a_collation_appears)
        store = _store()

        with pytest.raises(StorageError) as caught:
            await store.initialize()

        assert "collation" in str(caught.value)
        assert store._initialized is False
        assert recorder.collations == ["memory", "memory"]


class TestTheHybridTierIsAStatementAboutTwoOthers:
    """AT-146, AT-147 — when fusion is offered and when it is withheld.

    Hybrid is not a third peer in the preference list. It is a claim that the other two both came up,
    which is why every test here is about the *conditions* rather than about a pipeline: the pipeline is
    ``test_pipeline.py``'s tier and is asserted there on the emitted stages.

    A ``$rankFusion`` with one input pipeline is a more expensive spelling of that one pipeline and would
    be the likeliest shape of the bug. On a deployment with no registered embedding model, where the
    vector index fails with code 8, the missing input would be the vector one, so the "hybrid" result
    would be lexical ranking under a name that promises semantic ranking: the metadata would say
    ``hybrid`` and the caller would have no way to tell.
    """

    async def test_auto_prefers_fusion_where_the_deployment_and_both_tiers_allow_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``auto`` prefers fusion when it is available, and this is the ordering that produces.

        Hybrid leads and the two single tiers stay behind it in their usual order, rather than being
        replaced: the fallback list is what answers a query whose shape only one tier fits, and
        collapsing it to ``("hybrid",)`` would leave a manual-vector store unable to answer a text-only
        query.
        """
        recorder = _patch_setup(monkeypatch, rank_fusion=True)
        store = _store()

        await store.initialize()

        assert recorder.search == ["vector_index", "text_index"]
        assert store._tiers == ("hybrid", "vector", "text")
        assert store._pick_tier(query_text="dark mode", query_vector=None) == "hybrid"

    async def test_a_deployment_without_the_stage_resolves_as_it_did_before_task_31(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Vector-first resolution without fusion, asserted directly rather than only inherited."""
        recorder = _patch_setup(monkeypatch, rank_fusion=False)
        store = _store()

        await store.initialize()

        assert recorder.fusion_probes == ["memory"]
        assert store._tiers == ("vector", "text")

    async def test_the_version_is_not_asked_for_where_the_deployment_cannot_search(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``AT-146``'s zero case, and the reason the short-circuit exists.

        Hybrid needs both search tiers, so on a deployment with no Atlas Search the answer cannot be
        used whatever the version is. Asking anyway costs a round trip per connection for a value nothing
        reads, and this is the deployment the CI contract tier runs against: ``mongo:8`` has no mongot.
        """
        recorder = _patch_setup(monkeypatch, available=False, rank_fusion=True)
        store = _store()

        await store.initialize()

        assert recorder.probes == ["memory"]
        assert recorder.fusion_probes == []
        assert store._tiers == ()

    async def test_ten_stores_on_one_connection_ask_the_version_once(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """``AT-146``'s counting half, as ``AT-065b`` does it for the search probe.

        The result is a boolean every store would compute identically, so a per-store probe is invisible
        in behaviour and visible only as ten round trips on every process start.
        """
        recorder = _patch_setup(monkeypatch, rank_fusion=True)
        stores = [_store(name=f"facts{index}") for index in range(10)]

        await asyncio.gather(*(store.initialize() for store in stores))

        assert recorder.fusion_probes == ["memory"]
        assert all(store._tiers == ("hybrid", "vector", "text") for store in stores)

    async def test_an_explicit_hybrid_store_creates_both_indexes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The narrowing that a named ``search_type`` does everywhere else would be wrong here.

        ``search_type="text"`` creates one index because it queries one. ``"hybrid"`` names a tier built
        out of two, and the filter that keeps a text store from building a vector index it will not query
        would leave this store with no indexes at all.
        """
        recorder = _patch_setup(monkeypatch, rank_fusion=True)
        store = _store(config=_connection_config(search_type="hybrid"))

        await store.initialize()

        assert recorder.search == ["vector_index", "text_index"]
        assert store._tiers == ("hybrid",)

    async def test_an_explicit_hybrid_store_with_one_tier_refused_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """``AT-147``'s first direction. One half of a fusion is not a fusion."""
        _patch_setup(monkeypatch, failing=frozenset({"vector_index"}), rank_fusion=True)
        store = _store(config=_connection_config(search_type="hybrid"))

        with pytest.raises(StorageError) as caught:
            await store.initialize()

        assert "vector_index" in str(caught.value)
        assert _PRETEND_REASON in str(caught.value)

    async def test_an_explicit_hybrid_store_on_a_deployment_without_the_stage_raises(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The same rule read against the other way hybrid can be unavailable.

        A named tier that cannot be prepared is fatal, and the server version is one of the two reasons
        this one cannot be. Degrading to vector here would answer a different question than the one
        asked, silently, on the tier the caller explicitly declined to leave to ``auto``.
        """
        _patch_setup(monkeypatch, rank_fusion=False)
        store = _store(config=_connection_config(search_type="hybrid"))

        with pytest.raises(StorageError) as caught:
            await store.initialize()

        assert "rankFusion" in str(caught.value)

    async def test_auto_skips_fusion_where_only_one_tier_came_up(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """``AT-147``'s second direction: the same condition, not fatal, and vector answers."""
        _patch_setup(monkeypatch, failing=frozenset({"text_index"}), rank_fusion=True)
        store = _store()

        with caplog.at_level(logging.WARNING):
            await store.initialize()

        assert store._tiers == ("vector",)
        assert store._pick_tier(query_text="dark mode", query_vector=None) == "vector"

    async def test_a_query_only_one_tier_fits_falls_past_hybrid(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Both tiers are up and fusion is offered, and the query still cannot use it.

        A manual-vector store's hybrid tier needs both keys, because the ``$search`` branch has nothing
        to search with without ``text`` and the ``$vectorSearch`` branch has nothing to compare without
        ``vector``. Falling through to the tier the query does fit is what the ordered list is for.
        """
        _patch_setup(monkeypatch, rank_fusion=True)
        store = _store(config=_connection_config(search_type="auto", **MANUAL_VECTOR))

        await store.initialize()

        assert store._tiers == ("hybrid", "vector", "text")
        assert store._pick_tier(query_text="dark mode", query_vector=None) == "text"
        assert store._pick_tier(query_text=None, query_vector=QUERY_VECTOR) == "vector"
        assert store._pick_tier(query_text="dark mode", query_vector=QUERY_VECTOR) == "hybrid"


class TestTheQueryShapeOnlyFusionCanRead:
    """AT-157 — the one configuration where a query may carry both vector keys, and no wider.

    A query setting both ``text`` and ``vector`` is rejected because no single tier reads both. The
    hybrid tier on a manual-vector store reads both: ``text`` feeds its ``$search`` input pipeline and
    ``vector`` feeds its ``$vectorSearch`` one. So the rejection does not apply to exactly one
    configuration, and the exception has to be exactly that wide, or a query whose second key would be
    silently ignored gets through.

    Two checks rather than one, in two places, because they can answer at two different times. Whether
    the *config* could use both keys is known at construction and is checked before the first round trip,
    which is what ``TestEveryCallerInputIsCheckedBeforeTheNetwork`` asserts by running against a closed
    port. Whether the *deployment* delivered
    the fused tier is known only after the probe, and the answer there cannot be a fallback: every
    remaining tier reads one of the two keys and would drop the other silently.
    """

    async def test_the_autoembeddings_path_still_rejects_both_before_the_network(self) -> None:
        """Still rejected, and this is the case ``AT-076`` covers: on this path the fused tier reads ``text``
        in *both* of its input pipelines, so a ``vector`` beside it means nothing."""
        with pytest.raises(ValueError, match="no interpretation"):
            await _store().search({"text": "dark mode", "vector": QUERY_VECTOR})

    @pytest.mark.parametrize("search_type", ["vector", "text"], ids=["vector", "text"])
    async def test_a_named_single_tier_still_rejects_both_before_the_network(self, search_type: str) -> None:
        """A store that asked for one tier by name will never fuse, whatever the deployment can do."""
        store = _store(config=_connection_config(search_type=search_type, **MANUAL_VECTOR))

        with pytest.raises(ValueError, match="no interpretation"):
            await store.search({"text": "dark mode", "vector": QUERY_VECTOR})

    async def test_a_manual_store_that_could_fuse_gets_past_the_construction_time_check(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The narrowing itself, asserted as the tier that answers rather than as the absence of a raise.

        The store is on ``auto``: nothing about it names hybrid, and the shape becomes legal because the
        deployment offers fusion and the configuration lets it be chosen.
        """
        _patch_setup(monkeypatch, rank_fusion=True)
        store = _store(config=_connection_config(**MANUAL_VECTOR))
        await store.initialize()
        collection = _prepared(store, tiers=store._tiers)

        entries = await store.search({"text": "dark mode", "vector": QUERY_VECTOR})

        assert [next(iter(stage)) for stage in collection.stages] == ["$rankFusion", "$set", "$limit"]
        assert _metadata(entries[0])["_search_type"] == "hybrid"

    async def test_a_manual_store_that_cannot_fuse_raises_rather_than_answering_from_one_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The second half, and the reason it is not a fallback.

        Both tiers are up and only the server version is missing, so there is a tier here that would
        answer this query: the text one, reading ``text`` and ignoring the vector the caller computed. It
        would return entries, ranked, stamped ``_search_type: "text"``: a true report of a question
        nobody asked, and indistinguishable from a fused answer unless the caller reads the metadata.
        """
        _patch_setup(monkeypatch, rank_fusion=False)
        store = _store(config=_connection_config(**MANUAL_VECTOR))
        await store.initialize()
        _prepared(store, tiers=store._tiers)

        with pytest.raises(ValueError) as caught:
            await store.search({"text": "dark mode", "vector": QUERY_VECTOR})

        assert "hybrid" in str(caught.value)
        assert "vector, text" in str(caught.value)


class TestAScoreBoundDeclinesTheBetterTier:
    """AT-148, AT-149 — the exception that is not a preference.

    A caller who set ``min_score=0.7`` with the vector tier's scores in mind and left ``search_type`` at
    its default would otherwise have that bound applied to fused scores that top out near 0.033: an
    empty list, no error, no warning, and indistinguishable from an empty collection.

    So the tier resolution reads a configuration key that has nothing to do with tiers, which is
    irregular enough to be worth the two tests. This package's line on silent wrong answers is that
    ``initialize()`` degrades and ``search()`` raises; degrading here means declining the *better* tier,
    which is the inversion that makes a degradation safe.
    """

    @pytest.mark.parametrize(
        ("bound", "named"),
        [({"min_score": 0.7}, "min_score"), ({"max_score": 0.9}, "max_score")],
        ids=["floor", "ceiling"],
    )
    async def test_a_bound_leaves_auto_resolving_as_it_did_before(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, bound: dict[str, float], named: str
    ) -> None:
        """``AT-148`` and ``AT-149`` in one reading, because they are one decision and its log line.

        Both bounds, not only the floor. ``max_score`` is a ceiling, so a fused score near 0.03 passes it
        rather than failing it, and the failure is quieter still: a result set that keeps everything and
        means nothing. The log names which bound was set because the remedy differs by one word and is
        not guessable from the result.
        """
        _patch_setup(monkeypatch, rank_fusion=True)
        store = _store(**bound)

        with caplog.at_level(logging.WARNING):
            await store.initialize()

        assert store._tiers == ("vector", "text")
        assert store._pick_tier(query_text="dark mode", query_vector=None) == "vector"
        warnings = [record.getMessage() for record in caplog.records if named in record.getMessage()]
        assert len(warnings) == 1
        assert "hybrid" in warnings[0]

    async def test_no_bound_no_warning(self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
        """The ordinary store says nothing, which is what makes the line above worth reading."""
        _patch_setup(monkeypatch, rank_fusion=True)
        store = _store()

        with caplog.at_level(logging.WARNING):
            await store.initialize()

        assert [record.getMessage() for record in caplog.records if "min_score" in record.getMessage()] == []

    async def test_a_bound_is_silent_where_fusion_was_never_on_offer(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Nothing was declined, so there is nothing to report.

        A warning here would describe a tier the deployment cannot run to an operator who cannot enable
        it, on every store construction, while the store it names resolves exactly as it would without a
        bound.
        """
        _patch_setup(monkeypatch, rank_fusion=False)
        store = _store(min_score=0.7)

        with caplog.at_level(logging.WARNING):
            await store.initialize()

        assert store._tiers == ("vector", "text")
        assert [record.getMessage() for record in caplog.records if "min_score" in record.getMessage()] == []

    async def test_an_explicit_hybrid_store_keeps_its_bound_and_its_tier(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Hybrid asked for by name is not second-guessed, bound or no bound.

        The same line ``_ensure_search_tiers`` already draws between ``auto`` and a named tier. What the
        caller is owed here is the number, which is why ``test_readme.py`` holds the README and the
        docstring to stating the fused scale.
        """
        _patch_setup(monkeypatch, rank_fusion=True)
        store = _store(min_score=0.7, config=_connection_config(search_type="hybrid"))

        with caplog.at_level(logging.WARNING):
            await store.initialize()

        assert store._tiers == ("hybrid",)
        assert [record.getMessage() for record in caplog.records if "min_score" in record.getMessage()] == []

    async def test_the_bound_reaches_the_fused_score_rather_than_being_dropped(self) -> None:
        """``AT-150``, on scores this test chose, in the shape ``AT-079`` uses.

        The numbers are what a real fusion returns rather than what a cosine tier does: ``0.0328`` is a
        document ranked first by both branches, ``0.0164`` first by one, and ``0.0161`` third. A bound
        picked on the fused scale keeps the first two, and the same code path that applies it to a cosine
        score applies it here, which is the claim, since the alternative implementations both look right
        from outside: dropping the bound on this tier, or comparing against a score field ``$rankFusion``
        never projected and that would therefore read ``0.0`` for every document.
        """
        store = _store(min_score=0.0164, config=_connection_config(search_type="hybrid", **MANUAL_VECTOR))
        documents = [
            {"_id": str(index), "content": f"fact {index}", "score": score}
            for index, score in enumerate((0.0328, 0.0164, 0.0161))
        ]
        collection = _prepared(store, documents=documents, tiers=("hybrid",))

        entries = await store.search({"text": "dark mode", "vector": QUERY_VECTOR})

        assert [entry.content for entry in entries] == ["fact 0", "fact 1"]
        assert [next(iter(stage)) for stage in collection.stages] == ["$rankFusion", "$set", "$limit"]
        assert _metadata(entries[0])["_search_type"] == "hybrid"


class TestADriverErrorArrivesNamingTheNamespaceAndNothingElse:
    """AT-080 — the driver calls ``AT-014``'s memory half never reaches.

    ``TestNoMemoryMethodRendersThePassword`` asserts ``StorageError`` out of ``initialize``, ``search``
    and ``add`` against a real authentication failure, and that leaves a gap. An auth failure surfaces
    inside ``_indexes.search_support`` or ``_indexes.ensure``, and both wrap their own driver errors, so
    ``_reporting`` never sees a ``PyMongoError`` at all. The calls that reach the driver unwrapped are
    ``update_one`` on the write path, ``aggregate`` on the read path and the two deletes, and only a test
    that fails one of them shows whether ``_reporting`` would render the connection config into the
    message.

    Which is why the store is built on ``LEAKY_URI`` and the driver error carries no password. A real one
    does not, so the config this store is holding is the only route the password has into the message, and
    closing that route is the whole point of a decorator that renders a namespace and nothing else.
    ``_assert_no_leak`` is defined with ``TestNoMemoryMethodRendersThePassword`` below and shared rather
    than repeated.
    """

    @pytest.mark.parametrize("call", ["add", "search", "delete", "delete_all"])
    async def test_an_unwrapped_driver_error_names_the_operation_and_the_namespace(self, call: str) -> None:
        """The verb, the namespace, the chained cause, and neither the memory nor the password.

        Code 8 rather than a plausible code, because which code it is changes nothing here: ``_reporting``
        wraps every ``PyMongoError``, and a decorator that inspected the code would be the thing that
        decides some failures are not worth reporting.

        The two delete calls are the error half of ``TestDeletionIsAWrite``, kept here rather than given a
        class of their own: ``delete_one`` and ``delete_many`` are the third and fourth driver calls this
        store makes unwrapped, so they belong to the gap this class exists to close.
        """
        verbs = {
            "add": "adding a memory to",
            "search": "searching",
            "delete": "deleting a memory from",
            "delete_all": "deleting every memory in",
        }
        content = "the user prefers dark mode"
        failure = OperationFailure("pretend failure, carrying no credentials", code=8)
        store = _store(config=_connection_config(connection_string=LEAKY_URI), writable=True)
        _prepared(store, failure=failure)

        with pytest.raises(StorageError) as caught:
            if call == "add":
                await store.add(content)
            elif call == "search":
                await store.search(content)
            elif call == "delete":
                await store.delete(str(ObjectId()))
            else:
                await store.delete_all()

        message = str(caught.value)
        assert verbs[call] in message
        assert store._target in message
        assert caught.value.__cause__ is failure
        assert content not in message
        _assert_no_leak(message, caught.value, "".join(traceback.format_exception(caught.value)))


# --- contract tier: a real deployment, no query ------------------------------------------------


@pytest.fixture
async def contract_store(contract_uri: str, test_database_name: str, unique_collection_name: str) -> Any:
    """A writable store scoped to ``tenant-a``, in this test's own collection, on a real deployment.

    One collection per test rather than one per session, because most of what this tier asserts is a
    document count and a shared collection makes every count another test's business.
    """
    store = _real_store(contract_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-a")
    try:
        yield store
    finally:
        await store.close()


async def _require_no_search_support(store: MongoDBMemoryStore) -> int:
    """Skip unless the deployment really has no Atlas Search, naming why, and report the code it used.

    The tier marker says "any real MongoDB", which cannot express "one without mongot", and the three
    claims below are about the deployment that lacks it. CI points ``MONGODB_URI`` at ``mongo:8``, where
    the probe reports ``False``; a developer who points it at Atlas gets a skip with a reason rather
    than a failure they would learn to ignore.

    Returns the code so the callers can assert that the message names *this* deployment's code rather
    than a literal. Three codes mean this and they differ by server version and build, so a test that
    hard-coded one would pass on the deployment it was written against and nowhere else.

    Args:
        store: The store whose collection to probe.

    Returns:
        The server error code this deployment answers the probe with.
    """
    support = await _indexes.search_support(store._collection())
    if support.available:
        pytest.skip("MONGODB_URI names a deployment with Atlas Search; this test is about one without")
    assert support.code is not None, "the probe reported no search support and no code, which it must not"
    return support.code


@pytest.mark.contract
class TestDedupAgainstTheUniqueIndex:
    """AT-042, AT-043 — a retried write stores one document, and the reason the index is unique.

    Extraction writes are at-least-once and the coordinator re-drives the **whole batch** on any single
    failure, so the same fact arrives repeatedly by design. Without the unique partial index over
    ``(scope, store_name, content_hash)`` the collection grows once per retry, and the growth looks like
    the agent remembering the same thing twice.

    The hash covers content only, deliberately: a regenerated ``created_at`` must not be able to defeat
    dedup. ``$setOnInsert`` is what keeps the first-seen timestamp, which is asserted here because the
    obvious ``$set`` also passes a count test.
    """

    async def test_the_same_content_twice_stores_one_document(
        self, contract_store: MongoDBMemoryStore, contract_database: Any, unique_collection_name: str
    ) -> None:
        """One document, and a result that says so rather than reporting two writes."""
        await contract_store.initialize()

        first = await contract_store.add("the user prefers dark mode")
        second = await contract_store.add("the user prefers dark mode")

        assert first.inserted == 1
        assert first.duplicates == 0
        assert second.inserted == 0
        assert second.duplicates == 1
        assert second.ids == first.ids
        assert await contract_database[unique_collection_name].count_documents({}) == 1

    async def test_a_duplicate_leaves_the_first_seen_timestamp_alone(
        self, contract_store: MongoDBMemoryStore, contract_database: Any, unique_collection_name: str
    ) -> None:
        """``$setOnInsert``, not ``$set``: the second write must not move ``created_at`` forward.

        A store whose timestamps refresh on every retry has a recency index that sorts by "last
        extraction attempt", which is not what ``strands_scope_store_created_at`` is for.
        """
        await contract_store.initialize()
        await contract_store.add("the user prefers dark mode")
        collection = contract_database[unique_collection_name]
        before = (await collection.find_one({}))["created_at"]

        await contract_store.add("the user prefers dark mode")

        assert (await collection.find_one({}))["created_at"] == before

    async def test_a_concurrent_duplicate_key_error_is_reported_as_success(
        self, contract_store: MongoDBMemoryStore, contract_database: Any, unique_collection_name: str
    ) -> None:
        """A lost insert race reads as a duplicate, injected rather than raced to make it reproducible.

        The window is real and narrow: two upserts both match nothing, both insert, and the loser gets
        ``DuplicateKeyError``. Injecting it is the only way to assert *which* answer the loser gets, and
        the answer has to be the winner's id, since a caller that sees an error cannot tell a lost race
        from a rejected write. The natural race is asserted for its outcome in the next test.
        """
        await contract_store.initialize()
        first = await contract_store.add("the user prefers dark mode")
        real = contract_store._collection()

        class RaisingOnce:
            """The real collection, with ``DuplicateKeyError`` out of the first ``update_one``."""

            def __init__(self) -> None:
                self.raised = False

            def __getattr__(self, name: str) -> Any:
                return getattr(real, name)

            async def update_one(self, *args: Any, **kwargs: Any) -> Any:
                if not self.raised:
                    self.raised = True
                    raise DuplicateKeyError("E11000 duplicate key error collection: injected", 11000)
                return await real.update_one(*args, **kwargs)

        injected = RaisingOnce()
        contract_store._collection = lambda: injected  # type: ignore[assignment, return-value]

        second = await contract_store.add("the user prefers dark mode")

        assert injected.raised is True
        assert second.duplicates == 1
        assert second.inserted == 0
        assert second.ids == first.ids
        assert await contract_database[unique_collection_name].count_documents({}) == 1

    async def test_ten_concurrent_adds_of_one_fact_store_one_document(
        self, contract_store: MongoDBMemoryStore, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The race as it actually arrives, asserted on the outcome instead of on the exception.

        Whether any of the ten hits the ``DuplicateKeyError`` window depends on the server's timing, so
        asserting that one did would be flaky. What cannot vary is the outcome: one document, one
        insert, nine duplicates, no exception.
        """
        await contract_store.initialize()

        results = await asyncio.gather(
            *(contract_store.add("the user prefers dark mode") for _ in range(10)),
            return_exceptions=True,
        )

        assert [result for result in results if isinstance(result, BaseException)] == []
        # Narrowed by a second comprehension rather than suppressed. `return_exceptions=True` types the
        # list as `MongoDBAddResult | BaseException`, and mypy does not carry the assertion above into the
        # two lines below, so reading `.inserted` off the union is an error it is right to report.
        added = [result for result in results if not isinstance(result, BaseException)]
        assert sum(result.inserted for result in added) == 1
        assert sum(result.duplicates for result in added) == 9
        assert await contract_database[unique_collection_name].count_documents({}) == 1


@pytest.mark.contract
class TestInitializeIsIdempotent:
    """AT-045a — twice is the same as once, on the ordinary index set.

    Called on every ``search`` and every ``add``, so the warm path has to be cheap and must not
    accumulate anything. ``_indexes.ensure``'s own idempotency is ``test_indexes.py``'s claim; what this
    adds is that ``initialize()`` is the caller that keeps it, rather than passing a different spec set
    the second time and creating a second index under another name.
    """

    async def test_initializing_twice_creates_one_index_set(
        self, contract_store: MongoDBMemoryStore, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The three memory specs plus ``_id_``, after two calls."""
        await contract_store.initialize()
        await contract_store.initialize()

        information = await contract_database[unique_collection_name].index_information()

        assert set(information) == {
            "_id_",
            "strands_scope_store_content_hash_unique",
            "strands_scope_store_created_at",
            "strands_expires_at_ttl",
        }


@pytest.mark.contract
class TestTheStoreStampsTheScopeItself:
    """AT-046, AT-048a — scope isolation on the write path.

    Isolation here is application-enforced, not database-enforced: there is no server-side row filter,
    so a document lands in the right scope only because this package put it there. Every assertion reads
    the stored document rather than the returned result, because the result is this package's own report
    and the document is what the next query will match.

    The unscoped sentinel is the other half. An absent ``scope`` resolving to "no predicate" would make
    the *unconfigured* store the one that reads everything, which is the failure mode that looks like a
    relevance quirk instead of a leak.
    """

    async def test_the_stored_document_carries_the_stores_scope_and_name(
        self, contract_store: MongoDBMemoryStore, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The four fields the dedup and recency indexes are built over, plus the content."""
        await contract_store.initialize()

        await contract_store.add("the user prefers dark mode")

        document = await contract_database[unique_collection_name].find_one({})
        assert document["scope"] == "tenant-a"
        assert document["store_name"] == "facts"
        assert document["content"] == "the user prefers dark mode"
        assert document["created_at"]
        # Over the content and nothing else, which is what makes dedup survive a retry: a hash covering
        # `created_at` would make every regenerated entry a new document.
        assert document["content_hash"] == hashlib.sha256(b"the user prefers dark mode").hexdigest()

    async def test_caller_metadata_cannot_set_the_write_scope(
        self, contract_store: MongoDBMemoryStore, contract_database: Any, unique_collection_name: str
    ) -> None:
        """Caller metadata is nested, so a key named ``scope`` inside it is inert rather than rejected.

        Asserted rather than assumed, because the tempting implementation is to merge caller metadata
        into the document root, where ``{"scope": "tenant-b"}`` would be a one-line cross-scope write.
        The nested copy stays visible: dropping it would be silent data loss on a legitimate key that
        merely shares a name with ours.
        """
        await contract_store.initialize()

        await contract_store.add("a fact", {"scope": "tenant-b", "_scope": "tenant-b"})

        document = await contract_database[unique_collection_name].find_one({})
        assert document["scope"] == "tenant-a"
        assert document["metadata"]["scope"] == "tenant-b"

    async def test_a_configured_filter_cannot_set_the_write_scope(
        self,
        contract_uri: str,
        test_database_name: str,
        unique_collection_name: str,
        contract_database: Any,
    ) -> None:
        """``filter`` is read-path narrowing and the write path does not consult it at all.

        ``scope`` is one of the two baked-in filterable fields (``_indexes.declared_filter_fields``), so
        this filter passes the declared-field check and would be accepted by a query. That is
        what makes it worth asserting on the write path: the value is valid, it just has no authority
        here.
        """
        store = _real_store(
            contract_uri,
            test_database_name,
            unique_collection_name,
            writable=True,
            scope="tenant-a",
            filter={"scope": "tenant-b"},
        )
        try:
            await store.initialize()
            await store.add("a fact")
        finally:
            await store.close()

        assert await contract_database[unique_collection_name].count_documents({"scope": "tenant-a"}) == 1
        assert await contract_database[unique_collection_name].count_documents({"scope": "tenant-b"}) == 0

    async def test_a_store_with_no_scope_stamps_the_sentinel(
        self,
        contract_uri: str,
        test_database_name: str,
        unique_collection_name: str,
        contract_database: Any,
    ) -> None:
        """``AT-048a``. The field is present and equal to the sentinel, never missing and never empty.

        Missing is the dangerous one: the dedup index is partial on ``content_hash`` and the scope
        predicate would have to become ``{"scope": {"$exists": False}}`` to match, which no other query in
        this package writes. Empty is the quiet one, because ``""`` is falsy and every ``if scope:`` in a
        future edit would treat it as unset.

        ``store.scope`` reports the resolved value rather than the caller's ``None``, which departs from
        ``BedrockKnowledgeBaseStore``: reading ``None`` there while the documents carry a sentinel would
        let a reader conclude the store is unscoped when it is scoped to ``__unscoped__``.
        """
        store = _real_store(contract_uri, test_database_name, unique_collection_name, writable=True)
        try:
            assert store.scope == UNSCOPED
            assert UNSCOPED == "__unscoped__"

            await store.initialize()
            await store.add("a fact from a store nobody scoped")
        finally:
            await store.close()

        document = await contract_database[unique_collection_name].find_one({})
        assert document["scope"] == UNSCOPED


@pytest.mark.contract
class TestWritesStayInTheirScope:
    """AT-047b — two stores, one collection, and dedup that does not cross the boundary.

    The read half is ``TestNoSearchCrossesAScope`` on the integration tier, for the reason in the module
    docstring. This
    half is the one a plain deployment can prove, and it carries a claim the read half cannot: the unique
    index leads with ``scope``, so the *same* fact in two scopes is two documents. An index over
    ``content_hash`` alone would collapse them into one and hand tenant B a document written by tenant A,
    which is a cross-scope leak arriving through the dedup path rather than through a query.
    """

    async def test_the_same_fact_in_two_scopes_is_two_documents(
        self,
        contract_uri: str,
        test_database_name: str,
        unique_collection_name: str,
        contract_database: Any,
    ) -> None:
        """Both writes insert, and each lands under its own scope."""
        first = _real_store(contract_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-a")
        second = _real_store(contract_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-b")
        try:
            await first.initialize()

            a = await first.add("the user prefers dark mode")
            b = await second.add("the user prefers dark mode")
        finally:
            await first.close()
            await second.close()

        assert a.inserted == 1
        assert b.inserted == 1
        assert a.ids != b.ids
        collection = contract_database[unique_collection_name]
        assert await collection.count_documents({"scope": "tenant-a"}) == 1
        assert await collection.count_documents({"scope": "tenant-b"}) == 1


@pytest.mark.contract
class TestDeletionStaysInsideTheStoreThatIssuedIt:
    """AT-085 — deletes stay inside the issuing store, on real documents, with no query.

    Contract rather than integration, by the same tier rule as the rest of this file: the memory read
    path needs mongot and nothing here reads through ``search``. The id comes from
    ``MongoDBAddResult.ids[0]``, the same string ``search`` projects into ``_id`` metadata, so the round
    trip a caller makes is the round trip under test.

    This is what the unit tier cannot claim. There a fake records the filter it was handed; here a server
    decides what that filter matches, which is the difference between asserting a predicate and asserting
    an outcome.
    """

    async def test_a_memory_deletes_once_and_the_second_attempt_reports_nothing(
        self, contract_store: MongoDBMemoryStore, contract_database: Any, unique_collection_name: str
    ) -> None:
        """One of two documents goes, the other stays, and deleting the same id again returns ``0``.

        The second call is "matched nothing is not an error" on the path a retry takes: an
        erasure job that runs twice must not fail the second time.
        """
        first = await contract_store.add("the user prefers dark mode")
        await contract_store.add("the user works in emea")
        collection = contract_database[unique_collection_name]

        assert await contract_store.delete(first.ids[0]) == 1
        assert await collection.count_documents({}) == 1
        assert await contract_store.delete(first.ids[0]) == 0
        assert await collection.count_documents({}) == 1

    async def test_a_sibling_stores_id_deletes_nothing_and_reads_the_same_as_an_absent_one(
        self,
        contract_uri: str,
        test_database_name: str,
        unique_collection_name: str,
        contract_database: Any,
    ) -> None:
        """A delete is not an existence oracle: two return values that have to be equal.

        A well-formed id belonging to another store in the same scope, and an id belonging to nothing at
        all, both answer ``0``. If the first answered anything else, a loop over ids would tell a caller
        which documents exist outside their own store, one call at a time, without ever deleting one.
        """
        mine = _real_store(contract_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-a")
        sibling = _real_store(
            contract_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-a", name="notes"
        )
        try:
            theirs = await sibling.add("the user prefers dark mode")

            absent = await mine.delete(str(ObjectId()))
            borrowed = await mine.delete(theirs.ids[0])
        finally:
            await mine.close()
            await sibling.close()

        assert borrowed == absent == 0
        collection = contract_database[unique_collection_name]
        assert await collection.count_documents({"store_name": "notes"}) == 1

    async def test_delete_all_empties_its_own_store_and_leaves_the_sibling(
        self,
        contract_uri: str,
        test_database_name: str,
        unique_collection_name: str,
        contract_database: Any,
    ) -> None:
        """``delete_all`` empties one store's view, not one scope, as an assertion rather than a paragraph.

        Two memories in one store, one in a sibling, all three in one scope and one collection. The count
        returned is exactly the two, and the sibling's document is still there afterwards, which is the
        behavior a customer answering a deletion request has to know about: emptying a scope served by two
        stores is two calls.
        """
        mine = _real_store(contract_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-a")
        sibling = _real_store(
            contract_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-a", name="notes"
        )
        try:
            await mine.add("the user prefers dark mode")
            await mine.add("the user works in emea")
            await sibling.add("the user prefers dark mode")

            deleted = await mine.delete_all()
        finally:
            await mine.close()
            await sibling.close()

        assert deleted == 2
        collection = contract_database[unique_collection_name]
        assert await collection.count_documents({"store_name": "facts"}) == 0
        assert await collection.count_documents({"store_name": "notes"}) == 1


@pytest.mark.contract
class TestADeploymentWithNoSearchSupport:
    """AT-053a, AT-053c — a deployment without Atlas Search, measured rather than assumed.

    On ``mongo:8`` (``modules: []``) every search surface fails identically, ``OperationFailure`` code
    **31082**, while ordinary index creation and every CRUD path work normally. So this deployment can
    hold memories and cannot read them back.

    Code 31082 is what ``mongo:8`` answers and not what ``mongo:6``, ``mongo:7`` or an enterprise
    ``mongod`` 7.0 answer, so every assertion below reads the code from the deployment under test instead
    of naming one. A suite pinned to one deployment's code would pass there and miss a probe that raised
    on the others.

    ``initialize()`` degrades and ``search()`` raises, the line the SDK's own stores draw: capability
    probing may legitimately degrade, query paths log and re-raise. Failing ``initialize()`` would take
    away the half that works; returning zero results from ``search()`` would be a silent wrong answer,
    since no search tier runs without mongot and there is nothing for ``auto`` to resolve to.

    The message is not the one for a missing index. A missing or ``NOT READY`` index on a deployment
    that *does* support search gets a message quoting ``createSearchIndexes``. Any of the three codes
    means that command does not exist here, so quoting it would be advice the caller cannot act on. Two
    conditions, two messages, asserted apart below.
    """

    async def test_initialize_completes_with_the_ordinary_indexes_and_one_warning(
        self,
        contract_store: MongoDBMemoryStore,
        contract_database: Any,
        unique_collection_name: str,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """The degrade path: three ordinary indexes present, search indexes skipped, one warning."""
        code = await _require_no_search_support(contract_store)

        with caplog.at_level(logging.WARNING, logger="strands_mongodb.memory_store"):
            await contract_store.initialize()

        warnings = [
            record
            for record in caplog.records
            if record.name == "strands_mongodb.memory_store" and record.levelno == logging.WARNING
        ]
        assert len(warnings) == 1, [record.getMessage() for record in warnings]
        assert str(code) in warnings[0].getMessage()
        assert "Atlas" in warnings[0].getMessage()
        assert set(await contract_database[unique_collection_name].index_information()) == {
            "_id_",
            "strands_scope_store_content_hash_unique",
            "strands_scope_store_created_at",
            "strands_expires_at_ttl",
        }

    async def test_a_write_still_works_on_a_deployment_that_cannot_read(
        self, contract_store: MongoDBMemoryStore, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The half that keeps working is why ``initialize()`` degrades instead of raising."""
        await _require_no_search_support(contract_store)
        await contract_store.initialize()

        result = await contract_store.add("the user prefers dark mode")

        assert result.inserted == 1
        assert await contract_database[unique_collection_name].count_documents({}) == 1

    async def test_search_on_auto_raises_naming_the_code_and_what_to_connect_to(
        self, contract_store: MongoDBMemoryStore
    ) -> None:
        """``AT-053c``'s second half. ``auto`` is the shipped default, so this is the unconfigured path."""
        code = await _require_no_search_support(contract_store)
        await contract_store.initialize()

        with pytest.raises(StorageError) as caught:
            await contract_store.search("dark mode")

        assert str(code) in str(caught.value)
        assert "Atlas" in str(caught.value)

    async def test_search_type_vector_raises_about_the_deployment_not_about_an_index(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """``AT-053a``. A named tier already raises; this pins *which* message.

        The absent strings are the assertion. A caller told to run ``createSearchIndexes`` on a
        deployment where that command is unavailable is sent after a remedy that cannot work.
        """
        store = _real_store(
            contract_uri,
            test_database_name,
            unique_collection_name,
            writable=True,
            connection={"search_type": "vector"},
        )
        try:
            code = await _require_no_search_support(store)
            await store.initialize()

            with pytest.raises(StorageError) as caught:
                await store.search("dark mode")
        finally:
            await store.close()

        assert str(code) in str(caught.value)
        assert "createSearchIndexes" not in str(caught.value)
        assert "NOT READY" not in str(caught.value)


def _with_password(uri: str, secret: str = SECRET) -> str:
    """Return ``uri`` with ``u:<secret>@`` as its userinfo, replacing whatever was there.

    Args:
        uri: A connection string.
        secret: The password to embed.

    Returns:
        The rewritten URI. Credentials that do not authenticate are the point: the failing path is
        where a driver error is most likely to echo them back.
    """
    scheme, _, rest = uri.partition("://")
    host = rest.partition("@")[2] or rest
    return f"{scheme}://u:{secret}@{host}"


def _assert_no_leak(*subjects: Any) -> None:
    """Assert no subject renders the password.

    The same helper as ``test_storage.py``'s ``assert_no_leak``, duplicated rather than shared for the
    same reason each test module defines its own ``UNREACHABLE``: a failure here should point at this
    file. The failure message names the subject's position and type and never the password, since a
    CI log is exactly where it must not appear.

    Args:
        *subjects: Strings, or objects to render with ``repr``.
    """
    for index, subject in enumerate(subjects):
        text = subject if isinstance(subject, str) else repr(subject)
        assert SECRET not in text, f"subject {index} ({type(subject).__name__}) leaked the password"


class TestExpiryIsStampedFromTheDocumentsOwnClock:
    """AT-153 / AT-154 -- the three outcomes ``ttl_seconds`` can have.

    Three cases rather than two, and that is the whole design of this test. ``0`` and ``None`` are both
    falsy in Python and opposite instructions to MongoDB: ``expireAfterSeconds: 0`` on the index means
    "delete once the stamped time passes", so ``ttl_seconds=0`` asks for expiry at the next sweep, while
    absence asks for none at all. A ``if not self.ttl_seconds:`` guard satisfies a two-case test and
    silently converts the first request into the second, where the only symptom is a collection that
    fails to shrink, indistinguishable for weeks from one whose documents have not aged out yet.

    The offset is asserted against the document's own ``created_at`` rather than against a clock this
    test reads. That is the property that matters, and it is stronger than a tolerance window:
    one clock read means the two fields are exactly ``ttl_seconds`` apart, and a second ``now()`` call in
    the implementation would fail this by microseconds no matter how generous the window.
    """

    @pytest.mark.parametrize("ttl", [0, 1, 3600, 86400], ids=["immediate", "one", "hour", "day"])
    async def test_a_configured_ttl_stamps_exactly_that_offset_from_created_at(self, ttl: int) -> None:
        """AT-153, AT-154's positive cases, including ``0``, which is the one a falsy check drops."""
        store = _store(config=_connection_config(), writable=True, ttl_seconds=ttl)
        collection = _prepared(store)
        with contextlib.suppress(NotImplementedError):
            await store.add("the user prefers dark mode")

        insert = collection.upserts[-1][1]["$setOnInsert"]
        assert insert[_indexes.EXPIRES_FIELD] - insert["created_at"] == datetime.timedelta(seconds=ttl)

    async def test_no_ttl_stamps_no_field_at_all(self) -> None:
        """AT-154's negative case: with no TTL, the document has exactly the shape it has without the feature.

        Asserted as the field's absence rather than as a ``None`` value, because a stamped ``None`` is
        indexed by the TTL index as a value that is not a date, which is a different behaviour from not
        being indexed and one nobody would notice until a document failed to expire.
        """
        store = _store(config=_connection_config(), writable=True)
        collection = _prepared(store)
        with contextlib.suppress(NotImplementedError):
            await store.add("the user prefers dark mode")

        assert store.ttl_seconds is None
        assert _indexes.EXPIRES_FIELD not in collection.upserts[-1][1]["$setOnInsert"]

    async def test_zero_and_absence_reach_the_document_differently(self) -> None:
        """AT-154, stated as the comparison the three-way split exists to make.

        The two configurations a falsy check cannot tell apart, written side by side so that the test
        that fails when someone writes one is the test whose name says why.
        """
        immediate = _store(config=_connection_config(), writable=True, ttl_seconds=0)
        never = _store(config=_connection_config(), writable=True)
        stamps = []
        for store in (immediate, never):
            collection = _prepared(store)
            with contextlib.suppress(NotImplementedError):
                await store.add("the user prefers dark mode")
            stamps.append(collection.upserts[-1][1]["$setOnInsert"])

        assert _indexes.EXPIRES_FIELD in stamps[0], "ttl_seconds=0 is a request to expire, not a disabled TTL"
        assert _indexes.EXPIRES_FIELD not in stamps[1]

    async def test_the_stamp_is_set_on_insert_so_a_duplicate_does_not_extend_it(self) -> None:
        """Expiry lives beside ``created_at`` in ``$setOnInsert`` and moves with it.

        A re-extracted fact is the fact this store already holds, and ``$set`` here would
        turn a TTL into a last-seen window: a memory the extractor keeps rediscovering would never
        expire, which is the opposite of what an operator configuring a retention period asked for.
        """
        store = _store(config=_connection_config(), writable=True, ttl_seconds=60)
        collection = _prepared(store)
        with contextlib.suppress(NotImplementedError):
            await store.add("the user prefers dark mode")

        update = collection.upserts[-1][1]
        assert list(update) == ["$setOnInsert"], f"a second update operator would move the stamp: {list(update)}"
        assert _indexes.EXPIRES_FIELD in update["$setOnInsert"]


class TestTheTtlIndexIsUnconditionalAndThatIsLoadBearing:
    """AT-155 / AT-156 -- the index, and the twenty bytes beside it.

    ``memory_specs()`` returns the TTL index whether or not a TTL is configured, and that is why turning
    on ``ttl_seconds`` needs no migration: the index already exists, and a TTL index acts on every
    document carrying the field it covers.

    That stops being true as soon as the spec is made conditional, which is an easy and well-intentioned
    change to make, since it saves an index on stores that do not use it. This is the test that fails
    when it is made.
    """

    def test_the_memory_specs_carry_the_ttl_index_with_no_config_to_ask(self) -> None:
        """AT-155: ``memory_specs()`` takes no arguments, which is itself the guarantee."""
        names = [spec.name for spec in _indexes.memory_specs()]

        assert "strands_expires_at_ttl" in names
        assert inspect.signature(_indexes.memory_specs).parameters == {}, (
            "memory_specs() gained a parameter, which is how the TTL index becomes conditional"
        )
        ttl = next(spec for spec in _indexes.memory_specs() if spec.name == "strands_expires_at_ttl")
        assert ttl.options == {"expireAfterSeconds": 0}, (
            "expireAfterSeconds must be 0: the document carries the deadline, not the index"
        )
        assert ttl.keys == ((_indexes.EXPIRES_FIELD, 1),), "the index has to cover the field add() stamps"

    def test_the_two_surfaces_expire_on_the_same_field_and_the_same_index(self) -> None:
        """AT-155: a memory and a storage record are different documents in different collections, and
        an operator reading the README's provisioning commands sees one field name and one index name."""
        memory = {spec.name: spec for spec in _indexes.memory_specs()}["strands_expires_at_ttl"]
        storage = {spec.name: spec for spec in _indexes.storage_specs()}["strands_expires_at_ttl"]

        assert memory.keys == storage.keys
        assert memory.options == storage.options

    def test_the_size_overhead_of_the_expiry_field_has_one_definition(self) -> None:
        """AT-156: the constant a size preflight on this surface would have to use.

        There is no size preflight on the memory store to test; the one that exists is ``MongoDBStorage``'s.
        What can be tested is that the number has a single home and says that it is about the field
        rather than about that class, so a preflight added to the memory store later reuses it rather
        than reconstructing twenty bytes from first principles.
        """
        overhead = storage_module._EXPIRES_OVERHEAD_BYTES
        assert overhead > 0
        sources = [name for name, text in _package_sources().items() if "_EXPIRES_OVERHEAD_BYTES" in text]
        assert sources == ["storage.py"], f"the expiry overhead is defined or copied in more than one module: {sources}"

        stamped = {_indexes.EXPIRES_FIELD: datetime.datetime.now(datetime.timezone.utc)}
        assert len(bson.encode(stamped)) - len(bson.encode({})) == overhead, (
            "the constant no longer matches what an `expires_at` element costs in BSON, which is the "
            "only way to check a number whose whole purpose is to avoid encoding the document"
        )


_TTL_SWEEP_BUDGET: Final[float] = 150.0
"""How long a document may take to disappear before the expiry is judged not to work.

MongoDB's TTL monitor runs every 60 seconds by default and is not synchronous with anything: a document
whose deadline passed a moment after a sweep waits most of a cycle for the next one, and the deletion
itself is a background pass over the index. Two cycles plus slack is the smallest budget that is not
measuring luck.

Not a delay. The caller below polls once a second and returns the moment the document is gone, so a
deployment whose monitor has been turned down finishes in seconds.
"""


@pytest.mark.contract
class TestAMemoryWithATtlActuallyDisappears:
    """AT-152 -- the server's TTL monitor, asserted as a disappearance.

    Everything else about expiry is a field in a document this package wrote, and a test of that is a
    test of this package agreeing with itself. What nobody can check without a server is the part that
    matters: that the stamp is on the field the index covers, in a type the index understands, with an
    ``expireAfterSeconds`` that makes the deadline the document's own. Get any of the three wrong and
    every unit test above still passes while nothing is ever deleted.

    **No ``ensure_indexes()`` call, and that absence is the test.** The store is constructed, ``add`` is
    called, and the document goes away. A caller of ``MongoDBStorage`` has to provision the index
    themselves; a caller here does not, and the difference is worth pinning because it is the kind of
    asymmetry a later refactor "tidies up".

    Runs on the contract tier: a TTL index is ordinary and needs no mongot, so this is checked on every
    pull request rather than weekly.
    """

    async def test_a_document_written_with_a_ttl_is_gone_after_the_sweep(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str, contract_database: Any
    ) -> None:
        """AT-152: one store, one ``add``, and then the collection is empty."""
        collection = contract_database[unique_collection_name]
        with contextlib.suppress(OperationFailure):
            # Turns a 60-second monitor cycle into a 1-second one, where the deployment allows it. Atlas
            # does not expose `setParameter`, so this is an optimisation for local runs and never a
            # premise: the budget below is sized for a monitor nobody touched.
            await contract_database.client.admin.command("setParameter", 1, ttlMonitorSleepSecs=1)

        store = _real_store(
            contract_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-a", ttl_seconds=0
        )
        try:
            result = await store.add("this memory is written to be forgotten")
            assert result.inserted == 1

            stamped = await collection.find_one({"scope": "tenant-a"})
            assert stamped is not None, "the write did not land, so this test cannot be about the sweep"
            assert isinstance(stamped[_indexes.EXPIRES_FIELD], datetime.datetime), (
                "the TTL index ignores a field that is not a date, silently and forever: "
                f"{stamped[_indexes.EXPIRES_FIELD]!r}"
            )

            deadline = time.monotonic() + _TTL_SWEEP_BUDGET
            while await collection.count_documents({"scope": "tenant-a"}) and time.monotonic() < deadline:
                await asyncio.sleep(1.0)

            assert await collection.count_documents({"scope": "tenant-a"}) == 0, (
                f"a memory with ttl_seconds=0 was still there {_TTL_SWEEP_BUDGET}s later. The index "
                "exists and the stamp is a date, so what is left is expireAfterSeconds or the field name"
            )
        finally:
            await store.close()


@pytest.mark.contract
class TestNoMemoryMethodRendersThePassword:
    """AT-014's memory half — no memory method renders a password from the connection string.

    ``test_client.py`` covers construction and the registry; ``test_storage.py`` covers the five storage
    methods. The four memory methods are covered here, and they are the ones that fail in production: a
    store built once at start-up, then a driver error on every call, each one rendered into a log line
    or a traceback that reaches a ticket.

    Both paths run against the real deployment rather than against a closed port, which is what makes
    the marker ``contract``. The failing path uses credentials the server rejects, measured as
    ``OperationFailure`` code 18: an authentication failure is the error most likely to echo what it
    authenticated with. The succeeding path supplies an injected client alongside a password-bearing
    ``connection_string``, so every call reaches a live deployment while the config still holds a
    secret. That combination is constructed rather than typical, and it is the shape this guarantee
    exists for: ``_Connection`` stores no URI precisely because a dataclass ``__repr__`` would print it.

    The config is not a subject. It holds the password by construction, which is the premise; the
    guarantee is that nothing this package writes copies it out.
    """

    @pytest.mark.parametrize("call", ["initialize", "search", "add"])
    async def test_a_wrapped_driver_failure_renders_no_password(
        self, call: str, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """Each of the three methods that reach the network, on a real authentication failure."""
        store = _real_store(
            _with_password(contract_uri),
            test_database_name,
            unique_collection_name,
            writable=True,
        )
        try:
            with pytest.raises(StorageError) as caught:
                if call == "initialize":
                    await store.initialize()
                elif call == "search":
                    await store.search("dark mode")
                else:
                    await store.add("a fact")
        finally:
            await store.close()

        _assert_no_leak(
            str(caught.value),
            caught.value,
            "".join(traceback.format_exception(caught.value)),
        )

    async def test_the_succeeding_path_renders_no_password_at_debug(
        self,
        contract_uri: str,
        test_database_name: str,
        unique_collection_name: str,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """``DEBUG``, because that is the level a user turns on when something is wrong.

        ``get_tools`` is in here despite touching nothing: it is one of the four members the SDK calls,
        and the cheapest way for it to start leaking is a debug line naming the store it belongs to.
        """
        client: AsyncMongoClient[Any] = AsyncMongoClient(contract_uri)
        config: dict[str, Any] = {
            "client": client,
            "connection_string": _with_password(contract_uri),
            "database": test_database_name,
        }
        store = MongoDBMemoryStore(
            name="facts",
            # A plain dict rather than a `MongoDBConfig`, because holding a password alongside an
            # injected client is the shape this test constructs on purpose and no `TypedDict` narrows to
            # it without repeating the whole literal inline.
            config=config,  # type: ignore[arg-type]
            collection=unique_collection_name,
            writable=True,
        )
        try:
            with caplog.at_level(logging.DEBUG):
                await store.initialize()
                await store.add("the user prefers dark mode")
                store.get_tools()
        finally:
            await store.close()
            # Closed here rather than by `store.close()`, which never closes an injected client. That
            # asymmetry is the reason this path can hold a secret at all.
            await client.close()

        _assert_no_leak(*[record.getMessage() for record in caplog.records], store, store._connection)

    async def test_neither_the_store_nor_its_connection_renders_the_password(self) -> None:
        """``repr`` is where this leaks by accident: one added later for debugging, or a decorator.

        Needs no deployment and is here anyway, beside the two halves it belongs with. ``_Connection``
        is a dataclass, so it generates a ``__repr__`` over every field, and the field it deliberately
        does not have is the connection string.
        """
        store = _store(config=_connection_config(connection_string=LEAKY_URI))

        _assert_no_leak(store, store._connection, store._connection.client)


@pytest.mark.contract
class TestTheFusionProbeAgreesWithTheServerItProbed:
    """AT-145's real-deployment half -- the version read, against versions this package did not write.

    ``test_indexes.py`` closes this probe against a fake, which is where the malformed and missing
    ``versionArray`` cases live because no real server sends them. What a fake cannot check is the one
    thing the probe depends on: that ``buildInfo.versionArray[0]`` on an actual deployment is the major
    version, an ``int``, and agrees with the ``version`` string beside it. That is a claim about MongoDB's
    wire format, so it is asserted against MongoDB.

    Runs on the contract tier because ``buildInfo`` is a ``mongod`` command and needs no mongot, which
    also makes this the half that runs on every pull request. CI supplies 7.0, 8.0 and later majors over
    time rather than in one run, so the assertion is written as an agreement between two things the
    server said rather than as an expected boolean this test would have to keep in step with the matrix.
    """

    async def test_the_probe_answers_what_the_deployments_own_version_string_says(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str, contract_database: Any
    ) -> None:
        """AT-145: ``rank_fusion`` is ``True`` exactly where the server calls itself 8 or later."""
        build_info = await contract_database.command("buildInfo")
        major = int(str(build_info["version"]).split(".", 1)[0])

        answered = await _indexes.rank_fusion_support(contract_database[unique_collection_name])

        assert answered is (major >= _indexes.RANK_FUSION_MIN_MAJOR), (
            f"the probe said {answered} on a deployment calling itself {build_info['version']!r}"
        )
        assert build_info["versionArray"][0] == major, (
            "the probe reads versionArray[0] as the major version, and this server disagrees with its "
            f"own version string: {build_info['versionArray']} against {build_info['version']!r}"
        )

    async def test_a_store_on_this_deployment_reports_the_same_answer_in_its_capabilities(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str, contract_database: Any
    ) -> None:
        """AT-145: the capability a caller reads is the probe's answer, not a second opinion.

        Subject to the short-circuit: where search is unavailable the store never probes and reports
        ``False`` regardless of version (see ``TestTheHybridTierIsAStatementAboutTwoOthers``), which is
        the one case the two answers may differ and is asserted here rather than left as a surprise.
        """
        store = _real_store(contract_uri, test_database_name, unique_collection_name)
        try:
            await store.initialize()
            capabilities = store._connection.capabilities
            assert capabilities is not None, "initialize() leaves the probe's answer on the connection"
            probed = await _indexes.rank_fusion_support(contract_database[unique_collection_name])

            if not capabilities.search:
                assert capabilities.rank_fusion is False, (
                    "a deployment with no search process cannot reach the hybrid tier, so the "
                    "capability has to be False whatever the server version is"
                )
            else:
                assert capabilities.rank_fusion is probed
        finally:
            await store.close()


async def _settled(store: MongoDBMemoryStore) -> None:
    """Initialize ``store`` and wait for every index it can build, so its tier set is final.

    Under ``auto``, ``initialize()`` does not wait for a build, and a first ``search`` waits only for the
    first tier to be ready. Neither leaves the full set, so which tiers resolve would depend on which build
    finished first.
    """
    await store.initialize()
    if not store._can_search():
        return
    for _, spec in store._specs:
        # A refused index, such as an autoEmbed one on a deployment with no model, raises at once and stays out.
        with contextlib.suppress(StorageError):
            await _indexes.ensure(store._collection(), search=(spec,), create=store._ensure_indexes, timeout=180)
    await store._retry_search_tiers()


@pytest.mark.contract
class TestTheTierSetIsTheOneTheDeploymentImplies:
    """``AT-185`` -- tier resolution, graded by a tier that runs on every change.

    Which tier a store resolves is also asserted against monkeypatched capabilities in the unit tier,
    and against real search results in the Atlas tier. The Atlas tier runs on the cron and on a dispatch
    and on no change trigger, so its verdict on a pull request arrives after the merge. This class puts
    the claim on the tier gated on any deployment at all, so a change to the tier set is graded before it
    merges. What it covers is only the resolution: whether the store decides to use fusion. How well
    fusion ranks is a different claim, it needs a search process to produce the results it ranks, and it
    stays on the Atlas tier.

    **Implications rather than a lookup table.** A table keyed on the two capabilities is wrong: a local
    Atlas container reports ``search=True`` and ``rank_fusion=True`` and resolves ``("text",)``, because
    the default store's vector index needs a registered embedding model, that deployment has an empty
    registry (code 8), and the tier set therefore depends on a third input neither capability describes.
    What is true of every deployment is a set of one-directional implications, and each one is written
    here as one.

    Written to hold wherever it runs rather than on one deployment. On a deployment with no search process
    only the first implication has content, which is why the same class is run over two deployments: see
    the second job in the contract tier.
    """

    async def test_the_tier_set_agrees_with_what_this_deployment_can_do(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """``AT-185``: four implications, each one a rule that holds on any deployment.

        The pair itself is checked first. ``(search=False, rank_fusion=True)`` is unreachable, because
        ``initialize()`` does not probe the version where search is missing, and a deployment reporting it
        would mean that short-circuit had been removed rather than that this table is stale.
        """
        store = _real_store(contract_uri, test_database_name, unique_collection_name)
        try:
            await store.initialize()
            capabilities = store._connection.capabilities
            assert capabilities is not None, "initialize() leaves the probe's answer on the connection"
            tiers = store._tiers

            assert capabilities.search or not capabilities.rank_fusion, (
                "this deployment reports no search process and a probed $rankFusion, which the "
                "short-circuit in initialize() says cannot happen: the version is probed only where "
                "search is available"
            )
            if not capabilities.search:
                assert tiers == (), f"no search process means no search index and so no tier: {tiers}"
            if not capabilities.rank_fusion:
                assert "hybrid" not in tiers, (
                    f"the fused tier is on offer on a deployment that cannot run the stage: {tiers}"
                )
            if tiers:
                assert capabilities.search, f"tiers were prepared without a search process: {tiers}"
            if "hybrid" in tiers:
                assert capabilities.search and capabilities.rank_fusion, (
                    "hybrid needs both facts and this deployment reports "
                    f"search={capabilities.search}, rank_fusion={capabilities.rank_fusion}"
                )
                assert tiers == ("hybrid", "vector", "text"), (
                    "hybrid is a fusion of the other two, so a set containing it contains them, and it "
                    f"leads rather than replaces them: {tiers}"
                )
        finally:
            await store.close()

    async def test_a_store_needing_no_embedding_model_resolves_the_fusion_wherever_it_can(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """``AT-185``: the positive rule, on the one store shape a container can build both indexes for.

        The default store embeds on the deployment, so its vector index needs a model in the registry and
        a container has an empty one. The manual-vector path takes the caller's own vectors, so its index
        is an ordinary ``vector`` field and comes up wherever there is a search process at all. That makes
        this the test that grades the rule rather than its necessary conditions, and the one that fails on
        a pull request, rather than on a cron, when the tier set changes.

        The three ``_pick_tier`` reads are the fallback order, which is a claim about query *shapes* and
        not a preference: a manual-vector store's fused tier needs the caller's vector, so a text-only
        query has to fall past both hybrid and vector and be answered lexically, as it is on a local
        Atlas container.

        ``MANUAL_VECTOR``, ``QUERY_TEXT`` and ``QUERY_VECTOR`` are defined further down this module with
        the vector-tier corpus they were written for; module globals resolve when the test runs.
        """
        store = _real_store(contract_uri, test_database_name, unique_collection_name, connection=dict(MANUAL_VECTOR))
        try:
            await _settled(store)
            capabilities = store._connection.capabilities
            assert capabilities is not None

            if capabilities.search and capabilities.rank_fusion:
                assert store._tiers == ("hybrid", "vector", "text"), (
                    "a manual-vector store on a deployment with search and the stage has both indexes "
                    f"and so has the fusion: {store._tiers}"
                )
                assert store._pick_tier(query_text=QUERY_TEXT, query_vector=QUERY_VECTOR) == "hybrid"
                assert store._pick_tier(query_text=None, query_vector=QUERY_VECTOR) == "vector"
                assert store._pick_tier(query_text=QUERY_TEXT, query_vector=None) == "text", (
                    "the fused tier of a manual-vector store reads the caller's vector, so a query "
                    "without one falls past it and past the vector tier as well"
                )
            else:
                assert "hybrid" not in store._tiers, (
                    f"this deployment reports search={capabilities.search} and "
                    f"rank_fusion={capabilities.rank_fusion}, and offered the fusion anyway: {store._tiers}"
                )
        finally:
            await store.close()

    async def test_hybrid_leads_the_set_or_is_absent_from_it(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """``AT-185``: the ordering claim on its own, because the table would hide a subtle version.

        ``hybrid`` in the middle of the list is the one wrong answer a table comparison catches only by
        accident: it would still contain all three names. It is also the one a plausible edit produces,
        since ``insert(0, ...)`` and ``append(...)`` differ by two characters and both compile.
        """
        store = _real_store(contract_uri, test_database_name, unique_collection_name)
        try:
            await _settled(store)
            tiers = store._tiers

            assert "hybrid" not in tiers or tiers[0] == "hybrid", (
                f"hybrid is on offer here and is not the preferred tier: {tiers}"
            )
            assert tiers == () or tiers[-1] == "text", (
                f"text is the tier every other one falls through to, and it is not last: {tiers}"
            )
        finally:
            await store.close()

    async def test_a_text_query_resolves_to_hybrid_where_hybrid_is_on_offer(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """``AT-185``: resolution is the tier set read against a query shape, so read it.

        A plain string, not both keys: on the AutoEmbeddings path the fused tier reads ``text`` in both
        of its input pipelines, so one string fits it whole, and a test supplying a ``vector`` beside it
        would be asserting about the manual-vector mode instead of about the tier set.

        The third branch is the one CI takes, and it asserts the refusal cites the server's own code.
        Falling through to the text tier there would answer lexically and report ``text``, which is true
        and is not what a store that resolved nothing should be able to say.
        """
        store = _real_store(contract_uri, test_database_name, unique_collection_name)
        try:
            await _settled(store)
            capabilities = store._connection.capabilities
            assert capabilities is not None

            if "hybrid" in store._tiers:
                assert store._pick_tier(query_text="dark mode", query_vector=None) == "hybrid"
            elif store._tiers:
                assert store._pick_tier(query_text="dark mode", query_vector=None) != "hybrid", (
                    f"hybrid is not in {store._tiers} and a query resolved to it anyway"
                )
            else:
                with pytest.raises(StorageError) as caught:
                    store._pick_tier(query_text="dark mode", query_vector=None)
                assert str(capabilities.no_search_code) in str(caught.value), (
                    "a store with no tier has to refuse the query with the code the deployment gave for "
                    f"having no search process, and said: {caught.value}"
                )
        finally:
            await store.close()

    async def test_an_explicit_hybrid_store_gets_the_tier_or_an_error_and_never_a_substitute(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """``AT-185``: a named ``search_type`` has nothing to fall through to, on a real deployment.

        The unit tier asserts this against patched capabilities in both directions. Here the deployment
        supplies the direction, and the assertion is that there is no third outcome: the tier, or an
        error naming the deployment. A store left holding ``("vector",)`` after asking for ``"hybrid"``
        would answer semantically under a name that promises both, and nothing in the result says so.
        """
        store = _real_store(
            contract_uri,
            test_database_name,
            unique_collection_name,
            connection={"search_type": "hybrid"},
        )
        reference = _real_store(contract_uri, test_database_name, unique_collection_name)
        try:
            # Settled, not just initialized: `auto` does not wait for a build, so on a fresh collection its
            # tiers say what had finished, not what the deployment offers, while the explicit store waits.
            await _settled(reference)
            capabilities = reference._connection.capabilities
            assert capabilities is not None

            if "hybrid" in reference._tiers:
                await store.initialize()
                assert store._tiers == ("hybrid",), (
                    f"an explicit hybrid store has one tier by its own request: {store._tiers}"
                )
            elif capabilities.search:
                # Search, and something about this deployment still keeps the fusion from being built:
                # the stage is too old, or one of the two indexes it fuses would not come up. Fatal
                # either way, because a named tier has nothing to fall through to, and the message
                # carries the server's own reason rather than a guess at which of the two it was. On a
                # local Atlas container it is `voyage-4-lite not registered yet`, not the version.
                with pytest.raises(StorageError) as caught:
                    await store.initialize()
                assert "hybrid" in str(caught.value) or "index" in str(caught.value), (
                    f"the refusal has to say what could not be prepared: {caught.value}"
                )
                assert store._tiers == (), f"a store that raised has no tier, and this one is holding {store._tiers}"
            else:
                # No search process at all, and this is the branch CI takes. `initialize()` resolves an
                # empty set here without consulting the tier logic, deliberately and for every named
                # `search_type` alike: a store used for `add` and for filtered reads works on a
                # deployment that cannot search, and the refusal belongs at the query that needs a tier.
                await store.initialize()
                assert store._tiers == (), (
                    f"there is no search index to build here and this store built a tier set: {store._tiers}"
                )
                with pytest.raises(StorageError) as caught:
                    store._pick_tier(query_text="dark mode", query_vector=None)
                assert str(capabilities.no_search_code) in str(caught.value)
        finally:
            await reference.close()
            await store.close()


@pytest.mark.contract
class TestTheStageIsHereWhereTheProcessIsNot:
    """``AT-186`` -- why this deployment refuses hybrid, and not merely that it does.

    Two independent facts have to hold before a store offers fusion: ``mongod`` new enough for the
    ``$rankFusion`` stage, and a search process to build the two indexes the stage fuses. On the
    deployment CI runs this tier against, exactly one of them fails. A test that observed only "no hybrid
    here" would therefore pass just as happily on a deployment where the stage was missing, where the
    probe was broken, and where the resolution logic had been deleted, so the negative case of
    ``TestTheTierSetIsTheOneTheDeploymentImplies`` is only as strong as the reason behind it.

    On a single-node ``mongo:8`` replica set with ``modules: []`` the stage runs and returns fused
    documents, and ``search_support()`` on the same deployment answers ``available=False, code=31082``.
    The stage lives in ``mongod`` and it is there.

    The stage is run directly rather than through a store on purpose. ``initialize()`` skips the version
    probe where search is absent, so the package's own ``rank_fusion`` is ``False`` here by design, and
    what this class asks about is the deployment rather than the package.
    """

    async def test_this_deployment_can_run_rank_fusion_over_ordinary_pipelines(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str, contract_database: Any
    ) -> None:
        """``AT-186``: the stage, with two input pipelines that need no search index.

        ``$sort`` rather than ``$vectorSearch`` and ``$search``, which is what makes this runnable
        without mongot. The stage's own contract is the part being read: an input pipeline may be any
        pipeline, and the output is one ranking fused from the several.
        """
        build_info = await contract_database.command("buildInfo")
        if build_info["versionArray"][0] < _indexes.RANK_FUSION_MIN_MAJOR:
            pytest.skip(f"$rankFusion needs major {_indexes.RANK_FUSION_MIN_MAJOR}; this is {build_info['version']}")
        collection = contract_database[unique_collection_name]
        await collection.insert_many([{"_id": index, "up": index, "down": -index} for index in range(5)])

        cursor = await collection.aggregate(
            [
                {
                    "$rankFusion": {
                        "input": {
                            "pipelines": {
                                "ascending": [{"$sort": {"up": 1}}],
                                "descending": [{"$sort": {"down": 1}}],
                            }
                        }
                    }
                },
                {"$limit": 3},
            ]
        )
        fused = [document async for document in cursor]

        assert len(fused) == 3, f"the stage ran and returned {len(fused)} of 5 documents under a $limit of 3"
        assert {document["_id"] for document in fused} <= set(range(5)), (
            f"the stage returned documents this test did not write: {fused}"
        )

    async def test_the_hybrid_tier_is_refused_here_for_the_process_and_not_for_the_stage(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str, contract_database: Any
    ) -> None:
        """``AT-186``: the attribution, as the two answers disagreeing in the direction they should.

        Skips on a deployment that has search, where there is no refusal to attribute and the positive
        case of ``TestTheTierSetIsTheOneTheDeploymentImplies`` is the assertion instead.
        """
        store = _real_store(contract_uri, test_database_name, unique_collection_name)
        try:
            await store.initialize()
            capabilities = store._connection.capabilities
            assert capabilities is not None
            if capabilities.search:
                pytest.skip("this deployment has a search process, so it refuses nothing to attribute")

            stage_is_available = await _indexes.rank_fusion_support(contract_database[unique_collection_name])

            assert store._tiers == (), f"no search process means no search index and so no tier: {store._tiers}"
            assert stage_is_available is True, (
                "the deployment this tier runs against is expected to carry the stage, so that the "
                "absent search process is the only reason hybrid is unavailable. It answered False, "
                "which makes the tier-set test's negative case ambiguous rather than wrong"
            )
            assert capabilities.rank_fusion is False, (
                "the store must not have probed the version on a deployment where it cannot matter, "
                "even though the answer would have been True"
            )
        finally:
            await store.close()


@pytest.mark.contract
class TestTenStoresShareOneSetup:
    """AT-065's ``initialize()`` half — the client, the probe and the indexes.

    ``test_indexes.py`` covers the index half against ``_indexes.ensure`` directly, with no lock, because
    ten concurrent identical ``create_indexes`` calls produce zero failures and one index. What
    ``initialize()`` adds is two more counts that only exist once there is a store: one client for ten
    stores built from one config, and one capability probe rather than ten.

    The probe count is a spy, and it is the one assertion here that cannot be an outcome. The result of
    a probe is a boolean every store would compute identically, so a per-store probe is invisible in
    behavior and visible only as ten round trips on every process start.

    The ``$rankFusion`` probe is counted for the same reason and a stronger one: it is skipped entirely
    where search is unavailable, and this tier is the deployment where that is true of a real server
    rather than of a fake.
    """

    async def test_ten_stores_initializing_concurrently_share_one_client_probe_and_index_set(
        self,
        contract_uri: str,
        test_database_name: str,
        unique_collection_name: str,
        contract_database: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Ten distinct stores, one collection, one ``asyncio.gather``."""
        probed: list[str] = []
        real_probe = _indexes.search_support

        async def counting(collection: Any) -> _indexes.SearchSupport:
            probed.append(collection.name)
            return await real_probe(collection)

        monkeypatch.setattr(_indexes, "search_support", counting)

        fusion_probed: list[str] = []
        real_fusion = _indexes.rank_fusion_support

        async def counting_fusion(collection: Any) -> bool:
            fusion_probed.append(collection.name)
            return await real_fusion(collection)

        monkeypatch.setattr(_indexes, "rank_fusion_support", counting_fusion)
        stores = [
            _real_store(contract_uri, test_database_name, unique_collection_name, name=f"facts{index}")
            for index in range(10)
        ]
        try:
            results = await asyncio.gather(*(store.initialize() for store in stores), return_exceptions=True)

            assert [result for result in results if isinstance(result, BaseException)] == []
            assert len({id(store._connection.client) for store in stores}) == 1
            assert len(_client._REGISTRY) == 1
            assert probed == [unique_collection_name]
            assert len(await contract_database[unique_collection_name].index_information()) == 4

            # The fusion probe count, both halves, and which one applies is the deployment's to decide: MONGODB_URI
            # may name a bare `mongod` or a cluster with mongot, and the contract marker deliberately
            # accepts either. Ten stores must never mean ten `buildInfo` calls; zero is additionally
            # required where search is absent, because a tier list of two impossible entries cannot
            # contain the third and the probe is then a round trip bought for nothing.
            capabilities = stores[0]._connection.capabilities
            assert capabilities is not None
            assert len(set(fusion_probed)) <= 1, f"the fusion probe ran per store: {fusion_probed}"
            if not capabilities.search:
                assert fusion_probed == [], (
                    "a deployment with no search process cannot reach the hybrid tier, so asking it "
                    f"for its version is a round trip with no reader: {fusion_probed}"
                )
        finally:
            await stores[0].close()


# --- what the three vector metrics return, which is measurable on a container ------------------------
#
# The manual-vector path takes the caller's own vectors, so an index on any of the three metrics needs
# nothing from the deployment's embedding-model registry and a plain Atlas container can build all three.
# That is the same fact the tier-resolution tests above rely on, applied to scores, and it is why these
# tests are `contract` rather than `integration`.
#
# `MANUAL_VECTOR`, `_seed_vectors` and `_answered` are defined further down this module with the
# integration corpus they were written for; module-level names resolve when the test runs.

_METRIC_QUERY: Final[list[float]] = [1.0, 0.0, 0.0, 0.0]
"""The query for every metric test: the first axis, unit length, so a score is readable off a vector."""

_METRIC_CORPUS: Final[dict[str, list[float]]] = {
    "on the axis, a tenth of the way out": [0.1, 0.0, 0.0, 0.0],
    "half a unit, off the axis": [0.3, 0.4, 0.0, 0.0],
    "the same direction as the last one, ten times as long": [3.0, 4.0, 0.0, 0.0],
    "unit length, spread over every dimension": [0.5, 0.5, 0.5, 0.5],
    "square to the query, in a dimension of its own": [0.0, 0.0, 1.0, 0.0],
    "off to one side and behind": [-0.6, 0.8, 0.0, 0.0],
}
"""Six vectors chosen so that the three metrics disagree, which is the point of them.

Lengths differ deliberately. ``cosine`` normalises, so the second and third are *tied* under it; the
third is first under ``dotProduct``, which does not normalise; and it is **last** under ``euclidean``,
because a vector ten times too long is ten times too far away. One corpus, one query, three orders.

Each metric has a unique nearest and a unique furthest document here, and the first metric test computes
both rather than naming them, so a tie can never make that assertion vacuous.
"""


def _metric_similarity(metric: str, vector: list[float]) -> float:
    """Return this metric's own notion of nearness, higher being nearer.

    Not the score. The score is what the server computes *from* this, and keeping the two apart is what
    lets one test assert the direction without also asserting the formula.

    Args:
        metric: ``"cosine"``, ``"dotProduct"`` or ``"euclidean"``.
        vector: The stored vector, against :data:`_METRIC_QUERY`.

    Returns:
        Cosine similarity, dot product, or the negated squared distance -- negated so that higher is
        nearer on all three and one comparison reads the same way for each.
    """
    dot = sum(left * right for left, right in zip(vector, _METRIC_QUERY, strict=True))
    if metric == "cosine":
        lengths = math.sqrt(sum(value * value for value in vector)) * math.sqrt(
            sum(value * value for value in _METRIC_QUERY)
        )
        return dot / lengths
    if metric == "dotProduct":
        return dot
    return -sum((left - right) ** 2 for left, right in zip(vector, _METRIC_QUERY, strict=True))


def _metric_score(metric: str, vector: list[float]) -> float:
    """Return the score this deployment was measured to compute for one vector on one metric.

    Measured on ``mongodb/mongodb-atlas-local:8``: ``(1 + cosine) / 2``, ``(1 + dot) / 2``, and
    ``1 / (1 + squared distance)``. Written as arithmetic rather than as a table of expected numbers so
    that the corpus above can change without a transcription step.

    All three are similarities, and the third is the interesting one: ``euclidean`` is a distance metric
    and the server has already inverted it. This package has no distance to invert and must not invert
    the similarity it does get.

    Args:
        metric: ``"cosine"``, ``"dotProduct"`` or ``"euclidean"``.
        vector: The stored vector, against :data:`_METRIC_QUERY`.

    Returns:
        The expected ``vectorSearchScore``.
    """
    similarity = _metric_similarity(metric, vector)
    if metric == "euclidean":
        return 1 / (1 - similarity)
    return (1 + similarity) / 2


async def _seeded_metric_store(metric: str, uri: str, database: str, collection: str) -> MongoDBMemoryStore:
    """Build a manual-vector store on one metric, seed :data:`_METRIC_CORPUS`, and hand it back open.

    Skips where the deployment has no search process, which is one of the two legs this tier runs on:
    there is no vector index there and so no score to read, and ``TestTheTierSetIsTheOneTheDeploymentImplies``
    asserts the consequence for tier resolution.

    Args:
        metric: The ``similarity`` to build the index on.
        uri: Connection string for the deployment.
        database: This session's throwaway database.
        collection: This test's own collection.

    Returns:
        The initialized store, with the corpus written. **The caller closes it.**
    """
    store = _real_store(
        uri,
        database,
        collection,
        scope="tenant-a",
        connection={**MANUAL_VECTOR, "similarity": metric, "search_type": "vector"},
    )
    try:
        await store.initialize()
        capabilities = store._connection.capabilities
        assert capabilities is not None
        if not capabilities.search:
            pytest.skip("this deployment has no search process, so no vector index and no score to read")
        await _seed_vectors(store._collection(), scope="tenant-a", store_name="facts", facts=_METRIC_CORPUS)
    except BaseException:
        # `pytest.skip` raises, and a store left open on a skip leaks a client into the next test.
        await store.close()
        raise
    return store


async def _metric_scores(store: MongoDBMemoryStore) -> list[tuple[str, float]]:
    """Query the vector tier and return content with its score, in the order the server returned them.

    Args:
        store: A store from :func:`_seeded_metric_store`.

    Returns:
        One pair per document in :data:`_METRIC_CORPUS`, server order preserved.
    """
    results = await _answered(store, {"vector": _METRIC_QUERY, "limit": 10}, expected=len(_METRIC_CORPUS))
    return [(entry.content, float(_metadata(entry)["_relevance_score"])) for entry in results]


@pytest.mark.contract
class TestEveryMetricReturnsASimilarityAndNeverADistance:
    """``AT-188`` -- every vector metric scores as a similarity, measured on a real index.

    Results are similarity-ordered, with ``score`` populated and decreasing, and no distance reaches the
    caller. Atlas returns a similarity for all three metrics, so there is nothing left for this package
    to invert, and this class observes that on ``cosine``, ``dotProduct`` and ``euclidean`` indexes
    rather than taking it from documentation.

    The direction is the claim a caller depends on and it is asserted per metric, because a score that
    *was* a distance would order results the other way and ``min_score``, a floor on the reported
    number, would then keep the worst matches and drop the best, with no error on either side.
    """

    @pytest.mark.parametrize("metric", ["cosine", "dotProduct", "euclidean"])
    async def test_the_nearest_vector_scores_highest_and_the_furthest_lowest(
        self, metric: str, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """``AT-188`` -- the direction, from the corpus rather than from a written-down order.

        Three assertions and they are not the same one: that the server's order is descending by score,
        that reading the *metric's* own nearness along that order never rises, and that the ends are the
        documents the corpus computes as nearest and furthest. A raw distance in the score field passes
        none of the three, and an accidental ``sorted()`` in this package passes only the first.
        """
        store = await _seeded_metric_store(metric, contract_uri, test_database_name, unique_collection_name)
        try:
            measured = await _metric_scores(store)

            assert len(measured) == len(_METRIC_CORPUS), f"the corpus did not all arrive: {measured}"
            scores = [score for _, score in measured]
            assert scores == sorted(scores, reverse=True), f"{metric} results are not ordered by score: {measured}"
            assert all(score > 0.0 for score in scores), (
                f"a score of zero on {metric} is what an unprojected `$meta` reads as, so it cannot be "
                f"told from a document that scored nothing: {measured}"
            )

            nearness = [_metric_similarity(metric, _METRIC_CORPUS[content]) for content, _ in measured]
            assert nearness == sorted(nearness, reverse=True), (
                f"the score falls down this list while {metric} nearness does not, which is what a "
                f"distance in the score field looks like: {list(zip(measured, nearness, strict=True))}"
            )
            nearest = max(_METRIC_CORPUS, key=lambda content: _metric_similarity(metric, _METRIC_CORPUS[content]))
            furthest = min(_METRIC_CORPUS, key=lambda content: _metric_similarity(metric, _METRIC_CORPUS[content]))
            assert measured[0][0] == nearest, f"{metric}'s nearest vector is not first: {measured}"
            assert measured[-1][0] == furthest, f"{metric}'s furthest vector is not last: {measured}"
        finally:
            await store.close()

    @pytest.mark.parametrize("metric", ["cosine", "dotProduct", "euclidean"])
    async def test_the_score_is_the_number_this_deployments_formula_predicts(
        self, metric: str, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """``AT-188`` -- the formula, recomputed from the vectors rather than read off a table.

        The tolerance is relative and loose enough for ``float32``, which is the precision a vector field
        has: the worst disagreement measured over eighteen scores was ``2.4e-08``. A formula that changes
        in a future mongot fails here, which is the arrangement ``MAX_NUM_CANDIDATES`` already has in
        ``test_pipeline.py``'s ``TestTheBoundsThisPackageCopiesFromTheServer``.
        """
        store = await _seeded_metric_store(metric, contract_uri, test_database_name, unique_collection_name)
        try:
            measured = await _metric_scores(store)

            for content, score in measured:
                expected = _metric_score(metric, _METRIC_CORPUS[content])
                assert math.isclose(score, expected, rel_tol=1e-6), (
                    f"{metric} scored {content!r} at {score!r}, and the formula measured on this image "
                    f"predicts {expected!r}"
                )
        finally:
            await store.close()

    async def test_the_reported_score_is_the_one_the_server_projected(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """``AT-188`` -- the passthrough, against a pipeline this package did not build.

        ``euclidean`` on purpose: it is the metric whose name invites a normalisation, and a package that
        rescaled anything would rescale this one. The comparison pipeline is written out here rather than
        taken from ``_pipeline``, because a passthrough claim checked against the same builder the package
        uses would agree with itself.
        """
        store = await _seeded_metric_store("euclidean", contract_uri, test_database_name, unique_collection_name)
        try:
            reported = dict(await _metric_scores(store))
            cursor = await store._collection().aggregate(
                [
                    {
                        "$vectorSearch": {
                            "index": store._index_names["vector"],
                            "path": _indexes.VECTOR_FIELD,
                            "queryVector": _METRIC_QUERY,
                            "numCandidates": 100,
                            "limit": len(_METRIC_CORPUS),
                        }
                    },
                    {"$set": {"projected": {"$meta": _pipeline.VECTOR_SCORE_META}}},
                    {"$project": {_indexes.CONTENT_FIELD: 1, "projected": 1, "_id": 0}},
                ]
            )
            projected = {
                str(document[_indexes.CONTENT_FIELD]): float(document["projected"]) async for document in cursor
            }

            assert projected, "the comparison pipeline returned nothing, so it is asserting nothing"
            assert reported == projected, (
                "the score this package reports is not the score the server projected, so something "
                f"between the two is rescaling it: reported {reported}, projected {projected}"
            )
        finally:
            await store.close()

    async def test_a_dot_product_score_is_not_bounded_above_by_one(
        self, contract_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """``AT-188`` -- the range a cosine-sized ``max_score`` would cut into, measured rather than warned about.

        Four places in this repository say a cosine score lands in roughly 0 to 1, and all four are about
        cosine. ``dotProduct`` is ``(1 + dot) / 2`` with no normalisation of its own, so a stored vector
        longer than the query's scores above one: ``2.0`` for the corpus vector five times too long.
        A ``max_score`` ceiling carried over from the cosine range is therefore a filter that removes the
        strongest matches on such a store, silently, which is worth one test rather than one sentence.
        """
        store = await _seeded_metric_store("dotProduct", contract_uri, test_database_name, unique_collection_name)
        try:
            measured = await _metric_scores(store)

            above_one = [(content, score) for content, score in measured if score > 1.0]
            assert above_one, (
                "no dotProduct score in this corpus exceeded 1.0, so either the corpus lost its "
                f"over-long vector or the server now normalises: {measured}"
            )
            assert measured[0][1] == max(score for _, score in measured), "the ordering test's premise broke here"
        finally:
            await store.close()


# --- integration tier: mongot, because no search tier runs without it ---------------------------------

MANUAL_VECTOR: dict[str, Any] = {"embedding_dimensions": 4, "similarity": "cosine"}
"""Connection keys selecting the manual-vector path, matching ``test_pipeline.py``'s corpus width.

Four dimensions rather than a realistic 1024, because nothing here measures embedding quality and a
hand-written vector is the only kind whose expected neighbour is computable by reading it.
"""

QUERY_VECTOR: list[float] = [1.0, 0.0, 0.0, 0.0]
"""The query for every vector-tier test, aligned with the seeded vectors on the first axis."""

QUERY_TEXT = "dark mode"
"""The query for every text-tier test. Present in every seeded document, so ranking is not the claim."""


def _metadata(entry: MemoryEntry) -> dict[str, Any]:
    """Return an entry's metadata, failing the test if it has none.

    ``MemoryEntry.metadata`` is ``Metadata | None`` because the SDK allows a store to omit it, and this
    package never does. Asserting that once here keeps every caller reading as the claim
    it is making rather than as a chain of optional-narrowing, and mypy checks these tests
    (``pyproject.toml`` ``files``), so the narrowing is not optional.

    Args:
        entry: The entry to read.

    Returns:
        The entry's metadata.
    """
    assert entry.metadata is not None, f"every entry carries metadata; {entry.content!r} has none"
    return dict(entry.metadata)


_SEARCHABLE_BUDGET: Final[float] = 180.0
"""How long a write is waited on before it counts as never having arrived.

A document is not searchable the instant its write returns. On an Atlas cluster with a registered
embedding model, a document written after both search indexes read ``READY`` takes tens of seconds to
answer a query, and the lag stretches further while a run is driving several dozen search indexes
through creation and initial sync on one cluster. An Atlas CLI local deployment, where the shipped
default degrades to full text, answers in under a second, so a budget sized there fails on a cluster
with an empty result rather than a wrong one.

A budget is not a delay: every caller below polls twice a second and returns as soon as its premise is
satisfied, so a quiet cluster is not slowed by the allowance.
"""


async def _answered(
    store: MongoDBMemoryStore, query: Any, *, expected: int = 1, budget: float = _SEARCHABLE_BUDGET
) -> list[Any]:
    """Search until mongot has the corpus, or give up and return the last short result.

    Same reason as ``test_pipeline.py``'s ``_until_answered``: ``READY`` means the index exists, not
    that every document has reached it, so a query issued straight after ``initialize()`` can
    legitimately return nothing. On the AutoEmbeddings path there is a second wait behind the first,
    because Atlas generates the embedding after the write acknowledges. Polling rather
    than sleeping a fixed interval, because the wait is a property of the deployment.

    ``expected`` is what makes this wait for *the corpus* rather than for the first document to arrive.
    Documents reach mongot one at a time, so a caller whose premise is two documents and who waits only
    for non-empty gets the first one and a failure that reads as a wrong result rather than as a race,
    such as a two-document corpus assertion seeing one of two.

    Returning the short list rather than failing here keeps the failure at the assertion that cares,
    where the message names what the test expected instead of naming this helper.

    Args:
        store: The store to query.
        query: A string or a ``MongoDBSearchQuery``.
        expected: How many results the caller's premise needs. Never an upper bound: a test asserting
            that a scope predicate *excludes* something has to keep this at 1 and assert the count
            itself, or the wait would hide the extra document it is looking for.
        budget: Seconds to keep asking before giving up, polling twice a second.

    Returns:
        The first result list holding at least ``expected`` entries, or the last shorter one.
    """
    results: list[Any] = []
    deadline = time.monotonic() + budget
    while True:
        try:
            results = list(await store.search(query))
        except StorageError as error:
            # A skip, not a failure, when mongot is unreachable. Around the search call alone, and only
            # for the one code that means mongot never answered. Every caller below reaches search through
            # this helper, so this is the whole of the memory store's exposure; anything that fails
            # elsewhere still fails.
            skip_if_search_is_unreachable(error)
            raise
        if len(results) >= expected or time.monotonic() >= deadline:
            return results
        await asyncio.sleep(0.5)


async def _seed_vectors(collection: Any, *, scope: str, store_name: str, facts: dict[str, list[float]]) -> None:
    """Write vector-bearing documents directly, bypassing ``add``.

    Out of band on purpose: ``add`` takes content and metadata and no vector, the manual path indexes
    an ``embedding`` field, and this package does not embed on the client, so no ``MemoryStore`` method
    can put a vector in a document. The read path under test here is the manual-vector query path,
    which ``test_pipeline.py`` already exercises one layer down. Writing these with ``insert_many``
    follows ``test_pipeline.py``'s integration corpus rather than inventing a write API to make the test
    look tidier.

    The document shape is the one ``add`` writes, including the fields the scope pre-filter reads. A
    missing ``scope`` or ``store_name`` here would make ``TestNoSearchCrossesAScope`` pass by returning
    nothing.

    Args:
        collection: Collection to write to.
        scope: Value for the ``scope`` field.
        store_name: Value for the ``store_name`` field.
        facts: Content mapped to the embedding to store with it.
    """
    now = datetime.datetime.now(datetime.timezone.utc)
    await collection.insert_many(
        [
            {
                _indexes.CONTENT_FIELD: content,
                _indexes.VECTOR_FIELD: vector,
                "scope": scope,
                "store_name": store_name,
                "content_hash": hashlib.sha256(content.encode()).hexdigest(),
                "created_at": now,
            }
            for content, vector in facts.items()
        ]
    )


@pytest.fixture
async def atlas_store(atlas_uri: str, test_database_name: str, unique_collection_name: str) -> Any:
    """A writable store scoped to ``tenant-a`` on a deployment with mongot, on the shipped default.

    Default means the AutoEmbeddings path and ``search_type="auto"``, which is what a user who
    configures nothing gets. On an Atlas CLI local deployment that path cannot build its index, because
    no embedding model is registered, so this fixture is also the degraded-default fixture, and
    ``TestTheShippedDefaultAgainstADeploymentWithNoModel`` is the class that says so out loud.
    """
    store = _real_store(atlas_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-a")
    try:
        yield store
    finally:
        await store.close()


@pytest.mark.integration
class TestWhatASearchHandsBack:
    """AT-040 — the ``MemoryEntry`` a search hands back to the SDK.

    The whole round trip on one surface: ``add`` writes, mongot indexes, ``search`` reads, and what
    comes back is what the SDK's ``MemoryManager`` and ``search_memory`` tool will format. Every layer
    below this has its own test and none of them can see a ``MemoryEntry``.

    Queried with a plain string rather than a ``MongoDBSearchQuery``, because both SDK call sites pass a
    ``str``, so the string form is the production path and the
    widened form is the extension.
    """

    async def test_a_search_returns_memory_entries_carrying_the_four_reserved_keys(
        self, atlas_store: MongoDBMemoryStore
    ) -> None:
        """AT-040. Caller metadata survives beside the reserved keys, under them on collision."""
        await atlas_store.add("the user prefers dark mode", metadata={"source": "chat"})
        results = await _answered(atlas_store, QUERY_TEXT)

        assert results, f"the corpus never became searchable within {_SEARCHABLE_BUDGET:.0f} seconds"
        entry = results[0]
        assert isinstance(entry, MemoryEntry)
        assert entry.content == "the user prefers dark mode"
        assert entry.store_name == "facts"
        metadata = _metadata(entry)
        # Named individually rather than as a set comparison, so a failure says which key is missing
        # instead of printing two sets for the reader to diff.
        assert metadata["_id"]
        assert metadata["_scope"] == "tenant-a"
        # Every tier that can resolve. The claim is that the key carries the tier that ran; which one that
        # is depends on the deployment, and `auto` prefers fusion wherever both single tiers came up.
        assert metadata["_search_type"] in {"vector", "text", "hybrid"}
        assert isinstance(metadata["_relevance_score"], float)
        assert metadata["source"] == "chat"

    async def test_every_reserved_key_is_present_on_every_entry(self, atlas_store: MongoDBMemoryStore) -> None:
        """AT-040, over more than one result.

        The test above reads ``results[0]``, which an implementation stamping the keys onto the first
        entry alone would satisfy. Three facts, all matching, all checked.
        """
        for fact in ("dark mode is preferred", "dark mode at night", "dark mode everywhere"):
            await atlas_store.add(fact)
        results = await _answered(atlas_store, QUERY_TEXT, expected=3)

        assert len(results) == 3, f"expected all three facts back, got {[entry.content for entry in results]}"
        for entry in results:
            assert RESERVED_METADATA_KEYS <= set(_metadata(entry))


@pytest.mark.integration
class TestTheFirstSearchSetsItselfUp:
    """AT-045b — the read half of "``initialize()`` is not the caller's responsibility".

    ``TestWritesStayInTheirScope`` covers the write half on the contract tier, incidentally rather than
    by design: its second store is never initialized and its ``add`` lands anyway.
    ``TestInitializeIsIdempotent`` is the idempotency claim and calls ``initialize()`` explicitly, so it
    is not that half. This half is the one that needs
    mongot, because a search index that does not exist is a query failure rather than a slow write.

    Worth its own class because the lazy path and the eager path differ in exactly one way that
    matters: on the lazy path the index is created *inside* the call the user is awaiting, so if
    ``initialize`` did not wait for ``READY`` the first search would return nothing and look like an
    empty memory rather than a race.
    """

    async def test_searching_a_store_nobody_initialized_returns_results(
        self, atlas_store: MongoDBMemoryStore, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-045b. No ``initialize()`` call anywhere in this test, and no ``add`` before the write."""
        await atlas_store.add("the user prefers dark mode")
        results = await _answered(atlas_store, QUERY_TEXT)

        assert [entry.content for entry in results] == ["the user prefers dark mode"]
        names = [index["name"] async for index in await atlas_database[unique_collection_name].list_search_indexes()]
        assert names, "a search answered, so a search index has to exist"


@pytest.mark.integration
class TestConcurrentFirstSearchesShareOneWait:
    """AT-242 against a real build: searches that arrive together on a fresh store wait for it once.

    The shared wait only shows its behaviour against an index that is actually building, which no fake
    reproduces: every search must answer, and each tier's index is waited on by one call, not one per
    search.
    """

    async def test_they_all_answer_and_each_index_is_waited_on_once(
        self, atlas_store: MongoDBMemoryStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        await atlas_store.add("the user prefers dark mode")
        assert atlas_store._tiers == (), "a fresh store's indexes are still building after initialize()"
        ensure = _indexes.ensure
        waited: list[str] = []

        async def counting(collection: Any, **kwargs: Any) -> None:
            if kwargs.get("timeout") and kwargs.get("search"):
                waited.append(kwargs["search"][0].name)
            await ensure(collection, **kwargs)

        monkeypatch.setattr(_indexes, "ensure", counting)

        results = await asyncio.gather(*(atlas_store.search(QUERY_TEXT) for _ in range(5)))
        assert sorted(waited) == sorted(spec.name for _, spec in atlas_store._specs)

        # `READY` does not mean mongot has the document yet, so the batch repeats until it does.
        deadline = time.monotonic() + _SEARCHABLE_BUDGET
        while not all(results) and time.monotonic() < deadline:
            await asyncio.sleep(0.5)
            results = await asyncio.gather(*(atlas_store.search(QUERY_TEXT) for _ in range(5)))

        assert [[entry.content for entry in found] for found in results] == [["the user prefers dark mode"]] * 5
        assert len(waited) == len(atlas_store._specs), "searches after the first batch do not wait again"


@pytest.mark.integration
class TestNoSearchCrossesAScope:
    """AT-047a — no search crosses a scope, run once per search tier.

    The two tiers enforce scope by different mechanisms, and the tier is chosen by config rather than by
    test infrastructure, so both halves live here. Text uses a ``$match`` after ``$search``, which sees
    every document mongot returned and drops the wrong ones. Vector uses a ``filter`` inside
    ``$vectorSearch``, which is evaluated by mongot against the indexed filter fields before scoring.
    Only the second is what the shipped default resolves to on a cluster with a registered model, so
    testing one and inferring the other would leave production's mechanism unexercised.

    Both halves are adversarial in the same way: the other scope's document matches the query at least
    as well as this scope's. A corpus where the excluded document would not have been returned anyway
    tests nothing.
    """

    async def test_the_text_tier_never_returns_another_scopes_document(
        self, atlas_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """AT-047a, text tier. Two stores, one collection, the same fact in both, one result each.

        The tier is pinned rather than left at ``auto``, and that is the whole point of this half. On a
        deployment with no registered model ``auto`` degrades to text; on a cluster that has one it
        resolves to ``vector``, and an unpinned test would exercise the pre-filter twice and the
        ``$match`` mechanism never.
        """
        stores = [
            _real_store(
                atlas_uri,
                test_database_name,
                unique_collection_name,
                writable=True,
                scope=scope,
                connection={"search_type": "text"},
            )
            for scope in ("tenant-a", "tenant-b")
        ]
        try:
            await stores[0].add("dark mode for tenant a")
            await stores[1].add("dark mode for tenant b")

            for store, expected in ((stores[0], "dark mode for tenant a"), (stores[1], "dark mode for tenant b")):
                results = await _answered(store, QUERY_TEXT)
                assert [entry.content for entry in results] == [expected]
                assert {_metadata(entry)["_scope"] for entry in results} == {store.scope}
        finally:
            for store in stores:
                await store.close()

    async def test_the_vector_tier_never_returns_another_scopes_document(
        self, atlas_uri: str, atlas_database: Any, test_database_name: str, unique_collection_name: str
    ) -> None:
        """AT-047a, vector tier, where the predicate is a pre-filter rather than a later ``$match``.

        The vectors are seeded rather than added, for the reason in :func:`_seed_vectors`.
        ``tenant-b``'s vector is *closer* to the query than ``tenant-a``'s, so relevance alone would
        rank it first and a broken pre-filter shows up as the wrong document rather than as an empty
        result.
        """
        collection = atlas_database[unique_collection_name]
        await _seed_vectors(
            collection, scope="tenant-a", store_name="facts", facts={"dark mode for tenant a": [0.9, 0.1, 0.0, 0.0]}
        )
        await _seed_vectors(
            collection, scope="tenant-b", store_name="facts", facts={"dark mode for tenant b": QUERY_VECTOR}
        )
        store = _real_store(
            atlas_uri,
            test_database_name,
            unique_collection_name,
            scope="tenant-a",
            connection={**MANUAL_VECTOR, "search_type": "vector"},
        )
        try:
            results = await _answered(store, {"vector": QUERY_VECTOR, "limit": 10})
            assert [entry.content for entry in results] == ["dark mode for tenant a"]
            assert _metadata(results[0])["_search_type"] == "vector"
        finally:
            await store.close()


#: The hybrid corpus, shaped so that reciprocal rank fusion has something to say.
#:
#: Four documents, because three cannot produce the result this test is about. Reciprocal rank fusion
#: with the penalty at 60 is a sum of ``1/(60 + rank)``, and ``1/x`` is convex, so a document ranked
#: first and third beats one ranked second twice: ``1/61 + 1/63 = 0.03227`` against ``2/62 = 0.03226``.
#: The middle document only wins once the extremes are spread further than that, which takes a fourth
#: rank: ``1/61 + 1/64 = 0.03202``. This is the arithmetic the README's RRF passage describes, and the
#: reason the corpus is the size it is rather than the smallest one that runs.
#:
#: The vectors set the vector ranks exactly, since cosine against ``QUERY_VECTOR`` is readable off the
#: first component. The text ranks are BM25's and are *not* predicted here; the test measures them.
#: They are, however, what the *arrangement* is built around. A vector rank in descending keyword
#: density is roughly the order BM25 produces too, and two tiers that agree cannot demonstrate fusion:
#: the fused winner would simply be the vector tier's own winner.
#:
#: So the tiers are deliberately opposed, which is also the case hybrid search exists for. The
#: paraphrase carries the query vector exactly and none of the query's words, so it leads the vector
#: tier and the text tier never returns it at all. The keyword-stuffed line is the reverse: BM25's
#: winner, and last by cosine. Neither can win the fusion, since each scores from one tier only, and the
#: document ranked second by both takes it, which is the property ``TestFusionRanksWhatNeitherTierRanksFirst``
#: asserts.
_FUSION_CORPUS: Final[dict[str, list[float]]] = {
    "the user prefers a dim interface at night": [1.0, 0.0, 0.0, 0.0],
    "dark mode": [0.9, 0.44, 0.0, 0.0],
    "dark mode is the setting the user prefers": [0.7, 0.71, 0.0, 0.0],
    "dark mode dark mode dark mode, in dark mode": [0.2, 0.98, 0.0, 0.0],
}

_FUSION_TEXT_MATCHES: Final[int] = sum(1 for content in _FUSION_CORPUS if QUERY_TEXT in content)
"""How many of :data:`_FUSION_CORPUS` the text tier can return, which is not all of them.

The paraphrase holds neither of ``QUERY_TEXT``'s terms, so ``$search`` does not match it and no amount
of waiting will produce a fourth text result. ``_answered`` polls until its ``expected`` arrives or the
budget runs out, so passing the corpus size here would spend the whole budget on every run, on a
premise that cannot become true, and then assert against the same three documents anyway.
"""


def _fuse(*orders: list[str]) -> list[str]:
    """Rank documents the way ``$rankFusion`` does, from orders measured on the deployment.

    The expected result is computed rather than written down, because writing it down would mean
    predicting BM25's ordering of four short strings on a version of mongot this test does not pin.
    What the test actually claims is narrower and more useful: *given* what each tier returned, the
    fused order is reciprocal rank fusion of exactly those two orders, with equal weights and the
    penalty this package documents.

    A document a tier did not return scores zero from that tier, which is the server's behaviour and
    the reason a fused query can surface something one tier missed entirely.

    Args:
        *orders: One ranked list of contents per tier, best first.

    Returns:
        Every content seen, ordered by fused score, best first.
    """
    penalty = _pipeline.RANK_FUSION_PENALTY
    scores: dict[str, float] = {}
    for order in orders:
        for rank, content in enumerate(order, start=1):
            scores[content] = scores.get(content, 0.0) + 1 / (penalty + rank)
    return sorted(scores, key=lambda content: (-scores[content], content))


@pytest.mark.integration
class TestFusionRanksWhatNeitherTierRanksFirst:
    """AT-143 -- real ``mongot`` scoring for the fourth tier.

    The unit tests assert that this package builds one ``$rankFusion`` with two named input pipelines.
    They cannot assert that the server fuses, because the stage is the server's. This is the test that
    crosses that boundary, and the claim it makes is the one a caller cares about: a hybrid search
    returns an order that *neither* underlying tier returns, and returns it on the fused scale.

    Three stores over one collection, differing only in ``search_type``, so the two single-tier orders
    are measured from the same deployment, the same corpus and the same query as the fused one. Then
    the fused order is checked against :func:`_fuse` of those two. Predicting BM25's ordering instead
    would have made this a test of mongot's scoring rather than of this package's fusion.

    Skips rather than fails below MongoDB 8.0: ``$rankFusion`` is not there, ``initialize()`` says so
    by design, and a deployment lacking a server feature is the marker's problem and not this test's.
    """

    async def test_the_fused_order_is_rrf_of_the_two_tiers_it_composed(
        self, atlas_uri: str, test_database_name: str, unique_collection_name: str, atlas_database: Any
    ) -> None:
        """AT-143: the fused order, the winner neither tier picked, and the scale it arrives on."""
        await _seed_vectors(
            atlas_database[unique_collection_name], scope="tenant-a", store_name="facts", facts=_FUSION_CORPUS
        )
        stores = {
            tier: _real_store(
                atlas_uri,
                test_database_name,
                unique_collection_name,
                scope="tenant-a",
                connection={**MANUAL_VECTOR, "search_type": tier},
            )
            for tier in ("vector", "text", "hybrid")
        }
        try:
            try:
                await stores["hybrid"].initialize()
            except StorageError as error:
                # The whole sentence, not the version inside it: every deployment this suite runs
                # against reports a version beginning "8.0", so a substring test on that turns any
                # unrelated failure naming the server build into a silent skip.
                if "needs MongoDB 8.0 or later" in str(error):
                    pytest.skip(f"MONGODB_ATLAS_URI names a deployment without $rankFusion: {error}")
                raise

            size = len(_FUSION_CORPUS)
            by_vector = await _answered(stores["vector"], {"vector": QUERY_VECTOR, "limit": size}, expected=size)
            by_text = await _answered(
                stores["text"], {"text": QUERY_TEXT, "limit": size}, expected=_FUSION_TEXT_MATCHES
            )
            fused = await _answered(
                stores["hybrid"], {"text": QUERY_TEXT, "vector": QUERY_VECTOR, "limit": size}, expected=size
            )

            vector_order = [entry.content for entry in by_vector]
            text_order = [entry.content for entry in by_text]
            fused_order = [entry.content for entry in fused]

            assert _metadata(fused[0])["_search_type"] == "hybrid"
            assert fused_order == _fuse(vector_order, text_order), (
                f"fused {fused_order} is not RRF of vector {vector_order} and text {text_order}"
            )

            # The point of the tier, asserted as the property rather than as a named document: if the
            # fused winner were always one of the two tiers' winners, fusion would be a preference
            # between tiers and not a combination of them.
            assert fused_order[0] not in (vector_order[0], text_order[0]), (
                "the corpus stopped exercising fusion: its winner is a tier winner, so this run would "
                f"pass against a pipeline that just picked a tier. vector {vector_order}, text {text_order}"
            )

            # The fused scale, measured rather than asserted from the pipeline shape: a cosine score
            # would be near 1 and would clear any bound a caller carried over from the vector tier. The
            # fused ceiling is two reciprocal ranks, which is why `auto` declines fusion when a bound is
            # set.
            best = 2 / (_pipeline.RANK_FUSION_PENALTY + 1)
            score = _metadata(fused[0])["_relevance_score"]
            assert 0 < score <= best, f"a fused score cannot exceed {best}, and this one is {score}"
        finally:
            for store in stores.values():
                await store.close()


@pytest.mark.integration
class TestTheSentinelScopeIsAScopeLikeAnyOther:
    """AT-048b — the read half of the unscoped store's isolation.

    ``TestTheStoreStampsTheScopeItself`` proves the sentinel is *written*. This proves it is also
    *filtered on*, which is the half that matters: a store with no ``scope`` configured is the shape a
    single-tenant application has, and the two failures available to it are opposite. Filtering on
    nothing returns every tenant's documents. Filtering on ``None`` returns nothing, because no document
    carries ``None``. The sentinel exists so that neither is reachable, and only a query can tell them
    apart.
    """

    async def test_an_unscoped_store_reads_the_sentinel_scope_and_nothing_else(
        self, atlas_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        """AT-048b. One unscoped store, one scoped store, one collection, one result each."""
        unscoped = _real_store(atlas_uri, test_database_name, unique_collection_name, writable=True)
        scoped = _real_store(atlas_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-b")
        try:
            await unscoped.add("dark mode with no tenant")
            await scoped.add("dark mode for tenant b")

            results = await _answered(unscoped, QUERY_TEXT)
            assert [entry.content for entry in results] == ["dark mode with no tenant"]
            assert _metadata(results[0])["_scope"] == UNSCOPED
            assert [entry.content for entry in await _answered(scoped, QUERY_TEXT)] == ["dark mode for tenant b"]
        finally:
            await unscoped.close()
            await scoped.close()


@pytest.mark.integration
class TestTheShippedDefaultAgainstADeploymentWithNoModel:
    """AT-053b — the degradation the package's own default runs into, on purpose.

    Not a contrived config. ``embedding_model`` unset means AutoEmbeddings with the default model, and
    an Atlas CLI local deployment registers no models at all, so ``createSearchIndexes`` for the vector
    half fails with code 8 while the full-text half builds normally. That is the configuration every
    developer running this suite locally has, which is what makes the behavior worth pinning: if
    ``initialize()`` raised here, the package would be unusable on the only Atlas-like deployment that
    runs on a laptop, and if it stayed silent the first sign of trouble would be results that are
    lexical when the caller expected semantic.

    So it warns, and the warning carries the server's own message rather than a paraphrase, because the
    list of registered models is the one piece of information that tells the reader what to fix. This
    also skips rather than fails on a deployment that *does* have a model, for the same reason
    :func:`_require_no_search_support` does on the contract tier: the marker cannot express it.
    """

    async def test_initialize_warns_with_the_servers_message_and_does_not_raise(
        self, atlas_store: MongoDBMemoryStore, caplog: pytest.LogCaptureFixture
    ) -> None:
        """AT-053b, the write-side half: a partial index set is a warning, not a failure."""
        with caplog.at_level(logging.WARNING, logger="strands_mongodb"):
            await atlas_store.initialize()

        warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
        if not warnings:
            pytest.skip(
                "MONGODB_ATLAS_URI names a deployment with a registered embedding model, so this case cannot arise"
            )
        message = " ".join(record.getMessage() for record in warnings)
        assert "vector" in message.lower(), "the warning has to say which half of the index set is missing"
        # The server's phrasing, not ours. Measured on mongot 8.3.8 as `voyage-4-lite is not registered`.
        assert "regist" in message.lower(), f"the server's own reason has to survive into the log: {message!r}"

    async def test_search_answers_from_the_text_tier_when_the_vector_index_is_absent(
        self, atlas_store: MongoDBMemoryStore
    ) -> None:
        """AT-053b, the read-side half. ``auto`` means "whichever tier can answer", and one can."""
        await atlas_store.add("the user prefers dark mode")
        results = await _answered(atlas_store, QUERY_TEXT)

        assert [entry.content for entry in results] == ["the user prefers dark mode"]
        # `hybrid` beside `vector`, because this guard is detecting one thing: whether the vector half of
        # the index set came up. Both answers mean it did: `auto` resolves to fusion only where both
        # single tiers exist, so on a deployment with a registered model and `$rankFusion` the tier that
        # runs is `hybrid`, and without the stage it is `vector`.
        if _metadata(results[0])["_search_type"] in {"vector", "hybrid"}:
            pytest.skip(
                "MONGODB_ATLAS_URI names a deployment with a registered embedding model, so this case cannot arise"
            )
        assert _metadata(results[0])["_search_type"] == "text"


@pytest.mark.integration
class TestSearchTypeReportsTheTierThatRan:
    """AT-054 — the key that makes a degraded ``auto`` store visible instead of silent.

    ``_search_type`` is the only way a caller can tell a semantic answer from a lexical one, and the two
    look identical otherwise: same shape, same score field, same ordering by descending relevance. A
    store that reported the *requested* tier rather than the tier that ran would satisfy every other
    test in this file, which is why the two halves below use configs that resolve differently and assert
    the difference rather than asserting a constant.
    """

    async def test_the_text_tier_reports_text(self, atlas_store: MongoDBMemoryStore) -> None:
        """AT-054, text half. Asked for ``auto`` against a deployment with no model, so text ran."""
        await atlas_store.add("the user prefers dark mode")
        results = await _answered(atlas_store, QUERY_TEXT)

        assert results
        # `hybrid` beside `vector`, because this guard is detecting one thing: whether the vector half of
        # the index set came up. Both answers mean it did: `auto` resolves to fusion only where both
        # single tiers exist, so on a deployment with a registered model and `$rankFusion` the tier that
        # runs is `hybrid`, and without the stage it is `vector`.
        if _metadata(results[0])["_search_type"] in {"vector", "hybrid"}:
            pytest.skip(
                "MONGODB_ATLAS_URI names a deployment with a registered embedding model, so this case cannot arise"
            )
        assert _metadata(results[0])["_search_type"] == "text"

    async def test_the_vector_tier_reports_vector(
        self, atlas_uri: str, atlas_database: Any, test_database_name: str, unique_collection_name: str
    ) -> None:
        """AT-054, vector half, on the manual path with seeded vectors.

        ``search_type`` is left at ``auto`` here rather than pinned to ``vector``, so the assertion is
        about resolution and not about echoing the config back.
        """
        await _seed_vectors(
            atlas_database[unique_collection_name],
            scope="tenant-a",
            store_name="facts",
            facts={"the user prefers dark mode": QUERY_VECTOR},
        )
        store = _real_store(
            atlas_uri, test_database_name, unique_collection_name, scope="tenant-a", connection=MANUAL_VECTOR
        )
        try:
            results = await _answered(store, {"vector": QUERY_VECTOR})
            assert [entry.content for entry in results] == ["the user prefers dark mode"]
            assert _metadata(results[0])["_search_type"] == "vector"
        finally:
            await store.close()


_SCORE_DRIFT: Final[float] = 1e-3
"""How far the same document's score may move between two identical queries.

On the ``vector`` tier the same document can score about 7e-5 differently on two identical queries a
minute apart. Nothing in the package touches the number, which arrives in ``$meta`` and is copied into
``_relevance_score`` unchanged; a query given as text is embedded again for the second call, and an
approximate nearest-neighbour search need not traverse the same nodes twice.

1e-3 is over ten times that drift and about a hundred times smaller than the gap between the test's two
documents, so the tolerance cannot let one of them pass for the other. The identity claim is carried by
content anyway; this constant only keeps the score assertion from being a promise Atlas never made.
"""


@pytest.mark.integration
class TestTheScoreBoundDropsResults:
    """AT-059b — the bound applied after the query, and the comparison this test refuses.

    The bound is applied in Python rather than in a ``$match`` on ``$meta``, so what it filters is what
    mongot already returned and paid for. The test is calibrated against a first unbounded query instead
    of against a literal, because a fixed threshold is a different claim on each tier: BM25's
    ``searchScore`` is unbounded and depends on corpus statistics, while cosine ``vectorSearchScore`` is
    normalised to ``[0, 1]``. **The two are not comparable, and this test does not compare them.** A
    single number that "works on both" would be a number that happens to sit below every score in this
    particular corpus, which is a fact about the corpus and not about the bound.

    The second comparison it refuses is exact score equality: the surviving result's score is checked to
    :data:`_SCORE_DRIFT`, because the same document on the same query text can score slightly
    differently a minute apart. Which document survived is asserted by its content, which is the claim
    that matters.

    The third is the same mistake one level up: calibrating against an unbounded query is only safe
    while the unbounded query runs the same tier as the bounded one, and setting a bound is itself what
    decides whether ``auto`` uses the fused tier. The measuring store declares a bound of its own for
    that reason alone.
    """

    async def test_a_bound_above_the_lowest_score_drops_exactly_that_result(
        self, atlas_uri: str, test_database_name: str, unique_collection_name: str, caplog: pytest.LogCaptureFixture
    ) -> None:
        """AT-059b. Measure first, then bound just above the measurement's floor."""
        # `min_score=0.0` on the measuring store, which is not a bound so much as a declaration that one
        # exists. Tier resolution reads whether a bound is set and never its value, so this puts the
        # writer on exactly the path the bounded store below will take, whichever path that is on this
        # deployment, while dropping nothing, because every tier's score is non-negative.
        #
        # Without it the two stores can resolve differently and the test measures one scale to bound
        # another: a writer on fusion measures RRF scores near 0.03, a bounded store on vector scores
        # near 0.8, and a bound between the first two drops neither. Pinning a literal `search_type`
        # instead would not work here: this test has to pass against a deployment with a registered
        # embedding model and against one without, and those resolve to different tiers.
        writer = _real_store(
            atlas_uri, test_database_name, unique_collection_name, writable=True, scope="tenant-a", min_score=0.0
        )
        try:
            # Repeated terms outrank a single mention, which is what puts a measurable gap between the
            # highest and lowest score. Uniform text scores everything within rounding distance.
            await writer.add("dark mode dark mode dark mode")
            await writer.add("dark mode once, then padding " + " ".join(f"word{n}" for n in range(60)))
            unbounded = await _answered(writer, QUERY_TEXT, expected=2)
            assert len(unbounded) == 2, f"the corpus is the premise here: {[e.content for e in unbounded]}"
        finally:
            await writer.close()

        # Sorted as pairs rather than as bare scores: the survivor is identified by its content below, so
        # which of the two texts mongot ranks higher is measured here rather than assumed.
        measured = sorted((_metadata(entry)["_relevance_score"], entry.content) for entry in unbounded)
        (lowest, _), (highest, top_content) = measured
        assert lowest < highest, "without a score gap this test cannot distinguish a bound from a no-op"
        bound = (lowest + highest) / 2

        bounded = _real_store(atlas_uri, test_database_name, unique_collection_name, scope="tenant-a", min_score=bound)
        try:
            with caplog.at_level(logging.DEBUG, logger="strands_mongodb.memory_store"):
                results = await _answered(bounded, QUERY_TEXT)

            assert [entry.content for entry in results] == [top_content], (
                f"the bound sat between the two scores, so exactly the top document survives it: "
                f"{[(_metadata(entry)['_relevance_score'], entry.content) for entry in results]}"
            )
            kept = _metadata(results[0])["_relevance_score"]
            assert kept >= bound, f"a result the bound kept has to clear it: {kept} against {bound}"
            assert kept == pytest.approx(highest, abs=_SCORE_DRIFT), (
                f"the same document on the same query moved further than {_SCORE_DRIFT} between two calls: "
                f"{highest} then {kept}"
            )
            debug = [record.getMessage() for record in caplog.records if record.levelno == logging.DEBUG]
            # Both counts, and the key that caused the drop. A message saying only "filtered results"
            # tells the reader something happened without telling them how much, which on a bound set
            # slightly too high is the difference between a tuning problem and an empty memory.
            assert any("min_score" in message and "2" in message and "1" in message for message in debug), (
                f"the effect has to be visible at debug, naming the bound and both counts: {debug!r}"
            )
        finally:
            await bounded.close()


class TestASkippedTierIsTriedAgain:
    """AT-227. Under ``auto`` a tier that failed at startup is retried with backoff.

    The retry reads index status without waiting for a build, so it never holds a request for
    ``index_ready_timeout``, and a retry that fails keeps the tiers the store already answers from.
    Due-ness is forced through ``_tier_retry_at`` rather than by moving the clock, because patching
    ``time.monotonic`` would also move the event loop's own clock.
    """

    async def test_the_tier_comes_back_once_the_retry_is_due(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch, failing=frozenset({"vector_index"}))
        store = _store()
        await store.initialize()
        assert store._tiers == ("text",)

        recorder.failing = frozenset()
        store._tier_retry_at = 0.0
        await store.initialize()

        assert store._tiers == ("vector", "text")
        assert store._tier_retry_at is None

    async def test_nothing_is_retried_before_the_delay_has_passed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch, failing=frozenset({"vector_index"}))
        store = _store()
        await store.initialize()
        calls = len(recorder.timeouts)

        await store.initialize()

        assert len(recorder.timeouts) == calls
        assert store._tier_retry_at is not None
        assert store._tier_retry_at > time.monotonic()

    async def test_a_retry_does_not_wait_for_a_build(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _patch_setup(monkeypatch, failing=frozenset({"vector_index"}))
        store = _store()
        await store.initialize()
        calls = len(recorder.timeouts)

        store._tier_retry_at = 0.0
        await store.initialize()

        assert set(recorder.timeouts[calls:]) == {0}

    async def test_a_failed_retry_keeps_the_tiers_and_doubles_the_delay(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from strands_mongodb.memory_store import TIER_RETRY_MAX_SECONDS, TIER_RETRY_SECONDS

        recorder = _patch_setup(monkeypatch, failing=frozenset({"vector_index"}))
        store = _store()
        await store.initialize()
        assert store._tier_retry_delay == TIER_RETRY_SECONDS

        store._tier_retry_at = 0.0
        await store.initialize()
        assert store._tiers == ("text",)
        assert store._tier_retry_delay == 2 * TIER_RETRY_SECONDS

        # Every tier refusing on a retry is a raise inside the retry, and it still keeps what the store has.
        recorder.failing = frozenset({"vector_index", "text_index"})
        store._tier_retry_at = 0.0
        await store.initialize()
        assert store._tiers == ("text",)
        assert store._tier_retry_delay == 4 * TIER_RETRY_SECONDS

        store._tier_retry_delay = TIER_RETRY_MAX_SECONDS
        store._tier_retry_at = 0.0
        await store.initialize()
        assert store._tier_retry_delay == TIER_RETRY_MAX_SECONDS

    async def test_a_store_with_no_tier_still_backs_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from strands_mongodb.memory_store import TIER_RETRY_SECONDS

        recorder = _patch_setup(monkeypatch)
        recorder.building = {"vector_index", "text_index"}
        store = _store()
        await store.initialize()

        assert store._tiers == ()
        assert store._tier_retry_at is not None
        assert store._tier_retry_at > time.monotonic() + TIER_RETRY_SECONDS / 2

        store._tier_retry_at = 0.0
        await store.initialize()
        assert store._tier_retry_delay == 2 * TIER_RETRY_SECONDS

    async def test_a_deployment_without_search_schedules_no_retry(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_setup(monkeypatch, available=False)
        store = _store()
        await store.initialize()

        assert store._tier_retry_at is None

    async def test_a_store_with_every_tier_schedules_no_retry(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_setup(monkeypatch)
        store = _store()
        await store.initialize()

        assert store._tiers == ("vector", "text")
        assert store._tier_retry_at is None

    async def test_a_named_search_type_schedules_no_retry(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_setup(monkeypatch)
        store = _store(config=_connection_config(search_type="text"))
        await store.initialize()

        assert store._tiers == ("text",)
        assert store._tier_retry_at is None


class _WordEmbedder:
    """A four-dimension embedder over ``dark``, ``mode``, ``coffee`` and ``tea``, recording what it embeds."""

    def __init__(self, dimensions: int = 4) -> None:
        self.dimensions = dimensions
        self.calls: list[str] = []

    async def embed(self, text: str) -> list[float]:
        self.calls.append(text)
        words = text.lower().split()
        vector = [0.01 + words.count(word) for word in ("dark", "mode", "coffee", "tea")]
        return (vector + [0.01] * self.dimensions)[: self.dimensions]


class TestAnEmbedderCompletesTheManualPath:
    """AT-243 — with ``embedder``, ``add`` writes the vector and a plain-string ``search`` embeds the query."""

    def test_an_embedder_on_the_auto_embeddings_path_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="'embedder' is set"):
            _store(embedder=_WordEmbedder())

    async def test_add_stores_the_vector_in_the_insert(self) -> None:
        embedder = _WordEmbedder()
        store = _store(config=_connection_config(**MANUAL_VECTOR), writable=True, embedder=embedder)
        collection = _prepared(store)
        with contextlib.suppress(NotImplementedError):
            await store.add("the user prefers dark mode")

        assert embedder.calls == ["the user prefers dark mode"]
        assert collection.upserts[-1][1]["$setOnInsert"][_indexes.VECTOR_FIELD] == [1.01, 1.01, 0.01, 0.01]

    async def test_a_vector_of_the_wrong_length_writes_nothing(self) -> None:
        store = _store(config=_connection_config(**MANUAL_VECTOR), writable=True, embedder=_WordEmbedder(3))
        collection = _prepared(store)

        with pytest.raises(ValueError, match="3-dimension vector"):
            await store.add("dark")

        assert collection.upserts == []

    @pytest.mark.parametrize(
        ("tiers", "tier"), [(("vector", "text"), "vector"), (("hybrid", "vector", "text"), "hybrid")]
    )
    async def test_a_plain_string_reaches_the_vector_tiers(self, tiers: tuple[str, ...], tier: str) -> None:
        embedder = _WordEmbedder()
        store = _store(config=_connection_config(**MANUAL_VECTOR), embedder=embedder)
        collection = _prepared(store, tiers=tiers)

        found = await store.search("dark")

        assert embedder.calls == ["dark"]
        assert _metadata(found[0])["_search_type"] == tier
        assert "[1.01, 0.01, 0.01, 0.01]" in repr(collection.stages)

    async def test_a_text_only_store_embeds_nothing(self) -> None:
        embedder = _WordEmbedder()
        store = _store(config=_connection_config(**MANUAL_VECTOR), embedder=embedder)
        _prepared(store, tiers=("text",))

        await store.search("dark")

        assert embedder.calls == []

    async def test_a_caller_vector_is_used_as_given(self) -> None:
        embedder = _WordEmbedder()
        store = _store(config=_connection_config(**MANUAL_VECTOR), embedder=embedder)
        _prepared(store, tiers=("vector", "text"))

        await store.search({"vector": QUERY_VECTOR})

        assert embedder.calls == []


@pytest.mark.integration
class TestAnEmbedderAgainstADeployment:
    """AT-243 — the manual path round trip ``MemoryManager`` makes: ``add`` a string, ``search`` a string."""

    async def test_a_memory_added_as_text_is_found_by_a_text_query_on_the_vector_tier(
        self, atlas_uri: str, test_database_name: str, unique_collection_name: str
    ) -> None:
        store = _real_store(
            atlas_uri,
            test_database_name,
            unique_collection_name,
            writable=True,
            embedder=_WordEmbedder(),
            connection={**MANUAL_VECTOR, "search_type": "vector"},
        )
        try:
            await store.add("the user prefers dark mode")
            await store.add("the user drinks coffee and tea")

            found = await _answered(store, "dark mode", expected=2)

            assert [entry.content for entry in found] == [
                "the user prefers dark mode",
                "the user drinks coffee and tea",
            ]
            assert {_metadata(entry)["_search_type"] for entry in found} == {"vector"}
        finally:
            await store.close()
