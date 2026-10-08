/**
 * The harness CLI: `run`, `score`, `diff`.
 *
 *   npm run eval -- run   [--only invoice] [--limit 5] [--base-url URL]
 *   npm run eval -- score <results.json|runId>
 *   npm run eval -- diff  <before> <after>
 *
 * `run` and `score` are separate commands on purpose. Scoring must never call a
 * model: re-scoring a stored run after changing the metric has to be free and
 * deterministic, or nobody re-scores and the metric never improves. It also means
 * a committed result stays meaningful long after the machine that produced it is
 * gone.
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import {
  OllamaProvider,
  TIMEOUTS,
  classifyDocument,
  extractWithFallback,
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
import {
  GENERIC_TYPE,
  GenericSchema,
  getDocumentType,
  type TextMode,
} from '@ocr/shared'
import type { z } from 'zod'
import { resolveFixtures } from './labels.js'
import { checkRobustness } from './robustness.js'
import { loadResults, runId, saveResults, type DocumentResult, type RunConfig } from './results.js'
import { scoreCorpus, scoreDocument, type DocumentScore } from './scoring.js'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

// ── run ──────────────────────────────────────────────────────────────────────

async function commandRun(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'base-url': { type: 'string', default: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434' },
      'text-mode': { type: 'string', default: process.env.OCR_TEXT_MODE ?? 'auto' },
      'model-ocr': { type: 'string', default: process.env.OCR_MODEL_OCR ?? 'granite3.2-vision' },
      'model-classify': { type: 'string', default: process.env.OCR_MODEL_CLASSIFY ?? 'qwen2.5:3b' },
      'model-extract': { type: 'string', default: process.env.OCR_MODEL_EXTRACT ?? 'qwen2.5:3b' },
      'model-fallback': { type: 'string' },
      dpi: { type: 'string' },
      only: { type: 'string' },
      limit: { type: 'string' },
    },
  })

  const config: RunConfig = {
    textMode: values['text-mode']!,
    baseUrl: values['base-url']!,
    models: {
      ocr: values['model-ocr'] ?? null,
      classify: values['model-classify'] ?? null,
      extract: values['model-extract'] ?? null,
      fallback: values['model-fallback'] ?? null,
    },
    ...(values.dpi ? { dpi: Number(values.dpi) } : {}),
  }

  const fixtures = await resolveFixtures({
    ...(values.only ? { only: values.only } : {}),
    ...(values.limit ? { limit: Number(values.limit) } : {}),
  })

  if (fixtures.length === 0) {
    console.error('No approved fixtures matched. Only labels with "approved": true are run.')
    process.exit(1)
  }

  const id = runId(config)
  console.log(`\n${bold(id)}`)
  console.log(dim(`  ${fixtures.length} fixture(s) · ${config.textMode} · ${config.baseUrl}`))
  console.log(
    dim(`  ocr=${config.models['ocr']} classify=${config.models['classify']} extract=${config.models['extract']}\n`),
  )

  const provider = (model: string | null): LlmProvider | undefined =>
    model ? new OllamaProvider({ model, baseUrl: config.baseUrl, timeoutMs: TIMEOUTS.ocr }) : undefined

  const documents: DocumentResult[] = []

  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.name.padEnd(28)}`)
    const started = Date.now()
    try {
      const result = await runOne(fixture.path, config, provider)
      documents.push({ ...result, fixture: fixture.name, durationMs: Date.now() - started })
      process.stdout.write(
        `${result.status === 'completed' ? green('ok') : yellow(result.status)}` +
          dim(` ${result.type} ${((Date.now() - started) / 1000).toFixed(0)}s\n`),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      documents.push({
        fixture: fixture.name,
        type: null,
        confidence: null,
        classificationReason: null,
        status: 'failed',
        error: message,
        rawText: null,
        data: null,
        durationMs: Date.now() - started,
        usedVision: false,
      })
      process.stdout.write(`${red('failed')} ${dim(message.slice(0, 60))}\n`)
    }
  }

  const path = await saveResults({
    runId: id,
    startedAt: new Date().toISOString(),
    config,
    documents,
  })
  console.log(`\n  results → ${path}`)
  console.log(dim(`  score them with:  npm run eval -- score ${id}\n`))
}

/** One fixture through the engine. Mirrors the server's pipeline exactly. */
async function runOne(
  path: string,
  config: RunConfig,
  provider: (model: string | null) => LlmProvider | undefined,
): Promise<Omit<DocumentResult, 'fixture' | 'durationMs'>> {
  const bytes = new Uint8Array(await readFile(path))
  validatePdfInput(bytes)

  const textLayer = await readTextLayer(bytes)
  let rawText: string
  let usedVision = false

  if (shouldUseTextLayer(config.textMode as TextMode, textLayer)) {
    rawText = joinPages(textLayer.pages)
  } else {
    usedVision = true
    const ocrProvider = provider(config.models['ocr'] ?? null)
    if (!ocrProvider) throw new Error('This document needs the vision path and no ocr model is set')

    const rendered = await rasterizePdf(bytes, config.dpi ? { dpi: config.dpi } : {})
    const ocr = await ocrPages({
      provider: ocrProvider,
      promptTemplate: await loadOcrPrompt(ocrProvider.model),
      pages: rendered,
    })
    rawText = joinPages(ocr.pages)
    if (rawText.replace(/--- page \d+ ---/g, '').trim().length < 20) {
      throw new Error(`Transcription produced almost nothing (${rawText.length} chars)`)
    }
  }

  const classifyProvider = provider(config.models['classify'] ?? null)
  if (!classifyProvider) throw new Error('No classify model set')

  const classified = await classifyDocument({
    provider: classifyProvider,
    promptTemplate: await loadClassifierPrompt(),
    text: rawText,
  })

  const definition = getDocumentType(classified.type)
  const schema: z.ZodType = definition?.schema ?? GenericSchema
  const promptTemplate = definition
    ? await loadPrompt(definition.slug)
    : await loadGenericPrompt()

  const extractProvider = provider(config.models['extract'] ?? null)
  if (!extractProvider) throw new Error('No extract model set')

  const extracted = await extractWithFallback({
    provider: extractProvider,
    fallbackProvider: provider(config.models['fallback'] ?? null),
    schema,
    promptTemplate,
    text: rawText,
  })

  return {
    type: classified.type,
    confidence: classified.confidence,
    classificationReason: classified.reason,
    status: extracted.ok ? 'completed' : 'needs_review',
    error: extracted.ok ? null : extracted.reason,
    rawText,
    data: extracted.ok ? extracted.data : null,
    usedVision,
  }
}

// ── score ────────────────────────────────────────────────────────────────────

async function commandScore(argv: string[]): Promise<void> {
  const target = argv[0]
  if (!target) {
    console.error('usage: npm run eval -- score <results.json|runId>')
    process.exit(2)
  }

  const results = await loadResults(target)
  const fixtures = await resolveFixtures()
  const byName = new Map(fixtures.map((f) => [f.name, f]))

  const normal: DocumentScore[] = []
  const robustness: Array<{ fixture: string; passed: boolean; findings: number }> = []

  for (const doc of results.documents) {
    const fixture = byName.get(doc.fixture)
    if (!fixture) continue

    // Two metric classes, never averaged together (FR-10.4).
    if (fixture.label.robustness) {
      const check = checkRobustness(doc.data)
      robustness.push({ fixture: doc.fixture, passed: check.passed, findings: check.findings.length })
      continue
    }

    normal.push(
      scoreDocument({
        fixture: doc.fixture,
        expectedType: fixture.label.type,
        actualType: doc.type,
        expected: fixture.label.data,
        actual: doc.data,
      }),
    )
  }

  const corpus = scoreCorpus(normal)

  console.log(`\n${bold(results.runId)}`)
  console.log(dim(`  ${results.startedAt} · ${results.config.textMode}`))
  console.log(
    dim(`  ocr=${results.config.models['ocr']} extract=${results.config.models['extract']}\n`),
  )

  for (const doc of normal) {
    const bad = doc.counts.wrong + doc.counts.fabricated + doc.counts.missed
    const line =
      `  ${doc.fixture.padEnd(28)} F1 ${pct(doc.f1).padStart(6)}` +
      `  ${doc.counts.correct} right` +
      (doc.counts.wrong ? red(`  ${doc.counts.wrong} wrong`) : '') +
      (doc.counts.fabricated ? red(`  ${doc.counts.fabricated} invented`) : '') +
      (doc.counts.missed ? yellow(`  ${doc.counts.missed} missed`) : '')
    console.log(bad === 0 ? green(line) : line)
    if (!doc.type?.correct) {
      console.log(dim(`     classified ${doc.type?.actual} — expected ${doc.type?.expected}`))
    }
  }

  console.log()
  console.log(bold('  Fields'))
  console.log(`    precision          ${pct(corpus.precision)}   ${dim('of what it asserted, how much was right')}`)
  console.log(`    recall             ${pct(corpus.recall)}   ${dim('of what was there, how much it found')}`)
  console.log(`    F1                 ${bold(pct(corpus.f1))}`)
  console.log()
  console.log(`    correct            ${corpus.counts.correct}`)
  console.log(`    wrong              ${corpus.counts.wrong}`)
  console.log(
    `    ${red('invented')}           ${corpus.counts.fabricated}   ${dim('values where the document said nothing')}`,
  )
  console.log(`    missed             ${corpus.counts.missed}`)
  console.log(dim(`    correctly absent   ${corpus.counts.absent}   (not scored)`))
  console.log()
  console.log(bold('  Classification'))
  console.log(`    accuracy           ${pct(corpus.classificationAccuracy)}`)

  if (robustness.length > 0) {
    console.log()
    console.log(bold('  Robustness') + dim('  (pass/fail — never averaged into the above)'))
    for (const r of robustness) {
      console.log(`    ${r.fixture.padEnd(26)} ${r.passed ? green('pass') : red(`fail (${r.findings})`)}`)
    }
  }
  console.log()
}

// ── diff ─────────────────────────────────────────────────────────────────────

async function commandDiff(argv: string[]): Promise<void> {
  const [beforeArg, afterArg] = argv
  if (!beforeArg || !afterArg) {
    console.error('usage: npm run eval -- diff <before> <after>')
    process.exit(2)
  }

  const [before, after] = await Promise.all([loadResults(beforeArg), loadResults(afterArg)])
  const fixtures = await resolveFixtures()
  const byName = new Map(fixtures.map((f) => [f.name, f]))

  const scoreOf = (results: Awaited<ReturnType<typeof loadResults>>) =>
    scoreCorpus(
      results.documents
        .filter((d) => byName.has(d.fixture) && !byName.get(d.fixture)!.label.robustness)
        .map((d) =>
          scoreDocument({
            fixture: d.fixture,
            expectedType: byName.get(d.fixture)!.label.type,
            actualType: d.type,
            expected: byName.get(d.fixture)!.label.data,
            actual: d.data,
          }),
        ),
    )

  const a = scoreOf(before)
  const b = scoreOf(after)

  const delta = (x: number, y: number) => {
    const d = y - x
    const text = `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}pp`
    return d > 0.0001 ? green(text) : d < -0.0001 ? red(text) : dim(text)
  }
  const countDelta = (x: number, y: number) => {
    const d = y - x
    const text = `${d >= 0 ? '+' : ''}${d}`
    // More invented values is worse, so the colours invert for that row.
    return d === 0 ? dim(text) : text
  }

  console.log(`\n${dim('before')}  ${before.runId}`)
  console.log(`${dim('after ')}  ${after.runId}\n`)
  console.log(`  precision   ${pct(a.precision).padStart(7)} → ${pct(b.precision).padStart(7)}   ${delta(a.precision, b.precision)}`)
  console.log(`  recall      ${pct(a.recall).padStart(7)} → ${pct(b.recall).padStart(7)}   ${delta(a.recall, b.recall)}`)
  console.log(`  F1          ${pct(a.f1).padStart(7)} → ${pct(b.f1).padStart(7)}   ${delta(a.f1, b.f1)}`)
  console.log(`  classify    ${pct(a.classificationAccuracy).padStart(7)} → ${pct(b.classificationAccuracy).padStart(7)}   ${delta(a.classificationAccuracy, b.classificationAccuracy)}`)
  console.log()
  console.log(`  correct     ${String(a.counts.correct).padStart(7)} → ${String(b.counts.correct).padStart(7)}   ${countDelta(a.counts.correct, b.counts.correct)}`)
  console.log(`  wrong       ${String(a.counts.wrong).padStart(7)} → ${String(b.counts.wrong).padStart(7)}   ${countDelta(a.counts.wrong, b.counts.wrong)}`)
  console.log(`  invented    ${String(a.counts.fabricated).padStart(7)} → ${String(b.counts.fabricated).padStart(7)}   ${countDelta(a.counts.fabricated, b.counts.fabricated)}`)
  console.log(`  missed      ${String(a.counts.missed).padStart(7)} → ${String(b.counts.missed).padStart(7)}   ${countDelta(a.counts.missed, b.counts.missed)}`)

  // Per-document movement, because an unchanged aggregate can hide two documents
  // moving in opposite directions -- which is exactly when a change is wrong.
  const beforeByFixture = new Map(a.documents.map((d) => [d.fixture, d]))
  const moved = b.documents
    .map((d) => ({ d, prior: beforeByFixture.get(d.fixture) }))
    .filter((x) => x.prior && Math.abs(x.d.f1 - x.prior.f1) > 0.0001)

  if (moved.length > 0) {
    console.log(`\n  ${bold('per document')}`)
    for (const { d, prior } of moved) {
      console.log(`    ${d.fixture.padEnd(26)} ${pct(prior!.f1).padStart(6)} → ${pct(d.f1).padStart(6)}   ${delta(prior!.f1, d.f1)}`)
    }
  }
  console.log()
}

// ── entry ────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case 'run':
    await commandRun(rest)
    break
  case 'score':
    await commandScore(rest)
    break
  case 'diff':
    await commandDiff(rest)
    break
  default:
    console.error(`usage: npm run eval -- <run|score|diff> [options]

  run     [--only TYPE] [--limit N] [--base-url URL] [--text-mode MODE]
          [--model-ocr M] [--model-classify M] [--model-extract M] [--dpi N]
  score   <results.json|runId>
  diff    <before> <after>

Scoring never calls a model, so re-scoring a stored run after changing the
metric is free. ${basename(process.argv[1] ?? '')}`)
    process.exit(2)
}
