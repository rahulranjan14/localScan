import { readFile } from 'node:fs/promises'
import { Context } from '@temporalio/activity'
import type { DocumentType, TextMode } from '@ocr/shared'
import {
  OllamaProvider,
  TIMEOUTS,
  acquireText as acquireTextStep,
  classifyText,
  extractFields,
  indexDocument,
  validatePdfInput,
  type AcquiredText,
  type Classification,
  type LlmProvider,
} from '@ocr/core'
import { storedFilePath } from '@ocr/server/files'

/**
 * Everything the workflow is forbidden from doing: file reads, model calls,
 * database writes.
 *
 * Activities may be retried, so each one is written to be safe to run twice.
 * `persist` is the one that matters — it upserts on the content hash rather than
 * inserting blindly, because a retry after a successful write that lost its
 * acknowledgement would otherwise create a duplicate document.
 */

// Imported lazily so the worker does not open a database pool before it has a
// workflow to run — and so importing this module in a test does not either.
const db = () => import('@ocr/server/db')

function provider(role: 'ocr' | 'classify' | 'extract' | 'fallback' | 'embed'): LlmProvider | null {
  const model = process.env[`OCR_MODEL_${role.toUpperCase()}`]
  if (!model) return null
  return new OllamaProvider({
    model,
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    timeoutMs: TIMEOUTS[role],
  })
}

function required(role: 'ocr' | 'classify' | 'extract'): LlmProvider {
  const p = provider(role)
  if (!p) throw new Error(`No model configured for the "${role}" role`)
  return p
}


export async function validateInput(sha256: string): Promise<void> {
  validatePdfInput(new Uint8Array(await readFile(storedFilePath(sha256))))
}

export async function acquireText(sha256: string, pages?: number[]): Promise<AcquiredText> {
  return acquireTextStep({
    bytes: new Uint8Array(await readFile(storedFilePath(sha256))),
    mode: (process.env.OCR_TEXT_MODE ?? 'auto') as TextMode,
    ocr: provider('ocr') ?? undefined,
    pages,
    // Heartbeating is what makes a long activity resumable. Without it Temporal
    // cannot tell a worker transcribing page 7 of 20 from a worker that died,
    // and the deadline is what detects the difference (D-013).
    onPage: (page, of) => Context.current().heartbeat({ page, of }),
  })
}

export async function classify(rawText: string): Promise<Classification> {
  return classifyText(required('classify'), rawText)
}

export async function extract(rawText: string, type: DocumentType) {
  return extractFields(
    { extract: required('extract'), fallback: provider('fallback') ?? undefined },
    rawText,
    type,
  )
}

export interface PersistInput {
  sha256: string
  filename: string
  mime: string
  type: DocumentType
  rawText: string
  confidence: number | null
  reason: string | null
  usedVision: boolean
  data: unknown
  error: string | null
}

export async function persist(input: PersistInput): Promise<{
  documentId: string
  type: string
  status: string
}> {
  const { insertFile, insertDocument, findFileBySha256 } = await db()

  const existing = await findFileBySha256(input.sha256)
  const file =
    existing ??
    (await insertFile({
      filename: input.filename,
      mime: input.mime,
      sizeBytes: (await readFile(storedFilePath(input.sha256))).byteLength,
      sha256: input.sha256,
      path: storedFilePath(input.sha256),
    }))

  const notes = [
    input.reason,
    input.usedVision ? 'Text came from vision OCR, not a text layer.' : null,
  ].filter(Boolean)

  const document = await insertDocument({
    fileId: file.id,
    type: input.type,
    rawText: input.rawText,
    // Null when validation failed — never a partial result (FR-4.6).
    structuredData: input.data,
    confidence: input.confidence,
    classificationReason: notes.length > 0 ? notes.join(' ') : null,
    status: input.error === null ? 'completed' : 'needs_review',
    error: input.error,
  })

  return { documentId: document.id, type: document.type, status: document.status }
}

export async function index(documentId: string, rawText: string): Promise<number> {
  const embedProvider = provider('embed')
  if (!embedProvider) return 0

  const { replaceChunks } = await db()
  const chunks = await indexDocument({
    provider: embedProvider,
    rawText,
    onProgress: (done, total) => Context.current().heartbeat({ done, total }),
  })
  return replaceChunks(documentId, chunks)
}
