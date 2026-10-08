import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'

/**
 * Chunk storage and vector search.
 *
 * `@ocr/core` owns chunking and embedding and knows nothing about Postgres; this
 * file owns the SQL and knows nothing about models. Retrieval in core takes a
 * query function rather than a database client for the same reason — it is what
 * keeps the engine usable from the harness and the agent surface.
 */

export interface ChunkRow {
  id: string
  documentId: string
  page: number
  index: number
  content: string
}

export interface RetrievedChunk extends ChunkRow {
  /** Cosine distance: 0 is identical, 2 is opposite. Lower is more similar. */
  distance: number
  /** Carried so an answer can name the document in a cross-document query. */
  documentType: string
}

/**
 * Matches core's `EmbeddedChunk` field-for-field, so an indexed document can be
 * stored without a mapping step. The column is `idx` because `index` is awkward
 * in SQL; that rename lives in the query below and nowhere else.
 */
export interface InsertChunk {
  page: number
  index: number
  content: string
  embedding: number[]
}

/**
 * Replaces a document's chunks.
 *
 * Delete-then-insert inside one transaction rather than upsert, because
 * re-indexing after a re-extraction can produce a *different number* of chunks.
 * Upserting would leave the surplus behind, and stale chunks are worse than
 * missing ones: they retrieve confidently and cite a page whose text has changed.
 */
export async function replaceChunks(
  documentId: string,
  chunks: InsertChunk[],
): Promise<number> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM chunks WHERE document_id = $1', [documentId])

    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO chunks (document_id, page, idx, content, embedding)
         VALUES ($1, $2, $3, $4, $5)`,
        // pgvector accepts the literal '[1,2,3]' form; JSON.stringify produces
        // exactly that for an array of numbers.
        [documentId, chunk.page, chunk.index, chunk.content, JSON.stringify(chunk.embedding)],
      )
    }

    await client.query('COMMIT')
    return chunks.length
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export interface SearchOptions {
  embedding: number[]
  limit?: number
  /** Restricts to one document. Omitted searches the whole corpus (FR-6.6). */
  documentId?: string | undefined
}

export async function searchChunks(options: SearchOptions): Promise<RetrievedChunk[]> {
  const params: unknown[] = [JSON.stringify(options.embedding)]
  let where = ''

  if (options.documentId) {
    params.push(options.documentId)
    where = `WHERE c.document_id = $${params.length}`
  }

  params.push(Math.min(options.limit ?? 8, 50))

  const { rows } = await pool.query<RetrievedChunk>(
    `
    SELECT c.id,
           c.document_id        AS "documentId",
           c.page,
           c.idx                AS "index",
           c.content,
           d.type               AS "documentType",
           -- <=> is cosine distance, matching the operator class the index was
           -- built with. Any other operator here silently skips the index.
           c.embedding <=> $1   AS distance
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    ${where}
    ORDER BY c.embedding <=> $1
    LIMIT $${params.length}
    `,
    params,
  )
  return rows
}

export async function countChunks(documentId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM chunks WHERE document_id = $1',
    [documentId],
  )
  return Number(rows[0]?.n ?? 0)
}
