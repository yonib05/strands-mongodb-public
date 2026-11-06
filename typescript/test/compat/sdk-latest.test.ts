import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryManager, type MemoryStore, StorageError } from '@strands-agents/sdk'
import * as storageModule from '@strands-agents/sdk/storage'
import type { Storage } from '@strands-agents/sdk/storage'
import { Embedder } from '@strands-agents/sdk/storage/search'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { MongoDBMemoryStore, MongoDBStorage } from '../../src/index.js'
import { PACKAGE_ROOT } from '../readme.js'

const SDK = '@strands-agents/sdk'

const manifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    version: string
    peerDependencies: Record<string, string>
  }

const parse = (version: string) => version.split(/[-+]/)[0]!.split('.').map(Number)

function atLeast(installed: string, floor: string): boolean {
  const [a, b] = [parse(installed), parse(floor)]
  const differing = a.findIndex((part, index) => part !== b[index])
  return differing === -1 || a[differing]! > b[differing]!
}

describe('AT-034, AT-052: the installed SDK still carries what this package is built on', () => {
  it('is at least the declared floor', () => {
    const floor = manifest(PACKAGE_ROOT).peerDependencies[SDK]!.replace(/^>=/, '')
    // The SDK's `exports` map does not expose its package.json, so it is read from disk.
    const installed = manifest(join(PACKAGE_ROOT, 'node_modules', SDK)).version

    expect(atLeast(installed, floor), `${SDK} ${installed} is below the floor ${floor}`).toBe(true)
  })

  it('exports the four names the package imports', () => {
    expect(storageModule).toBeTypeOf('object')
    expect(StorageError).toBeTypeOf('function')
    expect(MemoryManager).toBeTypeOf('function')
    expect(Embedder).toBeTypeOf('function')
  })

  it('accepts MongoDBMemoryStore as a MemoryStore and MongoDBStorage as a Storage', () => {
    expectTypeOf<MongoDBMemoryStore>().toExtend<MemoryStore>()
    expectTypeOf<MongoDBStorage>().toExtend<Storage>()
  })

  it('compares versions by number rather than as strings', () => {
    expect(atLeast('1.100.0', '1.23.0')).toBe(true)
    expect(atLeast('1.23.0', '1.23.0')).toBe(true)
    expect(atLeast('1.22.9', '1.23.0')).toBe(false)
    expect(atLeast('2.0.0-rc.1', '1.23.0')).toBe(true)
  })
})
