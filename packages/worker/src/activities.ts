import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@temporalio/activity'
import {
  GENERIC_TYPE,
  GenericSchema,
  getDocumentType,
  type DocumentType,
  type TextMode,
} from '@ocr/shared'
import {
  OllamaProvider,
  TIMEOUTS,
  classifyDocument,
  extractWithFallback,
  indexDocument,
  joinPages,
  loadClassifierPrompt,
  loadGenericPrompt,
  loadOcrPrompt,
  loadPrompt,
  ocrPages,
  rasterizePdf,
  readTextLayer,
  shouldUseTextLayer,
  validatePdfInput,
  type LlmProvider,
} from '@ocr/core'
import type { z } from 'zod'

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

const filePath = (sha256: string) => join(process.env.OCR_DATA_DIR ?? 'data', 'files', sha256)

export async function validateInput(sha256: string): Promise<void> {
  validatePdfInput(new Uint8Array(await readFile(filePath(sha256))))
}

export interface AcquiredText {
  rawText: string
  usedVision: boolean
}

export async function acquireText(sha256: string, pages?: number[]): Promise<AcquiredText> {
  const bytes = new Uint8Array(await readFile(filePath(sha256)))
  const mode = (process.env.OCR_TEXT_MODE ?? 'auto') as TextMode
  const textLayer = await readTextLayer(bytes)

  if (shouldUseTextLayer(mode, textLayer)) {
    const selected = pages ? textLayer.pages.filter((p) => pages.includes(p.page)) : textLayer.pages
    return { rawText: joinPages(selected), usedVision: false }
  }

  const ocrProvider = required('ocr')
  const rendered = await rasterizePdf(bytes, pages ? { pages } : {})

  const ocr = await ocrPages({
    provider: ocrProvider,
    promptTemplate: await loadOcrPrompt(ocrProvider.model),
    pages: rendered,
    // Heartbeating is what makes a long activity resumable. Without it Temporal
    // cannot distinguish a worker transcribing page 7 of 20 from a worker that
    // died, and the whole activity restarts from the beginning on recovery.
    onPage: (page, of) => Context.current().heartbeat({ page, of }),
  })

  const rawText = joinPages(ocr.pages)
  if (rawText.replace(/--- page \d+ ---/g, '').trim().length < 20) {
    throw new Error(
      `The vision model returned almost no text (${rawText.length} chars). ` +
        `It ran without error and read nothing, which usually means the wrong ` +
        `prompt convention for this model rather than an unreadable document.`,
    )
  }
  return { rawText, usedVision: true }
}

export interface Classified {
  type: DocumentType
  confidence: number | null
  reason: string | null
}

export async function classify(rawText: string): Promise<Classified> {
  try {
    const result = await classifyDocument({
      provider: required('classify'),
      promptTemplate: await loadClassifierPrompt(),
      text: rawText,
    })
    return { type: result.type, confidence: result.confidence, reason: result.reason }
  } catch (error) {
    // A failed classification is not a failed document. Falling back to generic
    // keeps minutes of transcription that already succeeded.
    return {
      type: GENERIC_TYPE,
      confidence: null,
      reason: `Classification failed, treated as generic: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

export interface Extracted {
  ok: boolean
  data: unknown
  error: string | null
}

export async function extract(rawText: string, type: DocumentType): Promise<Extracted> {
  const definition = getDocumentType(type)
  const schema: z.ZodType = definition?.schema ?? GenericSchema
  const promptTemplate = definition
    ? await loadPrompt(definition.slug)
    : await loadGenericPrompt()

  const result = await extractWithFallback({
    provider: required('extract'),
    fallbackProvider: provider('fallback') ?? undefined,
    schema,
    promptTemplate,
    text: rawText,
  })

  return result.ok
    ? { ok: true, data: result.data, error: null }
    : { ok: false, data: null, error: result.reason }
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
      sizeBytes: (await readFile(filePath(input.sha256))).byteLength,
      sha256: input.sha256,
      path: filePath(input.sha256),
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
