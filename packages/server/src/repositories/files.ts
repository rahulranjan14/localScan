import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'

export interface FileRow {
  id: string
  filename: string
  mime: string
  sizeBytes: number
  sha256: string
  path: string
  createdAt: Date
}

const SELECT = `
  SELECT id, filename, mime, size_bytes AS "sizeBytes", sha256, path, created_at AS "createdAt"
  FROM files
`

export async function findFileBySha256(hash: string): Promise<FileRow | null> {
  const { rows } = await pool.query<FileRow>(`${SELECT} WHERE sha256 = $1`, [hash])
  return rows[0] ?? null
}

export async function findFileById(id: string): Promise<FileRow | null> {
  const { rows } = await pool.query<FileRow>(`${SELECT} WHERE id = $1`, [id])
  return rows[0] ?? null
}

export interface InsertFile {
  filename: string
  mime: string
  sizeBytes: number
  sha256: string
  path: string
}

/**
 * Inserts, or returns the existing row for identical content.
 *
 * `ON CONFLICT` rather than a check-then-insert: the hash is unique, and
 * checking first leaves a window in which a concurrent upload of the same file
 * inserts between the check and the write. Rare on a single-user tool, but the
 * conflict clause costs nothing and removes the case entirely.
 */
export async function insertFile(input: InsertFile, client?: PoolClient): Promise<FileRow> {
  const executor = client ?? pool
  const { rows } = await executor.query<FileRow>(
    `
    INSERT INTO files (filename, mime, size_bytes, sha256, path)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (sha256) DO UPDATE SET filename = files.filename
    RETURNING id, filename, mime, size_bytes AS "sizeBytes", sha256, path, created_at AS "createdAt"
    `,
    [input.filename, input.mime, input.sizeBytes, input.sha256, input.path],
  )
  const row = rows[0]
  if (!row) throw new Error('insertFile returned no row')
  return row
}
