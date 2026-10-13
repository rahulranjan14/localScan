import { isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dataDir, resolveStoredPath, storedFilePath } from './fileStore.js'

/**
 * The regression here is `D-015`: the server and the worker are started in
 * different directories, and a store resolved against the working directory
 * meant a different place in each. One process wrote the bytes, the other read
 * an ENOENT.
 *
 * So these tests change the working directory, which is the only way to
 * distinguish a repository-anchored path from one that merely looks right while
 * the suite happens to run from the root.
 */

const HASH = 'a'.repeat(64)
const originalEnv = process.env.OCR_DATA_DIR
const originalCwd = process.cwd()

afterEach(() => {
  process.chdir(originalCwd)
  if (originalEnv === undefined) delete process.env.OCR_DATA_DIR
  else process.env.OCR_DATA_DIR = originalEnv
})

describe('the file store', () => {
  it('resolves one hash to one absolute path, whatever the working directory', () => {
    delete process.env.OCR_DATA_DIR
    const fromRepoRoot = storedFilePath(HASH)

    expect(isAbsolute(fromRepoRoot)).toBe(true)
    expect(fromRepoRoot.endsWith(join('data', 'files', HASH))).toBe(true)

    process.chdir(join(originalCwd, 'packages', 'worker'))
    expect(storedFilePath(HASH)).toBe(fromRepoRoot)

    process.chdir(join(originalCwd, 'packages', 'server'))
    expect(storedFilePath(HASH)).toBe(fromRepoRoot)
  })

  it('resolves a relative OCR_DATA_DIR against the repository, not the process', () => {
    process.env.OCR_DATA_DIR = 'data'
    const fromRepoRoot = dataDir()

    process.chdir(join(originalCwd, 'packages', 'worker'))
    expect(dataDir()).toBe(fromRepoRoot)
  })

  it('leaves an absolute OCR_DATA_DIR alone', () => {
    process.env.OCR_DATA_DIR = '/tmp/ocr-store'
    expect(dataDir()).toBe('/tmp/ocr-store')
  })

  it('reads a legacy relative files.path as the repository-relative path it meant', () => {
    const legacy = join('data', 'files', HASH)
    expect(resolveStoredPath(legacy)).toBe(resolve(originalCwd, legacy))
  })

  it('passes an absolute files.path through unchanged', () => {
    const stored = storedFilePath(HASH)
    expect(resolveStoredPath(stored)).toBe(stored)
  })
})
