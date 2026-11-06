"""Search through the Python ``MongoDBMemoryStore`` for the TypeScript interop tier."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time

from bson import json_util

from strands_mongodb.memory_store import MongoDBMemoryStore


def _arguments() -> argparse.Namespace:
    """Parse the deployment and the store placement the bridge points at."""
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("--uri", "--database", "--collection", "--name", "--scope", "--search-type"):
        parser.add_argument(name, required=True)
    return parser.parse_args()


async def main() -> None:
    """Search for stdin's ``query`` until it answers or ``budget`` seconds pass, printing relaxed EJSON."""
    args = _arguments()
    payload = json.load(sys.stdin)
    store = MongoDBMemoryStore(
        name=args.name,
        scope=args.scope,
        collection=args.collection,
        config={
            "database": args.database,
            "connection_string": args.uri,
            "search_type": args.search_type,
            "index_ready_timeout": payload["budget"],
        },
    )
    # `READY` means the index exists, not that every document has reached it.
    deadline = time.monotonic() + payload["budget"]
    try:
        while not (results := await store.search(payload["query"])) and time.monotonic() < deadline:
            await asyncio.sleep(0.5)
    finally:
        await store.close()
    entries = [{"content": entry.content, "metadata": entry.metadata} for entry in results]
    print(json_util.dumps({"results": entries}, json_options=json_util.RELAXED_JSON_OPTIONS))


if __name__ == "__main__":
    asyncio.run(main())
