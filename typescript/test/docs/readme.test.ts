import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blocks, PACKAGE_README, prepare, selected, type Snippets, unconfigured, where } from '../readme.js'

describe('AT-092: the quickstarts are executed from the README text', () => {
  const unit = selected('unit', blocks(PACKAGE_README))
  let snippets: Snippets

  beforeAll(() => {
    snippets = prepare(unit)
  })

  afterAll(() => {
    snippets?.dispose()
  })

  it('type-checks every unit snippet against the package', () => {
    expect(unit.length).toBeGreaterThan(0)
    expect(() => snippets.typeCheck()).not.toThrow()
  })

  it.each(unit.map((block) => [where(block), block] as const))('runs %s with nothing reachable', (_location, block) => {
    expect(() => snippets.run(block, unconfigured())).not.toThrow()
  })
})
