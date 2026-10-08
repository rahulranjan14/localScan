/**
 * Verifies that the configured inference host can actually do what the pipeline
 * needs, before the application assumes it.
 *
 *   npm run check:inference -- --base-url http://192.168.29.128:11434 --model qwen2.5:3b
 *
 * Reachability and model presence are read from the host. Structured output is
 * *probed*, because nothing the host reports tells you whether a model will
 * honour a JSON schema -- and the whole extraction path depends on it (FR-8.9).
 *
 * This script never changes anything on the inference host. It only reads, and
 * where something is missing it prints the command for the host's owner to run
 * (FR-9.5, D-002).
 */
import { parseArgs } from 'node:util'
import { z } from 'zod'
import {
  ModelNotInstalledError,
  OllamaProvider,
  ProviderUnreachableError,
} from '@ocr/core'

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://127.0.0.1:11434' },
    model: { type: 'string', default: 'qwen2.5:3b' },
  },
})

const baseUrl = values['base-url']!
const model = values.model!

const ok = (s: string) => `  \x1b[32m✓\x1b[0m ${s}`
const bad = (s: string) => `  \x1b[31m✗\x1b[0m ${s}`
const info = (s: string) => `    \x1b[2m${s}\x1b[0m`

console.log(`\nInference host: ${baseUrl}`)
console.log(`Model:          ${model}\n`)

const provider = new OllamaProvider({ model, baseUrl })

if (!(await provider.ping())) {
  console.log(bad('unreachable'))
  console.log(info(`Nothing answered at ${baseUrl}.`))
  console.log(info('On the inference host, start it with:'))
  console.log(info('  OLLAMA_HOST=0.0.0.0 ollama serve'))
  process.exit(1)
}
console.log(ok('reachable'))

const installed = await provider.listModels()
const present = installed.some((m) => m.name === model || m.name.startsWith(`${model}:`))

if (!present) {
  console.log(bad(`"${model}" is not installed`))
  console.log(info(`Installed: ${installed.map((m) => m.name).join(', ') || '(none)'}`))
  console.log(info('On the inference host, run:'))
  console.log(info(`  ollama pull ${model}`))
  process.exit(1)
}
console.log(ok(`"${model}" installed`))

const caps = await provider.capabilities().catch((error: unknown) => {
  if (error instanceof ModelNotInstalledError) return null
  throw error
})
if (caps) {
  console.log(ok(`vision=${caps.vision} embedding=${caps.embedding}`))
}

// The probe itself: a deliberately tiny two-field schema. If a model cannot
// manage this, it cannot manage an invoice, and the failure should surface here
// rather than midway through a document.
const ProbeSchema = z.object({
  invoiceNumber: z.string(),
  total: z.number(),
})

const started = Date.now()
try {
  const result = await provider.chatStructured({
    schema: ProbeSchema,
    prompt:
      'Extract the invoice number and total.\n\n' +
      '<document>\nInvoice INV-2024-0042, amount due 15750.50 INR\n</document>',
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(ok(`structured output honoured (${seconds}s, includes cold model load)`))
  console.log(info(JSON.stringify(result)))
} catch (error) {
  console.log(bad('structured output NOT honoured'))
  console.log(info(error instanceof Error ? error.message : String(error)))
  console.log(info(`This model cannot serve the extract role. Try a different one.`))
  process.exit(1)
}

console.log(`\n\x1b[32mReady.\x1b[0m\n`)
