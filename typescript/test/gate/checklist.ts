/** One numbered item from the contract checklist, copied from `python/tests/test_gate.py`. */
export interface Item {
  number: number
  behaviour: string
  ids: readonly string[]
}

// Items 10 and 11 name the same two ids on purpose: both are halves of the normalisation decision.
export const CHECKLIST: readonly Item[] = [
  { number: 1, behaviour: 'read of an absent key returns None rather than raising', ids: ['AT-021'] },
  {
    number: 2,
    behaviour: 'read raises StorageError for a failure other than a missing key',
    ids: ['AT-022'],
  },
  {
    number: 3,
    behaviour: 'write overwrites an existing value rather than appending or erroring',
    ids: ['AT-020'],
  },
  {
    number: 4,
    behaviour: 'bytes round-trip unchanged, including empty, every byte value and a large payload',
    ids: ['AT-024'],
  },
  { number: 5, behaviour: 'delete of an absent key is a no-op', ids: ['AT-023'] },
  { number: 6, behaviour: "list('') returns every key", ids: ['AT-025'] },
  { number: 7, behaviour: 'list(prefix) returns full keys rather than suffixes', ids: ['AT-026'] },
  {
    number: 8,
    behaviour: "list results sort lexicographically, asserted against Python's sorted()",
    ids: ['AT-027'],
  },
  { number: 9, behaviour: 'list on a prefix matching nothing returns an empty list', ids: ['AT-028'] },
  {
    number: 10,
    behaviour: "keys normalise the SDK's way, so which keys collide is a documented decision",
    ids: ['AT-018', 'AT-019'],
  },
  {
    number: 11,
    behaviour: "a key or prefix containing a '..' segment is rejected",
    ids: ['AT-018', 'AT-019'],
  },
  {
    number: 12,
    behaviour: 'search scores are similarity-oriented, higher being better',
    ids: ['AT-032d', 'AT-033'],
  },
  {
    number: 13,
    behaviour: 'scores stay in the documented range and data is populated as asked',
    ids: ['AT-032b', 'AT-033'],
  },
  {
    number: 14,
    behaviour: 'a transport failure raises StorageError with the cause chained',
    ids: ['AT-022', 'AT-036', 'AT-080'],
  },
  {
    number: 15,
    behaviour: 'the session-snapshot key shapes round-trip and UUID7 keys sort chronologically',
    ids: ['AT-027', 'AT-081'],
  },
  {
    number: 16,
    behaviour: 'search returns MemoryEntry with content, store_name and the reserved metadata',
    ids: ['AT-040'],
  },
  {
    number: 17,
    behaviour: 'max_search_results precedence, and below 1 raises ValueError',
    ids: ['AT-041'],
  },
  {
    number: 18,
    behaviour: 'adding identical content twice leaves one document and reports one duplicate',
    ids: ['AT-042'],
  },
  {
    number: 19,
    behaviour: 'a concurrent duplicate insert surfaces as success, not DuplicateKeyError',
    ids: ['AT-043'],
  },
  {
    number: 20,
    behaviour: 'add_messages stays absent, so the SDK routes extraction through add',
    ids: ['AT-044a', 'AT-044b'],
  },
  {
    number: 21,
    behaviour: 'initialize is idempotent and the first search performs it',
    ids: ['AT-045a', 'AT-045b'],
  },
  {
    number: 22,
    behaviour: 'concurrent initialize across instances makes one client and one index set',
    ids: ['AT-012', 'AT-065'],
  },
  {
    number: 23,
    behaviour: 'a filter naming an undeclared field raises a ValueError naming the field',
    ids: ['AT-049'],
  },
  {
    number: 24,
    behaviour: 'a filter containing an MQL operator key is rejected',
    ids: ['AT-050a', 'AT-050b', 'AT-050c'],
  },
  {
    number: 25,
    behaviour: "two scopes never see each other's documents, for search and for add",
    ids: ['AT-046', 'AT-047a', 'AT-047b'],
  },
  { number: 26, behaviour: 'an injected client is never closed by the store', ids: ['AT-010', 'AT-011'] },
  {
    number: 27,
    behaviour: 'driver metadata is attached on both construction paths',
    ids: ['AT-013a', 'AT-013b'],
  },
  {
    number: 28,
    behaviour: 'an oversized payload raises StorageError naming the key, size and limit',
    ids: ['AT-029', 'AT-038a'],
  },
  {
    number: 29,
    behaviour: 'vector on a deployment without search raises, auto degrades and reports',
    ids: ['AT-053a', 'AT-053c', 'AT-054'],
  },
]

/** The items a release needs proven against a real deployment. */
export const RELEASE_GATE: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19])
