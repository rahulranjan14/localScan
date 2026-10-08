import type { LlmProvider } from '../providers/types.js'
import { chunkDocument, splitJoinedPages, type Chunk, type ChunkOptions } from './chunk.js'

/**
 * Turns a document's text into embedded chunks, ready to store.
 *
 * Takes a provider and returns data. It does not know what a database is — the
 * caller stores the result. That is the same rule as everywhere else in core, and
 * it is what lets the harness index a document without a server running.
 */

export interface IndexInput {
  provider: LlmProvider
  /** As stored: page markers intact, so page numbers survive (FR-6.1). */
  rawText: string
  chunking?: ChunkOptions
  /**
   * Texts per embedding request.
   *
   * Batched because one request per chunk means one round trip per chunk, and a
   * forty-chunk document then pays forty times the latency for the same work.
   * Not unbounded, because a single request carrying a whole document can exceed
   * the server's body limit and fails as an opaque 400.
   */
  batchSize?: number
  onProgress?: (embedded: number, total: number) => void
  signal?: AbortSignal
}

export interface EmbeddedChunk extends Chunk {
  embedding: number[]
}

const DEFAULT_BATCH_SIZE = 16

export async function indexDocument(input: IndexInput): Promise<EmbeddedChunk[]> {
  const pages = splitJoinedPages(input.rawText)
  const chunks = chunkDocument(pages, input.chunking ?? {})
  if (chunks.length === 0) return []

  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE
  const embedded: EmbeddedChunk[] = []

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize)
    const vectors = await input.provider.embed(batch.map((c) => c.content))

    if (vectors.length !== batch.length) {
      // Pairing by index below, so a length mismatch would attach the wrong
      // vector to the wrong text and produce retrieval that is subtly,
      // unfalsifiably wrong.
      throw new Error(
        `Embedding provider returned ${vectors.length} vectors for ${batch.length} texts`,
      )
    }

    batch.forEach((chunk, n) => embedded.push({ ...chunk, embedding: vectors[n]! }))
    input.onProgress?.(embedded.length, chunks.length)
  }

  return embedded
}

export interface Citation {
  page: number
  documentId?: string
  documentType?: string
}

/**
 * Formats retrieved chunks for a prompt, fenced and labelled by page.
 *
 * Two things are load-bearing. The page label is what lets the model cite, and
 * the fencing applies to retrieved text as well as to the original OCR — RAG
 * widens the injection surface, because a chunk from any stored document is
 * untrusted text being injected at query time (FR-11.1).
 */
export function formatContext(
  chunks: Array<{ page: number; content: string; documentType?: string }>,
): string {
  return chunks
    .map((chunk, i) => {
      const label = chunk.documentType
        ? `source ${i + 1} · ${chunk.documentType} · page ${chunk.page}`
        : `source ${i + 1} · page ${chunk.page}`
      const fenced = chunk.content.replace(/<\/?source>/gi, (m) => m.replace(/</g, '‹'))
      return `<source id="${i + 1}" page="${chunk.page}">\n${fenced}\n</source>`.replace(
        '<source',
        `<!-- ${label} -->\n<source`,
      )
    })
    .join('\n\n')
}
