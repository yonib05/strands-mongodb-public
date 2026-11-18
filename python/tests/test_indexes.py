"""Index specs, idempotent ensure and verify, and readiness polling.

Three tiers, because the module has three kinds of claim and they are verifiable in different places.
What the package *emits* is a dict and runs unmocked in the unit tier. What a **plain MongoDB** does
with an ordinary index runs in the contract tier. What **mongot** does with a search index, including
the asynchronous build that makes created and queryable two different states, runs in the integration
tier.

Nothing here re-probes the server for facts already settled. The server behaviour these tests rely on
was measured against MongoDB 8.3.8, and the tests below assert what follows from it. The ones that do
hit a deployment are
the ones where a passing mock would prove nothing: option conflicts, the missing-namespace asymmetry,
and the build states.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import TYPE_CHECKING, Any, Final

import pytest

from strands_mongodb import _indexes

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Iterable, Mapping, Sequence

    from strands_mongodb.types import MongoDBConfig, VectorSimilarity

# The ordinary indexes this package creates on the memory collection: dedup, recency and TTL. Only counted.
MEMORY_ROWS = ("3", "4", "7")


class TestVectorModeIsResolvedFromTheConfig:
    """AT-067 — ``embedding_dimensions`` and ``similarity`` select the manual vector mode, and conflicting
    combinations raise.

    Mode selection mirrors ``pymongo_search_utils._check_param_config``'s exactly-one-mode rule without
    importing it. The manual mode has to be configurable because an ``autoEmbed`` index is rejected at
    **creation** on deployments without automated embedding, Atlas local among them, and a manual vector
    index cannot be created without ``numDimensions`` and ``similarity``.
    """

    def test_an_empty_config_selects_autoembed_with_the_documented_default(self) -> None:
        """Zero configuration stays the Atlas path, so the default install needs no vector settings."""
        mode = _indexes.vector_mode({"database": "d"})

        assert mode.auto_embed is True
        assert mode.model == _indexes.DEFAULT_EMBEDDING_MODEL
        assert mode.dimensions is None
        assert mode.similarity is None

    def test_the_default_model_is_the_one_the_community_package_ships(self) -> None:
        """Sourced, not chosen. ``strands-mongodb-store`` 0.2.0 defaults to this model."""
        assert _indexes.DEFAULT_EMBEDDING_MODEL == "voyage-4-lite"

    def test_an_explicit_model_selects_autoembed_with_that_model(self) -> None:
        mode = _indexes.vector_mode({"database": "d", "embedding_model": "voyage-3-large"})

        assert mode.auto_embed is True
        assert mode.model == "voyage-3-large"

    def test_dimensions_and_similarity_select_the_manual_vector_mode(self) -> None:
        mode = _indexes.vector_mode({"database": "d", "embedding_dimensions": 1024, "similarity": "cosine"})

        assert mode.auto_embed is False
        assert mode.model is None
        assert mode.dimensions == 1024
        assert mode.similarity == "cosine"

    def test_dimensions_without_similarity_raises_and_names_the_missing_field(self) -> None:
        """A vector index needs both. Defaulting the similarity would pick a metric for the caller's
        embeddings, and the wrong metric returns plausible neighbours that are the wrong neighbours."""
        with pytest.raises(ValueError, match="similarity"):
            _indexes.vector_mode({"database": "d", "embedding_dimensions": 1024})

    def test_similarity_without_dimensions_raises(self) -> None:
        with pytest.raises(ValueError, match="embedding_dimensions"):
            _indexes.vector_mode({"database": "d", "similarity": "cosine"})

    def test_setting_both_modes_raises_rather_than_picking_one(self) -> None:
        """The two modes index different fields with different contents, so a silent precedence rule
        would build one index and leave the caller expecting the other."""
        with pytest.raises(ValueError) as caught:
            _indexes.vector_mode(
                {
                    "database": "d",
                    "embedding_model": "voyage-3-large",
                    "embedding_dimensions": 1024,
                    "similarity": "cosine",
                }
            )

        message = str(caught.value)
        assert "embedding_model" in message
        assert "embedding_dimensions" in message

    @pytest.mark.parametrize("similarity", ["cosine", "dotProduct", "euclidean"])
    def test_every_similarity_atlas_accepts_is_accepted_here(self, similarity: VectorSimilarity) -> None:
        mode = _indexes.vector_mode({"database": "d", "embedding_dimensions": 8, "similarity": similarity})

        assert mode.similarity == similarity

    def test_an_unknown_similarity_is_rejected_here_rather_than_by_the_server(self) -> None:
        """Atlas rejects it too, but at index creation, after the collection has been created and the
        other five indexes built. Rejecting it while it is still a dict costs one comparison."""
        # Held as `Any` because `VectorSimilarity` forbids this value, and being unable to write the
        # literal is the *point*: the check exists for configs assembled from environment variables or
        # a JSON file, which reach `vector_mode` having never passed a type checker.
        config: Any = {"database": "d", "embedding_dimensions": 8, "similarity": "l2"}

        with pytest.raises(ValueError, match="cosine"):
            _indexes.vector_mode(config)

    @pytest.mark.parametrize("dimensions", [0, -1, 8193])
    def test_dimensions_outside_the_atlas_bounds_are_rejected_here(self, dimensions: int) -> None:
        """The server answers ``numDimensions`` outside ``[1..8192]`` with code 8. Same reasoning as the
        similarity check. ``-1`` is included because some client libraries use it as a placeholder."""
        with pytest.raises(ValueError, match=r"1\.\.8192"):
            _indexes.vector_mode({"database": "d", "embedding_dimensions": dimensions, "similarity": "cosine"})


class TestTheVectorIndexDefinition:
    """AT-071 — filter fields are declared at creation time, in both modes.

    The server rejects a pre-filter over an undeclared path with code 8 (mongot 8.3.8). This package
    filters by ``scope`` on every query, so failing to declare ``scope`` here would break every scoped
    query. ``_filter.validate`` is the guard that names the config key to edit.
    """

    def test_the_autoembed_definition_matches_the_confirmed_wire_shape(self) -> None:
        definition = _indexes.vector_index_definition(_indexes.vector_mode({"database": "d"}))

        assert definition["fields"][0] == {
            "type": "autoEmbed",
            "path": "content",
            "model": "voyage-4-lite",
            "modality": "text",
        }

    def test_the_manual_definition_carries_dimensions_and_similarity(self) -> None:
        definition = _indexes.vector_index_definition(
            _indexes.vector_mode({"database": "d", "embedding_dimensions": 4, "similarity": "euclidean"}),
            vector_field="embedding",
        )

        assert definition["fields"][0] == {
            "type": "vector",
            "path": "embedding",
            "numDimensions": 4,
            "similarity": "euclidean",
        }

    def test_no_definition_ever_emits_the_placeholder_dimension_count(self) -> None:
        """Some client libraries use ``numDimensions: -1`` as a placeholder for the server-side path. That
        is client-side validation, not a wire format: the server answers ``-1`` with code 8.
        ``vector_mode`` cannot produce it, so this asserts the emitted dict as well."""
        configs: tuple[MongoDBConfig, ...] = ({"database": "d"}, {"database": "d", "embedding_model": "m"})
        for config in configs:
            definition = _indexes.vector_index_definition(_indexes.vector_mode(config))

            assert all(field.get("numDimensions") != -1 for field in definition["fields"])

    def test_scope_and_store_name_are_always_declared_filterable(self) -> None:
        """Not optional and not caller supplied. These two are how one collection isolates N stores."""
        definition = _indexes.vector_index_definition(_indexes.vector_mode({"database": "d"}))

        filters = [f["path"] for f in definition["fields"] if f["type"] == "filter"]
        assert filters == ["scope", "store_name"]

    def test_caller_filter_fields_are_appended_after_the_baked_in_two(self) -> None:
        definition = _indexes.vector_index_definition(
            _indexes.vector_mode({"database": "d"}), filter_fields=["metadata.tier", "owner"]
        )

        filters = [f["path"] for f in definition["fields"] if f["type"] == "filter"]
        assert filters == ["scope", "store_name", "metadata.tier", "owner"]

    def test_a_caller_field_that_duplicates_a_baked_in_one_is_declared_once(self) -> None:
        """Atlas rejects a definition with two ``filter`` entries on one path, and a caller listing
        ``scope`` in ``filter_fields`` is asking for something already true rather than making a
        mistake worth failing over."""
        definition = _indexes.vector_index_definition(
            _indexes.vector_mode({"database": "d"}), filter_fields=["scope", "owner"]
        )

        filters = [f["path"] for f in definition["fields"] if f["type"] == "filter"]
        assert filters == ["scope", "store_name", "owner"]

    def test_the_declared_paths_are_readable_without_rebuilding_the_definition(self) -> None:
        """``_filter.validate`` needs the set this definition declared, and the definition is the single
        authority on it. That only holds if the set can be read back from here."""
        assert _indexes.declared_filter_fields(["owner"]) == ("scope", "store_name", "owner")

    def test_the_filter_paths_and_the_filter_module_agree_on_the_baked_in_pair(self) -> None:
        """Two modules naming the same two fields is exactly how they drift apart."""
        from strands_mongodb import _filter

        assert _indexes.declared_filter_fields(())[:2] == _filter.BAKED_IN_FILTER_FIELDS


class TestTheFullTextIndexDefinition:
    """The full-text index: the text tier, and the text branch of the hybrid tier."""

    def test_it_maps_the_content_field_as_a_string_and_nothing_else(self) -> None:
        definition = _indexes.text_index_definition()

        assert definition == {"mappings": {"dynamic": False, "fields": {"content": [{"type": "string"}]}}}

    def test_dynamic_mapping_is_off(self) -> None:
        """``dynamic: True`` indexes every field of every document, including the caller metadata a
        memory carries. That is storage and build time spent on fields no query reads."""
        assert _indexes.text_index_definition()["mappings"]["dynamic"] is False


class TestTheIndexInventory:
    """The ordinary index inventory, as the README's index table lists it.

    The server creates ``_id_``, and the two search indexes live in :func:`memory_search_specs`. That
    leaves one ordinary index on ``storage`` and three on ``memory``.
    """

    def test_the_storage_surface_declares_exactly_its_ttl_index(self) -> None:
        specs = _indexes.storage_specs()

        assert [spec.keys for spec in specs] == [(("expires_at", 1),)]
        assert specs[0].options == {"expireAfterSeconds": 0}

    def test_the_memory_surface_declares_three_ordinary_indexes(self) -> None:
        assert len(_indexes.memory_specs()) == len(MEMORY_ROWS)

    def test_the_dedup_index_carries_the_options_it_exists_for(self) -> None:
        """The key list is not the point of the dedup index; ``unique`` is. An ordinary compound index
        over the same three fields satisfies a key-list check exactly and stops nothing, so duplicates
        would be written while the index is reported present."""
        spec = self._by_keys(("scope", 1), ("store_name", 1), ("content_hash", 1))

        assert spec.options == {
            "unique": True,
            "partialFilterExpression": {"content_hash": {"$exists": True}},
        }

    def test_the_dedup_index_is_partial_so_documents_without_a_hash_do_not_collide(self) -> None:
        """A unique index treats a missing field as ``null``, so without the partial expression the
        second document with no ``content_hash`` collides with the first."""
        spec = self._by_keys(("scope", 1), ("store_name", 1), ("content_hash", 1))

        assert spec.options["partialFilterExpression"] == {"content_hash": {"$exists": True}}

    def test_the_recency_index_sorts_created_at_descending(self) -> None:
        """``-1`` because every read of it is newest-first; an ascending index serves the same
        sort, but the direction here is the one the queries use."""
        spec = self._by_keys(("scope", 1), ("store_name", 1), ("created_at", -1))

        assert spec.options == {}

    def test_the_memory_ttl_index_is_declared_unconditionally(self) -> None:
        """The memory TTL index is created whether or not ``ttl_seconds`` is configured. Creating it only
        when one is configured fails silently: a store that gains a TTL later stamps ``expires_at`` on every
        document and nothing deletes them, with no error to read. A TTL index is inert for documents
        that carry no ``expires_at``, so the unconditional version costs nothing at rest."""
        spec = self._by_keys(("expires_at", 1))

        assert spec.options == {"expireAfterSeconds": 0}

    def test_specs_take_no_arguments_so_the_inventory_cannot_vary_by_caller(self) -> None:
        """A caller without DDL rights hands an operator the exact command list. That list is only
        useful if it is the same list every store asks for."""
        assert _indexes.storage_specs() == _indexes.storage_specs()
        assert _indexes.memory_specs() == _indexes.memory_specs()

    def test_every_name_carries_the_package_prefix(self) -> None:
        """Provenance for whoever reads ``getIndexes()`` on a collection this package shares with an
        application's own indexes. Matching is on keys, so the name only ever appears in a message or
        in a create we issue."""
        for spec in (*_indexes.storage_specs(), *_indexes.memory_specs()):
            assert spec.name.startswith("strands_")

    @staticmethod
    def _by_keys(*keys: tuple[str, int]) -> _indexes.IndexSpec:
        """Return the memory spec with this key list, failing the test if it is absent."""
        for spec in _indexes.memory_specs():
            if spec.keys == keys:
                return spec
        pytest.fail(f"no memory index declared over {keys}")


class TestTheSearchIndexInventory:
    """The two search indexes, built from the config because both names and one definition come from it."""

    def test_both_search_indexes_are_declared(self) -> None:
        specs = _indexes.memory_search_specs({"database": "d"})

        assert [spec.type for spec in specs] == ["vectorSearch", "search"]

    def test_the_default_index_names_are_the_reference_implementation_names(self) -> None:
        """Sourced rather than chosen: ``vector_index`` and ``text_index`` are the names existing MongoDB
        integrations create. A caller pointing this package at a collection another library already
        indexed then finds its indexes."""
        specs = _indexes.memory_search_specs({"database": "d"})

        assert [spec.name for spec in specs] == ["vector_index", "text_index"]

    def test_configured_names_override_the_defaults(self) -> None:
        specs = _indexes.memory_search_specs({"database": "d", "vector_index_name": "v", "text_index_name": "t"})

        assert [spec.name for spec in specs] == ["v", "t"]

    def test_the_config_filter_fields_reach_the_vector_definition(self) -> None:
        """The path from ``MongoDBConfig`` to the index is what declares the caller's filter fields. A
        definition that is right in isolation and never receives the config would leave them undeclared."""
        specs = _indexes.memory_search_specs({"database": "d", "filter_fields": ["owner"]})

        paths = [f["path"] for f in specs[0].definition["fields"] if f["type"] == "filter"]
        assert paths == ["scope", "store_name", "owner"]

    def test_a_conflicting_vector_config_raises_here_too(self) -> None:
        """The mode check has to run on the path ``initialize()`` actually takes, not only when
        ``vector_mode`` is called directly."""
        with pytest.raises(ValueError, match="embedding_dimensions"):
            _indexes.memory_search_specs({"database": "d", "embedding_model": "m", "embedding_dimensions": 4})


class TestTheCreationCommandsHandedToAnOperator:
    """AT-061 — the command a caller without DDL rights forwards to whoever has them.

    Naming the index is not enough on its own: the person who receives the message is not the person who
    configured the store, and they need something they can run.

    ``db.runCommand`` with the raw server command rather than a shell helper. That is the command
    pymongo itself sends, so it is verifiable from here rather than remembered: ``createIndexes`` and
    ``createSearchIndexes`` are what ``collection.py`` builds. A shell helper's argument order would be
    a detail this package has no way to check, and getting it wrong sends an operator a command that
    fails in their hands.
    """

    def test_an_ordinary_command_is_the_server_command_pymongo_sends(self) -> None:
        spec = _indexes.storage_specs()[0]

        command = spec.creation_command("storage")
        assert command.startswith("db.runCommand(")
        assert '"createIndexes": "storage"' in command
        assert '"expires_at": 1' in command
        assert '"expireAfterSeconds": 0' in command

    def test_an_ordinary_command_names_the_index_it_creates(self) -> None:
        spec = _indexes.storage_specs()[0]

        assert spec.name in spec.creation_command("storage")

    def test_a_search_command_uses_the_search_variant_of_the_command(self) -> None:
        spec = _indexes.memory_search_specs({"database": "d"})[0]

        command = spec.creation_command("memory")
        assert '"createSearchIndexes": "memory"' in command
        assert '"type": "vectorSearch"' in command
        assert '"autoEmbed"' in command

    def test_every_command_is_valid_json_inside_the_call(self) -> None:
        """Runnable means parseable. A repr of a Python dict is not: ``True`` and single quotes are
        both syntax errors in mongosh."""
        import json
        import re

        for spec, collection in (
            (_indexes.memory_specs()[0], "memory"),
            (_indexes.memory_search_specs({"database": "d"})[1], "memory"),
        ):
            command = spec.creation_command(collection)
            body = re.fullmatch(r"db\.runCommand\((.*)\)", command)
            assert body is not None, command
            json.loads(body.group(1))

    def test_a_drop_command_keeps_a_hostile_index_name_inside_its_string(self) -> None:
        """The name in a drop command comes from the deployment, so whoever created the index chose it."""
        import json
        import re

        name = 'x"}); db.dropDatabase(); ({"a":"\\'
        spec = _indexes.SearchIndexSpec(name=name, definition={}, type="search")

        for command, key in (
            (_indexes.drop_index_command("memory", name), "index"),
            (spec.drop_command("memory"), "name"),
        ):
            body = re.fullmatch(r"db\.runCommand\((.*)\)", command)
            assert body is not None, command
            assert json.loads(body.group(1))[key] == name


class FakeSearchIndexCursor:
    """The cursor ``list_search_indexes`` returns, which is async-iterable and not iterable.

    Stands in for ``AsyncCommandCursor``. Deliberately does **not** implement ``__iter__``: the real
    class does not either, and a fake that did would let a synchronous ``for`` loop pass here and fail
    against a deployment.
    """

    def __init__(self, documents: Iterable[dict[str, Any]]) -> None:
        self._documents = list(documents)

    async def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        for document in self._documents:
            yield document


class FakeAsyncDatabase:
    """The database half of the fake, which exists for two calls: ``create_collection`` and ``command``.

    ``command`` serves the ``$rankFusion`` probe and counts its calls, because "once per connection" is
    an assertion about a number and not about a return value.
    """

    def __init__(
        self,
        *,
        name: str = "testdb",
        create_error: Exception | None = None,
        version_array: Sequence[int] | None = None,
        command_error: Exception | None = None,
    ) -> None:
        self.name = name
        self._create_error = create_error
        # 8.0.23 unless a test says otherwise: the version the target deployments report, so a test
        # that does not care about the version does not accidentally assert against a fabricated one.
        self._version_array = list(version_array if version_array is not None else (8, 0, 23, 0))
        self._command_error = command_error
        self.create_collection_calls: list[tuple[str, dict[str, Any]]] = []
        self.command_calls: list[str] = []

    async def create_collection(self, name: str, **kwargs: Any) -> Any:
        self.create_collection_calls.append((name, kwargs))
        if self._create_error is not None:
            raise self._create_error
        return None

    async def command(self, command: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
        self.command_calls.append(command)
        if self._command_error is not None:
            raise self._command_error
        return {
            "version": ".".join(str(part) for part in self._version_array[:3]),
            "versionArray": list(self._version_array),
        }


class FakeAsyncCollection:
    """``AsyncCollection`` narrowed to the four methods this module calls.

    Every method is a coroutine function, which ``TestTheFakesMatchTheDriver`` checks against the real
    class rather than assuming. The two ``__getattr__``-shaped traps the real class has are absent
    here on purpose: this fake raises ``AttributeError`` for an unknown attribute, so a typo in the
    module under test fails in the unit tier instead of resolving to a sub-collection.
    """

    def __init__(
        self,
        *,
        name: str = "memory",
        indexes: dict[str, dict[str, Any]] | None = None,
        search_states: dict[str, Sequence[list[dict[str, Any]]]] | None = None,
        database: FakeAsyncDatabase | None = None,
    ) -> None:
        self.name = name
        self.database = database if database is not None else FakeAsyncDatabase()
        self._indexes = dict(indexes or {})
        # name -> the documents each successive `list_search_indexes` call returns. The last entry
        # repeats, so a test programs a build's transitions and the poll loop reads them in order.
        self._search_states = {key: list(value) for key, value in (search_states or {}).items()}
        self._search_reads: dict[str, int] = {}
        self.created_indexes: list[Any] = []
        self.created_search_indexes: list[Any] = []

    async def index_information(self) -> dict[str, dict[str, Any]]:
        return {name: dict(spec) for name, spec in self._indexes.items()}

    async def create_indexes(self, models: Sequence[Any]) -> list[str]:
        self.created_indexes.extend(models)
        for model in models:
            document = dict(model.document)
            # Two ways `IndexModel.document` differs from what `index_information` reports, both
            # measured on pymongo 4.17.0 against a deployment: it holds `key` as a
            # `SON` where the server reports a list of tuples, and it carries the index name as a field
            # where the server uses it as the entry's key and drops it from the body. Normalised here so
            # a create followed by a verify reads the shape the server would have returned.
            name = document.pop("name")
            document["key"] = list(document["key"].items())
            self._indexes[name] = {"v": 2, **document}
        return [model.document["name"] for model in models]

    async def list_search_indexes(self, name: str | None = None) -> FakeSearchIndexCursor:
        states = self._search_states.get(name if name is not None else "*", [[]])
        read = self._search_reads.get(name or "*", 0)
        self._search_reads[name or "*"] = read + 1
        return FakeSearchIndexCursor(states[min(read, len(states) - 1)])

    async def create_search_index(self, model: Any) -> str:
        self.created_search_indexes.append(model)
        name: str = model.document["name"]
        self._search_states.setdefault(name, [[{"name": name, "status": "READY"}]])
        return name


def operation_failure(code: int, message: str = "probed") -> Exception:
    """Build a real ``OperationFailure`` with a server error code, as the driver would raise it."""
    from pymongo.errors import OperationFailure

    return OperationFailure(message, code=code)


def network_failure(message: str = "socket timed out") -> Exception:
    """Build a ``PyMongoError`` that is **not** an ``OperationFailure``, which carries no server code.

    The distinction is the whole reason the module catches two exception types rather than one. A
    connection that dies mid-call never reaches the server, so there is no code to compare against 26
    or 48, and the code-inspecting handler would raise ``AttributeError`` if it ran on one of these.
    """
    from pymongo.errors import NetworkTimeout

    return NetworkTimeout(message)


def raiser(error: BaseException) -> Any:
    """Build a coroutine function that raises, for patching a fake method."""

    async def raise_it(*args: Any, **kwargs: Any) -> Any:
        raise error

    return raise_it


async def bounded(awaitable: Any, seconds: float = 5.0) -> Any:
    """Run an awaitable under a deadline the test owns rather than the one it is testing.

    Two tests below push ``_wait_until_ready`` past its deadline on purpose, against a fake whose
    status never changes. If the deadline check is the thing that is broken, the loop never ends and
    the run stops producing output: no assertion fires, no test is named, and the only symptom is a
    process that has to be killed. Bounding the call turns that back into an ordinary failure.

    The number is unrelated to the ``timeout=0`` under test. It only has to be longer than a correct
    implementation needs, which here is one poll.
    """
    return await asyncio.wait_for(awaitable, timeout=seconds)


def existing(*keys: tuple[str, int], **options: Any) -> dict[str, Any]:
    """Build one entry as ``index_information`` reports it, including the ``v`` nobody asked for."""
    return {"v": 2, "key": list(keys), **options}


class TestOrdinaryIndexesAgainstAFake:
    """Creating, verifying and reporting ordinary indexes: the branch logic, without a deployment.

    The contract tier proves the server behaves as these tests assume. These tests prove the
    module branches on it correctly, which is a different claim and much cheaper to make exhaustive.
    """

    async def test_a_missing_index_is_created_when_creation_is_allowed(self) -> None:
        collection: Any = FakeAsyncCollection()

        await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert len(collection.created_indexes) == 1

    async def test_all_missing_indexes_are_created_in_one_call(self) -> None:
        """``create_indexes`` takes a list, and three round trips where one would do is three chances
        for a partial result to leave the collection half indexed."""
        collection: Any = FakeAsyncCollection()

        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=True)

        assert len(collection.created_indexes) == len(MEMORY_ROWS)

    async def test_an_index_matching_on_keys_and_options_is_left_alone(self) -> None:
        collection: Any = FakeAsyncCollection(
            indexes={"whatever_they_called_it": existing(("expires_at", 1), expireAfterSeconds=0)}
        )

        await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert collection.created_indexes == []

    async def test_matching_is_on_the_key_list_rather_than_the_name(self) -> None:
        """Forced rather than preferred: creating a second index over keys that already carry one
        returns code 85 whatever name is used, so a name-keyed check would try, fail, and
        report a conflict the caller cannot act on. The index above is named nothing like ours."""
        collection: Any = FakeAsyncCollection(indexes={"legacy_ttl": existing(("expires_at", 1), expireAfterSeconds=0)})

        await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert collection.created_indexes == []

    async def test_a_matching_key_list_with_a_missing_option_raises(self) -> None:
        """AT-063 — an index over the dedup keys that lacks ``unique`` is refused. It satisfies a
        key-list check exactly and stops no duplicates, so accepting it would let duplicates through with
        every index reported present."""
        from strands.types.exceptions import StorageError

        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(indexes={"theirs": existing(*dedup.keys)})

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[dedup], create=True)

        message = str(caught.value)
        assert "unique" in message

    async def test_the_mismatch_message_carries_found_wanted_and_the_remedy(self) -> None:
        """Naming the option is half of it. The reader has to know what to do, and what to do is drop
        an index somebody else created, which is why we report it instead of doing it."""
        from strands.types.exceptions import StorageError

        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(indexes={"theirs": existing(*dedup.keys)})

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[dedup], create=True)

        message = str(caught.value)
        assert "theirs" in message
        assert "dropIndex" in message

    async def test_a_mismatch_raises_even_when_creation_is_allowed(self) -> None:
        """``ensure_indexes=True`` cannot fix this one. Creating over those keys is code 85, and
        dropping the existing index is not ours to do."""
        from strands.types.exceptions import StorageError

        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(indexes={"theirs": existing(*dedup.keys)})

        with pytest.raises(StorageError):
            await _indexes.ensure(collection, ordinary=[dedup], create=True)
        assert collection.created_indexes == []

    async def test_a_differing_ttl_is_a_mismatch_rather_than_a_match(self) -> None:
        """AT-064 — a differing ``expireAfterSeconds`` is a mismatch. It is not a TTL special case: the
        comparison covers every option this package sets, and this is one of four."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(
            indexes={"strands_expires_at_ttl": existing(("expires_at", 1), expireAfterSeconds=3600)}
        )

        with pytest.raises(StorageError, match="expireAfterSeconds"):
            await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

    async def test_the_conflict_message_names_the_value_the_index_actually_has(self) -> None:
        """Naming the option is not enough to act on. Whoever reads this has to decide whether the
        existing index is theirs and whether losing its setting matters, and that decision needs both
        numbers. The other assertions here match on the option's *name*, so this is the one that fails
        if the rendered value is replaced with a fixed string."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(
            indexes={"strands_expires_at_ttl": existing(("expires_at", 1), expireAfterSeconds=3600)}
        )

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert "its expireAfterSeconds is 3600 and this package needs 0" in str(caught.value)

    async def test_an_index_that_covers_the_keys_but_lacks_the_option_reads_as_absent(self) -> None:
        """A plain index on ``expires_at`` with no TTL at all is the likelier accident than a TTL set to
        the wrong number, and the message has a separate arm for it. Branch coverage cannot see this
        arm: it is the false side of a conditional expression inside one statement, so it needs a test
        of its own."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(indexes={"someone_elses": existing(("expires_at", 1))})

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert "its expireAfterSeconds is absent and this package needs 0" in str(caught.value)

    async def test_server_defaults_we_never_asked_for_are_not_mismatches(self) -> None:
        """The comparison covers options this package sets. ``v``, ``background`` and anything else the
        server or another tool added are not ours to have an opinion about, and treating them as
        mismatches would make every index on a real deployment look wrong."""
        collection: Any = FakeAsyncCollection(
            indexes={"theirs": existing(("expires_at", 1), expireAfterSeconds=0, background=True, hidden=False)}
        )

        await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert collection.created_indexes == []

    async def test_a_partial_expression_reported_as_a_son_still_compares_equal(self) -> None:
        """``index_information`` returns ``partialFilterExpression`` as a ``bson.son.SON``.
        ``SON`` subclasses ``dict`` and compares equal to the plain dict we sent, so the comparison
        needs no normalisation step. Asserted rather than trusted, because if it were false every
        deployment would report the dedup index as mismatched."""
        from bson.son import SON

        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(
            indexes={
                "theirs": existing(
                    *dedup.keys,
                    unique=True,
                    partialFilterExpression=SON([("content_hash", SON([("$exists", True)]))]),
                )
            }
        )

        await _indexes.ensure(collection, ordinary=[dedup], create=True)

        assert collection.created_indexes == []

    async def test_verify_only_creates_nothing_and_raises_on_the_missing_index(self) -> None:
        """AT-061 — verify-only mode creates nothing and raises on a missing index."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=False)

        assert collection.created_indexes == []
        assert "createIndex" in str(caught.value)

    async def test_the_verify_only_error_names_every_missing_index_not_only_the_first(self) -> None:
        """A caller who has to raise a ticket per index raises three tickets. The commands are all
        computable in one pass, so the message carries all of them."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=False)

        assert str(caught.value).count("createIndex") == len(MEMORY_ROWS)

    async def test_verify_only_passes_when_everything_is_present(self) -> None:
        collection: Any = FakeAsyncCollection()
        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=True)

        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=False)

        assert len(collection.created_indexes) == len(MEMORY_ROWS)

    async def test_an_unexpected_driver_error_surfaces_as_a_storage_error(self) -> None:
        """Code 13 is unauthorized: a real answer to "may I create indexes", and not one this module
        can act on. It arrives wrapped, because ``StorageError`` is what a caller catches, with the
        original chained so the code and message survive."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()
        collection.create_indexes = raiser(operation_failure(13, "not authorized"))  # type: ignore[method-assign]

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert caught.value.__cause__ is not None
        assert "not authorized" in str(caught.value.__cause__)

    async def test_nothing_is_read_when_there_is_nothing_to_ensure(self) -> None:
        """``storage`` has no search indexes, so its ``initialize()`` passes an empty list. That must
        not cost a round trip."""
        collection: Any = FakeAsyncCollection()
        collection.index_information = raiser(AssertionError("should not be called"))  # type: ignore[method-assign]

        await _indexes.ensure(collection, create=True)

    @staticmethod
    def _dedup_spec() -> _indexes.IndexSpec:
        """The unique partial index the dedup constraint rests on."""
        return next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))


class TestAMatchedIndexWhoseCollationFoldsCaseIsRefused:
    """AT-193 — a dedup index that matches on keys and options but folds case is refused, which the
    ``AT-176`` collection-level preflight cannot see.

    The collection-level collation preflight reads the *collection's* default collation, and an index
    carries its own: a collection with none at all, which passes the preflight, can hold a unique index
    created ``{locale: "en", strength: 2}``. The dedup rule is enforced by that index, so the rule it
    enforces is the folded one: ``Remember X`` and ``remember x`` hash to different values, match the
    same index entry, and the second write is treated as a duplicate of a memory it does not duplicate.

    On ``mongod`` 7.0.12 the second ``add`` returns ``ids=[], inserted=0, duplicates=1``, with the first
    write's content left in place and the second's never stored. ``_existing()`` re-queries with the
    binary selector and a collated index cannot serve that query, so the caller is told the memory was
    already there and nothing can find it.

    The rule is checked here rather than added to ``IndexSpec.options`` because the server does not store
    a simple collation (the contract tier asserts this): an ``options`` entry of
    ``{"collation": {"locale": "simple"}}`` would find ``collation`` absent on every correct index and
    refuse every deployment that has one.
    """

    @staticmethod
    def _dedup_spec() -> _indexes.IndexSpec:
        """The unique partial index the dedup constraint rests on."""
        return next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))

    def _matched(self, **collation: Any) -> Any:
        """A collection holding an index that matches the dedup spec exactly but for its collation."""
        dedup = self._dedup_spec()
        return FakeAsyncCollection(indexes={"theirs": existing(*dedup.keys, **dedup.options, **collation)})

    async def test_an_index_reporting_a_folding_collation_is_refused(self) -> None:
        """Every option matches, so ``_check_options`` passes it, and the folding collation still refuses it."""
        from strands.types.exceptions import StorageError

        collection = self._matched(collation={"locale": "en", "strength": 2})

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[self._dedup_spec()], create=True)

        assert "collation" in str(caught.value)

    async def test_the_message_names_the_locale_and_the_index_and_the_remedy(self) -> None:
        """The same standard ``_check_options`` is held to: whoever reads this has to decide whether the
        index is theirs, and that decision needs the locale it was built with and the command to drop it."""
        from strands.types.exceptions import StorageError

        collection = self._matched(collation={"locale": "en", "strength": 2})

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[self._dedup_spec()], create=True)

        message = str(caught.value)
        assert "'en'" in message
        assert "theirs" in message
        assert "dropIndex" in message

    async def test_nothing_is_created_on_the_way_to_the_refusal(self) -> None:
        """``create=True`` cannot resolve this one either. The server would accept a second index over the
        same keys under a different collation, but the folded constraint would still be enforced beside it,
        and dropping an index somebody else created is not this package's decision."""
        from strands.types.exceptions import StorageError

        collection = self._matched(collation={"locale": "en", "strength": 2})

        with pytest.raises(StorageError):
            await _indexes.ensure(collection, ordinary=[self._dedup_spec()], create=True)

        assert collection.created_indexes == []

    async def test_an_index_reporting_a_simple_collation_is_accepted(self) -> None:
        """The first vacuity guard. A rule that refused every reported collation would pass all three
        tests above and refuse the deployments that spell the safe answer out."""
        collection = self._matched(collation={"locale": "simple"})

        await _indexes.ensure(collection, ordinary=[self._dedup_spec()], create=True)

        assert collection.created_indexes == []

    async def test_an_index_reporting_no_collation_at_all_is_accepted(self) -> None:
        """The second, and the one that matters most: this is what every correct index reports, because
        the server does not store a simple collation. A rule reading absence as a mismatch would refuse
        every correct deployment."""
        collection = self._matched()

        await _indexes.ensure(collection, ordinary=[self._dedup_spec()], create=True)

        assert collection.created_indexes == []

    async def test_a_missing_index_is_still_created_rather_than_inspected(self) -> None:
        """The third. The rule is about an index that is *there*; an absent one has no collation to read
        and the creation path must stay reachable."""
        collection: Any = FakeAsyncCollection()

        await _indexes.ensure(collection, ordinary=[self._dedup_spec()], create=True)

        assert len(collection.created_indexes) == 1


class TestAFoldedConstraintBehindACorrectIndexIsStillRefused:
    """AT-196 — a folding unique index is refused even when the declared dedup index is also present.

    An index's identity on the server is its keys **and** its collation. On 7.0.12, a second index over
    the same keys under the same collation is refused whatever it is named, and a second index over the
    same keys under a *different* collation is created. So a collection can carry the declared dedup index
    and a folding unique index over the same three keys at once, both enforced.

    Every index over a key list is examined, not only one. Reading a single entry per key list would make
    the answer depend on creation order, while the server enforces both constraints whichever one this
    package read.
    """

    FOLDING: Final[dict[str, Any]] = {"locale": "en", "strength": 2}

    @staticmethod
    def _dedup_spec() -> _indexes.IndexSpec:
        """The unique partial index the dedup constraint rests on."""
        return next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))

    def _both(self, *, folding_first: bool) -> Any:
        """A collection carrying the declared index and a folding unique one, in the given order.

        Args:
            folding_first: Whether the folding index is the one ``index_information`` reports first.
                The answer must not depend on it.

        Returns:
            A :class:`FakeAsyncCollection` whose index mapping preserves that order.
        """
        dedup = self._dedup_spec()
        ours = (dedup.name, existing(*dedup.keys, **dedup.options))
        theirs = ("folding_unique", existing(*dedup.keys, **dedup.options, collation=self.FOLDING))
        pair = [theirs, ours] if folding_first else [ours, theirs]
        return FakeAsyncCollection(indexes=dict(pair))

    async def test_a_folding_unique_index_behind_the_declared_one_is_refused(self) -> None:
        """Every option of the declared index matches an index that is really there, and the deployment is
        still refused because the folded rule is enforced beside it."""
        from strands.types.exceptions import StorageError

        collection = self._both(folding_first=True)

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[self._dedup_spec()], create=True)

        assert "folding_unique" in str(caught.value)

    async def test_the_answer_does_not_depend_on_which_index_was_created_first(self) -> None:
        """The answer does not depend on creation order: two orderings of one deployment, one answer."""
        from strands.types.exceptions import StorageError

        for folding_first in (True, False):
            with pytest.raises(StorageError):
                await _indexes.ensure(
                    self._both(folding_first=folding_first), ordinary=[self._dedup_spec()], create=True
                )

    async def test_the_message_names_the_index_that_is_actually_the_problem(self) -> None:
        """Not the declared index, which is correct and is not what anyone needs to act on. Whoever reads
        this has to find one index among several over the same keys, so it needs the name and the locale."""
        from strands.types.exceptions import StorageError

        collection = self._both(folding_first=True)

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[self._dedup_spec()], create=True)

        message = str(caught.value)
        assert "'en'" in message
        assert "dropIndex" in message

    async def test_nothing_is_created_on_the_way_to_the_refusal(self) -> None:
        """``create=True`` has nothing to do here: the declared index is present and correct."""
        from strands.types.exceptions import StorageError

        collection = self._both(folding_first=True)

        with pytest.raises(StorageError):
            await _indexes.ensure(collection, ordinary=[self._dedup_spec()], create=True)

        assert collection.created_indexes == []

    async def test_a_second_binary_index_over_the_same_keys_is_accepted(self) -> None:
        """The first vacuity guard. A fix that refused whenever it found more than one index over a key
        list would pass every test above, and refuse a deployment with nothing wrong with it."""
        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(
            indexes={
                dedup.name: existing(*dedup.keys, **dedup.options),
                "theirs": existing(*dedup.keys, **dedup.options),
            }
        )

        await _indexes.ensure(collection, ordinary=[dedup], create=True)

        assert collection.created_indexes == []

    async def test_a_folding_index_enforcing_nothing_beside_a_correct_one_is_accepted(self) -> None:
        """The second, and the narrower one. What is refused is a folded *constraint*, not a folded index:
        a non-unique collated index over the same keys enforces no rule, so there is no rule to be wrong
        about. A guard that refused every folding sibling would refuse deployments with nothing wrong."""
        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(
            indexes={
                dedup.name: existing(*dedup.keys, **dedup.options),
                "theirs": existing(*dedup.keys, collation=self.FOLDING),
            }
        )

        await _indexes.ensure(collection, ordinary=[dedup], create=True)

        assert collection.created_indexes == []

    async def test_a_folding_index_enforcing_nothing_and_alone_is_still_refused(self) -> None:
        """The third, guarding the guard above. Relaxing the folding-sibling rule must not relax the
        single-index collation rule: alone, that index is the only one over those keys, this package's binary queries
        cannot use it, and it is refused for that reason rather than for a constraint it does not hold."""
        from strands.types.exceptions import StorageError

        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(indexes={"theirs": existing(*dedup.keys, collation=self.FOLDING)})

        with pytest.raises(StorageError):
            await _indexes.ensure(collection, ordinary=[dedup], create=True)


class TestADateOnlyIndexIsNotHeldToAStringRule:
    """AT-197 — a date-only index is exempt from the collation rule.

    A collation changes how an index compares strings. ``strands_expires_at_ttl`` is keyed on
    ``expires_at`` alone, is non-unique, and holds a BSON date or nothing at all, so it never compares a
    string. Holding it to the collation rule would refuse a working deployment and tell the operator to
    drop an index that does its job.

    A collated TTL index does its job: over a TTL index built ``{locale: "en", strength: 2}`` on 7.0.12,
    a document stamped an hour in the past is removed and a document with ``expires_at: null`` is left
    alone, the same two outcomes the binary TTL index produces.
    """

    FOLDING: Final[dict[str, Any]] = {"locale": "en", "strength": 2}

    @staticmethod
    def _ttl_spec() -> _indexes.IndexSpec:
        """The TTL spec, taken from ``storage_specs`` so both surfaces are covered by one declaration."""
        return _indexes.storage_specs()[0]

    async def test_a_collated_ttl_index_is_accepted(self) -> None:
        """A collated TTL index is accepted, because nothing about this deployment is wrong."""
        spec = self._ttl_spec()
        collection: Any = FakeAsyncCollection(
            indexes={spec.name: existing(*spec.keys, **spec.options, collation=self.FOLDING)}
        )

        await _indexes.ensure(collection, ordinary=[spec], create=True)

        assert collection.created_indexes == []

    async def test_the_whole_memory_index_set_is_accepted_over_a_collated_ttl_index(self) -> None:
        """The same case through the call ``MongoDBMemoryStore.initialize()`` makes, with the whole memory
        index set. Refusing here would leave the store unusable."""
        specs = _indexes.memory_specs()
        indexes: dict[str, Any] = {}
        for spec in specs:
            folding = self.FOLDING if spec.name.endswith("_ttl") else {}
            indexes[spec.name] = existing(*spec.keys, **spec.options, **({"collation": folding} if folding else {}))
        collection: Any = FakeAsyncCollection(indexes=indexes)

        await _indexes.ensure(collection, ordinary=specs, create=True)

        assert collection.created_indexes == []

    async def test_the_exemption_is_declared_on_the_spec_rather_than_guessed(self) -> None:
        """Which specs are exempt is a fact about what this package writes into those fields, so it is
        recorded where the other facts about a declared index live. Asserted because the alternative,
        matching on a field name or an index name, would be guessing about documents nothing has read."""
        by_name = {spec.name: spec for spec in _indexes.memory_specs()}

        assert by_name["strands_expires_at_ttl"].date_only is True

    async def test_the_recency_index_is_not_exempt(self) -> None:
        """The vacuity guard, and the one that keeps the exemption from swallowing the rule.
        ``strands_scope_store_created_at`` keys ``scope`` and ``store_name`` as well, both strings this
        package compares exactly, so a folding collation on it is still refused."""
        from strands.types.exceptions import StorageError

        spec = next(s for s in _indexes.memory_specs() if s.name.endswith("_created_at"))
        collection: Any = FakeAsyncCollection(
            indexes={spec.name: existing(*spec.keys, **spec.options, collation=self.FOLDING)}
        )

        assert spec.date_only is False
        with pytest.raises(StorageError):
            await _indexes.ensure(collection, ordinary=[spec], create=True)

    async def test_the_dedup_index_is_not_exempt(self) -> None:
        """The second vacuity guard. A folding dedup index has to keep failing, or the exemption has
        removed the rule it narrows."""
        from strands.types.exceptions import StorageError

        spec = next(s for s in _indexes.memory_specs() if s.options.get("unique"))
        collection: Any = FakeAsyncCollection(
            indexes={spec.name: existing(*spec.keys, **spec.options, collation=self.FOLDING)}
        )

        assert spec.date_only is False
        with pytest.raises(StorageError):
            await _indexes.ensure(collection, ordinary=[spec], create=True)

    async def test_a_date_only_index_this_package_creates_carries_no_collation(self) -> None:
        """The exemption is about reading somebody else's index, not about building one. Nothing here
        ever creates a collated index, and if that changed the exemption would be hiding it."""
        spec = self._ttl_spec()

        assert "collation" not in spec.creation_command("memory")


def search_states(name: str, *statuses: str, definition: Mapping[str, Any] | None = None) -> Any:
    """Program a search index's successive ``list_search_indexes`` reads from a status sequence.

    Args:
        name: Index name the poll loop will ask for.
        statuses: One status per read, in order. ``""`` means the index is absent on that read.
        definition: What ``latestDefinition`` reports, when the caller cares.

    Returns:
        A ``search_states`` mapping for :class:`FakeAsyncCollection`.
    """
    reads: list[list[dict[str, Any]]] = []
    for status in statuses:
        if not status:
            reads.append([])
            continue
        document: dict[str, Any] = {"name": name, "status": status, "queryable": status == "READY"}
        if definition is not None:
            document["latestDefinition"] = definition
        reads.append([document])
    return {name: reads}


class TestSearchIndexesAgainstAFake:
    """Search indexes: the three build states, the status vocabulary, and the namespace errors swallowed.

    An asynchronous build is the one thing a fake models well: the states are just successive reads.
    What a fake cannot show is that the states occur, which is what ``TestSearchIndexesAgainstAtlas``
    goes to Atlas for.
    """

    async def test_a_missing_index_is_created_and_then_polled_to_ready(self) -> None:
        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "", "BUILDING", "READY"))

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert len(collection.created_search_indexes) == 1

    async def test_the_collection_is_created_before_the_search_index(self) -> None:
        """AT-068 — the collection is created first. ``createSearchIndexes`` against a missing namespace
        is code 26, while ``createIndexes`` creates the collection implicitly. The reference
        implementation's otherwise odd list-then-create is required rather than defensive."""
        collection: Any = FakeAsyncCollection(name="memory", search_states=search_states("vector_index", "", "READY"))

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert collection.database.create_collection_calls[0][0] == "memory"

    async def test_the_collection_is_created_without_a_client_side_existence_check(self) -> None:
        """``check_exists=False`` removes a check-then-act race and a round trip. It also removes
        ``CollectionInvalid`` from the picture entirely: pymongo raises that only from the
        client-side branch, so a server-side race arrives as code 48 instead."""
        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "", "READY"))

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert collection.database.create_collection_calls[0][1] == {"check_exists": False}

    async def test_a_collection_that_already_exists_is_not_an_error(self) -> None:
        """Code 48 is ``NamespaceExists``, which is the outcome the check we skipped was predicting.
        On 8.3.8 with ``check_exists=False`` the second create is silently accepted and 48 never
        arrives, so this branch is defense in depth for other server versions. Driven from a fake
        rather than left as an unexercised line."""
        collection: Any = FakeAsyncCollection(
            database=FakeAsyncDatabase(create_error=operation_failure(48, "NamespaceExists")),
            search_states=search_states("vector_index", "", "READY"),
        )

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert len(collection.created_search_indexes) == 1

    async def test_a_collection_creation_failure_that_is_not_code_48_surfaces(self) -> None:
        """Only 48 is swallowed. Code 13 means the caller may not create collections, which is
        information rather than noise."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(
            database=FakeAsyncDatabase(create_error=operation_failure(13, "not authorized")),
            search_states=search_states("vector_index", "", "READY"),
        )

        with pytest.raises(StorageError):
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=True,
                interval=0,
            )

    async def test_an_index_already_ready_is_left_alone_and_the_collection_is_not_touched(self) -> None:
        """A second ``initialize()`` on a warm deployment should cost two reads and no writes."""
        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "READY"))

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert collection.created_search_indexes == []
        assert collection.database.create_collection_calls == []

    @pytest.mark.parametrize("status", ["PENDING", "BUILDING", "STAGED", "SOMETHING_NEW"])
    async def test_every_status_that_is_not_ready_or_failed_is_read_as_building(self, status: str) -> None:
        """Only the two terminal statuses are named, and everything else waits, because the server's full
        status vocabulary is not pinned down: ``PENDING``, for one, occurs on 8.3.8. ``READY`` is ready,
        ``FAILED`` is missing-with-detail. An unrecognised status read as building costs one poll; read
        as ready, search returns zero documents and the user reads it as the agent forgetting."""
        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", status, "READY"))

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert collection.created_search_indexes == []

    async def test_a_failed_build_raises_with_the_failure_detail(self) -> None:
        """AT-062a's sibling: a failed build raises with its detail, a branch Atlas local does not
        produce. Reported rather than recreated: an identical definition is accepted while a build is
        failed and does not restart it, so a create here would wait out the whole timeout to learn what
        the status already said. The remedy needs a drop, and dropping an index is not ours to do."""
        from strands.types.exceptions import StorageError

        states: dict[str, Sequence[list[dict[str, Any]]]] = {
            "vector_index": [
                [
                    {
                        "name": "vector_index",
                        "status": "FAILED",
                        "queryable": False,
                        "latestDefinition": {},
                        "statusDetail": [{"hostname": "mongot-0", "mainIndex": {"message": "oom"}}],
                    }
                ]
            ]
        }
        collection: Any = FakeAsyncCollection(search_states=states)

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=True,
                interval=0,
            )

        message = str(caught.value)
        assert "FAILED" in message
        assert "oom" in message
        assert "dropSearchIndex" in message

    async def test_a_build_that_fails_partway_through_raises_rather_than_waiting_it_out(self) -> None:
        """The same state reached from the other direction, and the one a fake is needed for.

        The test above finds ``FAILED`` on the first read, which is what a second ``initialize()`` sees.
        This is what the *first* one sees: the build starts, reports ``BUILDING``, and then fails. Both
        paths have to raise, because waiting for a failed build to become ready is a 300 second wait for
        a status that will not change.

        Which is why the call is ``bounded``: this test's name is a claim about *not* waiting, and
        without a bound the version that waits still fails, five minutes later, on the default timeout.
        """
        from strands.types.exceptions import StorageError

        failed = {
            "name": "vector_index",
            "status": "FAILED",
            "queryable": False,
            "statusDetail": [{"hostname": "mongot-0", "mainIndex": {"message": "disk full"}}],
        }
        collection: Any = FakeAsyncCollection(
            search_states={"vector_index": [[{"name": "vector_index", "status": "BUILDING"}], [failed]]}
        )

        with pytest.raises(StorageError) as caught:
            await bounded(
                _indexes.ensure(
                    collection,
                    search=[_indexes.memory_search_specs({"database": "d"})[0]],
                    create=False,
                    interval=0,
                )
            )

        assert "disk full" in str(caught.value)

    async def test_an_index_dropped_mid_build_is_waited_for_rather_than_recreated(self) -> None:
        """A gap in the states nothing else covers: the index was there on the first read and is gone on
        the second, because something else dropped it.

        Waiting is the only move left. Reporting ready would be false, and creating it would race
        whoever is holding the other end of the drop. So the wait runs out and the timeout message says
        the index is absent, which is the one thing the reader could not have guessed.
        """
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "BUILDING", ""))

        with pytest.raises(StorageError, match="absent"):
            await bounded(
                _indexes.ensure(
                    collection,
                    search=[_indexes.memory_search_specs({"database": "d"})[0]],
                    create=False,
                    timeout=0,
                    interval=0,
                )
            )

    async def test_the_timeout_message_does_not_promise_a_retry_under_auto(self) -> None:
        """Under ``auto`` a tier that times out is dropped and ``initialize()`` returns early ever after,
        so advice to call it again would do nothing there. The message has to say which stores it helps."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "BUILDING"))

        with pytest.raises(StorageError) as caught:
            await bounded(
                _indexes.ensure(
                    collection,
                    search=[_indexes.memory_search_specs({"database": "d"})[0]],
                    create=False,
                    timeout=0,
                    interval=0,
                )
            )

        message = str(caught.value)
        assert "named search_type" in message
        assert "'auto'" in message

    async def test_a_present_index_with_a_different_definition_raises(self) -> None:
        """Re-issuing a *different* definition under an existing name is code 68, *"already
        exists with a different definition. Drop it first if needed."* That, and not the fact that
        re-creation fails, is what makes the reference's list-then-bail pattern worth keeping."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[0]
        collection: Any = FakeAsyncCollection(
            search_states=search_states(
                spec.name, "READY", definition={"fields": [{"type": "vector", "path": "other"}]}
            )
        )

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert "dropSearchIndex" in str(caught.value)
        assert collection.created_search_indexes == []

    async def test_an_identical_definition_is_a_match_even_reported_back_by_the_server(self) -> None:
        """``latestDefinition`` round-trips byte for byte for a ``vectorSearch`` index, measured on
        8.3.8. Asserted rather than assumed, because it is half of what makes definitions comparable
        and it is the half that does **not** generalise: see the text-index tests below."""
        spec = _indexes.memory_search_specs({"database": "d"})[0]
        collection: Any = FakeAsyncCollection(
            search_states=search_states(spec.name, "READY", definition=spec.definition)
        )

        await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert collection.created_search_indexes == []

    async def test_the_definition_mongot_rewrites_for_a_text_index_is_still_a_match(self) -> None:
        """AT-069 — the definition mongot reports back for a text index still matches what was declared.

        The reported shape below is copied from mongot 8.3.8 rather than constructed: it collapses the
        one-element list we sent into the object it held and fills in three defaults nobody asked for.
        Comparing for equality passes on the vector index above and fails here, so every second
        ``initialize()`` would refuse to run over a text index the first one created.
        """
        spec = _indexes.memory_search_specs({"database": "d"})[1]
        rewritten = {
            "mappings": {
                "dynamic": False,
                "fields": {
                    "content": {
                        "type": "string",
                        "indexOptions": "offsets",
                        "store": True,
                        "norms": "include",
                    }
                },
            }
        }
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=rewritten))

        await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert collection.created_search_indexes == []

    async def test_a_text_index_mapped_over_a_different_field_is_a_mismatch(self) -> None:
        """The reason tolerating the rewrite cannot become tolerating anything. A ``text_index`` that
        another library built over its own field name is present, healthy, and answers every search this
        package issues with nothing."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[1]
        theirs = {"mappings": {"dynamic": False, "fields": {"text": {"type": "string"}}}}
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=theirs))

        with pytest.raises(StorageError, match="dropSearchIndex"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_a_vector_index_with_the_wrong_dimension_count_is_a_mismatch(self) -> None:
        """The same failure on the vector side, and the likelier one: 1536 is what an OpenAI-shaped
        ``vector_index`` carries, and a query vector of a different length is rejected per query rather
        than at initialize."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d", "embedding_dimensions": 1024, "similarity": "cosine"})[0]
        theirs = {
            "fields": [
                {"type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine"},
                {"type": "filter", "path": "scope"},
                {"type": "filter", "path": "store_name"},
            ]
        }
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=theirs))

        with pytest.raises(StorageError, match="numDimensions"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_a_missing_filter_path_is_a_mismatch(self) -> None:
        """The filter-path declaration, checked on the verify path. The server rejects a query that
        filters on an undeclared path (code 8), so an index that never declared ``store_name`` filterable
        fails every query this package issues. Refusing it at ``initialize()`` names the cause."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[0]
        theirs = {
            "fields": [
                dict(spec.definition["fields"][0]),
                {"type": "filter", "path": "scope"},
            ]
        }
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=theirs))

        with pytest.raises(StorageError, match="store_name"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_fields_the_server_or_another_tool_added_are_not_mismatches(self) -> None:
        """Same rule as the ordinary indexes, reached from the same direction: the comparison covers
        what this package declared. An extra filter path somebody else needs costs nothing here, and
        failing over it would make this package refuse to share a collection."""
        spec = _indexes.memory_search_specs({"database": "d"})[0]
        theirs = {
            "fields": [
                *(dict(f) for f in spec.definition["fields"]),
                {"type": "filter", "path": "their_own_field"},
            ]
        }
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=theirs))

        await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert collection.created_search_indexes == []

    async def test_dynamic_mapping_turned_on_is_a_mismatch(self) -> None:
        """``dynamic: True`` is a scalar difference rather than a missing key, so it exercises the other
        half of the comparison. It also matters on its own: dynamic mapping indexes every field of every
        document, including whatever a caller attached to a memory."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[1]
        theirs = {"mappings": {"dynamic": True, "fields": {"content": {"type": "string"}}}}
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=theirs))

        with pytest.raises(StorageError, match="dynamic"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_verify_only_raises_with_the_search_creation_command(self) -> None:
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", ""))

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=False,
                interval=0,
            )

        assert "createSearchIndex" in str(caught.value)
        assert collection.created_search_indexes == []

    async def test_verify_only_still_waits_for_a_build_somebody_else_started(self) -> None:
        """Building is not missing, and the remedy for building is to wait. Returning early would hand
        the caller a store whose searches return nothing, which is the failure verification exists to
        prevent."""
        collection: Any = FakeAsyncCollection(
            search_states=search_states("vector_index", "BUILDING", "BUILDING", "READY")
        )

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=False,
            interval=0,
        )

        assert collection.created_search_indexes == []

    async def test_a_build_that_never_finishes_times_out_naming_the_last_status(self) -> None:
        """300 seconds of silence followed by a bare timeout tells the reader nothing. The status is
        the actionable part: ``BUILDING`` at timeout is a slow build, and anything else is a status this
        package does not recognise.

        The call goes through ``bounded`` for the reason recorded there: this is one of the two tests
        whose termination would otherwise depend on the deadline check it is testing.
        """
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "BUILDING"))

        with pytest.raises(StorageError) as caught:
            await bounded(
                _indexes.ensure(
                    collection,
                    search=[_indexes.memory_search_specs({"database": "d"})[0]],
                    create=True,
                    timeout=0,
                    interval=0,
                )
            )

        message = str(caught.value)
        assert "BUILDING" in message
        assert "vector_index" in message

    async def test_the_default_timeout_is_measured_and_the_interval_matches_the_reference(self) -> None:
        """AT-125 — the default readiness timeout is 300 seconds, and the poll interval is the reference's.

        ``pymongo_search_utils`` polls with ``TIMEOUT = 120`` and ``INTERVAL = 0.5``. On cloud Atlas, two
        index builds on an idle cluster take about 105 seconds, and one build on a cluster carrying other
        collections has run past 120. That puts 120 inside the observed range, the one place a budget must
        not sit, so the timeout is longer.

        The interval is the reference's. Raising a ceiling changes when a failure arrives and not when a
        success does, and the poll frequency is what decides the latter.
        """
        assert _indexes.READY_TIMEOUT_SECONDS == 300
        assert _indexes.POLL_INTERVAL_SECONDS == 0.5

    async def test_polling_yields_to_the_event_loop_between_reads(self) -> None:
        """Polling never blocks the event loop. The reference helpers use a blocking ``time.sleep``, which
        in an async agent stalls every other coroutine on the loop for the whole wait."""
        collection: Any = FakeAsyncCollection(
            search_states=search_states("vector_index", "BUILDING", "BUILDING", "READY")
        )
        ticks = 0

        async def tick() -> None:
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0)

        ticker = asyncio.create_task(tick())
        try:
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=False,
                interval=0,
            )
        finally:
            ticker.cancel()

        assert ticks > 0

    async def test_a_read_against_a_collection_that_does_not_exist_reads_as_absent(self) -> None:
        """The other half of the missing-namespace asymmetry, on the read rather than the write.

        pymongo normalises code 26 for ordinary indexes itself: ``list_indexes`` passes
        ``allowable_errors=[26]``, so ``index_information()`` on a missing collection answers ``{}``.
        ``list_search_indexes`` carries no such allowance, and it is an aggregate rather than a command,
        so the same normalisation is done here. Raising instead would mean a first ``initialize()``
        against a fresh database fails before it has created anything.
        """
        spec = _indexes.memory_search_specs({"database": "d"})[0]
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY"))
        real = collection.list_search_indexes
        reads = 0

        async def missing_namespace_on_the_first_read(name: str | None = None) -> Any:
            nonlocal reads
            reads += 1
            if reads == 1:
                raise operation_failure(26, "ns does not exist: testdb.memory")
            return await real(name)

        collection.list_search_indexes = missing_namespace_on_the_first_read

        await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert len(collection.created_search_indexes) == 1

    async def test_a_read_that_fails_for_any_other_reason_surfaces(self) -> None:
        """Only 26 is swallowed. Code 13 means the caller may not list search indexes, and treating
        that as "no indexes exist" would drive a create that fails the same way one call later.

        ``bounded`` because the wrong behaviour here is a *slow* pass into the poll loop rather than a
        fast wrong answer: swallowing code 13 sends this call to the default 300 second timeout.
        """
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()
        collection.list_search_indexes = raiser(operation_failure(13, "not authorized"))

        with pytest.raises(StorageError, match="vector_index"):
            await bounded(
                _indexes.ensure(
                    collection,
                    search=[_indexes.memory_search_specs({"database": "d"})[0]],
                    create=True,
                    interval=0,
                )
            )

        assert collection.created_search_indexes == []

    async def test_a_read_that_never_reached_the_server_surfaces(self) -> None:
        """A ``PyMongoError`` that is not an ``OperationFailure`` has no ``code`` to compare, which is
        why there are two handlers rather than one ``if error.code != 26``. Comparing a code on this
        exception raises ``AttributeError`` from inside the error handler, losing the real cause."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()
        collection.list_search_indexes = raiser(network_failure())

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=True,
                interval=0,
            )

        assert "socket timed out" in str(caught.value.__cause__)

    async def test_a_collection_creation_that_never_reached_the_server_surfaces(self) -> None:
        """Same two-handler reasoning as the read above, on ``create_collection``. Code 48 is the only
        swallowed outcome, and a dropped connection carries no code to compare it against."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(
            database=FakeAsyncDatabase(create_error=network_failure()),
            search_states=search_states("vector_index", "", "READY"),
        )

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=True,
                interval=0,
            )

        assert "creating the collection" in str(caught.value)
        assert collection.created_search_indexes == []

    async def test_an_object_reported_where_one_was_declared_is_a_mismatch(self) -> None:
        """The definition comparison walks nested objects, so it has to answer for a reported value of
        the wrong *kind* as well as the wrong value. Reachable in practice: mongot rewrites ``search``
        definitions, so a future rewrite could flatten ``mappings`` into something that is not
        an object, and the comparison must say so rather than raise ``AttributeError``."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[1]
        collection: Any = FakeAsyncCollection(
            search_states=search_states(spec.name, "READY", definition={"mappings": "dynamic"})
        )

        with pytest.raises(StorageError, match="declared the object"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_a_list_reported_as_a_scalar_is_a_mismatch(self) -> None:
        """The list arm of the same question. A single declared entry is allowed to arrive as a bare
        object, because that is exactly what mongot does to ``fields`` inside a ``search`` mapping, but
        a string is neither and reports as a mismatch rather than being coerced."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[0]
        collection: Any = FakeAsyncCollection(
            search_states=search_states(spec.name, "READY", definition={"fields": "everything"})
        )

        with pytest.raises(StorageError, match="declared the list"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_a_status_is_logged_when_it_changes_and_not_on_every_poll(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A build that takes the full 300 seconds is 600 polls. Logging each one buries the operator's
        own output; logging none makes a slow build indistinguishable from a hang. The line is therefore
        per transition, which is also the only signal that says which of the two is happening."""
        spec = _indexes.memory_search_specs({"database": "d"})[0]
        collection: Any = FakeAsyncCollection(
            search_states=search_states(spec.name, "BUILDING", "BUILDING", "BUILDING", "READY")
        )

        with caplog.at_level(logging.INFO, logger="strands_mongodb"):
            await _indexes.ensure(collection, search=[spec], create=False, interval=0)

        statuses = [record.getMessage() for record in caplog.records if spec.name in record.getMessage()]
        assert sum("BUILDING" in message for message in statuses) == 1, statuses
        assert sum("READY" in message for message in statuses) == 1, statuses


class TestReadinessIsAboutTheDefinitionAndNotOnlyTheStatus:
    """AT-180 — an index that reports READY is checked against the declared definition, not only its status.

    ``_ensure_search`` checks each existing index's definition on its cold read, then hands whatever is
    still building to ``_wait_until_ready``. Reading ``status`` alone there would accept two cases:

    * an index found BUILDING with a covering definition, dropped and recreated by another actor while
      this loop polls, reporting READY with a definition that no longer covers this package's. A search
      index cannot be redefined in place, but drop-and-recreate is exactly the remedy the cold-path
      message prints, so the other actor is as likely to be an operator following this package's own
      instructions as anything else;
    * an index this package created itself one call earlier. The cold read found nothing, so
      ``_ensure_search`` had no document to check, and the only later document is the one the poll reads.

    Accepting either would be a silent empty result: every index reports READY, ``initialize()`` returns,
    and searches return nothing or the wrong thing. The recheck is one containment check over a document
    already in hand.

    There is no contract-tier sibling, because two Atlas tests already cover the recheck's only way to be
    wrong, which is being over-strict about what a real mongot reports back.
    ``test_the_vector_definition_the_server_reports_back_is_the_one_we_sent`` and
    ``test_the_text_definition_is_covered_whether_or_not_the_server_rewrites_it`` both run ``ensure`` with
    ``create=True`` over a fresh collection, so both poll a real build to READY through this branch, and
    both fail if the containment rule stops covering the rewrite mongot 8.3.8 performs.
    """

    DRIFTED: Final[dict[str, Any]] = {
        "fields": [{"type": "autoEmbed", "path": "content", "model": "voyage-3-lite", "modality": "text"}]
    }
    """The declared vector definition with a different embedding model and both filter paths gone.

    Not an arbitrary edit. A cheaper model is the single most plausible thing somebody changes by hand,
    and dropping ``filter`` on ``scope`` is the change that makes ``$vectorSearch`` refuse the scope term
    ``_filter.compose`` pins on every read.
    """

    @staticmethod
    def _spec() -> _indexes.SearchIndexSpec:
        """The vector spec, whose definition has three declared fields to drift away from."""
        return _indexes.memory_search_specs({"database": "d"})[0]

    async def test_a_definition_that_drifts_during_the_build_is_refused_when_it_reports_ready(self) -> None:
        """The definition covers on the read before the poll and does not cover on the read that ends it."""
        from strands.types.exceptions import StorageError

        spec = self._spec()
        collection: Any = FakeAsyncCollection(
            search_states={
                spec.name: [
                    [{"name": spec.name, "status": "BUILDING", "latestDefinition": spec.definition}],
                    [{"name": spec.name, "status": "READY", "latestDefinition": self.DRIFTED}],
                ]
            }
        )

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, search=[spec], create=False, interval=0)

        assert "voyage-4-lite" in str(caught.value)

    async def test_an_index_this_package_created_is_checked_against_what_the_server_built(self) -> None:
        """The second way in, and the one that needs no other actor at all.

        Absent on the cold read, so ``_ensure_search`` creates it and appends it to ``waiting`` with no
        document to check. Everything known about that index afterwards arrives through the poll, so the
        recheck is what compares it with the model that was sent.
        """
        from strands.types.exceptions import StorageError

        spec = self._spec()
        collection: Any = FakeAsyncCollection(
            search_states={spec.name: [[], [{"name": spec.name, "status": "READY", "latestDefinition": self.DRIFTED}]]}
        )

        with pytest.raises(StorageError, match="does not cover"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert collection.created_search_indexes != []

    async def test_the_refusal_carries_the_same_remedy_as_the_cold_path(self) -> None:
        """One message for one condition, wherever it is noticed.

        The recheck reuses ``_check_definition`` rather than composing its own sentence, so an operator who
        hits this on the second ``initialize()`` and an operator who hits it on the first read the same two
        commands. Asserted because a hand-written message here is the obvious shortcut.
        """
        from strands.types.exceptions import StorageError

        spec = self._spec()
        collection: Any = FakeAsyncCollection(
            search_states={
                spec.name: [
                    [{"name": spec.name, "status": "BUILDING", "latestDefinition": spec.definition}],
                    [{"name": spec.name, "status": "READY", "latestDefinition": self.DRIFTED}],
                ]
            }
        )

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, search=[spec], create=False, interval=0)

        message = str(caught.value)
        assert "dropSearchIndex" in message
        assert "createSearchIndex" in message

    async def test_a_build_whose_definition_still_covers_is_accepted(self) -> None:
        """The vacuity guard. A recheck that refused every polled index would pass all three tests above
        and make every asynchronous build unusable, which is most of what readiness polling is for."""
        spec = self._spec()
        collection: Any = FakeAsyncCollection(
            search_states=search_states(spec.name, "BUILDING", "READY", definition=spec.definition)
        )

        await _indexes.ensure(collection, search=[spec], create=False, interval=0)

    async def test_a_report_that_carries_no_definition_is_not_a_gap(self) -> None:
        """``latestDefinition`` absent means *unknown*, and unknown is not *wrong*.

        mongot 8.3.8 sends it on every read, so this is a shape the fake produces more readily than a
        deployment does. It is still the right default: the alternative is a recheck that turns a field
        this package does not control into a hard failure at the end of a 300 second build. The cold-path
        definition check makes the same choice, and the recheck inherits it rather than deciding again.
        """
        spec = self._spec()
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "BUILDING", "READY"))

        await _indexes.ensure(collection, search=[spec], create=False, interval=0)

    async def test_the_recheck_reads_nothing_the_poll_was_not_already_reading(self) -> None:
        """The recheck costs no extra reads.

        A recheck implemented as its own ``list_search_indexes`` would double the reads on every poll of
        every build, to 1200 aggregations over a 300 second one. The document is already in hand from the
        status read, so the count is the count the loop had before: one per read of the index, and this
        script needs two of them. The cold read in ``_ensure_search`` finds BUILDING and the first poll
        finds READY, which is also why the definition has to be rechecked at all: the loop's own reads
        are the only ones that ever see the finished build.
        """
        spec = self._spec()
        collection: Any = FakeAsyncCollection(
            search_states=search_states(spec.name, "BUILDING", "READY", definition=spec.definition)
        )

        await _indexes.ensure(collection, search=[spec], create=False, interval=0)

        # The cold read consumes BUILDING, the first poll consumes READY. The count is 2 and not 3,
        # because `_ensure_search`'s read is one of the two rather than an extra one.
        assert collection._search_reads[spec.name] == 2

    async def test_one_drifted_index_beside_one_clean_one_names_the_drifted_one(self) -> None:
        """Two indexes are waited on together, and the message has to say which of them is the problem."""
        from strands.types.exceptions import StorageError

        vector, text = _indexes.memory_search_specs({"database": "d"})
        collection: Any = FakeAsyncCollection(
            search_states={
                vector.name: [[{"name": vector.name, "status": "READY", "latestDefinition": vector.definition}]],
                text.name: [
                    [{"name": text.name, "status": "BUILDING", "latestDefinition": text.definition}],
                    [{"name": text.name, "status": "READY", "latestDefinition": {"mappings": {"dynamic": True}}}],
                ],
            }
        )

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, search=[vector, text], create=False, interval=0)

        assert text.name in str(caught.value)
        assert vector.name not in str(caught.value)


class TestTheCapabilityProbeAgainstAFake:
    """AT-053d — the three server codes that mean "this deployment has no Atlas Search".

    Each deployment answers with one of the three, so the contract tier, which sees one deployment per
    run, cannot show that the probe accepts all of them. These run against a fake, so all three codes and
    one unrecognised code are driven through the probe in a run that needs no deployment at all.

    What each test below asserts is the branch, not the number: `False` and the code for a deployment
    without search, `True` for one with it, and `StorageError` for anything the set does not name.
    """

    async def test_a_deployment_that_lists_its_search_indexes_supports_search(self) -> None:
        """The ordinary answer, and the one that carries no code: nothing failed, so nothing was seen."""
        collection: Any = FakeAsyncCollection()

        support = await _indexes.search_support(collection)

        assert support.available is True
        assert support.code is None

    @pytest.mark.parametrize("code", [31082, 115, 6047401])
    async def test_each_measured_code_degrades_and_reports_itself(self, code: int) -> None:
        """All three, because the deployment that answers 115 is as real as the one that answers 31082.

        The code comes back rather than being discarded, so the warning `initialize()` logs can name the
        one in the operator's own log instead of a fixed one.
        """
        collection: Any = FakeAsyncCollection()
        collection.list_search_indexes = raiser(operation_failure(code, "no search here"))

        support = await _indexes.search_support(collection)

        assert support.available is False
        assert support.code == code

    async def test_a_code_outside_the_measured_set_raises_rather_than_reading_as_no_search(self) -> None:
        """Code 13 is a wrong password, and reporting it as a deployment without Atlas Search would send
        the caller to buy a cluster they already have. The closed set is what keeps that legible."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()
        collection.list_search_indexes = raiser(operation_failure(13, "not authorized"))

        with pytest.raises(StorageError, match="probing Atlas Search support"):
            await _indexes.search_support(collection)

    async def test_the_code_create_search_index_answers_with_is_not_in_the_set(self) -> None:
        """Code 59 means the same thing on 6.0.28 and 7.0.40, and is deliberately not matched here.

        It arrives at `create_search_index`, which never runs until this probe has already cleared the
        deployment, so matching it would be a claim about a call this package cannot reach in that state.
        Asserting the exclusion keeps it a decision rather than an oversight.
        """
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()
        collection.list_search_indexes = raiser(operation_failure(59, "no such command"))

        with pytest.raises(StorageError):
            await _indexes.search_support(collection)

    async def test_a_collection_that_does_not_exist_still_answers_the_question(self) -> None:
        """Code 26 is not a failed probe. An absent collection has no search indexes, and the *call*
        worked, which is what was being asked. A fresh database must not fail its first `initialize()`."""
        collection: Any = FakeAsyncCollection()
        collection.list_search_indexes = raiser(operation_failure(26, "ns does not exist"))

        support = await _indexes.search_support(collection)

        assert support.available is True
        assert support.code is None

    async def test_a_probe_that_never_reached_the_server_raises(self) -> None:
        """A `PyMongoError` that is not an `OperationFailure` has no `code` to compare against the set,
        so it needs the second handler. Comparing one would raise `AttributeError` from inside the
        handler and lose the cause, which is the same two-handler argument as the read path above."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()
        collection.list_search_indexes = raiser(network_failure())

        with pytest.raises(StorageError) as caught:
            await _indexes.search_support(collection)

        assert "socket timed out" in str(caught.value.__cause__)


class TestTheRankFusionProbeAgainstAFake:
    """AT-145 — whether the deployment can run ``$rankFusion``, from its own version.

    The opposite shape from the probe above, deliberately. ``search_support`` must be a *call* because
    Atlas Search is mongot, a separate process no version number predicts: a 7.0.12 deployment can report
    ``modules: ['enterprise']`` and have no search. ``$rankFusion`` is an aggregation stage inside
    ``mongod`` itself, so ``mongod``'s own version is not merely adequate for it but authoritative.

    ``versionArray`` rather than a parse of ``version``: the server computes the former as integers,
    and the latter is a string carrying things like ``"8.0.23-rc1"`` whose parsing this package would
    then own.
    """

    @pytest.mark.parametrize(
        ("version_array", "expected"),
        [
            ((6, 0, 28, 0), False),
            ((7, 0, 12, 0), False),
            ((8, 0, 0, 0), True),
            ((8, 0, 23, 0), True),
            ((8, 2, 1, 0), True),
            ((9, 0, 0, 0), True),
        ],
    )
    async def test_the_major_version_is_what_decides(self, version_array: tuple[int, ...], expected: bool) -> None:
        """8.0 is the floor, not 8.1. The MongoDB 8.0 manual states it in the stage's own compatibility
        note and permits ``$vectorSearch`` in an input pipeline, with a worked example.

        8.0.23 is among these because it is what the target deployments report, and a floor one minor
        version too high would turn the hybrid tier off there for no reason.
        """
        collection: Any = FakeAsyncCollection(database=FakeAsyncDatabase(version_array=version_array))

        assert await _indexes.rank_fusion_support(collection) is expected

    async def test_it_reads_build_info_once_per_call(self) -> None:
        """``AT-146``'s per-call half. The per-connection half is the caching in ``memory_store``, which
        is asserted where the cache lives; what this pins is that the probe itself does not fan out."""
        database = FakeAsyncDatabase()
        collection: Any = FakeAsyncCollection(database=database)

        await _indexes.rank_fusion_support(collection)

        assert database.command_calls == ["buildInfo"]

    @pytest.mark.parametrize(
        "payload",
        [{}, {"versionArray": []}, {"versionArray": ["8", 0, 0, 0]}, {"versionArray": None}],
    )
    async def test_a_version_array_the_server_does_not_send_reads_as_unsupported(self, payload: dict[str, Any]) -> None:
        """Absent or malformed, the answer is ``False``.

        Degrading to "no fusion" costs a caller the better tier; degrading to "yes" costs them a query
        that fails on every search against a deployment that cannot run the stage. Only one of those is
        recoverable by the caller, so the unreadable answer resolves to the recoverable one.
        """

        async def command(_command: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
            return payload

        database = FakeAsyncDatabase()
        database.command = command  # type: ignore[method-assign, assignment]
        collection: Any = FakeAsyncCollection(database=database)

        assert await _indexes.rank_fusion_support(collection) is False

    async def test_a_failed_build_info_degrades_rather_than_raising(self) -> None:
        """Unlike ``search_support``, which raises on an unrecognised code so a wrong password does not
        read as a missing cluster. The asymmetry is right: that probe's answer decides whether search
        runs at all, and this one only decides which of two working tiers is preferred. A deployment
        that will not answer ``buildInfo`` has a problem the very next call surfaces anyway.
        """
        database = FakeAsyncDatabase(command_error=operation_failure(13, "not authorized"))
        collection: Any = FakeAsyncCollection(database=database)

        assert await _indexes.rank_fusion_support(collection) is False


class TestTheFakesMatchTheDriver:
    """The parity contract for both fakes in this file: awaitable where the driver is, iterable as it is.

    A fake that returns a value where the driver returns a coroutine passes every test above and fails on
    first real traffic. The check is mechanical on purpose, so it keeps holding as the module grows.
    """

    # Every driver method this module calls, and the arguments it calls them with.
    CALLS: tuple[tuple[str, str, tuple[Any, ...], dict[str, Any]], ...] = (
        ("AsyncCollection", "index_information", (), {}),
        ("AsyncCollection", "create_indexes", ([],), {}),
        ("AsyncCollection", "list_search_indexes", (), {}),
        ("AsyncCollection", "create_search_index", (None,), {}),
        ("AsyncDatabase", "create_collection", ("name",), {"check_exists": False}),
        ("AsyncDatabase", "command", ("buildInfo",), {}),
    )

    @pytest.mark.parametrize(("owner", "method", "args", "kwargs"), CALLS)
    def test_every_method_the_module_calls_is_a_coroutine_function_on_the_real_class(
        self, owner: str, method: str, args: tuple[Any, ...], kwargs: dict[str, Any]
    ) -> None:
        """``async def`` on the fake is worth nothing unless it is ``async def`` upstream."""
        real = getattr(self._driver_class(owner), method)

        assert inspect.iscoroutinefunction(real), f"{owner}.{method} is not a coroutine function"

    @pytest.mark.parametrize(("owner", "method", "args", "kwargs"), CALLS)
    def test_the_real_signature_accepts_the_arguments_we_pass(
        self, owner: str, method: str, args: tuple[Any, ...], kwargs: dict[str, Any]
    ) -> None:
        """A fake with ``**kwargs`` accepts anything. The driver does not, and ``check_exists`` in
        particular is the argument this module's collection creation depends on."""
        signature = inspect.signature(getattr(self._driver_class(owner), method))

        signature.bind(None, *args, **kwargs)

    @pytest.mark.parametrize(("owner", "method", "args", "kwargs"), CALLS)
    def test_the_fake_offers_the_same_method_as_a_coroutine_function(
        self, owner: str, method: str, args: tuple[Any, ...], kwargs: dict[str, Any]
    ) -> None:
        fake = FakeAsyncCollection if owner == "AsyncCollection" else FakeAsyncDatabase

        assert inspect.iscoroutinefunction(getattr(fake, method))

    def test_the_fake_collection_raises_for_an_unknown_attribute(self) -> None:
        """The real ``AsyncCollection.__getattr__`` resolves any unknown name to a sub-collection, so
        ``getattr(collection, "typo")`` is truthy and never raises. The fake is stricter than the driver
        here, deliberately: a typo in the module under test fails in the unit tier rather than on a
        deployment."""
        with pytest.raises(AttributeError):
            FakeAsyncCollection().definitely_not_a_method  # type: ignore[attr-defined]  # noqa: B018

    def test_the_fake_cursor_is_async_iterable(self) -> None:
        """The fake cursor is async-iterable, as the driver's is."""
        cursor = FakeSearchIndexCursor([{"name": "n", "status": "READY"}])

        assert hasattr(cursor, "__aiter__")

    def test_the_fake_cursor_is_not_synchronously_iterable(self) -> None:
        """The half that matters. ``AsyncCommandCursor`` has no ``__iter__``, measured on
        pymongo 4.17.0, so a fake that grew one would let ``for index in cursor`` pass here."""
        assert not hasattr(FakeSearchIndexCursor([]), "__iter__")

    def test_the_real_cursor_is_not_synchronously_iterable_either(self) -> None:
        """The claim above, checked against the class rather than against memory of it."""
        from pymongo.asynchronous.command_cursor import AsyncCommandCursor

        assert hasattr(AsyncCommandCursor, "__aiter__")
        assert not hasattr(AsyncCommandCursor, "__iter__")

    def test_list_search_indexes_is_awaitable_and_returns_the_cursor(self) -> None:
        """Two shapes are plausible and only one is real: ``list_search_indexes`` is itself a
        coroutine, so the cursor arrives from ``await``, not from iterating the call directly. Getting
        this backwards is a ``TypeError`` on a real deployment and nothing at all against a loose
        fake."""
        from pymongo.asynchronous.collection import AsyncCollection

        assert inspect.iscoroutinefunction(AsyncCollection.list_search_indexes)

    @staticmethod
    def _driver_class(owner: str) -> type:
        from pymongo.asynchronous.collection import AsyncCollection
        from pymongo.asynchronous.database import AsyncDatabase

        return AsyncCollection if owner == "AsyncCollection" else AsyncDatabase


@pytest.mark.contract
class TestACollatedIndexAgainstARealDeployment:
    """AT-193 — against a real server: the premises of the collation refusal, and what it refuses.

    Two premises are asserted here: that ``index_information`` reports an index's own collation at all,
    without which the rule could not be checked client-side, and that a folded unique index does to the
    dedup rule what the refusal says it does.

    On 7.0.12 the second insert of a key differing only in case is an ``E11000`` against an index that
    *should* hold both, and the binary query that would find the existing one cannot use a collated
    index, so the caller is told the record is already there and no later read can produce it.
    """

    FOLDING: Final[dict[str, Any]] = {"locale": "en", "strength": 2}

    async def test_the_server_reports_an_index_collation_where_the_check_reads_it(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The premise. If this fails the rule is reading a field the server does not send, and every
        folded index would pass."""
        from pymongo import IndexModel

        collection = contract_database[unique_collection_name]
        dedup = next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))
        await collection.create_indexes(
            [IndexModel(list(dedup.keys), name="theirs", **dedup.options, collation=self.FOLDING)]
        )

        found = (await collection.index_information())["theirs"]

        assert found.get("collation", {}).get("locale") == "en"

    async def test_an_uncollated_index_reports_no_collation_at_all(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The vacuity guard, and the reason the rule cannot be an ``IndexSpec.options`` entry: what a
        correct index reports is nothing, so a wanted value of ``simple`` would mismatch all of them."""
        collection = contract_database[unique_collection_name]
        dedup = next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))
        await collection.create_indexes([dedup.to_model()])

        assert "collation" not in (await collection.index_information())[dedup.name]

    async def test_ensure_refuses_the_folded_index_and_creates_nothing(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """End to end: a real index the server built, and a refusal before any write."""
        from pymongo import IndexModel
        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]
        dedup = next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))
        await collection.create_indexes(
            [IndexModel(list(dedup.keys), name="theirs", **dedup.options, collation=self.FOLDING)]
        )
        before = await collection.index_information()

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[dedup], create=True)

        assert "collation" in str(caught.value)
        assert await collection.index_information() == before

    async def test_two_records_differing_only_in_case_collide_on_the_folded_index(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """What the refusal is refusing, in the driver rather than in a paragraph.

        The unique index is what stops a memory being stored twice. Built this way it also stops a
        different memory being stored once, and the query that would have found the first one, the
        binary equality the package issues, cannot use the index that rejected the second.
        """
        from pymongo import IndexModel
        from pymongo.errors import DuplicateKeyError

        collection = contract_database[unique_collection_name]
        await collection.create_indexes(
            [IndexModel([("content_hash", 1)], name="folded", unique=True, collation=self.FOLDING)]
        )
        await collection.insert_one({"content_hash": "Remember-X"})

        with pytest.raises(DuplicateKeyError):
            await collection.insert_one({"content_hash": "remember-x"})

        assert await collection.find_one({"content_hash": "remember-x"}) is None, (
            "if this is not None the deployment did not fold the index and this class is checking "
            "something the server no longer does"
        )


@pytest.mark.contract
class TestOrdinaryIndexesAgainstARealDeployment:
    """AT-060, AT-061, AT-063, AT-064 — the same branches, against a server that answers for itself.

    The fake above encodes measured server behaviour. These tests are what stop that encoding
    from drifting away from the server: they assert outcomes rather than error codes, so a server
    upgrade that renumbers a conflict fails here rather than in production.
    """

    async def test_ensure_creates_every_declared_index(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-060 — every declared index is created. Also shows ``createIndexes`` creating the
        collection implicitly: nothing creates ``unique_collection_name`` first, and the search path is
        the only one that has to."""
        collection = contract_database[unique_collection_name]

        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=True)

        keys = {tuple(spec["key"]) for spec in (await collection.index_information()).values()}
        for spec in _indexes.memory_specs():
            assert spec.keys in keys

    async def test_a_second_ensure_creates_nothing_and_raises_nothing(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The idempotency the whole module exists for, end to end rather than by branch."""
        collection = contract_database[unique_collection_name]
        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=True)
        before = await collection.index_information()

        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=True)

        assert await collection.index_information() == before

    async def test_an_index_under_a_foreign_name_with_our_options_is_accepted(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-063 — the positive half. Someone else's naming convention is not a reason to
        fail, and it is not a reason to try creating a second index over the same keys either."""
        from pymongo import IndexModel

        collection = contract_database[unique_collection_name]
        spec = _indexes.storage_specs()[0]
        await collection.create_indexes([IndexModel(list(spec.keys), name="their_own_ttl", expireAfterSeconds=0)])

        await _indexes.ensure(collection, ordinary=[spec], create=True)

        assert "their_own_ttl" in await collection.index_information()
        assert spec.name not in await collection.index_information()

    async def test_the_server_rejects_a_second_index_over_the_same_keys(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The measurement that forces key-list matching, asserted rather than quoted. Without this,
        the test above looks like a stylistic preference instead of the only thing that works."""
        from pymongo import IndexModel
        from pymongo.errors import OperationFailure

        collection = contract_database[unique_collection_name]
        spec = _indexes.storage_specs()[0]
        await collection.create_indexes([IndexModel(list(spec.keys), name="their_own_ttl", expireAfterSeconds=0)])

        with pytest.raises(OperationFailure):
            await collection.create_indexes([spec.to_model()])

    async def test_an_index_missing_the_option_it_exists_for_is_reported(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-063 — an index missing the option it exists for is reported. A plain compound index over
        the dedup keys is what a well-meaning application developer adds for query performance, and it
        satisfies a key-list check exactly while stopping no duplicates."""
        from pymongo import IndexModel
        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]
        dedup = next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))
        await collection.create_indexes([IndexModel(list(dedup.keys), name="just_for_speed")])

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[dedup], create=True)

        assert "unique" in str(caught.value)
        assert "just_for_speed" in str(caught.value)

    async def test_a_ttl_index_with_a_different_expiry_is_reported(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-064 — a TTL index with a different expiry is reported. The server rejects the re-creation
        too, with code 85 under either name. This asserts the package names the reason before the server
        gets a chance to."""
        from pymongo import IndexModel
        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]
        spec = _indexes.storage_specs()[0]
        await collection.create_indexes([IndexModel(list(spec.keys), name="theirs", expireAfterSeconds=3600)])

        with pytest.raises(StorageError, match="expireAfterSeconds"):
            await _indexes.ensure(collection, ordinary=[spec], create=True)

    async def test_verify_only_creates_nothing_on_a_real_deployment(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-061 — verify-only mode creates nothing on a real deployment. The collection is not created
        either, which matters: a verify-only run is what a caller without DDL rights does, and it must not
        need any."""
        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=False)

        assert await collection.index_information() == {}
        assert unique_collection_name not in await contract_database.list_collection_names()
        assert unique_collection_name in str(caught.value)

    async def test_the_commands_in_the_verify_only_error_actually_create_the_indexes(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The commands in a verify-only error are meant to be run, so this test runs them.

        Every ``db.runCommand({...})`` is parsed straight out of the error text and
        executed against the deployment, and then the same verify that produced the message has to pass.
        A command that is merely well formed and does not produce the index the next verify wants is
        worse than no command at all: the operator runs it, the caller still fails, and neither of them
        can tell which half was wrong.
        """
        import json
        import re

        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]
        specs = _indexes.memory_specs()
        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=specs, create=False)

        commands = re.findall(r"db\.runCommand\((\{.*?\})\)\n", str(caught.value))
        assert len(commands) == len(specs), str(caught.value)
        for command in commands:
            await contract_database.command(json.loads(command))

        await _indexes.ensure(collection, ordinary=specs, create=False)

    async def test_ten_concurrent_ensures_produce_one_index_set(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-060's "tolerate a concurrent creator", and the index half of AT-065.

        No lock here, which is stronger than the locked version: this is the check-then-create window
        left wide open, and it is benign. Ten concurrent identical ``create_indexes`` calls produce zero
        failures and one index, so tolerating a concurrent creator rests on the server's own idempotency
        rather than on an ``except`` clause. That matters because the alternative is dangerous:
        swallowing the conflict codes to tolerate a racer would also swallow the genuine option mismatch
        two tests up.

        The ``initialize()`` half is ``TestTenStoresShareOneSetup`` in ``test_memory_store.py``.
        """
        collection = contract_database[unique_collection_name]
        specs = _indexes.memory_specs()

        results = await asyncio.gather(
            *(_indexes.ensure(collection, ordinary=specs, create=True) for _ in range(10)),
            return_exceptions=True,
        )

        assert [r for r in results if isinstance(r, BaseException)] == []
        # `_id_` plus one per spec, and no duplicates under alternate names.
        assert len(await collection.index_information()) == len(specs) + 1

    async def test_the_fake_and_the_driver_report_index_information_the_same_way(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The collection fake's behavioural check. The unit tier's ``existing()`` helper hard-codes a shape; this is
        the test that fails if the driver ever reports ``key`` as something other than a list of
        tuples, or drops the ``v`` the comparison has to ignore."""
        collection = contract_database[unique_collection_name]
        spec = _indexes.storage_specs()[0]
        await collection.create_indexes([spec.to_model()])

        real = (await collection.index_information())[spec.name]
        fake: Any = FakeAsyncCollection()
        await fake.create_indexes([spec.to_model()])
        mocked = (await fake.index_information())[spec.name]

        assert set(real) == set(mocked)
        assert real["key"] == mocked["key"]
        assert type(real["key"]) is type(mocked["key"])


# The manual-vector mode, which the Atlas tier tests because an `autoEmbed` index is rejected at creation
# on deployments without automated embedding, Atlas local among them. Four dimensions because nothing here
# reads the vectors; the index only has to be real.
MANUAL_VECTOR_CONFIG: MongoDBConfig = {
    "database": "unused",
    "embedding_dimensions": 4,
    "similarity": "cosine",
}


def _reported_version(index: Mapping[str, Any]) -> int:
    """The definition version from a ``$listSearchIndexes`` document, under whichever key carries it.

    The two deployments differ in the key *and* in the value shape. An Atlas CLI local deployment sends
    ``latestVersion`` as a bare integer. Cloud Atlas 8.0.30 sends ``latestDefinitionVersion`` as a
    subdocument, ``{"createdAt": datetime(...), "version": 0}``, and neither sends the other's key.
    Reading either one directly is a ``KeyError`` on the other cluster, and reading the cloud one as a
    number is a ``TypeError``.

    Args:
        index: One document from ``list_search_indexes()``.

    Returns:
        The version, as an integer, from whichever of the two shapes arrived.
    """
    for key in ("latestVersion", "latestDefinitionVersion"):
        if key in index:
            reported = index[key]
            # `dict` rather than `Mapping`: the name is imported under `TYPE_CHECKING` only, and the
            # driver hands back plain dicts, so the narrower check is also the one that exists at runtime.
            return int(reported["version"] if isinstance(reported, dict) else reported)
    raise AssertionError(f"no definition version key in {sorted(index)}")


@pytest.mark.integration
class TestSearchIndexesAgainstAtlas:
    """AT-062a/b/c, AT-066, AT-068 — the asynchronous build, which is what no fake can prove.

    Every test here uses the manual-vector mode. That is not a convenience: an ``autoEmbed`` definition
    fails at **creation** on an Atlas local deployment with code 8, *"CanonicalModel: voyage-4-lite not
    registered yet, supported models are: []"*, and ``MONGODB_ATLAS_URI`` is the variable that may name
    such a deployment. A cloud cluster with a registered model accepts the definition, which is what the
    separate ``autoembed`` tier and ``MONGODB_AUTOEMBED_URI`` exist to require rather than hope for.
    """

    async def test_a_missing_search_index_is_created_and_reaches_ready(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-062c, and AT-068 with it: nothing creates the collection first except ``ensure``."""
        collection = atlas_database[unique_collection_name]
        specs = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)

        await _indexes.ensure(collection, search=specs, create=True)

        states = {index["name"]: index["status"] async for index in await collection.list_search_indexes()}
        assert states == {spec.name: "READY" for spec in specs}

    async def test_createsearchindexes_needs_the_collection_to_exist(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-068 — ``createSearchIndexes`` fails on a missing namespace, which is why the collection comes first.

        Issued as a raw driver call against a namespace nothing has created. ``createIndexes`` in the
        same position creates the collection implicitly, which is why this asymmetry is easy to miss and
        why it is asserted rather than described.
        """
        from pymongo.errors import OperationFailure

        ghost = atlas_database[f"{unique_collection_name}_ghost"]
        spec = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)[0]

        with pytest.raises(OperationFailure) as caught:
            await ghost.create_search_index(spec.to_model())

        assert caught.value.code == 26

    async def test_creating_the_collection_twice_is_not_an_error(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """``check_exists=False`` on a collection that exists is accepted outright on 8.3.8, so the
        code-48 handler in the module is defense in depth for other server versions rather than a
        branch this deployment reaches. Asserted so the claim is checked rather than assumed."""
        await atlas_database.create_collection(unique_collection_name, check_exists=False)

        await atlas_database.create_collection(unique_collection_name, check_exists=False)

    async def test_a_second_ensure_creates_nothing(self, atlas_database: Any, unique_collection_name: str) -> None:
        """The warm path, which is what every ``initialize()`` after the first one runs. Re-issuing an
        identical definition is in fact accepted by the server, both while building and after ready, so
        this asserts the module does not issue it: a create that succeeds is still a round trip and
        still a write permission the caller may not have.

        The version is what makes the assertion sharp rather than a name comparison that any two runs
        satisfy, and it is read through ``_reported_version`` because the two deployments spell the key
        differently."""
        collection = atlas_database[unique_collection_name]
        specs = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)
        await _indexes.ensure(collection, search=specs, create=True)
        before = [(index["name"], _reported_version(index)) async for index in await collection.list_search_indexes()]

        await _indexes.ensure(collection, search=specs, create=True)

        after = [(index["name"], _reported_version(index)) async for index in await collection.list_search_indexes()]
        assert after == before
        assert before, "nothing was listed, so an unchanged listing proves nothing"

    async def test_verify_only_reports_a_missing_search_index_with_its_command(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-062a — *Missing* is the state whose remedy is to create, so the
        message carries the creation command and the collection is left untouched."""
        from strands.types.exceptions import StorageError

        collection = atlas_database[unique_collection_name]
        specs = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, search=specs, create=False)

        message = str(caught.value)
        assert "createSearchIndex" in message
        assert unique_collection_name not in await atlas_database.list_collection_names()

    async def test_a_building_index_is_distinguished_from_a_ready_one(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-062b, the one that needs care: catching an index mid-build is a race.

        On an Atlas local deployment ``READY`` arrives within a fraction of a second, and polling
        immediately after ``create_search_index`` reliably observes a non-ready status. Reliably is not
        always, so the whole scenario retries three times on a fresh collection and then **skips with a
        reason** rather than failing. A flaky assertion about a race teaches the reader to rerun the suite
        until it is green, which is worse than a skip that says why.
        """
        for attempt in range(3):
            collection = atlas_database[f"{unique_collection_name}_{attempt}"]
            spec = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)[0]
            await atlas_database.create_collection(collection.name, check_exists=False)
            await collection.create_search_index(spec.to_model())

            observed = [index["status"] async for index in await collection.list_search_indexes(spec.name)]
            if observed and observed[0] != "READY":
                # The building state, reached on a real deployment. The package must
                # wait it out rather than reporting it as missing or as ready.
                assert _indexes.readiness(observed[0]) == "building"
                await _indexes.ensure(collection, search=[spec], create=False)
                return

        pytest.skip(
            "the vector index reached READY before the first poll on all 3 attempts, so the building "
            "state was not observable on this deployment"
        )

    async def test_polling_a_real_build_leaves_the_event_loop_running(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-066 — polling a real build leaves the event loop running. The reference helpers poll with
        a blocking ``time.sleep``, which in an agent process stalls every other coroutine on the loop for
        as long as the build takes. Asserted against a real build rather than a programmed one, because
        the interval that matters is the one the module chose and not the ``0`` the unit tier passes."""
        collection = atlas_database[unique_collection_name]
        specs = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)
        ticks = 0

        async def tick() -> None:
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0.01)

        ticker = asyncio.create_task(tick())
        try:
            await _indexes.ensure(collection, search=specs, create=True)
        finally:
            ticker.cancel()

        assert ticks > 1

    async def test_the_real_cursor_yields_the_keys_the_fake_promises(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """The cursor fake's behavioural check. The unit tier reads ``name``, ``status``, ``latestDefinition`` and
        ``statusDetail`` off programmed dicts; this is what fails if the server stops sending them.

        The set is the fake's, and no wider. ``type`` was once in it, and not every deployment sends it
        (INTPYTHON-1182). Nothing in the package reads it, so requiring it failed a server the package works on.
        """
        collection = atlas_database[unique_collection_name]
        specs = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)
        await _indexes.ensure(collection, search=specs, create=True)

        documents = [index async for index in await collection.list_search_indexes()]

        assert documents
        for document in documents:
            assert {"name", "status", "queryable", "latestDefinition"} <= set(document)

    async def test_the_vector_definition_the_server_reports_back_is_the_one_we_sent(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """One half of what the comparison in ``ensure`` rests on, and the half that holds.

        A ``vectorSearch`` definition round-trips byte for byte, so every key of it is comparable
        directly. Asserted here rather than assumed, because it is what makes a wrong ``numDimensions``
        detectable at all.
        """
        collection = atlas_database[unique_collection_name]
        spec = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)[0]
        await _indexes.ensure(collection, search=[spec], create=True)

        documents = [index async for index in await collection.list_search_indexes(spec.name)]

        assert documents[0]["latestDefinition"] == spec.definition

    async def test_the_text_definition_is_covered_whether_or_not_the_server_rewrites_it(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """The other half: a text definition may come back rewritten, so the comparison is containment.

        mongot 8.3.8 collapses the one-element list into the object it held and adds ``indexOptions``,
        ``store`` and ``norms``. Atlas 8.0.30 returns the same definition verbatim, so the rewrite is a
        property of the deployment rather than of the index type, and equality would pass on one cluster
        and fail on the other for identical package code.

        Containment is therefore asserted unconditionally, because it is what ``ensure`` rests on. The
        rewrite is asserted in the branch where it happens, naming the three keys mongot adds, so a
        deployment that changes its mind about normalising is a visible change rather than a silently
        loosened comparison.
        """
        collection = atlas_database[unique_collection_name]
        spec = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)[1]
        await _indexes.ensure(collection, search=[spec], create=True)

        reported = [index async for index in await collection.list_search_indexes(spec.name)][0]["latestDefinition"]

        assert _indexes._definition_gap(spec.definition, reported) is None
        mapped = reported["mappings"]["fields"]["content"]
        if reported == spec.definition:
            assert mapped == [{"type": "string"}]
        else:
            assert not isinstance(mapped, list)
            assert mapped["type"] == "string"
            assert {"indexOptions", "store", "norms"} <= set(mapped)


class TestEveryCallSitePassesTheConfiguredBudget:
    """AT-126 — every ``_indexes.ensure`` call site passes the configured timeout, a completeness claim.

    ``test_storage.py`` and ``test_memory_store.py`` assert that the call sites they know about carry
    ``timeout``. Neither can assert that those are *all* of them, and the failure that matters is exactly
    that: a call site added later, defaulting silently to the module constant, so an operator who raised
    ``index_ready_timeout`` for a shared Atlas project finds one build still giving up at 300 seconds and
    nothing anywhere saying why.

    Source inspection rather than a runtime count, for the same reason ``test_conventions.py`` uses it:
    a call site that no test reaches is precisely the one this has to see. The check is narrow: it reads
    the keyword names of every ``_indexes.ensure(...)`` call in the package and nothing about their
    values, so it stays true through any refactor that keeps the keyword.
    """

    @staticmethod
    def _ensure_calls() -> list[tuple[str, int, set[str]]]:
        """Every ``_indexes.ensure(...)`` call in the shipped package, with the keywords it passes.

        Returns:
            One ``(module, line, keywords)`` triple per call site, in file then line order.
        """
        import ast
        from pathlib import Path

        found: list[tuple[str, int, set[str]]] = []
        source_root = Path(__file__).resolve().parent.parent / "src" / "strands_mongodb"
        for path in sorted(source_root.glob("*.py")):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if not isinstance(node, ast.Call):
                    continue
                function = node.func
                if (
                    isinstance(function, ast.Attribute)
                    and function.attr == "ensure"
                    and isinstance(function.value, ast.Name)
                    and function.value.id == "_indexes"
                ):
                    found.append((path.name, node.lineno, {kw.arg for kw in node.keywords if kw.arg}))
        return found

    def test_the_call_sites_are_the_four_the_package_has(self) -> None:
        """A guard on the guard. If this fails the package grew or lost a call site, and the test below
        is either checking something new or has quietly stopped checking anything."""
        by_module = [module for module, _, _ in self._ensure_calls()]

        assert by_module == ["memory_store.py", "memory_store.py", "memory_store.py", "storage.py"], (
            self._ensure_calls()
        )

    def test_every_call_site_passes_a_timeout(self) -> None:
        missing = [(module, line) for module, line, keywords in self._ensure_calls() if "timeout" not in keywords]

        assert not missing, (
            f"these _indexes.ensure call sites pass no timeout=, so index_ready_timeout does not "
            f"reach them and they wait out the module default instead: {missing}"
        )


@pytest.mark.contract
class TestCompetingIndexesAgainstARealDeployment:
    """AT-196 — against a real server: the premise the fake cannot assert.

    Everything in the unit class above rests on one claim about the server: that a second index over the
    same keys under a *different* collation is created rather than refused. If that is wrong, a collection
    cannot carry two competing indexes and the check has nothing to find. The fake is built from that claim,
    so it cannot test it; this class builds the indexes and asks.

    The remaining tests show that the constraint the check looks for is really enforced: the folded rule
    refuses a write the binary index would have accepted, on a deployment where both
    indexes are present and the declared one is entirely correct.
    """

    FOLDING: Final[dict[str, Any]] = {"locale": "en", "strength": 2}

    @staticmethod
    def _dedup_spec() -> _indexes.IndexSpec:
        """The unique partial index the dedup constraint rests on."""
        return next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))

    async def _both(self, collection: Any) -> _indexes.IndexSpec:
        """Build the declared dedup index and a folding unique index over the same keys.

        Args:
            collection: The contract collection to build them on.

        Returns:
            The declared spec, for the assertions.
        """
        from pymongo import IndexModel

        dedup = self._dedup_spec()
        await collection.create_indexes([dedup.to_model()])
        await collection.create_indexes(
            [IndexModel(list(dedup.keys), name="folding_unique", **dedup.options, collation=self.FOLDING)]
        )
        return dedup

    async def test_the_server_keeps_both_indexes_over_one_key_list(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The premise. An index's identity is its keys and its collation, and if it were the keys alone
        the second creation here would be a conflict rather than an index."""
        collection = contract_database[unique_collection_name]
        dedup = await self._both(collection)

        found = await collection.index_information()

        over_those_keys = [
            name for name, entry in found.items() if [tuple(p) for p in entry["key"]] == list(dedup.keys)
        ]
        assert sorted(over_those_keys) == sorted([dedup.name, "folding_unique"])

    async def test_ensure_refuses_the_deployment_the_declared_index_is_correct_on(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The declared index is present, correct, and matches every option, and the deployment is still
        refused, because the folding unique index beside it is enforced too."""
        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]
        dedup = await self._both(collection)
        before = await collection.index_information()

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[dedup], create=True)

        assert "folding_unique" in str(caught.value)
        assert await collection.index_information() == before

    async def test_the_folded_constraint_refuses_a_write_the_declared_index_allows(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """What the refusal is refusing. Two records differing only in the case of ``scope`` are distinct
        under the declared index and one record under the folding one, and the server enforces both."""
        from pymongo.errors import DuplicateKeyError

        collection = contract_database[unique_collection_name]
        await self._both(collection)
        await collection.insert_one({"scope": "Tenant-A", "store_name": "s", "content_hash": "h"})

        with pytest.raises(DuplicateKeyError) as caught:
            await collection.insert_one({"scope": "tenant-a", "store_name": "s", "content_hash": "h"})

        assert "folding_unique" in str(caught.value)

    async def test_the_declared_index_alone_accepts_that_same_write(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The vacuity guard, and the one that makes the test above mean anything. Without it, that
        ``DuplicateKeyError`` could be the declared index doing its job on a genuinely duplicate record."""
        collection = contract_database[unique_collection_name]
        await collection.create_indexes([self._dedup_spec().to_model()])
        await collection.insert_one({"scope": "Tenant-A", "store_name": "s", "content_hash": "h"})

        await collection.insert_one({"scope": "tenant-a", "store_name": "s", "content_hash": "h"})

        assert await collection.count_documents({}) == 2


@pytest.mark.contract
class TestACollatedTtlIndexAgainstARealDeployment:
    """AT-197 — against a real server: a collated TTL index works, and ``ensure`` accepts it.

    The exemption rests on a claim about the server: that a non-simple collation on a date-only TTL index
    changes nothing about expiry. A collation orders strings and a BSON date is not one, and this class
    asks the server rather than relying on that reasoning.

    ``expireAfterSeconds`` is swept by a background task on its own schedule, roughly once a minute, which
    is longer than a test should wait. What is asserted here is what can be asserted promptly: the server
    accepts the index, reports the collation the check reads, and agrees the index is a TTL index. The
    deletion itself was checked separately against ``mongod`` 7.0.12: a document stamped an hour in the
    past is removed by the sweep and an ``expires_at: null`` document is left in place.
    """

    FOLDING: Final[dict[str, Any]] = {"locale": "en", "strength": 2}

    async def _collated_ttl(self, collection: Any) -> _indexes.IndexSpec:
        """Build the TTL index with a folding collation, as an operator's own tooling might have.

        Args:
            collection: The contract collection to build it on.

        Returns:
            The declared TTL spec.
        """
        from pymongo import IndexModel

        spec = _indexes.storage_specs()[0]
        await collection.create_indexes(
            [IndexModel(list(spec.keys), name=spec.name, **spec.options, collation=self.FOLDING)]
        )
        return spec

    async def test_the_server_builds_a_collated_ttl_index_at_all(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The premise. If the server refused this combination, the exemption would be code for a
        deployment that cannot exist."""
        collection = contract_database[unique_collection_name]
        spec = await self._collated_ttl(collection)

        found = (await collection.index_information())[spec.name]

        assert found.get("collation", {}).get("locale") == "en"
        assert found.get("expireAfterSeconds") == 0

    async def test_ensure_accepts_it(self, contract_database: Any, unique_collection_name: str) -> None:
        """Against the server rather than the fake: ``ensure`` accepts the collated TTL index, so
        ``ensure_indexes()`` does not fail on a deployment that expires documents correctly."""
        collection = contract_database[unique_collection_name]
        spec = await self._collated_ttl(collection)
        before = await collection.index_information()

        await _indexes.ensure(collection, ordinary=[spec], create=True)

        assert await collection.index_information() == before

    async def test_a_collated_index_on_the_dedup_keys_is_still_refused(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The vacuity guard. The exemption is for the date-only index and nothing else, and an exemption
        that leaked to the index specs keying strings would undo the dedup collation rule on a real deployment."""
        from pymongo import IndexModel
        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]
        dedup = next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))
        await collection.create_indexes(
            [IndexModel(list(dedup.keys), name="theirs", **dedup.options, collation=self.FOLDING)]
        )

        with pytest.raises(StorageError):
            await _indexes.ensure(collection, ordinary=[dedup], create=True)
