import {
  GENERIC_TYPE,
  GenericSchema,
  getDocumentType,
  type DocumentType,
} from '@ocr/shared'
import {
  classifyDocument,
  extractWithFallback,
  shouldUseTextLayer,
  joinPages,
  loadClassifierPrompt,
  loadGenericPrompt,
  loadOcrPrompt,
  loadPrompt,
  ocrPages,
  rasterizePdf,
  readTextLayer,
  indexDocument,
  validatePdfInput,
  type LlmProvider,
} from '@ocr/core'
import type { z } from 'zod'
import {
  findDocumentByFileId,
  insertDocument,
  type DocumentRow,
} from '../repositories/documents.js'
import { findFileBySha256, insertFile } from '../repositories/files.js'
import { replaceChunks } from '../repositories/chunks.js'
import { sha256, storeFile } from '../storage/fileStore.js'
import { RoleUnconfiguredError, providerForRole, type ServerConfig } from '../config.js'

/**
 * Ingestion: bytes in, a stored document out.
 *
 * Runs inline inside the request. A known limitation, stated rather than hidden --
 * extraction takes minutes on local hardware, which is far too long to hold a
 * connection open. Phase 6 moves this into a durable workflow and the endpoint
 * starts returning 202 plus a run id (FR-1.5). Inline until then means the
 * application is useful several phases before the orchestrator exists.
 *
 * The sequence is fixed on purpose. There is no planning step deciding what to do
 * next, because the steps never vary; the autonomy in this system is the
 * classifier choosing a schema and, later, the retrieval loop (PRD non-goals).
 */

/**
 * Below this, a transcription is treated as having failed.
 *
 * Low on purpose: a genuinely sparse page -- a stamp, a signature block -- should
 * still be stored. This is meant to catch *nothing at all*, not thin content.
 */
const MIN_USEFUL_TRANSCRIPTION = 20

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
  /** 1-based page numbers, when the user asked for a subset (FR-1.4). */
  pages?: number[]
  onProgress?: (stage: string, detail?: string) => void
}

export async function ingestDocument(input: IngestInput): Promise<DocumentRow> {
  const say = input.onProgress ?? (() => {})

  // Guards before anything parses the bytes (FR-1.2).
  validatePdfInput(input.bytes)

  const hash = sha256(input.bytes)

  // Content-addressed, so a re-upload returns what we have rather than paying
  // for extraction twice (FR-1.3).
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

  // ── Text acquisition ────────────────────────────────────────────────────
  //
  // Which source to trust is a configured choice, not a fixed rule. `auto` takes
  // the text layer when it is usable, but a text layer can be mangled in ways a
  // rendered page is not -- this project's own corpus has one that yields
  // `AIR_I NDIA` -- so `always_vlm` is a legitimate setting rather than a
  // pessimisation. The harness is what decides which wins.
  const mode = input.config.textMode
  say('text-layer', `mode=${mode}`)
  const textLayer = await readTextLayer(input.bytes)
  let rawText: string
  let usedVision = false

  if (shouldUseTextLayer(mode, textLayer)) {
    // The cheap path, and the common one: a digital PDF needs no model at all,
    // which on local hardware is the difference between seconds and minutes.
    rawText = joinPages(
      input.pages ? textLayer.pages.filter((p) => input.pages!.includes(p.page)) : textLayer.pages,
    )
    say('text-layer', `${textLayer.pagesWithText}/${textLayer.totalPages} pages, no model needed`)
  } else {
    usedVision = true
    say('rasterise')
    const rendered = await rasterizePdf(input.bytes, {
      ...(input.pages ? { pages: input.pages } : {}),
    })

    const ocrProvider = providerForRole(input.config, 'ocr')
    say('ocr', `${rendered.length} page(s) via ${ocrProvider.model}`)
    const ocr = await ocrPages({
      provider: ocrProvider,
      // Resolved per model: a transcription prompt written for one VLM can
      // produce nothing at all on another (see loadOcrPrompt).
      promptTemplate: await loadOcrPrompt(ocrProvider.model),
      pages: rendered,
      onPage: (page, of, ms) => say('ocr', `page ${page}/${of} in ${(ms / 1000).toFixed(0)}s`),
    })

    // An empty transcription is a failure, not a success with nothing in it.
    //
    // Checking page *count* is not enough: a model can return a page whose text
    // is an empty string, which deepseek-ocr:3b did on its first run here. That
    // sailed through as status=completed with 15 characters stored -- a record
    // claiming success for a document nothing had read. Classification then
    // honestly reported generic at 0.00 confidence, which was the only clue.
    const transcribed = ocr.pages.reduce((n, page) => n + page.text.trim().length, 0)

    if (ocr.pages.length === 0 || transcribed < MIN_USEFUL_TRANSCRIPTION) {
      return insertDocument({
        fileId: file.id,
        type: GENERIC_TYPE,
        rawText: null,
        structuredData: null,
        confidence: null,
        classificationReason: null,
        status: 'failed',
        error:
          (ocr.pages.length === 0
            ? `Transcription failed on every page. `
            : `The vision model returned almost no text (${transcribed} characters across ` +
              `${ocr.pages.length} page(s)). The model ran without error but read nothing, ` +
              `which usually means the wrong prompt convention for this model rather than an ` +
              `unreadable document. `) +
          ocr.failures.map((f) => `p${f.page}: ${f.reason}`).join('; ').slice(0, 800),
      })
    }

    rawText = joinPages(ocr.pages)
    if (ocr.failures.length > 0) {
      say('ocr', `${ocr.failures.length} page(s) failed, continuing with the rest`)
    }
  }

  // ── Classification ──────────────────────────────────────────────────────
  say('classify')
  let type: DocumentType = GENERIC_TYPE
  let confidence: number | null = null
  let reason: string | null = null

  try {
    const classified = await classifyDocument({
      provider: providerForRole(input.config, 'classify'),
      promptTemplate: await loadClassifierPrompt(),
      text: rawText,
    })
    type = classified.type
    confidence = classified.confidence
    reason = classified.reason
    say('classify', `${type} (${confidence.toFixed(2)})`)
  } catch (error) {
    // A failed classification is not a failed document. Falling back to generic
    // keeps the text stored and queryable, where aborting would discard work
    // that already succeeded -- including minutes of OCR.
    reason = `Classification failed, treated as generic: ${
      error instanceof Error ? error.message : String(error)
    }`
    say('classify', 'failed, falling back to generic')
  }

  // ── Extraction ──────────────────────────────────────────────────────────
  say('extract', type)
  const { schema, promptTemplate } = await resolveExtraction(type)

  const result = await extractWithFallback({
    provider: providerForRole(input.config, 'extract'),
    fallbackProvider: optionalProvider(input.config, 'fallback'),
    schema,
    promptTemplate,
    text: rawText,
  })

  const document = await insertDocument({
    fileId: file.id,
    type,
    rawText,
    // Null on failure. Storing a partial result would make an unvalidated value
    // indistinguishable from a checked one the moment it lands here (FR-4.6).
    structuredData: result.ok ? result.data : null,
    confidence,
    classificationReason: appendNotes(reason, {
      usedVision,
      usedFallback: result.usedFallback,
      injection: result.injection.matched,
    }),
    status: result.ok ? 'completed' : 'needs_review',
    error: result.ok ? null : result.reason,
  })

  // Indexed last, and failure here is not fatal. A document that extracted
  // correctly but could not be embedded is still a usable document; losing the
  // extraction because the embedding model was unreachable would not be.
  try {
    say('index')
    const embedProvider = optionalProvider(input.config, 'embed')
    if (embedProvider && rawText) {
      const chunks = await indexDocument({ provider: embedProvider, rawText })
      await replaceChunks(document.id, chunks)
      say('index', `${chunks.length} chunk(s)`)
    }
  } catch (error) {
    say('index', `failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return document
}

/**
 * Type to schema plus prompt. The only place routing happens, and it holds no
 * per-type logic -- a new type is picked up from the registry (FR-4.1).
 */
async function resolveExtraction(
  type: DocumentType,
): Promise<{ schema: z.ZodType; promptTemplate: string }> {
  if (type === GENERIC_TYPE) {
    return { schema: GenericSchema, promptTemplate: await loadGenericPrompt() }
  }
  const definition = getDocumentType(type)
  if (!definition) {
    // The classifier is constrained to registry slugs, so this is unreachable
    // unless the registry changed under a running process.
    return { schema: GenericSchema, promptTemplate: await loadGenericPrompt() }
  }
  return { schema: definition.schema, promptTemplate: await loadPrompt(definition.slug) }
}

/** `fallback` is optional; an unset role must not fail the run. */
function optionalProvider(config: ServerConfig, role: 'fallback' | 'embed'): LlmProvider | undefined {
  try {
    return providerForRole(config, role)
  } catch (error) {
    if (error instanceof RoleUnconfiguredError) return undefined
    throw error
  }
}

/**
 * Records how the result was reached alongside why the type was chosen.
 *
 * Whether vision ran, whether the fallback model was needed, and whether the text
 * tripped an injection pattern are all things a reviewer wants when a value looks
 * wrong, and none of them are recoverable from the output afterwards.
 */
function appendNotes(
  reason: string | null,
  notes: { usedVision: boolean; usedFallback: boolean; injection: string[] },
): string | null {
  const parts: string[] = []
  if (reason) parts.push(reason)
  if (notes.usedVision) parts.push('Text came from vision OCR, not a text layer.')
  if (notes.usedFallback) parts.push('Primary extraction failed validation; fallback model used.')
  if (notes.injection.length > 0) {
    parts.push(`Injection patterns seen (logged, not blocked): ${notes.injection.join(', ')}.`)
  }
  return parts.length > 0 ? parts.join(' ') : null
}
