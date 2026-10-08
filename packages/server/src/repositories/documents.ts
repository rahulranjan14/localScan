import type { DocumentStatus, DocumentType } from '@ocr/shared'
import { pool } from '../db/pool.js'

export interface DocumentRow {
  id: string
  fileId: string
  type: DocumentType
  rawText: string | null
  structuredData: unknown
  editedStructuredData: unknown
  confidence: number | null
  classificationReason: string | null
  status: DocumentStatus
  error: string | null
  createdAt: Date
  updatedAt: Date
}

const SELECT = `
  SELECT id,
         file_id                AS "fileId",
         type,
         raw_text               AS "rawText",
         structured_data        AS "structuredData",
         edited_structured_data AS "editedStructuredData",
         confidence,
         classification_reason  AS "classificationReason",
         status,
         error,
         created_at             AS "createdAt",
         updated_at             AS "updatedAt"
  FROM documents
`

export interface InsertDocument {
  fileId: string
  type: DocumentType
  rawText: string | null
  /** Null whenever validation failed -- never a partial result (FR-4.6). */
  structuredData: unknown
  confidence: number | null
  classificationReason: string | null
  status: DocumentStatus
  error: string | null
}

export async function insertDocument(input: InsertDocument): Promise<DocumentRow> {
  const { rows } = await pool.query<DocumentRow>(
    `
    INSERT INTO documents
      (file_id, type, raw_text, structured_data, confidence, classification_reason, status, error)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, file_id AS "fileId", type, raw_text AS "rawText",
              structured_data AS "structuredData",
              edited_structured_data AS "editedStructuredData",
              confidence, classification_reason AS "classificationReason",
              status, error, created_at AS "createdAt", updated_at AS "updatedAt"
    `,
    [
      input.fileId,
      input.type,
      input.rawText,
      input.structuredData === null ? null : JSON.stringify(input.structuredData),
      input.confidence,
      input.classificationReason,
      input.status,
      input.error,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('insertDocument returned no row')
  return row
}

export async function findDocumentById(id: string): Promise<DocumentRow | null> {
  const { rows } = await pool.query<DocumentRow>(`${SELECT} WHERE id = $1`, [id])
  return rows[0] ?? null
}

/** Most recent document for a stored file, used to answer a re-upload. */
export async function findDocumentByFileId(fileId: string): Promise<DocumentRow | null> {
  const { rows } = await pool.query<DocumentRow>(
    `${SELECT} WHERE file_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [fileId],
  )
  return rows[0] ?? null
}

export interface ListFilter {
  type?: string | undefined
  status?: string | undefined
  limit?: number
}

export async function listDocuments(filter: ListFilter = {}): Promise<DocumentRow[]> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.type) {
    params.push(filter.type)
    conditions.push(`type = $${params.length}`)
  }
  if (filter.status) {
    params.push(filter.status)
    conditions.push(`status = $${params.length}`)
  }

  params.push(Math.min(filter.limit ?? 100, 500))

  const { rows } = await pool.query<DocumentRow>(
    `${SELECT}
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  )
  return rows
}

/**
 * Writes the edited copy only. `structured_data` is never updated, so what the
 * model produced stays available for comparison after any number of corrections
 * (FR-5.6).
 */
export async function updateEditedData(id: string, data: unknown): Promise<DocumentRow | null> {
  const { rows } = await pool.query<DocumentRow>(
    `
    UPDATE documents
       SET edited_structured_data = $2,
           status = CASE WHEN status = 'needs_review' THEN 'completed' ELSE status END,
           updated_at = now()
     WHERE id = $1
    RETURNING id, file_id AS "fileId", type, raw_text AS "rawText",
              structured_data AS "structuredData",
              edited_structured_data AS "editedStructuredData",
              confidence, classification_reason AS "classificationReason",
              status, error, created_at AS "createdAt", updated_at AS "updatedAt"
    `,
    [id, JSON.stringify(data)],
  )
  return rows[0] ?? null
}
