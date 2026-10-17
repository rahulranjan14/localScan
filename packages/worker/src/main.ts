// First, and as a side effect: the worker is a separate process from the HTTP
// server, so it loads .env itself. Without this every role reads as unconfigured
// and the first activity fails with "No model configured" -- which looks like a
// configuration mistake rather than a missing import.
import '@ocr/server/env'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { NativeConnection, Worker } from '@temporalio/worker'
import * as activities from './activities.js'

/**
 * The worker process: polls Temporal for work and runs activities.
 *
 * Deliberately separate from the HTTP server. The whole point of this phase is
 * that killing this process mid-extraction loses nothing — the run resumes when
 * a worker comes back. Running it inside the API server would make that
 * demonstration meaningless, because killing it would take the API down too.
 */
const self = fileURLToPath(import.meta.url)
const here = dirname(self)

// Run from source under tsx the sibling is workflows.ts; built it is
// workflows.js. Keying off this file's own extension gets both right without a
// filesystem probe or a separate dev entry point.
const workflowsFile = self.endsWith('.ts') ? 'workflows.ts' : 'workflows.js'

/**
 * One activity at a time by default, because there is one inference host.
 *
 * Temporal's default lets a worker run many activities at once, which for this
 * pipeline means many simultaneous requests to the same Ollama instance. Ten
 * documents submitted together took 5 to 98 minutes each instead of about three,
 * and two of them lost their extraction entirely to connection failures while
 * the host was up and serving. Nothing was gained for the cost: the models are
 * the bottleneck and they do not parallelise on one box.
 *
 * Raise it only when there is more than one host to spread work across.
 */
const concurrency = Number(process.env.OCR_WORKER_CONCURRENCY ?? 1)

/**
 * The server already honoured TEMPORAL_ADDRESS; the worker did not, and defaulted
 * to localhost. That is invisible until the two run in separate containers, where
 * localhost is the container itself and the worker polls nothing forever.
 */
const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
})

const worker = await Worker.create({
  connection,
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  maxConcurrentActivityTaskExecutions: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1,
  // Workflows run in an isolated sandbox with no access to the host's modules,
  // which is what enforces their determinism. They are referenced by path rather
  // than imported, so nothing from this file leaks into that sandbox.
  workflowsPath: join(here, workflowsFile),
  activities,
  taskQueue: 'ocr',
})

console.log(`  worker     task queue "ocr" · namespace default · ${concurrency} activity at a time`)
console.log('  temporal   http://127.0.0.1:8233')
console.log('  kill this process mid-run; the run resumes when it restarts\n')

await worker.run()
