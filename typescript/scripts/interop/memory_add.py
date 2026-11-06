"""Add one memory through the Python ``MongoDBMemoryStore`` for the TypeScript interop tier."""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
from datetime import timezone

from bson import json_util

from strands_mongodb.memory_store import MongoDBMemoryStore

# Relaxed EJSON in, so `{"$date": ...}` and `{"$oid": ...}` arrive as an aware `datetime` and an `ObjectId`.
_EJSON = json_util.RELAXED_JSON_OPTIONS.with_options(tz_aware=True, tzinfo=timezone.utc)


def _arguments() -> argparse.Namespace:
    """Parse the deployment and the store placement the bridge points at."""
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("--uri", "--database", "--collection", "--name", "--scope", "--search-type"):
        parser.add_argument(name, required=True)
    return parser.parse_args()


async def main() -> None:
    """Add stdin's ``content`` with its EJSON ``metadata`` and print the add result."""
    args = _arguments()
    payload = json_util.loads(sys.stdin.read(), json_options=_EJSON)
    store = MongoDBMemoryStore(
        name=args.name,
        scope=args.scope,
        writable=True,
        collection=args.collection,
        config={"database": args.database, "connection_string": args.uri, "search_type": args.search_type},
    )
    try:
        result = await store.add(payload["content"], payload.get("metadata"))
    finally:
        await store.close()
    print(json.dumps(dataclasses.asdict(result)))


if __name__ == "__main__":
    asyncio.run(main())
