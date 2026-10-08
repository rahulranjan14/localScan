/**
 * Pass/fail checks for deliberately hard documents (FR-10.4).
 *
 * Kept entirely separate from field scoring, and the separation is the point. A
 * cheque, a dense utility bill or a photograph of a crumpled receipt will never
 * extract cleanly, and scoring them on field accuracy produces a number that
 * punishes the pipeline for a document nobody could read.
 *
 * What matters for those is narrower and absolute: **the output must not be
 * poisoned.** A model that fails honestly leaves fields null. A model that fails
 * badly emits base64, HTML fragments, chat control tokens or a chatty preamble
 * into what is supposed to be extracted data — and those land in the database
 * looking like content.
 *
 * Averaging this into an F1 hides both numbers: the hard documents drag the field
 * score down for the wrong reason, and a genuine poisoning is diluted to a
 * rounding error.
 */

export interface GarbageSignature {
  name: string
  pattern: RegExp
  why: string
}

export const GARBAGE_SIGNATURES: GarbageSignature[] = [
  {
    name: 'base64_blob',
    pattern: /[A-Za-z0-9+/]{120,}={0,2}/,
    why: 'A long base64 run is image data leaking into a text field, never document content.',
  },
  {
    name: 'chat_control_token',
    pattern: /<\|(im_start|im_end|endoftext|eot_id|assistant|user|system)\|>/,
    why: 'The model emitted its own conversation scaffolding as data.',
  },
  {
    name: 'html_markup',
    pattern: /<\/?(table|tr|td|th|tbody|div|span|p)\b[^>]*>/i,
    why: 'HTML in an extracted value means the model described a layout instead of reading it.',
  },
  {
    name: 'markdown_fence',
    pattern: /```/,
    why: 'A code fence inside a field value is formatting that escaped the JSON wrapper.',
  },
  {
    name: 'hallucinated_preamble',
    pattern: /^\s*(here (is|are)|sure[,!]|certainly[,!]|i (have|will|can)\b|based on the (document|image))/i,
    why: 'Conversational framing in a field value: the model answered a person, not a schema.',
  },
  {
    name: 'refusal',
    pattern: /\b(i (cannot|can't|am unable to)|as an ai\b)/i,
    why: 'A refusal stored as a field value is worse than an empty field.',
  },
]

export interface RobustnessFinding {
  path: string
  signature: string
  why: string
  excerpt: string
}

export interface RobustnessResult {
  passed: boolean
  findings: RobustnessFinding[]
  /** Every string field inspected, so a pass is meaningful rather than vacuous. */
  fieldsChecked: number
}

/**
 * Walks every string in the extracted data looking for signatures.
 *
 * Operates on the *structured output*, not the raw transcription. Garbage in a
 * transcription is expected and harmless — it is what the extraction step is for.
 * Garbage that survives into a validated field is the failure.
 */
export function checkRobustness(data: unknown): RobustnessResult {
  const findings: RobustnessFinding[] = []
  let fieldsChecked = 0

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      fieldsChecked++
      for (const signature of GARBAGE_SIGNATURES) {
        const match = signature.pattern.exec(node)
        if (match) {
          findings.push({
            path: path || '(root)',
            signature: signature.name,
            why: signature.why,
            excerpt: match[0].slice(0, 80),
          })
        }
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`))
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, path ? `${path}.${key}` : key)
      }
    }
  }

  walk(data, '')
  return { passed: findings.length === 0, findings, fieldsChecked }
}
