import { z } from 'zod'
import { DOCUMENT_TYPES, GENERIC_TYPE, type DocumentType } from '@ocr/shared'
import type { LlmProvider } from '../providers/types.js'
import { renderPrompt } from '../guards/prompt.js'

/**
 * Document classification: text in, a type plus a confidence plus a reason out.
 *
 * This is one of the two places in the system where a model decides control flow
 * — the other is the retrieval loop. The extraction pipeline itself is a fixed
 * sequence on purpose, so classification is where the autonomy genuinely is.
 */

/**
 * The type list is built from the registry rather than written out, so adding a
 * document type does not require editing a prompt or this schema (FR-4.1). An
 * enum written by hand here is exactly the kind of third place that falls out of
 * step with the other two.
 */
function classificationSchema() {
  // `generic` first so the tuple is provably non-empty without an assertion:
  // there is always at least one valid answer, even with no types registered.
  const slugs: [string, ...string[]] = [GENERIC_TYPE, ...Object.keys(DOCUMENT_TYPES)]
  return z.object({
    type: z.enum(slugs),
    confidence: z.number().min(0).max(1),
    /** Capped: this is displayed next to the answer, not stored prose. */
    reason: z.string().min(1).max(400),
  })
}

export interface ClassifyResult {
  type: DocumentType
  /**
   * Self-reported and **not calibrated.** A model saying 0.95 does not mean 95%
   * of such answers are right. The interface must present it as the model's
   * opinion, never as a probability of correctness (FR-3.4).
   */
  confidence: number
  reason: string
}

export interface ClassifyInput {
  provider: LlmProvider
  /** The `_classifier.md` template, with {{TYPES}} and {{DOCUMENT}}. */
  promptTemplate: string
  text: string
  /**
   * Below this, a typed answer is replaced with `generic`.
   *
   * A wrong type is worse than no type: it produces structured data that
   * validates against a schema the document never matched, which reads as
   * authoritative. `generic` loses nothing — the document is still stored, still
   * indexed, still answerable.
   */
  minConfidence?: number
  signal?: AbortSignal
}

const DEFAULT_MIN_CONFIDENCE = 0.5

/** Only the first part of a long document is needed to tell what it is. */
const CLASSIFY_TEXT_LIMIT = 6000

export async function classifyDocument(input: ClassifyInput): Promise<ClassifyResult> {
  const types = Object.values(DOCUMENT_TYPES)
    .map((definition) => `- **${definition.slug}** — ${definition.label}`)
    .join('\n')

  const prompt = renderPrompt(
    input.promptTemplate.replace('{{TYPES}}', types),
    input.text.slice(0, CLASSIFY_TEXT_LIMIT),
  )

  const schema = classificationSchema()
  const raw = await input.provider.chatStructured({
    schema,
    prompt,
    temperature: 0,
    ...(input.signal ? { signal: input.signal } : {}),
  })

  const threshold = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE

  if (raw.type !== GENERIC_TYPE && raw.confidence < threshold) {
    return {
      type: GENERIC_TYPE,
      confidence: raw.confidence,
      reason: `Classified as "${raw.type}" with confidence ${raw.confidence.toFixed(2)}, below the ${threshold} threshold, so treated as generic. Model's reason: ${raw.reason}`,
    }
  }

  return { type: raw.type as DocumentType, confidence: raw.confidence, reason: raw.reason }
}
