import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadDotEnv, TIER_VARIABLES, tierUri } from '../env.js'

describe('loadDotEnv', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strands-mongodb-env-'))
    for (const name of Object.values(TIER_VARIABLES)) vi.stubEnv(name, undefined)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const writeEnv = (name: string, text: string) => {
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }

  it('fills an unset variable', () => {
    const path = writeEnv('.env', 'MONGODB_URI=mongodb://localhost:27017/?directConnection=true\n')
    loadDotEnv([path])
    expect(process.env.MONGODB_URI).toBe('mongodb://localhost:27017/?directConnection=true')
    expect(tierUri('contract')).toBe('mongodb://localhost:27017/?directConnection=true')
  })

  it('strips one layer of quotes', () => {
    const path = writeEnv('.env', 'MONGODB_ATLAS_URI="mongodb+srv://u:p%40ss@cluster/?w=majority"\n')
    loadDotEnv([path])
    expect(tierUri('integration')).toBe('mongodb+srv://u:p%40ss@cluster/?w=majority')
  })

  it('does not recognise an export prefix', () => {
    const path = writeEnv('.env', 'export MONGODB_URI=x\n')
    loadDotEnv([path])
    expect(process.env.MONGODB_URI).toBeUndefined()
  })

  it('never sets the build tier flag', () => {
    const path = writeEnv('.env', 'STRANDS_MONGODB_BUILD_TIER=1\n')
    loadDotEnv([path])
    expect(process.env.STRANDS_MONGODB_BUILD_TIER).toBeUndefined()
    expect(tierUri('build')).toBeUndefined()
  })

  it('does not override a variable that is already set', () => {
    vi.stubEnv('MONGODB_URI', 'mongodb://from-shell')
    const path = writeEnv('.env', 'MONGODB_URI=mongodb://from-file\n')
    loadDotEnv([path])
    expect(process.env.MONGODB_URI).toBe('mongodb://from-shell')
  })

  it('treats a variable set to empty as set, and tierUri reads it as undefined', () => {
    vi.stubEnv('MONGODB_URI', '')
    const path = writeEnv('.env', 'MONGODB_URI=mongodb://from-file\n')
    loadDotEnv([path])
    expect(process.env.MONGODB_URI).toBe('')
    expect(tierUri('contract')).toBeUndefined()
  })

  it('reads an empty assignment in the file as empty', () => {
    const path = writeEnv('.env', 'MONGODB_URI=\n')
    loadDotEnv([path])
    expect(process.env.MONGODB_URI).toBe('')
    expect(tierUri('contract')).toBeUndefined()
  })

  it('ignores comment lines and blank lines', () => {
    const path = writeEnv('.env', '# MONGODB_URI=mongodb://commented\n\n  #MONGODB_ATLAS_URI=x\n')
    loadDotEnv([path])
    expect(process.env.MONGODB_URI).toBeUndefined()
    expect(process.env.MONGODB_ATLAS_URI).toBeUndefined()
  })

  it('ignores keys that are not tier variables', () => {
    vi.stubEnv('STRANDS_MONGODB_UNRELATED', undefined)
    const path = writeEnv('.env', 'STRANDS_MONGODB_UNRELATED=1\n')
    loadDotEnv([path])
    expect(process.env.STRANDS_MONGODB_UNRELATED).toBeUndefined()
  })

  it('reads only the first file that exists', () => {
    const first = writeEnv('first.env', 'MONGODB_URI=mongodb://first\n')
    const second = writeEnv('second.env', 'MONGODB_ATLAS_URI=mongodb://second\n')
    loadDotEnv([join(dir, 'missing.env'), first, second])
    expect(process.env.MONGODB_URI).toBe('mongodb://first')
    expect(process.env.MONGODB_ATLAS_URI).toBeUndefined()
  })

  it('does not throw when no file exists', () => {
    expect(() => loadDotEnv([join(dir, 'missing.env')])).not.toThrow()
    expect(tierUri('contract')).toBeUndefined()
  })
})
