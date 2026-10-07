import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * PDFs on disk, keyed by content hash. The database holds the path.
 *
 * Storing bytes in Postgres would be transactionally neater and wrong for this
 * application: it bloats every dump, and a local tool gains nothing from
 * row-and-bytes atomicity it can get by writing the file first and the row
 * second.
 */

export const dataDir = (): string => resolve(process.env.OCR_DATA_DIR ?? 'data')
const filesDir = (): string => join(dataDir(), 'files')

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
  const path = join(filesDir(), hash)
  await writeFile(path, bytes)
  return { sha256: hash, path, sizeBytes: bytes.byteLength }
}

export async function readStoredFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}
