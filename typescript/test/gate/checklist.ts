/** One numbered item from the contract checklist, copied from `python/tests/test_gate.py`. */
export interface Item {
  number: number
  gate: boolean
  behaviour: string
  ids: readonly string[]
}

// Items 10 and 11 name the same two ids on purpose: both are halves of the normalisation decision.
export const CHECKLIST: readonly Item[] = [
  { number: 1, gate: true, behaviour: 'read of an absent key returns None rather than raising', ids: ['AT-021'] },
  {
    number: 2,
    gate: true,
    behaviour: 'read raises StorageError for a failure other than a missing key',
    ids: ['AT-022'],
  },
  {
    number: 3,
    gate: true,
    behaviour: 'write overwrites an existing value rather than appending or erroring',
    ids: ['AT-020'],
  },
  {
    number: 4,
    gate: true,
    behaviour: 'bytes round-trip unchanged, including empty, every byte value and a large payload',
    ids: ['AT-024'],
  },
  { number: 5, gate: true, behaviour: 'delete of an absent key is a no-op', ids: ['AT-023'] },
  { number: 6, gate: true, behaviour: "list('') returns every key", ids: ['AT-025'] },
  { number: 7, gate: true, behaviour: 'list(prefix) returns full keys rather than suffixes', ids: ['AT-026'] },
  {
    number: 8,
    gate: true,
    behaviour: "list results sort lexicographically, asserted against Python's sorted()",
    ids: ['AT-027'],
  },
  { number: 9, gate: true, behaviour: 'list on a prefix matching nothing returns an empty list', ids: ['AT-028'] },
  {
    number: 10,
    gate: false,
    behaviour: "keys normalise the SDK's way, so which keys collide is a documented decision",
    ids: ['AT-018', 'AT-019'],
  },
  {
    number: 11,
    gate: false,
    behaviour: "a key or prefix containing a '..' segment is rejected",
    ids: ['AT-018', 'AT-019'],
  },
  {
    number: 12,
    gate: false,
    behaviour: 'search scores are similarity-oriented, higher being better',
    ids: ['AT-032d', 'AT-033'],
  },
  {
    number: 13,
    gate: false,
    behaviour: 'scores stay in the documented range and data is populated as asked',
    ids: ['AT-032b', 'AT-033'],
  },
  {
    number: 14,
    gate: false,
    behaviour: 'a transport failure raises StorageError with the cause chained',
    ids: ['AT-022', 'AT-036', 'AT-080'],
  },
  {
    number: 15,
    gate: false,
    behaviour: 'the session-snapshot key shapes round-trip and UUID7 keys sort chronologically',
    ids: ['AT-027', 'AT-081'],
  },
  {
    number: 16,
    gate: true,
    behaviour: 'search returns MemoryEntry with content, store_name and the reserved metadata',
    ids: ['AT-040'],
  },
  {
    number: 17,
    gate: true,
    behaviour: 'max_search_results precedence, and below 1 raises ValueError',
    ids: ['AT-041'],
  },
  {
    number: 18,
    gate: true,
    behaviour: 'adding identical content twice leaves one document and reports one duplicate',
    ids: ['AT-042'],
  },
  {
    number: 19,
    gate: true,
    behaviour: 'a concurrent duplicate insert surfaces as success, not DuplicateKeyError',
    ids: ['AT-043'],
  },
  {
    number: 20,
    gate: false,
    behaviour: 'add_messages stays absent, so the SDK routes extraction through add',
    ids: ['AT-044a', 'AT-044b'],
  },
  {
    number: 21,
    gate: false,
    behaviour: 'initialize is idempotent and the first search performs it',
    ids: ['AT-045a', 'AT-045b'],
  },
  {
    number: 22,
    gate: false,
    behaviour: 'concurrent initialize across instances makes one client and one index set',
    ids: ['AT-012', 'AT-065'],
  },
  {
    number: 23,
    gate: false,
    behaviour: 'a filter naming an undeclared field raises a ValueError naming the field',
    ids: ['AT-049'],
  },
  {
    number: 24,
    gate: false,
    behaviour: 'a filter containing an MQL operator key is rejected',
    ids: ['AT-050a', 'AT-050b', 'AT-050c'],
  },
  {
    number: 25,
    gate: false,
    behaviour: "two scopes never see each other's documents, for search and for add",
    ids: ['AT-046', 'AT-047a', 'AT-047b'],
  },
  { number: 26, gate: false, behaviour: 'an injected client is never closed by the store', ids: ['AT-010', 'AT-011'] },
  {
    number: 27,
    gate: false,
    behaviour: 'driver metadata is attached on both construction paths',
    ids: ['AT-013a', 'AT-013b'],
  },
  {
    number: 28,
    gate: false,
    behaviour: 'an oversized payload raises StorageError naming the key, size and limit',
    ids: ['AT-029', 'AT-038a'],
  },
  {
    number: 29,
    gate: false,
    behaviour: 'vector on a deployment without search raises, auto degrades and reports',
    ids: ['AT-053a', 'AT-053c', 'AT-054'],
  },
]

// Written out apart from the table so a flag flipped by accident in one contradicts the other.
export const RELEASE_GATE: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19])
