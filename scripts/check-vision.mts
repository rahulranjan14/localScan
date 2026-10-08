/**
 * Runs the vision OCR path over one PDF and prints the transcription.
 *
 *   npm run check:vision -- <file.pdf> --base-url http://HOST:11434 --model granite3.2-vision
 *
 * Separate from check-inference because the vision path has its own failure modes
 * and its own cost. It exercises the real modules -- rasterizePdf and ocrPages --
 * rather than a hand-rolled request, so what passes here is what the pipeline
 * will do.
 *
 * Expect minutes per page on CPU. That is not a fault to be fixed; it is why the
 * text-layer check runs first and why this path is the fallback (FR-2.2).
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import {
  OllamaProvider,
  TIMEOUTS,
  hasUsableTextLayer,
  loadOcrPrompt,
  ocrPages,
  rasterizePdf,
  readTextLayer,
} from '@ocr/core'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'base-url': { type: 'string', default: 'http://127.0.0.1:11434' },
    model: { type: 'string', default: 'granite3.2-vision' },
    dpi: { type: 'string', default: '150' },
    pages: { type: 'string' },
    'max-tokens': { type: 'string', default: '4096' },
    /** Forces the vision path even when the document has perfectly good text. */
    force: { type: 'boolean', default: false },
  },
})

const file = positionals[0]
if (!file) {
  console.error('usage: npm run check:vision -- <file.pdf> [--base-url URL] [--model NAME] [--dpi N] [--force]')
  process.exit(2)
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const step = (s: string) => console.log(`\x1b[36m▸\x1b[0m ${s}`)

const bytes = new Uint8Array(await readFile(file))
step(`${basename(file)} — ${(bytes.byteLength / 1024).toFixed(0)} KB`)

const textLayer = await readTextLayer(bytes)
const usable = hasUsableTextLayer(textLayer)
step(`text layer: ${textLayer.pagesWithText}/${textLayer.totalPages} pages usable=${usable}`)

if (usable && !values.force) {
  console.log(dim('\n  This document has a text layer, so the pipeline would not call a model.'))
  console.log(dim('  Pass --force to exercise the vision path anyway.\n'))
  process.exit(0)
}

const dpi = Number(values.dpi)
const pageList = values.pages?.split(',').map(Number)

const rasterStarted = Date.now()
const rendered = await rasterizePdf(bytes, {
  dpi,
  ...(pageList ? { pages: pageList } : {}),
})
step(
  `rasterised ${rendered.length} page(s) at ${dpi} DPI in ${((Date.now() - rasterStarted) / 1000).toFixed(1)}s` +
    ` — ${rendered[0]?.width}x${rendered[0]?.height}, ` +
    `${(rendered.reduce((n, p) => n + p.png.byteLength, 0) / 1024).toFixed(0)} KB total`,
)

const provider = new OllamaProvider({
  model: values.model!,
  baseUrl: values['base-url']!,
  timeoutMs: TIMEOUTS.ocr,
})

const caps = await provider.capabilities()
if (!caps.vision) {
  console.log(`\n\x1b[31m✗ "${values.model}" is not a vision model.\x1b[0m`)
  console.log(dim('  The ocr role needs one; this would fail at extraction time instead.\n'))
  process.exit(1)
}
step(`"${values.model}" reports vision support · timeout ${TIMEOUTS.ocr / 60000} min per page`)

console.log(dim(`\n  Transcribing. Minutes per page on CPU is normal.\n`))

const result = await ocrPages({
  provider,
  promptTemplate: await loadOcrPrompt(),
  pages: rendered,
  maxTokensPerPage: Number(values['max-tokens']),
  onPage: (page, of, ms) =>
    console.log(dim(`  page ${page}/${of} done in ${(ms / 1000).toFixed(1)}s`)),
})

for (const failure of result.failures) {
  console.log(`\x1b[31m  page ${failure.page} failed:\x1b[0m ${failure.reason}`)
}

const total = result.pages.reduce((n, p) => n + p.text.length, 0)
console.log(`\n\x1b[32m✓ ${result.pages.length} page(s), ${total} characters\x1b[0m\n`)

for (const page of result.pages) {
  console.log(dim(`--- page ${page.page} ---`))
  console.log(page.text)
  console.log()
}

// The comparison that matters: the text layer is ground truth here, so a
// transcription far shorter than it means the model stopped early.
if (usable) {
  const layerChars = textLayer.pages.reduce((n, p) => n + p.text.length, 0)
  console.log(
    dim(`  text layer had ${layerChars} characters; vision produced ${total} ` +
      `(${((total / layerChars) * 100).toFixed(0)}%)`),
  )
}
