import { InvoiceSchema, type DocumentType } from '@ocr/shared'
import {
  extractStructured,
  hasUsableTextLayer,
  joinPages,
  loadPrompt,
  readTextLayer,
  validatePdfInput,
} from '@ocr/core'
import {
  findDocumentByFileId,
  insertDocument,
  type DocumentRow,
} from '../repositories/documents.js'
import { findFileBySha256, insertFile } from '../repositories/files.js'
import { sha256, storeFile } from '../storage/fileStore.js'
import { providerForRole, type ServerConfig } from '../config.js'

/**
 * Phase 1 ingestion: validate, store, read text, extract, persist.
 *
 * Runs inline inside the request. That is a known limitation, not an oversight --
 * extraction takes ~2 minutes on local hardware, which is far too long to hold a
 * connection open. Phase 6 moves this into a durable workflow and the endpoint
 * starts returning 202 plus a run id (FR-1.5). Keeping it inline until then
 * means the application is useful several phases before the orchestrator exists.
 */

export class DuplicateDocument extends Error {
  constructor(readonly existing: DocumentRow) {
    super('This document has already been processed')
    this.name = 'DuplicateDocument'
  }
}

export interface IngestInput {
  bytes: Uint8Array
  filename: string
  mime: string
  config: ServerConfig
}

export async function ingestDocument(input: IngestInput): Promise<DocumentRow> {
  // Guards before anything parses the bytes.
  validatePdfInput(input.bytes)

  const hash = sha256(input.bytes)

  // Content-addressed, so a re-upload costs nothing and returns what we already
  // have rather than paying for extraction twice (FR-1.3).
  const existing = await findFileBySha256(hash)
  if (existing) {
    const prior = await findDocumentByFileId(existing.id)
    if (prior) throw new DuplicateDocument(prior)
  }

  const stored = await storeFile(input.bytes)
  const file = await insertFile({
    filename: input.filename,
    mime: input.mime,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    path: stored.path,
  })

  const textLayer = await readTextLayer(input.bytes)

  if (!hasUsableTextLayer(textLayer)) {
    // Honest failure rather than a bad guess. Rasterisation and vision OCR are
    // Phase 2; until then a scanned document is recorded as something the system
    // cannot yet handle, not as an empty extraction.
    return insertDocument({
      fileId: file.id,
      type: 'generic',
      rawText: joinPages(textLayer.pages),
      structuredData: null,
      confidence: null,
      classificationReason: null,
      status: 'failed',
      error:
        `Only ${textLayer.pagesWithText} of ${textLayer.totalPages} pages carry text. ` +
        `Scanned documents need the vision model, which arrives in Phase 2.`,
    })
  }

  const rawText = joinPages(textLayer.pages)

  // Phase 1 has one type and no classifier, so everything is treated as an
  // invoice. Phase 2 adds classification and routes to a schema.
  const type: DocumentType = 'invoice'

  const result = await extractStructured({
    provider: providerForRole(input.config, 'extract'),
    schema: InvoiceSchema,
    promptTemplate: await loadPrompt('invoice'),
    text: rawText,
  })

  return insertDocument({
    fileId: file.id,
    type,
    rawText,
    // Null on failure. Storing a partial result would make an unvalidated value
    // indistinguishable from a checked one the moment it lands here (FR-4.6).
    structuredData: result.ok ? result.data : null,
    confidence: null,
    classificationReason: null,
    status: result.ok ? 'completed' : 'needs_review',
    error: result.ok ? null : result.reason,
  })
}
