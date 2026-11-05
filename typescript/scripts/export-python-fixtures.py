"""Export the Python package's pure builders as JSON fixtures for the TypeScript parity tests.

Run from `python/`: `hatch run python ../typescript/scripts/export-python-fixtures.py`.
"""

from __future__ import annotations

import itertools
import json
from pathlib import Path
from typing import Any

from strands_mongodb import _indexes, _pipeline, types

OUT = Path(__file__).resolve().parent.parent / "src" / "__fixtures__"

BASE_CONFIG: types.MongoDBConfig = {"database": "x", "connection_string": "mongodb://h"}
AUTO = _indexes.vector_mode({**BASE_CONFIG, "embedding_model": "voyage-4-lite"})
MANUAL = _indexes.vector_mode({**BASE_CONFIG, "embedding_dimensions": 3, "similarity": "cosine"})
MODES = (("auto", AUTO), ("manual", MANUAL))

QUERY_TEXT = "what does the user prefer"
QUERY_VECTOR = [0.1, 0.2, 0.3]
QUERY_FILTER = {"scope": "user-1", "store_name": "default"}
FILTERS = (("nofilter", None), ("filter", QUERY_FILTER))
LIMITS = (5, 10)
OVERSAMPLING = (10, 3)
SCORES = (True, False)
EXTRA_FILTER_FIELDS = ["metadata.topic", "scope"]


def render_mode(mode: _indexes.VectorMode) -> dict[str, Any]:
    return {
        "autoEmbed": mode.auto_embed,
        "model": mode.model,
        "dimensions": mode.dimensions,
        "similarity": mode.similarity,
    }


def vector_cases() -> list[dict[str, Any]]:
    cases = []
    for (mode_name, mode), (filter_name, query_filter), score, limit, factor in itertools.product(
        MODES, FILTERS, SCORES, LIMITS, OVERSAMPLING
    ):
        query = {"queryText": QUERY_TEXT} if mode.auto_embed else {"queryVector": QUERY_VECTOR}
        stages = _pipeline.vector_stages(
            mode=mode,
            index_name="vector_index",
            limit=limit,
            query_text=query.get("queryText"),
            query_vector=query.get("queryVector"),
            query_filter=query_filter,
            oversampling_factor=factor,
            score=score,
        )
        cases.append(
            {
                "name": f"vector_stages/{mode_name}/{filter_name}/score={str(score).lower()}/limit={limit}/oversampling={factor}",
                "input": {
                    "mode": render_mode(mode),
                    "indexName": "vector_index",
                    "limit": limit,
                    **query,
                    "queryFilter": query_filter,
                    "oversamplingFactor": factor,
                    "score": score,
                },
                "stages": stages,
            }
        )
    return cases


def text_cases() -> list[dict[str, Any]]:
    cases = []
    for (filter_name, query_filter), score, limit in itertools.product(FILTERS, SCORES, LIMITS):
        stages = _pipeline.text_stages(
            query_text=QUERY_TEXT, index_name="text_index", limit=limit, query_filter=query_filter, score=score
        )
        cases.append(
            {
                "name": f"text_stages/{filter_name}/score={str(score).lower()}/limit={limit}",
                "input": {
                    "queryText": QUERY_TEXT,
                    "indexName": "text_index",
                    "limit": limit,
                    "queryFilter": query_filter,
                    "score": score,
                },
                "stages": stages,
            }
        )
    return cases


def hybrid_cases() -> list[dict[str, Any]]:
    cases = []
    for (mode_name, mode), (filter_name, query_filter), limit, factor in itertools.product(
        MODES, FILTERS, LIMITS, OVERSAMPLING
    ):
        query_vector = None if mode.auto_embed else QUERY_VECTOR
        stages = _pipeline.hybrid_stages(
            mode=mode,
            vector_index_name="vector_index",
            text_index_name="text_index",
            query_text=QUERY_TEXT,
            limit=limit,
            query_vector=query_vector,
            query_filter=query_filter,
            oversampling_factor=factor,
        )
        cases.append(
            {
                "name": f"hybrid_stages/{mode_name}/{filter_name}/limit={limit}/oversampling={factor}",
                "input": {
                    "mode": render_mode(mode),
                    "vectorIndexName": "vector_index",
                    "textIndexName": "text_index",
                    "queryText": QUERY_TEXT,
                    "limit": limit,
                    "queryVector": query_vector,
                    "queryFilter": query_filter,
                    "oversamplingFactor": factor,
                },
                "stages": stages,
            }
        )
    return cases


def render_spec(spec: _indexes.IndexSpec) -> dict[str, Any]:
    return {
        "name": spec.name,
        "keys": [list(key) for key in spec.keys],
        "options": dict(spec.options),
        "dateOnly": spec.date_only,
    }


def search_configs() -> list[tuple[str, types.MongoDBConfig]]:
    configs = []
    for (mode_name, _), extra in itertools.product(MODES, (None, EXTRA_FILTER_FIELDS)):
        vector = {"embedding_model": "voyage-4-lite"} if mode_name == "auto" else {"embedding_dimensions": 3, "similarity": "cosine"}
        config: types.MongoDBConfig = {**BASE_CONFIG, **vector}  # type: ignore[typeddict-item]
        if extra is not None:
            config["filter_fields"] = extra
        configs.append((f"{mode_name}/{'extra' if extra else 'baked'}", config))
    return configs


def index_specs() -> dict[str, Any]:
    vector_definitions = [
        {
            "name": f"vector_index_definition/{mode_name}/{'extra' if extra else 'baked'}",
            "input": {"mode": render_mode(mode), "filterFields": extra},
            "definition": _indexes.vector_index_definition(mode, filter_fields=extra),
        }
        for (mode_name, mode), extra in itertools.product(MODES, ([], EXTRA_FILTER_FIELDS))
    ]
    return {
        "storage_specs": [render_spec(spec) for spec in _indexes.storage_specs()],
        "memory_specs": [render_spec(spec) for spec in _indexes.memory_specs()],
        "vector_index_definition": vector_definitions,
        "text_index_definition": _indexes.text_index_definition(),
    }


def ordinary_commands(specs: tuple[_indexes.IndexSpec, ...], collection: str) -> list[dict[str, str]]:
    return [
        {
            "name": spec.name,
            "collection": collection,
            "creation_command": spec.creation_command(collection),
            "drop_command": _indexes.drop_index_command(collection, spec.name),
        }
        for spec in specs
    ]


def commands() -> dict[str, Any]:
    search = [
        {
            "name": f"{config_name}/{spec.type}",
            "collection": "memory",
            "input": {"config": config},
            "creation_command": spec.creation_command("memory"),
            "drop_command": spec.drop_command("memory"),
        }
        for config_name, config in search_configs()
        for spec in _indexes.memory_search_specs(config)
    ]
    return {
        "storage_specs": ordinary_commands(_indexes.storage_specs(), "storage"),
        "memory_specs": ordinary_commands(_indexes.memory_specs(), "memory"),
        "memory_search_specs": search,
    }


def write(name: str, payload: Any) -> None:
    (OUT / name).write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    write("pipeline-stages.json", vector_cases() + text_cases() + hybrid_cases())
    write("index-specs.json", index_specs())
    write("commands.json", commands())


if __name__ == "__main__":
    main()
