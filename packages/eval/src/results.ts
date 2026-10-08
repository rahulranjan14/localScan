import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { resultsDir } from './labels.js'

/**
 * A results file is the output of one `eval run`, committed.
 *
 * It records what produced the numbers as well as the numbers, because a result
 * without its configuration cannot be compared with anything. The predecessor
 * system's harness was well designed and unreproducible; this is the half of that
 * problem that is not about fixtures.
 */

export const RunConfigSchema = z.object({
  textMode: z.string(),
  baseUrl: z.string(),
  models: z.record(z.string(), z.string().nullable()),
  dpi: z.number().optional(),
})
export type RunConfig = z.infer<typeof RunConfigSchema>

export const DocumentResultSchema = z.object({
  fixture: z.string(),
  /** Null when the pipeline failed before producing data. */
  type: z.string().nullable(),
  confidence: z.number().nullable(),
  classificationReason: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  rawText: z.string().nullable(),
  data: z.unknown(),
  durationMs: z.number(),
  usedVision: z.boolean(),
})
export type DocumentResult = z.infer<typeof DocumentResultSchema>

export const ResultsFileSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  config: RunConfigSchema,
  documents: z.array(DocumentResultSchema),
})
export type ResultsFile = z.infer<typeof ResultsFileSchema>

/** Dated and configuration-stamped, so two runs are distinguishable at a glance. */
export function runId(config: RunConfig): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const ocr = (config.models['ocr'] ?? 'none').split(':')[0]
  const extract = (config.models['extract'] ?? 'none').split(':')[0]
  return `${stamp}__${ocr}__${extract}__${config.textMode}`
}

export async function saveResults(results: ResultsFile): Promise<string> {
  await mkdir(resultsDir(), { recursive: true })
  const path = join(resultsDir(), `${results.runId}.json`)
  await writeFile(path, JSON.stringify(results, null, 2) + '\n')
  return path
}

export async function loadResults(pathOrName: string): Promise<ResultsFile> {
  const path = pathOrName.endsWith('.json')
    ? pathOrName
    : join(resultsDir(), `${pathOrName}.json`)

  const parsed = ResultsFileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!parsed.success) {
    throw new Error(`${path} is not a valid results file:\n${parsed.error.message}`)
  }
  return parsed.data
}
