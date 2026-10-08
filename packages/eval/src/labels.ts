import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/**
 * Ground truth, loaded from a committed file.
 *
 * `approved` is required and must be true for a fixture to be scored. The point is
 * that a label is a claim about what a document says, and an unverified claim
 * scored as truth is worse than no label — it produces a number that looks like
 * measurement.
 */

export const LabelSchema = z.object({
  /** Only hand-verified labels are scored. Unapproved fixtures are skipped. */
  approved: z.boolean(),
  type: z.string().min(1),
  data: z.unknown(),
  source: z.string().optional(),
  notes: z.string().optional(),
  /**
   * A robustness fixture is scored pass/fail on whether the output is free of
   * garbage, not on field accuracy (FR-10.4). A cheque or a dense bill will never
   * extract cleanly; what matters is that it does not poison the output with
   * base64 or HTML. Mixing that into an F1 hides both numbers.
   */
  robustness: z.boolean().default(false),
})
export type Label = z.infer<typeof LabelSchema>

export const LabelsFileSchema = z.object({
  _comment: z.unknown().optional(),
  fixtures: z.record(z.string(), LabelSchema),
})
export type LabelsFile = z.infer<typeof LabelsFileSchema>

const here = dirname(fileURLToPath(import.meta.url))

/** packages/eval/dist → packages/eval */
export function evalDir(): string {
  return process.env.OCR_EVAL_DIR ?? resolve(here, '..')
}

export const fixturesDir = (): string => join(evalDir(), 'fixtures')
export const resultsDir = (): string => join(evalDir(), 'results')
export const labelsPath = (): string => join(evalDir(), 'labels.json')

export async function loadLabels(): Promise<LabelsFile> {
  const path = labelsPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (cause) {
    throw new Error(`No labels file at ${path}`, { cause })
  }

  const parsed = LabelsFileSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    // Loud, because a malformed labels file scored as if it were fine would
    // silently change every number in the report.
    throw new Error(`${path} is not a valid labels file:\n${parsed.error.message}`)
  }
  return parsed.data
}

export interface ResolvedFixture {
  name: string
  path: string
  label: Label
}

export async function resolveFixtures(filter?: {
  only?: string
  limit?: number
}): Promise<ResolvedFixture[]> {
  const labels = await loadLabels()

  return Object.entries(labels.fixtures)
    .filter(([, label]) => label.approved)
    .filter(([, label]) => !filter?.only || label.type === filter.only)
    .slice(0, filter?.limit ?? Infinity)
    .map(([name, label]) => ({ name, path: join(fixturesDir(), name), label }))
}
