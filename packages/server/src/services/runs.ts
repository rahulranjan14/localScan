import { createHash } from 'node:crypto'
import { Client, Connection } from '@temporalio/client'
import { storeFile } from '../storage/fileStore.js'
import { findFileBySha256 } from '../repositories/files.js'
import { findDocumentByFileId } from '../repositories/documents.js'
import type { DocumentRow } from '../repositories/documents.js'

/**
 * Starts durable extraction runs and reports on them.
 *
 * There is no `runs` table. Temporal *is* the run history, and its Web UI is the
 * admin console — the predecessor hand-rolled a pipeline_runs table, a retry
 * decorator with a hardcoded backoff list, and a database lock with no lease that
 * could wedge the pipeline permanently. All three are deleted by this choice.
 */

const TASK_QUEUE = 'ocr'

/**
 * How recently a poller must have checked in to count as alive.
 *
 * A healthy worker long-polls continuously, so its last access is always within
 * seconds. Sixty seconds is generous enough to never report a busy worker as
 * dead, and short enough that a killed one stops counting quickly.
 */
const POLLER_FRESHNESS_MS = 60_000

let client: Client | null = null

async function temporal(): Promise<Client> {
  if (client) return client
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  })
  client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' })
  return client
}

export class DuplicateDocument extends Error {
  constructor(readonly existing: DocumentRow) {
    super('This document has already been processed')
    this.name = 'DuplicateDocument'
  }
}

/**
 * Re-processing the same bytes is refused by default: a re-upload should not
 * cost a workflow execution when the answer is already stored (FR-1.3).
 *
 * While tuning an OCR prompt or comparing vision models that is exactly
 * backwards — the same document has to run again and again, and finding a new
 * PDF for each attempt changes the thing being measured. `OCR_ALLOW_REPROCESS=true`
 * opts a development machine into allowing it. The server flag and the caller
 * must agree, so a stray parameter in production cannot cause a re-run.
 */
const reprocessAllowed = (): boolean => process.env.OCR_ALLOW_REPROCESS === 'true'

export interface StartRunInput {
  bytes: Uint8Array
  filename: string
  mime: string
  pages?: number[] | undefined
  /** Run again even if these bytes are already stored. Development only. */
  reprocess?: boolean | undefined
}

export interface StartedRun {
  runId: string
  workflowId: string
  sha256: string
}

export async function startExtraction(input: StartRunInput): Promise<StartedRun> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')

  // Deduplication stays here rather than in the workflow: answering a re-upload
  // should not cost a workflow execution, and the answer is already in the
  // database (FR-1.3).
  const reprocess = input.reprocess === true && reprocessAllowed()

  const existingFile = await findFileBySha256(sha256)
  if (existingFile && !reprocess) {
    const prior = await findDocumentByFileId(existingFile.id)
    if (prior) throw new DuplicateDocument(prior)
  }

  // Written to disk before the workflow starts, so activities can read it by
  // hash rather than the bytes travelling through Temporal's payload limit.
  await storeFile(input.bytes)

  // A forced re-run gets its own workflow id, so its history sits beside the
  // earlier attempts rather than replacing them. Comparing runs is the point.
  const workflowId = reprocess
    ? `extract-${sha256.slice(0, 16)}-${Date.now().toString(36)}`
    : `extract-${sha256.slice(0, 16)}`
  const handle = await (await temporal()).workflow.start('extractDocumentWorkflow', {
    taskQueue: TASK_QUEUE,
    // Content-addressed, so starting the same document twice reuses the run
    // rather than racing two of them.
    workflowId,
    args: [{ sha256, filename: input.filename, mime: input.mime, pages: input.pages }],
  })

  return { runId: handle.firstExecutionRunId, workflowId, sha256 }
}

/**
 * Starts a run and waits for it.
 *
 * For the agent surface, where returning a run id would make every caller
 * implement polling. The durability is unchanged — if the worker dies mid-run
 * this call waits while the run resumes on another worker, which is the whole
 * point of it being a workflow rather than a function call.
 */
export async function runExtraction(input: StartRunInput): Promise<unknown> {
  const started = await startExtraction(input)
  const handle = (await temporal()).workflow.getHandle(started.workflowId)
  return handle.result()
}

export interface RunStatus {
  workflowId: string
  runId: string
  status: string
  startedAt: string | null
  closedAt: string | null
  result?: unknown
  error?: string
}

/**
 * The message a person should read, dug out of Temporal's wrapping.
 *
 * A failed activity arrives three errors deep -- `WorkflowFailedError` wrapping
 * `ActivityFailure` wrapping the `ApplicationFailure` that carries the actual
 * reason -- and the outermost message is the string "Workflow execution failed".
 * Reporting that is reporting the status twice: the interface already says FAILED,
 * and the one thing it needs is why (`D-016`).
 *
 * The deepest message wins, prefixed with the activity that produced it, because
 * which step failed is most of the diagnosis.
 */
function failureMessage(error: unknown): string {
  const messages: string[] = []
  let activityType: string | undefined
  let current: unknown = error
  const seen = new Set<unknown>()

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    if (current.message) messages.push(current.message)
    const withActivity = current as { activityType?: unknown }
    if (typeof withActivity.activityType === 'string') activityType = withActivity.activityType
    current = current.cause
  }

  const deepest = messages.at(-1)
  if (!deepest) return 'The run failed and reported no message'
  return activityType ? `${activityType}: ${deepest}` : deepest
}

export async function describeRun(workflowId: string): Promise<RunStatus> {
  const handle = (await temporal()).workflow.getHandle(workflowId)
  const description = await handle.describe()

  const status: RunStatus = {
    workflowId,
    runId: description.runId,
    status: description.status.name,
    startedAt: description.startTime?.toISOString() ?? null,
    closedAt: description.closeTime?.toISOString() ?? null,
  }

  if (description.status.name === 'COMPLETED') {
    status.result = await handle.result()
  } else if (description.status.name === 'FAILED') {
    status.error = await handle.result().then(() => 'unknown', failureMessage)
  }

  return status
}

/**
 * Is Temporal reachable, and is anyone listening on the task queue?
 *
 * Both halves matter and they fail differently. With no Temporal the upload
 * fails outright. With Temporal but **no worker**, the upload succeeds, the run
 * is created, and then nothing happens — forever, with no error anywhere. That
 * silent version is the one worth detecting, because from the interface it is
 * indistinguishable from a slow model.
 */
export async function temporalHealth(): Promise<{
  reachable: boolean
  workers: number | null
  taskQueue: string
  reason?: string
}> {
  try {
    const client = await temporal()
    const description = await client.workflowService.describeTaskQueue({
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: { name: TASK_QUEUE },
      taskQueueType: 1, // WORKFLOW
    })

    // Counting registrations is not the same as counting live workers: Temporal
    // keeps a poller listed for a while after it stops polling, so a killed
    // worker still reads as present. Filtering on lastAccessTime is what makes
    // the answer true now rather than true recently.
    const cutoff = Date.now() - POLLER_FRESHNESS_MS
    const live = (description.pollers ?? []).filter((poller) => {
      const seconds = Number(poller.lastAccessTime?.seconds ?? 0)
      return seconds * 1000 >= cutoff
    })

    return { reachable: true, workers: live.length, taskQueue: TASK_QUEUE }
  } catch (error) {
    return {
      reachable: false,
      workers: null,
      taskQueue: TASK_QUEUE,
      reason: error instanceof Error ? error.message.slice(0, 200) : String(error),
    }
  }
}
