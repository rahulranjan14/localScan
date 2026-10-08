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

export interface StartRunInput {
  bytes: Uint8Array
  filename: string
  mime: string
  pages?: number[] | undefined
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
  const existingFile = await findFileBySha256(sha256)
  if (existingFile) {
    const prior = await findDocumentByFileId(existingFile.id)
    if (prior) throw new DuplicateDocument(prior)
  }

  // Written to disk before the workflow starts, so activities can read it by
  // hash rather than the bytes travelling through Temporal's payload limit.
  await storeFile(input.bytes)

  const workflowId = `extract-${sha256.slice(0, 16)}`
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
    status.error = await handle.result().then(
      () => 'unknown',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
  }

  return status
}
