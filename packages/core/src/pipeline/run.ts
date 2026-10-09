import {
  GENERIC_TYPE,
  GenericSchema,
  getDocumentType,
  type DocumentType,
  type TextMode,
} from '@ocr/shared'
import type { z } from 'zod'
import { joinPages, readTextLayer, shouldUseTextLayer } from '../pdf/textLayer.js'
import { rasterizePdf, type RasterizeOptions } from '../pdf/rasterize.js'
import { validatePdfInput } from '../guards/input.js'
import { ocrPages } from './ocr.js'
import { classifyDocument } from './classify.js'
import { extractWithFallback } from './extract.js'
import {
  loadClassifierPrompt,
  loadGenericPrompt,
  loadOcrPrompt,
  loadPrompt,
} from '../documents/prompts.js'
import type { LlmProvider } from '../providers/types.js'

/**
 * The pipeline, in one place.
 *
 * It lived in three — the HTTP service, the Temporal activities and the eval
 * harness — which is how a benchmark quietly stops measuring the application. The
 * harness would keep reporting a number for a pipeline that had drifted from the
 * one running in production, and nothing would fail.
 *
 * The Temporal worker still splits this across activities, because durability
 * needs each step to be individually retryable. It calls the same functions
 * rather than reimplementing them, so there is one definition of each step and
 * two ways of sequencing it.
 */

export interface PipelineProviders {
  ocr?: LlmProvider | undefined
  classify: LlmProvider
  extract: LlmProvider
  fallback?: LlmProvider | undefined
}

export interface AcquireTextOptions {
  bytes: Uint8Array
  mode: TextMode
  ocr?: LlmProvider | undefined
  pages?: number[] | undefined
  rasterize?: RasterizeOptions
  onPage?: (page: number, of: number, durationMs: number) => void
}

export interface AcquiredText {
  rawText: string
  usedVision: boolean
}

/** Below this a transcription is treated as having failed, not as thin content. */
const MIN_USEFUL_TRANSCRIPTION = 20

export async function acquireText(options: AcquireTextOptions): Promise<AcquiredText> {
  const textLayer = await readTextLayer(options.bytes)

  if (shouldUseTextLayer(options.mode, textLayer)) {
    const selected = options.pages
      ? textLayer.pages.filter((p) => options.pages!.includes(p.page))
      : textLayer.pages
    return { rawText: joinPages(selected), usedVision: false }
  }

  if (!options.ocr) {
    throw new Error('This document needs the vision path and no ocr model is configured')
  }

  const rendered = await rasterizePdf(options.bytes, {
    ...(options.rasterize ?? {}),
    ...(options.pages ? { pages: options.pages } : {}),
  })

  const ocr = await ocrPages({
    provider: options.ocr,
    // Per model: a transcription prompt written for one VLM can produce nothing
    // at all on another (D-009).
    promptTemplate: await loadOcrPrompt(options.ocr.model),
    pages: rendered,
    ...(options.onPage ? { onPage: options.onPage } : {}),
  })

  const rawText = joinPages(ocr.pages)
  const transcribed = rawText.replace(/--- page \d+ ---/g, '').trim().length

  if (transcribed < MIN_USEFUL_TRANSCRIPTION) {
    // An empty transcription is a failure, not a success with nothing in it. A
    // model can return a page whose text is an empty string -- deepseek-ocr did,
    // and the document was stored as completed with 15 characters.
    throw new Error(
      `The vision model returned almost no text (${transcribed} characters across ` +
        `${ocr.pages.length} page(s)). It ran without error and read nothing, which ` +
        `usually means the wrong prompt convention for this model rather than an ` +
        `unreadable document.`,
    )
  }

  return { rawText, usedVision: true }
}

export interface Classification {
  type: DocumentType
  confidence: number | null
  reason: string | null
}

export async function classifyText(
  provider: LlmProvider,
  rawText: string,
): Promise<Classification> {
  try {
    const result = await classifyDocument({
      provider,
      promptTemplate: await loadClassifierPrompt(),
      text: rawText,
    })
    return { type: result.type, confidence: result.confidence, reason: result.reason }
  } catch (error) {
    // A failed classification is not a failed document: falling back to generic
    // keeps transcription that already succeeded, which can be minutes of work.
    return {
      type: GENERIC_TYPE,
      confidence: null,
      reason: `Classification failed, treated as generic: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

/** Type to schema plus prompt. The only place routing happens (FR-4.1). */
export async function resolveExtraction(
  type: DocumentType,
): Promise<{ schema: z.ZodType; promptTemplate: string }> {
  const definition = getDocumentType(type)
  return definition
    ? { schema: definition.schema, promptTemplate: await loadPrompt(definition.slug) }
    : { schema: GenericSchema, promptTemplate: await loadGenericPrompt() }
}

export interface ExtractionResult {
  ok: boolean
  data: unknown
  error: string | null
  usedFallback: boolean
}

export async function extractFields(
  providers: Pick<PipelineProviders, 'extract' | 'fallback'>,
  rawText: string,
  type: DocumentType,
): Promise<ExtractionResult> {
  const { schema, promptTemplate } = await resolveExtraction(type)

  const result = await extractWithFallback({
    provider: providers.extract,
    fallbackProvider: providers.fallback,
    schema,
    promptTemplate,
    text: rawText,
  })

  return result.ok
    ? { ok: true, data: result.data, error: null, usedFallback: result.usedFallback }
    : { ok: false, data: null, error: result.reason, usedFallback: result.usedFallback }
}

export interface RunPipelineInput {
  bytes: Uint8Array
  mode: TextMode
  providers: PipelineProviders
  pages?: number[] | undefined
  rasterize?: RasterizeOptions
  onStage?: (stage: string, detail?: string) => void
}

export interface PipelineOutput extends Classification, ExtractionResult, AcquiredText {}

/**
 * The whole sequence, for callers that do not need per-step durability.
 *
 * Used by the eval harness. The server does not call this — it starts a Temporal
 * workflow, which runs the same steps as separately retryable activities.
 */
export async function runPipeline(input: RunPipelineInput): Promise<PipelineOutput> {
  const say = input.onStage ?? (() => {})

  validatePdfInput(input.bytes)

  say('text')
  const text = await acquireText({
    bytes: input.bytes,
    mode: input.mode,
    ocr: input.providers.ocr,
    pages: input.pages,
    ...(input.rasterize ? { rasterize: input.rasterize } : {}),
  })

  say('classify')
  const classification = await classifyText(input.providers.classify, text.rawText)

  say('extract', classification.type)
  const extracted = await extractFields(input.providers, text.rawText, classification.type)

  return { ...text, ...classification, ...extracted }
}
