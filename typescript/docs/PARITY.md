# Parity findings

Facts the TypeScript port relies on, measured on 2026-11-05.
Fixtures in `src/__fixtures__/` are regenerated with `cd python && hatch run python ../typescript/scripts/export-python-fixtures.py`.

## 1. SDK floor: `@strands-agents/sdk` 1.23.0

The floor is `>=1.23.0`.
`StorageSearchResult` is exported from `@strands-agents/sdk/storage/search`, not from `@strands-agents/sdk/storage`.

```ts
import type { Storage } from '@strands-agents/sdk/storage'
import type { SearchStrategy, Embedder, StorageSearchResult } from '@strands-agents/sdk/storage/search'
```

The stub (those imports plus `StorageError`, `Logger`, `JSONValue`, `Tool`, `MemoryStore`, `MemoryStoreConfig`, `MemoryEntry`, `SearchOptions` from `@strands-agents/sdk`, using `SearchStrategy['index']`, `MemoryStore['initialize']`, `MemoryStore['getTools']`) gives:

| SDK | `tsc --noEmit` | First error |
| --- | --- | --- |
| 1.10.0, 1.12.0 | fail | no `@strands-agents/sdk/storage/search` module |
| 1.14.0 to 1.17.0 | fail | no `Embedder` export; `SearchStrategy` has no `index` |
| 1.18.0 to 1.22.0 | fail | `@strands-agents/sdk/storage/search` has no `Embedder` export |
| 1.23.0, 1.24.0 | pass | |

With the import path above on TypeScript 5.9.3: 1.22.0 fails with `TS2305: Module '"@strands-agents/sdk/storage/search"' has no exported member 'Embedder'`, and 1.23.0 passes.

## 2. Keyword tokenizer: identical

TypeScript (`strands-ts/src/storage/search/keyword.ts`): `text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)`, into a `Set`.
Python (`strands-py/src/strands/storage/search/keyword.py`): `{t for t in re.split(r"\W+", text.lower()) if t}`.
The source regexes differ textually but split on the same characters.
Every code point assigned in Python 3.13's Unicode 15.1 is classified the same by Python `\w` and by JS `[\p{L}\p{N}_]` (Node 24, Unicode 17). The 9039 differences are all code points unassigned in Unicode 15.1.
`str.lower()` and `String.prototype.toLowerCase()` agree on every code point assigned in Unicode 15.1, including final sigma.

## 3. `listSearchIndexes` status fields

atlas-local `mongodb/mongodb-atlas-local:8` (MongoDB 8.3.13), driver `mongodb@7.8.0`, `bson@7.3.4`.
Fields: `id`, `name`, `type`, `status`, `queryable`, `latestVersion`, `latestDefinition`.
`status` goes from `PENDING` to `READY`; `queryable` goes from `false` to `true`.

Immediately after `createSearchIndex`:

```
[
  {
    id: '6aecd59e6f588f18278b6539',
    name: 'vector_index',
    type: 'vectorSearch',
    status: 'PENDING',
    queryable: false,
    latestVersion: 0,
    latestDefinition: {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: 3, similarity: 'cosine' },
        { type: 'filter', path: 'scope' },
        { type: 'filter', path: 'store_name' }
      ]
    }
  }
]
```

Once settled:

```
{
  id: '6aecd59e6f588f18278b6539',
  name: 'vector_index',
  type: 'vectorSearch',
  status: 'READY',
  queryable: true,
  latestVersion: 0,
  latestDefinition: {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions: 3, similarity: 'cosine' },
      { type: 'filter', path: 'scope' },
      { type: 'filter', path: 'store_name' }
    ]
  }
}
```

## 4. AutoEmbeddings on atlas-local: code 8

Creating an `autoEmbed` index fails with code 8. No AutoEmbeddings index can exist on this image:

```
{
  name: 'MongoServerError',
  code: 8,
  codeName: 'UnknownError',
  message: 'CanonicalModel: voyage-4-lite not registered yet, supported models are: []'
}
```

An AutoEmbeddings `$vectorSearch` (`query: { text }`, `model`) against a READY manual index also fails with code 8, for `path: 'content'` and for `path: 'embedding'`:

```
{
  name: 'MongoServerError',
  code: 8,
  codeName: 'UnknownError',
  message: 'Executor error during aggregate command on namespace: parity2.memory :: caused by :: queryVector must be present'
}
```

A `$vectorSearch` naming an index that does not exist returns `[]` with no error.

## 5. Empty `Binary`

`new Binary(new Uint8Array(0))` is subtype 0 with length 0, and survives a round trip as a `Binary`.
A bare `Uint8Array(0)` written as a field value also reads back as a `Binary` of subtype 0 and length 0.

```
new Binary(new Uint8Array(0))      -> Binary.createFromBase64('', 0)
sub_type 0, position 0, length() 0, buffer Buffer of length 0, value().length 0
BSON.serialize({ data })           -> 10000000056461746100000000000000
findOne after insert               -> Binary.createFromBase64('', 0), instanceof Binary, sub_type 0, length() 0
```

## 6. Document size: matches `_encoded_size`

`BSON.calculateObjectSize({ _id, data: Binary, updated_at: Date })` equals `46 + utf8(_id) + data.length`.
Adding `expires_at: Date` adds exactly 20.
Both equal `BSON.serialize(...).length`, and a bare `Uint8Array` for `data` sizes the same as a `Binary`.

```
key                    keyBytes  size   plain  python  withTtl  pythonTtl
'k'                    1         0      47     47      67       67
'k'                    1         1      48     48      68       68
'k'                    1         1000   1047   1047    1067     1067
'k'                    1         65536  65583  65583   65603    65603
'strands/session/abc'  19        0      65     65      85       85
'strands/session/abc'  19        1      66     66      86       86
'strands/session/abc'  19        1000   1065   1065    1085     1085
'strands/session/abc'  19        65536  65601  65601   65621    65621
'clé/ünïcödé/日本語'   26        0      72     72      92       92
'clé/ünïcödé/日本語'   26        1      73     73      93       93
'clé/ünïcödé/日本語'   26        1000   1072   1072    1092     1092
'clé/ünïcödé/日本語'   26        65536  65608  65608   65628    65628
'🙂/emoji'             10        0      56     56      76       76
'🙂/emoji'             10        1      57     57      77       77
'🙂/emoji'             10        1000   1056   1056    1076     1076
'🙂/emoji'             10        65536  65592  65592   65612    65612
all match: true
```
