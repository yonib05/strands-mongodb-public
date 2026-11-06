"""Write keys through the Python ``MongoDBStorage`` for the TypeScript interop tier."""

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
    """Write each base64 payload in stdin's ``writes`` under its key."""
    args = _arguments()
    writes: dict[str, str] = json.load(sys.stdin)["writes"]
    storage = MongoDBStorage({"database": args.database, "connection_string": args.uri}, collection=args.collection)
    try:
        for key, data in writes.items():
            await storage.write(key, base64.b64decode(data))
    finally:
        await storage.close()
    print(json.dumps({"written": list(writes)}))


if __name__ == "__main__":
    asyncio.run(main())
