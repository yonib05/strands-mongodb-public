"""Read keys through the Python ``MongoDBStorage`` for the TypeScript interop tier."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys

from strands_mongodb.storage import MongoDBStorage


def _arguments() -> argparse.Namespace:
    """Parse the deployment the bridge points at."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uri", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--collection", required=True)
    return parser.parse_args()


async def main() -> None:
    """Print each key in stdin's ``keys`` with its payload as base64, or ``null`` when absent."""
    args = _arguments()
    keys: list[str] = json.load(sys.stdin)["keys"]
    storage = MongoDBStorage({"database": args.database, "connection_string": args.uri}, collection=args.collection)
    values: dict[str, str | None] = {}
    try:
        for key in keys:
            data = await storage.read(key)
            values[key] = None if data is None else base64.b64encode(data).decode("ascii")
    finally:
        await storage.close()
    print(json.dumps({"values": values}))


if __name__ == "__main__":
    asyncio.run(main())
