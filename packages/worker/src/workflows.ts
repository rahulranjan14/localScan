import { proxyActivities } from '@temporalio/workflow'
import type * as activities from './activities.js'

/**
 * The extraction pipeline as a durable workflow.
 *
 * **Workflow code must be deterministic.** No I/O, no `Date.now()`, no
 * `Math.random()`. Every model call and every database write happens in an
 * activity — Temporal replays this function from its event history to recover
 * state, so anything non-deterministic would produce a different path on replay
 * and corrupt the run it was trying to rescue.
 *
 * This is orchestration only, and it is deliberately boring: a fixed sequence
 * with one branch. That is also the argument for Temporal being here rather than
 * LangGraph — there is no model-driven control flow to express, only steps that
 * must survive a crash.
 *
 * Per-activity retries and timeouts, because they differ by two orders of
 * magnitude: transcription can take half an hour and input validation should
 * never be retried at all.
 */

/**
 * Model calls: long, and flaky enough to be worth a couple of retries.
 *
 * `heartbeatTimeout` is the load-bearing setting, not `startToCloseTimeout`.
 * These activities heartbeat as they work, and without a heartbeat deadline
 * Temporal has nothing to measure those beats against — so a worker that dies
 * mid-transcription is only noticed when the 35-minute start-to-close limit
 * expires. That makes "kill the worker and the run resumes" technically true and
 * practically useless.
 *
 * With it, a dead worker is detected in two minutes and the activity is
 * rescheduled onto another one.
 */
const { acquireText, index } = proxyActivities<typeof activities>({
  startToCloseTimeout: '35 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
})

/**
 * Single model calls, which cannot heartbeat.
 *
 * Classification and extraction are one request each: there is no progress to
 * report from inside them, so they must not promise a heartbeat. Giving them the
 * deadline above would kill them mid-call while they were working correctly —
 * the opposite of what it is for.
 *
 * The cost is that a worker dying during one of these is only noticed at
 * start-to-close. That is the honest trade: an activity that cannot report
 * progress cannot be monitored for progress.
 */
const { classify, extract } = proxyActivities<typeof activities>({
  startToCloseTimeout: '25 minutes',
  retry: { maximumAttempts: 3 },
})

/** Bad input is bad on every attempt; a retry only fails again more slowly. */
const { validateInput } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
})

/** Transient database errors are worth several attempts, unlike model calls. */
const { persist } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5 },
})

export interface ExtractInput {
  sha256: string
  filename: string
  mime: string
  pages?: number[]
}

export interface ExtractOutput {
  documentId: string
  type: string
  status: string
}

export async function extractDocumentWorkflow(input: ExtractInput): Promise<ExtractOutput> {
  await validateInput(input.sha256)

  // Text layer or vision, decided inside the activity because the decision needs
  // to read the file. The workflow only needs to know text came back.
  const text = await acquireText(input.sha256, input.pages)

  const classified = await classify(text.rawText)

  const extracted = await extract(text.rawText, classified.type)

  const document = await persist({
    sha256: input.sha256,
    filename: input.filename,
    mime: input.mime,
    type: classified.type,
    rawText: text.rawText,
    confidence: classified.confidence,
    reason: classified.reason,
    usedVision: text.usedVision,
    data: extracted.ok ? extracted.data : null,
    error: extracted.ok ? null : extracted.error,
    review: extracted.review,
  })

  // Indexing failure is not fatal: a document that extracted correctly but could
  // not be embedded is still useful, and losing the extraction because an
  // embedding model was unreachable would not be.
  try {
    await index(document.documentId, text.rawText)
  } catch {
    // Recorded in the activity's own history; the run still succeeds.
  }

  return document
}
