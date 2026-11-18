import { Buffer } from 'node:buffer'
import { runInNewContext } from 'node:vm'
import { Binary, BSON, BSONRegExp, Decimal128, Long, ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { compose, validate } from '../filter.js'
import { BAKED_IN_FILTER_FIELDS as BAKED_IN } from '../index-specs.js'

function messageOf(run: () => void): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError)
    return (error as TypeError).message
  }
  throw new Error('expected a TypeError')
}

describe('BSON encoding premise', () => {
  const plain = BSON.serialize({ tier: { $ne: 'gold' } })

  it('AT-179 encodes a Map exactly as a plain object', () => {
    expect(Buffer.compare(BSON.serialize({ tier: new Map([['$ne', 'gold']]) }), plain)).toBe(0)
  })

  it('AT-179 encodes a class instance exactly as a plain object', () => {
    class Sneaky {
      $ne = 'gold'
    }

    expect(Buffer.compare(BSON.serialize({ tier: new Sneaky() }), plain)).toBe(0)
  })

  it('AT-179 encodes an object with a null _bsontype as a document carrying its keys', () => {
    const decoded = BSON.deserialize(BSON.serialize({ tier: { _bsontype: null, $ne: 'gold' } }))

    expect(decoded.tier).toMatchObject({ $ne: 'gold' })
  })
})

describe('validate', () => {
  describe('operator keys', () => {
    it.each(['$where', '$expr', '$function', '$accumulator', '$or', '$and', '$nor', '$jsonSchema'])(
      'AT-050a rejects the top-level operator %s by name',
      (operator) => {
        expect(messageOf(() => validate({ [operator]: 'anything' }, { declaredFields: BAKED_IN }))).toContain(operator)
      }
    )

    it('names the offending key with the package prefix', () => {
      const message = messageOf(() => validate({ $where: 'sleep(1000)' }, { declaredFields: BAKED_IN }))

      expect(message).toMatch(/^strands_mongodb: /)
      expect(message).toContain('$where')
      expect(message).not.toContain('sleep(1000)')
    })

    it('AT-050b rejects an operator nested one level down', () => {
      expect(() => validate({ a: { $ne: null } }, { declaredFields: ['a'] })).toThrow(/\$ne/)
    })

    it('rejects an operator nested three levels down', () => {
      expect(() => validate({ a: { b: { c: { $gt: 1 } } } }, { declaredFields: ['a'] })).toThrow(/\$gt/)
    })

    it('rejects an operator inside an array', () => {
      expect(() => validate({ a: [{ $where: 'sleep(1000)' }] }, { declaredFields: ['a'] })).toThrow(/\$where/)
    })

    it('rejects an operator inside a nested array', () => {
      expect(() => validate({ a: [[{ $expr: {} }]] }, { declaredFields: ['a'] })).toThrow(/\$expr/)
    })

    it('AT-050c ignores a Symbol-keyed property, which BSON never encodes', () => {
      const filter = { a: 'x', [Symbol('$where')]: 'sleep(1000)' }

      expect(() => validate(filter, { declaredFields: ['a'] })).not.toThrow()
    })

    it('AT-050c rejects a non-string Map key', () => {
      expect(() => validate({ a: new Map<unknown, unknown>([[1, 'x']]) }, { declaredFields: ['a'] })).toThrow(TypeError)
    })

    it('allows arrays of plain values', () => {
      expect(() => validate({ tier: ['gold', 'silver'] }, { declaredFields: ['tier'] })).not.toThrow()
      expect(() => validate({ tier: [] }, { declaredFields: ['tier'] })).not.toThrow()
      expect(() => validate({ tier: [{ nested: 'ok' }] }, { declaredFields: ['tier'] })).not.toThrow()
    })

    it('allows a $ that is not a prefix', () => {
      expect(() => validate({ price$usd: 10 }, { declaredFields: ['price$usd'] })).not.toThrow()
    })

    it('rejects a benign comparison operator too, since there is no allow-list', () => {
      expect(() => validate({ age: { $gt: 5 } }, { declaredFields: ['age'] })).toThrow(/\$gt/)
    })
  })

  describe('mapping kinds', () => {
    const DECLARED = ['tier', 'scope', 'store_name']
    const mappings = (payload: Record<string, unknown>): [string, unknown][] => [
      ['Map', new Map(Object.entries(payload))],
      ['null-prototype object', Object.assign(Object.create(null) as object, payload)],
    ]

    it.each(mappings({ $ne: 'gold' }))('AT-179 rejects an operator inside a %s value', (_kind, value) => {
      expect(() => validate({ tier: value }, { declaredFields: DECLARED })).toThrow(/\$ne/)
    })

    it('AT-179 rejects an operator in a Map nested one level down', () => {
      const filter = { tier: { inner: new Map([['$ne', null]]) } }

      expect(() => validate(filter, { declaredFields: DECLARED })).toThrow(/\$ne/)
    })

    it('AT-179 rejects an operator in a Map inside an array', () => {
      const filter = { tier: [new Map([['$where', 'sleep(1000)']])] }

      expect(() => validate(filter, { declaredFields: DECLARED })).toThrow(/\$where/)
    })

    class Sneaky {
      $ne = 'gold'
    }

    it('AT-179 rejects an operator in a class instance used as the filter itself', () => {
      expect(() => validate(new Sneaky() as unknown as Record<string, unknown>, { declaredFields: DECLARED })).toThrow(
        /\$ne/
      )
    })

    it('AT-179 rejects an operator in a class instance nested inside a value', () => {
      expect(() => validate({ tier: { inner: new Sneaky() } }, { declaredFields: DECLARED })).toThrow(/\$ne/)
    })

    const forged = '{"_bsontype": null, "tier": {"$ne": "gold"}, "undeclared": {"$where": "sleep(1000)"}}'

    it('AT-179 rejects an operator in a forged null _bsontype object used as the filter itself', () => {
      const filter = JSON.parse(forged) as Record<string, unknown>

      expect(() => validate(filter, { declaredFields: [...DECLARED, '_bsontype', 'undeclared'] })).toThrow(/\$ne/)
    })

    it('AT-179 rejects an operator in a forged null _bsontype object nested as a value', () => {
      const filter = { tier: JSON.parse(forged) as unknown }

      expect(() => validate(filter, { declaredFields: DECLARED })).toThrow(/\$ne/)
    })

    it('AT-049 checks the top-level keys of a forged null _bsontype filter', () => {
      const filter = JSON.parse('{"_bsontype": null, "tier": "gold", "undeclared": "x"}') as Record<string, unknown>

      expect(() => validate(filter, { declaredFields: DECLARED })).toThrow(/'_bsontype', 'undeclared'/)
    })

    it.each([
      ['an ObjectId', new ObjectId()],
      ['a Date', new Date(0)],
      ['a Buffer', Buffer.from('gold')],
      ['a Binary', new Binary(Buffer.from('gold'))],
      ['a Decimal128', Decimal128.fromString('1.5')],
      ['a Long', Long.fromNumber(5)],
      ['a value from a second copy of bson 7', { _bsontype: 'ObjectId', [Symbol.for('@@mdb.bson.version')]: 7 }],
    ])('passes %s value, since the driver encodes it as a scalar', (_kind, value) => {
      const filter = { tier: value, nested: [{ tier: value }] }

      expect(() => validate(filter, { declaredFields: ['tier', 'nested'] })).not.toThrow()
    })

    it.each([
      ['parsed from JSON', JSON.parse('{"_bsontype": "x", "$ne": 1}') as unknown],
      ['from another major version of bson', { _bsontype: 'ObjectId', [Symbol.for('@@mdb.bson.version')]: 6 }],
    ])('rejects an object carrying a _bsontype marker %s, naming the path', (_kind, value) => {
      const message = messageOf(() => validate({ tier: { inner: [value] } }, { declaredFields: DECLARED }))

      expect(message).toMatch(/^strands_mongodb: /)
      expect(message).toContain("'tier.inner[0]'")
      expect(message).toContain('_bsontype')
    })

    it('rejects a _bsontype marker on the filter itself', () => {
      const filter = JSON.parse('{"_bsontype": "x", "tier": "gold"}') as Record<string, unknown>

      expect(messageOf(() => validate(filter, { declaredFields: [...DECLARED, '_bsontype'] }))).toContain('_bsontype')
    })

    it('reports an operator key before a forged _bsontype value', () => {
      const forgedValue = JSON.parse('{"_bsontype": "x"}') as unknown

      expect(() => validate({ tier: forgedValue, scope: { $ne: 1 } }, { declaredFields: DECLARED })).toThrow(/\$ne/)
    })

    it.each([
      ['a Map', new Map([['tier', 'gold']])],
      ['an array', [{ tier: 'gold' }]],
      ['a Date', new Date(0)],
    ])('rejects %s as the filter itself', (_kind, value) => {
      const message = messageOf(() =>
        validate(value as unknown as Record<string, unknown>, { declaredFields: DECLARED })
      )

      expect(message).toMatch(/^strands_mongodb: /)
      expect(message).toContain('plain object')
    })

    it('accepts a null-prototype object as the filter itself', () => {
      const filter = Object.assign(Object.create(null) as Record<string, unknown>, { tier: 'gold' })

      expect(() => validate(filter, { declaredFields: DECLARED })).not.toThrow()
    })

    it('allows a clean mapping value as exact subdocument equality', () => {
      for (const [, value] of mappings({ inner: 'gold' })) {
        expect(() => validate({ tier: value }, { declaredFields: DECLARED })).not.toThrow()
      }
    })
  })

  describe('regex values', () => {
    const DECLARED = ['tier', 'scope', 'store_name']

    it('AT-179 rejects a RegExp value and names the field', () => {
      const message = messageOf(() => validate({ tier: /^gol/ }, { declaredFields: DECLARED }))

      expect(message).toMatch(/^strands_mongodb: /)
      expect(message).toContain("'tier'")
      expect(message).toContain('regular expression')
      expect(message).not.toContain('^gol')
    })

    it('names the path of a nested regex', () => {
      const message = messageOf(() => validate({ tier: { inner: [1, /x/] } }, { declaredFields: DECLARED }))

      expect(message).toContain("'tier.inner[1]'")
    })

    it('rejects a BSONRegExp from a second copy of bson', () => {
      const foreign = { _bsontype: 'BSONRegExp', pattern: 'x', options: '', [Symbol.for('@@mdb.bson.version')]: 7 }

      expect(() => validate({ tier: foreign }, { declaredFields: DECLARED })).toThrow(/regular expression/)
    })

    it('AT-179 rejects a BSONRegExp value', () => {
      expect(() => validate({ tier: new BSONRegExp('^gol') }, { declaredFields: DECLARED })).toThrow(
        /regular expression/
      )
    })

    it('rejects a subclass of BSONRegExp', () => {
      class Sneaky extends BSONRegExp {}

      expect(() => validate({ tier: new Sneaky('^gol') }, { declaredFields: DECLARED })).toThrow(/regular expression/)
    })

    it.each([
      ['a nested object', { tier: { inner: /x/ } }],
      ['an array', { tier: [/x/] }],
      ['an array, as a BSONRegExp', { tier: [new BSONRegExp('x')] }],
      ['a Map', { tier: new Map([['inner', /x/]]) }],
    ])('rejects a regex inside %s', (_where, filter) => {
      expect(() => validate(filter, { declaredFields: DECLARED })).toThrow(/regular expression/)
    })

    it('rejects a RegExp from another realm, which the driver still encodes as a regex', () => {
      const foreign: unknown = runInNewContext('/.*/')

      expect(foreign).not.toBeInstanceOf(RegExp)
      expect(() => validate({ tier: foreign }, { declaredFields: DECLARED })).toThrow(/regular expression/)
    })

    it.each([
      ['a Map from another realm', runInNewContext('new Map([["$ne", "gold"]])') as unknown],
      ['an object tagged as a Map', { [Symbol.toStringTag]: 'Map', entries: () => [['$ne', 'gold']] }],
    ])('rejects an operator key inside %s, which the driver still encodes as a document', (_what, smuggled) => {
      expect(() => validate({ tier: smuggled }, { declaredFields: DECLARED })).toThrow(/invalid filter key '\$ne'/)
    })

    it('rejects a Map from another realm as the filter itself', () => {
      const foreign = runInNewContext('new Map([["tier", "gold"]])') as Record<string, unknown>

      expect(() => validate(foreign, { declaredFields: DECLARED })).toThrow(/not a plain object/)
    })

    it('allows a string that looks like a pattern', () => {
      expect(() => validate({ tier: '^gol.*$' }, { declaredFields: DECLARED })).not.toThrow()
      expect(() => validate({ tier: ['^gol', 'silver'] }, { declaredFields: DECLARED })).not.toThrow()
    })

    it('reports the operator key when a filter has both faults', () => {
      const message = messageOf(() => validate({ tier: { $ne: /x/ } }, { declaredFields: DECLARED }))

      expect(message).toContain('$ne')
      expect(message).not.toContain('regular expression')
    })
  })

  describe('values the driver would not send as written', () => {
    const DECLARED = ['tier', 'scope', 'store_name']

    it.each([
      ['undefined', undefined],
      ['function', () => 1],
      ['symbol', Symbol('gold')],
    ])('rejects a value of type %s, which the driver can drop so the term matches everything', (type, value) => {
      const message = messageOf(() => validate({ tier: value }, { declaredFields: DECLARED }))

      expect(message).toContain("'tier'")
      expect(message).toContain(type)
    })

    it.each([
      ['a nested object', { tier: { inner: undefined } }, "'tier.inner'"],
      ['an array', { tier: ['gold', () => 1] }, "'tier[1]'"],
      ['a Map', { tier: new Map([['inner', Symbol('x')]]) }, "'tier.inner'"],
    ])('names the path of one inside %s', (_where, filter, path) => {
      expect(messageOf(() => validate(filter, { declaredFields: DECLARED }))).toContain(path)
    })

    it('allows null, which matches a null or missing field', () => {
      expect(() => validate({ tier: null }, { declaredFields: DECLARED })).not.toThrow()
    })

    it.each([
      ['a value', { tier: { toBSON: () => ({ $ne: null }) } }, "'tier'"],
      ['the filter itself', { toBSON: () => ({ tier: { $ne: null } }) }, 'the top level'],
      ['a Date', { tier: Object.assign(new Date(0), { toBSON: () => ({ $ne: null }) }) }, "'tier'"],
    ])('rejects toBSON on %s, which the driver would encode in its place', (_where, filter, path) => {
      const message = messageOf(() => validate(filter, { declaredFields: DECLARED }))

      expect(message).toContain('toBSON')
      expect(message).toContain(path)
    })

    it('reports an operator key before a dropped value', () => {
      const message = messageOf(() => validate({ tier: undefined, scope: { $ne: 1 } }, { declaredFields: DECLARED }))

      expect(message).toContain('$ne')
    })
  })

  describe('undeclared fields', () => {
    it('AT-049 rejects an undeclared field and names it', () => {
      expect(() => validate({ 'metadata.foo': 'x' }, { declaredFields: BAKED_IN })).toThrow(/metadata\.foo/)
    })

    it('names the config key and the available fields', () => {
      const message = messageOf(() => validate({ 'metadata.foo': 'x' }, { declaredFields: BAKED_IN }))

      expect(message).toMatch(/^strands_mongodb: /)
      expect(message).toContain('filterFields')
      expect(message).toContain('scope, store_name')
    })

    it('says none when nothing is declared', () => {
      expect(() => validate({ region: 'eu' }, { declaredFields: [] })).toThrow(/filterable here: none/)
    })

    it('passes a declared field', () => {
      expect(() =>
        validate({ 'metadata.tier': 'gold' }, { declaredFields: ['scope', 'store_name', 'metadata.tier'] })
      ).not.toThrow()
    })

    it('treats the baked-in paths as filterable', () => {
      expect(() => validate({ scope: 'tenant-a' }, { declaredFields: BAKED_IN })).not.toThrow()
      expect(() => validate({ store_name: 'facts' }, { declaredFields: BAKED_IN })).not.toThrow()
    })

    it('names every undeclared field, sorted', () => {
      const message = messageOf(() =>
        validate({ 'metadata.tier': 1, region: 2, created_at: 3 }, { declaredFields: ['scope'] })
      )

      expect(message).toContain("'created_at', 'metadata.tier', 'region'")
    })

    it('accepts any iterable of declared fields', () => {
      expect(() => validate({ tier: 'gold' }, { declaredFields: new Set(['tier']) })).not.toThrow()
    })

    it('treats only top-level keys as field paths', () => {
      expect(() => validate({ metadata: { tier: 'gold' } }, { declaredFields: ['metadata'] })).not.toThrow()

      expect(() => validate({ metadata: { tier: 'gold' } }, { declaredFields: ['metadata.tier'] })).toThrow(/metadata/)
    })

    it('accepts an empty filter', () => {
      expect(() => validate({}, { declaredFields: [] })).not.toThrow()
    })

    it('runs the operator guard before the declared-field guard', () => {
      const message = messageOf(() => validate({ $where: 'sleep(1000)' }, { declaredFields: [] }))

      expect(message).toContain('$where')
      expect(message).not.toContain('filterFields')
    })
  })
})

describe('compose', () => {
  const options = { scope: 'tenant-a', storeName: 'facts' }

  describe('scope predicate', () => {
    it('AT-051 is present without a caller filter', () => {
      const composed = compose([undefined], options)

      expect(composed.$and).toContainEqual({ scope: { $eq: 'tenant-a' } })
      expect(composed.$and).toContainEqual({ store_name: { $eq: 'facts' } })
    })

    it('comes first', () => {
      const composed = compose([{ 'metadata.tier': 'gold' }], options)

      expect((composed.$and as unknown[])[0]).toEqual({ scope: { $eq: 'tenant-a' } })
    })

    it('composes the sentinel scope like any other', () => {
      const composed = compose([undefined], { scope: '__no_scope__', storeName: 'facts' })

      expect((composed.$and as unknown[])[0]).toEqual({ scope: { $eq: '__no_scope__' } })
    })
  })

  describe('caller filters', () => {
    it('AT-051 conjoins rather than merges', () => {
      const composed = compose([{ 'metadata.tier': 'gold' }], options)

      expect(composed.$and).toContainEqual({ scope: { $eq: 'tenant-a' } })
      expect(composed.$and).toContainEqual({ 'metadata.tier': 'gold' })
    })

    it('AT-051 cannot replace the scope predicate by naming scope', () => {
      const composed = compose([{ scope: 'tenant-b' }], options)

      expect(composed.$and).toContainEqual({ scope: { $eq: 'tenant-a' } })
      expect(composed.$and).toContainEqual({ scope: 'tenant-b' })
    })

    it.each([
      ['undefined', undefined],
      ['an empty object', {}],
    ])('adds no term for %s', (_kind, callerFilter) => {
      expect(compose([callerFilter], options)).toEqual({
        $and: [{ scope: { $eq: 'tenant-a' } }, { store_name: { $eq: 'facts' } }],
      })
    })

    it('keeps each caller filter as its own term, in order', () => {
      const composed = compose([{ tier: 'gold' }, undefined, { region: 'eu' }], options)

      expect(composed.$and).toEqual([
        { scope: { $eq: 'tenant-a' } },
        { store_name: { $eq: 'facts' } },
        { tier: 'gold' },
        { region: 'eu' },
      ])
    })

    it('does not mutate the caller filter', () => {
      const caller = { 'metadata.tier': 'gold' }

      compose([caller], options)

      expect(caller).toEqual({ 'metadata.tier': 'gold' })
    })

    it('copies the caller filter so later top-level mutation leaves the predicate alone', () => {
      const caller: Record<string, unknown> = { 'metadata.tier': 'gold' }
      const composed = compose([caller], options)
      const term = (composed.$and as unknown[])[2]

      caller['metadata.tier'] = 'bronze'

      expect(term).not.toBe(caller)
      expect(term).toEqual({ 'metadata.tier': 'gold' })
    })

    it('rejects a Map rather than dropping it, since it would add no term', () => {
      const caller = new Map([['tier', 'gold']]) as unknown as Record<string, unknown>

      expect(() => compose([caller], options)).toThrow(TypeError)
    })

    it('keeps a BSON value as the same instance', () => {
      const id = new ObjectId()
      const composed = compose([{ owner: id }], options)

      expect(((composed.$and as unknown[])[2] as Record<string, unknown>).owner).toBe(id)
    })
  })
})
