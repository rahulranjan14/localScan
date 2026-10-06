/**
 * Runs the engine over one PDF and prints the result. No server, no database.
 *
 *   npm run extract -- <file.pdf> --base-url http://192.168.29.128:11434
 *
 * This exists because the engine is pure: given bytes and a model binding it
 * returns a result, with no HTTP layer and no storage involved. Being able to
 * exercise it from a command line is the practical proof of that -- the same
 * code path the server and the eval harness will use.
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { InvoiceSchema } from '@ocr/shared'
import {
  OllamaProvider,
  extractStructured,
  hasUsableTextLayer,
  joinPages,
  loadPrompt,
  readTextLayer,
  validatePdfInput,
} from '@ocr/core'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'base-url': { type: 'string', default: 'http://127.0.0.1:11434' },
    model: { type: 'string', default: 'qwen2.5:3b' },
  },
})

const file = positionals[0]
if (!file) {
  console.error('usage: npm run extract -- <file.pdf> [--base-url URL] [--model NAME]')
  process.exit(2)
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const step = (s: string) => console.log(`\x1b[36m▸\x1b[0m ${s}`)

const bytes = new Uint8Array(await readFile(file))
const sha256 = createHash('sha256').update(bytes).digest('hex')

step(`${basename(file)}  ${(bytes.byteLength / 1024).toFixed(0)} KB`)
console.log(dim(`  sha256 ${sha256}`))

validatePdfInput(bytes)
step('input accepted')

const textLayer = await readTextLayer(bytes)
const usable = hasUsableTextLayer(textLayer)
step(
  `text layer: ${textLayer.pagesWithText}/${textLayer.totalPages} pages — ` +
    (usable ? 'using it, no vision model needed' : 'insufficient, would need OCR'),
)

if (!usable) {
  console.log(dim('\n  Rasterisation and vision OCR arrive in Phase 2.'))
  process.exit(1)
}

const text = joinPages(textLayer.pages)
console.log(dim(`  ${text.length} characters extracted`))

const provider = new OllamaProvider({ model: values.model!, baseUrl: values['base-url']! })
const promptTemplate = await loadPrompt('invoice')

step(`extracting with ${values.model} …`)
const result = await extractStructured({
  provider,
  schema: InvoiceSchema,
  promptTemplate,
  text,
})

if (result.injection.matched.length > 0) {
  // Reported, not acted on. The document is processed either way (FR-11.2).
  console.log(dim(`  injection patterns seen: ${result.injection.matched.join(', ')}`))
}

if (!result.ok) {
  console.log(`\n\x1b[31m✗ extraction failed after ${(result.durationMs / 1000).toFixed(1)}s\x1b[0m`)
  console.log(dim(`  ${result.reason}`))
  console.log(dim('  In the application this becomes status=needs_review with no stored data.'))
  process.exit(1)
}

console.log(`\n\x1b[32m✓ validated in ${(result.durationMs / 1000).toFixed(1)}s\x1b[0m\n`)
console.log(JSON.stringify(result.data, null, 2))
