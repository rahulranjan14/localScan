/**
 * Field-level scoring against ground truth.
 *
 * The design of this file is a direct response to what happened without it. A run
 * was recorded as "5/5 fields correct" because five fields were checked and twenty
 * were not; six of those twenty held invented values. Another run scored 99-101%
 * on character overlap while silently changing a year and dropping a vendor.
 *
 * So two rules shape everything below:
 *
 *   1. **Every field in the schema is scored**, not the ones someone thought to
 *      look at. The flattening is exhaustive by construction.
 *   2. **Fabrication is counted separately from error.** A wrong value and a value
 *      invented where the document said nothing are different failures: the first
 *      can be spotted by a reviewer comparing against the page, the second looks
 *      exactly like a real value and is the one that survives review.
 */

export type FieldVerdict =
  /** Expected a value, got that value. */
  | 'correct'
  /** Expected a value, got a different one. */
  | 'wrong'
  /** Expected a value, got null or nothing. */
  | 'missed'
  /** Expected nothing, got a value. The dangerous one. */
  | 'fabricated'
  /** Expected nothing, got nothing. Correct, and not counted toward accuracy. */
  | 'absent'

export interface FieldScore {
  path: string
  verdict: FieldVerdict
  expected: unknown
  actual: unknown
}

export interface DocumentScore {
  fixture: string
  /** Null when the document failed before producing data. */
  type: { expected: string; actual: string | null; correct: boolean } | null
  fields: FieldScore[]
  counts: Record<FieldVerdict, number>
  /** correct / (correct + wrong + fabricated) — of what it asserted, how much was right. */
  precision: number
  /** correct / (correct + wrong + missed) — of what was there, how much it found. */
  recall: number
  f1: number
}

/**
 * Flattens a document into `path → value` pairs.
 *
 * Arrays are indexed (`lineItems[0].description`) rather than set-matched. Index
 * alignment is the honest choice here: a model that emits line items in a
 * different order than the document has made an error worth seeing, and
 * best-effort matching would hide it behind a good score.
 */
/**
 * Arrays whose entries are labelled rather than ordered.
 *
 * `extraFields` is a bag: the document states `Order Number`, `ACC #` and
 * `BSB #`, and nothing about the page makes one of them first. Indexing it like
 * `lineItems` scored a correct value as wrong purely for arriving in a different
 * position, and one extra entry at the front cascaded into every later field —
 * `sliced-inv-3337` lost seven fields that way, of which two were real.
 *
 * So these are keyed by their own `key` instead of by position. Line items stay
 * positional, for the reason given above: their order is the document's.
 */
const KEYED_ARRAYS = new Map<string, string>([
  ['extraFields', 'key'],
  ['sections', 'section'],
])

export function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>()

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) {
      out.set(path, null)
      return
    }
    if (Array.isArray(node)) {
      if (node.length === 0) {
        out.set(path, null)
        return
      }
      const keyField = KEYED_ARRAYS.get(path.split('.').pop() ?? '')
      if (keyField !== undefined) {
        for (const item of node) {
          const label = (item as Record<string, unknown> | null)?.[keyField]
          // An entry with no label cannot be matched to one; fall back to its
          // position so it is still counted rather than silently dropped.
          const slot = typeof label === 'string' ? label.trim().replace(/\s+/g, ' ') : `?${node.indexOf(item)}`
          walk(item, `${path}{${slot}}`)
        }
        return
      }
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
      if (entries.length === 0) {
        out.set(path, null)
        return
      }
      for (const [key, child] of entries) walk(child, path ? `${path}.${key}` : key)
      return
    }
    out.set(path, node)
  }

  walk(value, prefix)
  return out
}

/**
 * Compares two field values.
 *
 * Numbers are compared numerically, so `2500` and `2500.0` agree. Strings are
 * compared after trimming and collapsing internal whitespace, because a
 * transcription that returns `AIR_I NDIA` for `AIR_INDIA` has made a real error
 * but `Acme  Ltd` for `Acme Ltd` has not.
 *
 * Deliberately *not* fuzzy beyond that. A scorer that forgives near-misses will
 * forgive a changed digit, which is the error class that matters most here.
 */
export function valuesMatch(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true
  if (expected === null || actual === null) return false

  if (typeof expected === 'number' || typeof actual === 'number') {
    const a = typeof expected === 'number' ? expected : Number(expected)
    const b = typeof actual === 'number' ? actual : Number(actual)
    return Number.isFinite(a) && Number.isFinite(b) && a === b
  }

  if (typeof expected === 'string' && typeof actual === 'string') {
    const normalise = (s: string) => s.trim().replace(/\s+/g, ' ')
    return normalise(expected) === normalise(actual)
  }

  return false
}

function verdictFor(expected: unknown, actual: unknown): FieldVerdict {
  const expectedEmpty = expected === null || expected === undefined || expected === ''
  const actualEmpty = actual === null || actual === undefined || actual === ''

  if (expectedEmpty && actualEmpty) return 'absent'
  if (expectedEmpty) return 'fabricated'
  if (actualEmpty) return 'missed'
  return valuesMatch(expected, actual) ? 'correct' : 'wrong'
}

export interface ScoreInput {
  fixture: string
  expectedType: string
  actualType: string | null
  expected: unknown
  /** Null when extraction failed, which scores every expected field as missed. */
  actual: unknown
}

export function scoreDocument(input: ScoreInput): DocumentScore {
  const expectedFields = flatten(input.expected)
  const actualFields = flatten(input.actual ?? {})

  // The union, so a fabricated field at a path the ground truth never mentions is
  // still scored. Iterating only the expected side is how fabrication hides.
  const paths = [...new Set([...expectedFields.keys(), ...actualFields.keys()])].sort()

  const fields: FieldScore[] = paths.map((path) => ({
    path,
    verdict: verdictFor(expectedFields.get(path) ?? null, actualFields.get(path) ?? null),
    expected: expectedFields.get(path) ?? null,
    actual: actualFields.get(path) ?? null,
  }))

  const counts: Record<FieldVerdict, number> = {
    correct: 0,
    wrong: 0,
    missed: 0,
    fabricated: 0,
    absent: 0,
  }
  for (const field of fields) counts[field.verdict]++

  const asserted = counts.correct + counts.wrong + counts.fabricated
  const present = counts.correct + counts.wrong + counts.missed

  const precision = asserted === 0 ? 1 : counts.correct / asserted
  const recall = present === 0 ? 1 : counts.correct / present
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  return {
    fixture: input.fixture,
    type: {
      expected: input.expectedType,
      actual: input.actualType,
      correct: input.expectedType === input.actualType,
    },
    fields,
    counts,
    precision,
    recall,
    f1,
  }
}

export interface CorpusScore {
  documents: DocumentScore[]
  classificationAccuracy: number
  counts: Record<FieldVerdict, number>
  precision: number
  recall: number
  f1: number
}

/**
 * Aggregates by field, not by document.
 *
 * Averaging per-document F1 would let a one-field document count as much as a
 * forty-field one. Pooling the counts weights each decision equally, which is what
 * "how often is this pipeline right" actually means.
 */
export function scoreCorpus(documents: DocumentScore[]): CorpusScore {
  const counts: Record<FieldVerdict, number> = {
    correct: 0,
    wrong: 0,
    missed: 0,
    fabricated: 0,
    absent: 0,
  }
  for (const doc of documents) {
    for (const verdict of Object.keys(counts) as FieldVerdict[]) {
      counts[verdict] += doc.counts[verdict]
    }
  }

  const asserted = counts.correct + counts.wrong + counts.fabricated
  const present = counts.correct + counts.wrong + counts.missed
  const precision = asserted === 0 ? 1 : counts.correct / asserted
  const recall = present === 0 ? 1 : counts.correct / present

  const classified = documents.filter((d) => d.type !== null)
  const classificationAccuracy =
    classified.length === 0
      ? 1
      : classified.filter((d) => d.type!.correct).length / classified.length

  return {
    documents,
    classificationAccuracy,
    counts,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  }
}
