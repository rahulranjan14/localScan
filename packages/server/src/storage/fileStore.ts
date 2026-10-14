import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * PDFs on disk, keyed by content hash. The database holds the path.
 *
 * Storing bytes in Postgres would be transactionally neater and wrong for this
 * application: it bloats every dump, and a local tool gains nothing from
 * row-and-bytes atomicity it can get by writing the file first and the row
 * second.
 *
 * Where the store lives is defined here and nowhere else, and it is anchored to
 * the repository rather than to a working directory (`D-015`). The server and
 * the worker are separate processes started in separate directories, so
 * `resolve('data')` meant two different places and an upload written by one was
 * looked for, unsuccessfully, by the other.
 */

/**
 * The workspace root, found by walking up for the `package.json` that declares
 * the workspaces.
 *
 * Derived from this module's own location rather than from `process.cwd()`,
 * which is the entire point: every process gets the same answer however it was
 * started, and the walk works the same from `src` under tsx as from `dist`
 * after a build. Computed once, because it cannot change while the process runs.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        workspaces?: unknown
      }
      if (pkg.workspaces) return dir
    } catch {
      // No package.json here, or it does not parse. Keep walking.
    }
    const parent = dirname(dir)
    // Reached the filesystem root without finding the workspace: fall back to
    // the working directory, which is what this code did before D-015.
    if (parent === dir) return process.cwd()
    dir = parent
  }
}

const repoRoot = findRepoRoot()

/**
 * `OCR_DATA_DIR` is resolved against the repository root, not the working
 * directory, so a relative override means one directory to every process.
 */
export const dataDir = (): string => resolve(repoRoot, process.env.OCR_DATA_DIR ?? 'data')
const filesDir = (): string => join(dataDir(), 'files')

/** Where the bytes for a hash live. The only definition of this path. */
export const storedFilePath = (hash: string): string => join(filesDir(), hash)

/**
 * Absolute path for a value read out of `files.path`.
 *
 * Rows written before `D-015` hold a path relative to whichever directory the
 * worker happened to be started in. Resolving those against the repository root
 * is what they meant, and it keeps documents stored then readable now without
 * rewriting data.
 */
export const resolveStoredPath = (path: string): string =>
  isAbsolute(path) ? path : resolve(repoRoot, path)

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface StoredFile {
  sha256: string
  path: string
  sizeBytes: number
}

/**
 * Writes the file and returns where it went. Idempotent: the same bytes produce
 * the same path, so a re-upload overwrites itself with identical content.
 */
export async function storeFile(bytes: Uint8Array): Promise<StoredFile> {
  const hash = sha256(bytes)
  await mkdir(filesDir(), { recursive: true })
  const path = storedFilePath(hash)
  await writeFile(path, bytes)
  return { sha256: hash, path, sizeBytes: bytes.byteLength }
}

export async function readStoredFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolveStoredPath(path)))
}
