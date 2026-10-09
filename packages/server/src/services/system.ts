import { totalmem, freemem } from 'node:os'
import { ROLES, type ModelCapabilities, type Role, type RoleStatus } from '@ocr/shared'
import { OllamaProvider, ProviderUnreachableError, TIMEOUTS } from '@ocr/core'
import { pool } from '../db/pool.js'
import { temporalHealth } from './runs.js'
import { z } from 'zod'
import type { ServerConfig } from '../config.js'

/** Deliberately tiny: a model that cannot manage this cannot manage a document. */
const ProbeSchema = z.object({ invoiceNumber: z.string(), total: z.number() })

/**
 * One endpoint behind both the header indicator and the system page (FR-9.1).
 *
 * Everything here is a **cheap** check: reachability, a trivial query, a model
 * listing. No inference, because this runs on a 30-second poll and a polling
 * loop that calls a model is a polling loop that melts the inference host
 * (FR-9.4). The structured-output probe is separate and on demand.
 */

export interface ModelInfo {
  name: string
  sizeBytes: number
  /**
   * `null` when it cannot be known, which is the normal case here.
   *
   * Fit is a property of the **inference host**, and this process runs on a
   * different machine. Ollama reports no memory figures, so for a remote host
   * the honest answer is "unknown" — judging it against this machine's free
   * memory would report every model as too large while they all run fine.
   */
  fits: boolean | null
  capabilities?: ModelCapabilities
}

export interface RoleReport {
  role: Role
  provider: string | null
  model: string | null
  status: RoleStatus
  /** One sentence naming the fix, since each status maps to exactly one. */
  note: string
  /** Present for `unreachable`, so the user can see which host was tried. */
  baseUrl?: string
}

export interface SystemReport {
  services: {
    database: { ok: boolean; version?: string; pgvector?: boolean; reason?: string }
    temporal: { ok: boolean; workers: number | null; taskQueue: string; reason?: string }
    inference: { ok: boolean; baseUrl: string; models: ModelInfo[]; reason?: string }
  }
  roles: RoleReport[]
  host: {
    totalMemory: number
    availableMemory: number
    /** False unless OCR_INFERENCE_MEMORY_BYTES states the inference host's memory. */
    inferenceMemoryKnown: boolean
  }
  textMode: string
}

/** What each role needs a model to be able to do. */
const ROLE_REQUIREMENT: Record<Role, keyof ModelCapabilities | null> = {
  ocr: 'vision',
  embed: 'embedding',
  classify: null,
  extract: null,
  fallback: null,
}

export async function systemReport(config: ServerConfig): Promise<SystemReport> {
  const availableMemory = freemem()

  const [database, temporal, inference] = await Promise.all([
    checkDatabase(),
    temporalHealth().then((t) => ({
      ok: t.reachable && (t.workers ?? 0) > 0,
      workers: t.workers,
      taskQueue: t.taskQueue,
      ...(t.reason ? { reason: t.reason } : {}),
    })),
    checkInference(config),
  ])

  return {
    services: { database, temporal, inference },
    roles: ROLES.map((role) => reportRole(role, config, inference)),
    host: {
      totalMemory: totalmem(),
      availableMemory,
      // Of the machine running this process, which is usually not the machine
      // running the models. Reported for context, never used to judge fit.
      inferenceMemoryKnown: declaredInferenceMemory() !== null,
    },
    textMode: config.textMode,
  }
}

async function checkDatabase(): Promise<SystemReport['services']['database']> {
  try {
    const { rows } = await pool.query<{ version: string; vector: string | null }>(
      `SELECT current_setting('server_version') AS version,
              (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector`,
    )
    return {
      ok: true,
      version: rows[0]?.version ?? 'unknown',
      // Reported rather than assumed: without it retrieval fails at query time
      // rather than at startup, which is much harder to diagnose.
      pgvector: rows[0]?.vector != null,
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }
  }
}

/**
 * Memory available on the machine that actually loads the models, in bytes.
 *
 * Opt-in, and unset by default, because this process cannot determine it:
 *
 *  - The models usually run on another machine, and Ollama reports no memory
 *    figures, so there is nothing to read.
 *  - A loopback URL does not mean local. The macOS forwarder in scripts/
 *    presents a remote host at 127.0.0.1, which makes the URL useless as
 *    evidence.
 *  - macOS `freemem()` counts only truly free pages, not reclaimable ones. It
 *    reports 0.2 GB free on a healthy 9 GB machine, which would mark every
 *    model as too large.
 *
 * So `wont_fit` is reported only when someone has stated the figure. A state
 * that cannot be determined correctly is better left unreported than guessed:
 * telling a user to pick a smaller model when nothing is wrong sends them to
 * fix something that is not broken.
 */
function declaredInferenceMemory(): number | null {
  const raw = process.env.OCR_INFERENCE_MEMORY_BYTES
  if (!raw) return null
  const bytes = Number(raw)
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null
}

async function checkInference(
  config: ServerConfig,
): Promise<SystemReport['services']['inference']> {
  const budget = declaredInferenceMemory()
  // Any model will do to list what is installed; the listing is per host.
  const probe = new OllamaProvider({
    model: 'unused',
    baseUrl: config.ollamaBaseUrl,
    timeoutMs: 5_000,
  })

  try {
    const installed = await probe.listModels()
    return {
      ok: true,
      baseUrl: config.ollamaBaseUrl,
      models: installed
        .filter((m) => !m.name.startsWith('llamacpp:'))
        .map((m) => ({
          name: m.name,
          sizeBytes: m.sizeBytes,
          // Only answerable when inference is on this machine. See ModelInfo.
          fits: budget === null ? null : m.sizeBytes < budget,
        })),
    }
  } catch (error) {
    return {
      ok: false,
      baseUrl: config.ollamaBaseUrl,
      models: [],
      reason:
        error instanceof ProviderUnreachableError
          ? `Nothing answered at ${config.ollamaBaseUrl}`
          : error instanceof Error
            ? error.message.slice(0, 200)
            : 'unknown',
    }
  }
}

/**
 * Seven named states, each mapping to exactly one user action (FR-9.2).
 *
 * A single "unhealthy" flag would force the user to guess which of these it is,
 * and the fixes are completely different: pull a model, start a host, pick a
 * smaller one, assign one at all.
 */
function reportRole(
  role: Role,
  config: ServerConfig,
  inference: SystemReport['services']['inference'],
): RoleReport {
  const binding = config.roles[role]

  if (!binding) {
    return {
      role,
      provider: null,
      model: null,
      status: 'unconfigured',
      note: `No model assigned. Set OCR_MODEL_${role.toUpperCase()} in .env.`,
    }
  }

  const base = { role, provider: binding.provider, model: binding.model }

  if (!inference.ok) {
    return {
      ...base,
      status: 'unreachable',
      note: `The inference host is not answering. Start it, or correct OLLAMA_BASE_URL.`,
      baseUrl: inference.baseUrl,
    }
  }

  const installed = inference.models.find(
    (m) => m.name === binding.model || m.name.startsWith(`${binding.model}:`),
  )

  if (!installed) {
    // Named, with the command, and not run. The inference host belongs to
    // whoever operates it (FR-9.5, D-002).
    return {
      ...base,
      status: 'not_installed',
      note: `Not on ${inference.baseUrl}. On that machine run:  ollama pull ${binding.model}`,
    }
  }

  // Only when fit is actually known. `null` means inference is on another
  // machine whose memory this process cannot see, and reporting wont_fit on a
  // guess would send the user to fix something that is not broken.
  if (installed.fits === false) {
    const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`
    return {
      ...base,
      status: 'wont_fit',
      note: `${gb(installed.sizeBytes)} model, more than the ${gb(declaredInferenceMemory() ?? 0)} declared for the inference host. Choose a smaller one for this role.`,
    }
  }

  const requirement = ROLE_REQUIREMENT[role]
  if (requirement && installed.capabilities && !installed.capabilities[requirement]) {
    return {
      ...base,
      status: 'incapable',
      note: `This model does not support ${requirement}, which the ${role} role needs.`,
    }
  }

  return { ...base, status: 'ready', note: '' }
}

export interface ProbeResult {
  role: Role
  model: string
  /** Whether the model honoured a requested JSON schema. */
  honoursSchema: boolean
  durationMs: number
  detail: string
}

/**
 * The structured-output probe (FR-8.9).
 *
 * Vision and embedding support can be read from the host. Whether a model
 * honours a JSON schema cannot — nothing reports it — so it is measured: a
 * deliberately tiny two-field request, and whether the result validated.
 *
 * On demand only, never on the poll. It is an inference call, which is exactly
 * what a polling loop must not contain.
 */
export async function probeStructuredOutput(
  config: ServerConfig,
  role: Role,
): Promise<ProbeResult> {
  const binding = config.roles[role]
  if (!binding) throw new Error(`No model assigned to the "${role}" role`)

  const provider = new OllamaProvider({
    model: binding.model,
    baseUrl: config.ollamaBaseUrl,
    timeoutMs: TIMEOUTS[role],
  })

  const started = Date.now()
  try {
    const result = await provider.chatStructured({
      schema: ProbeSchema,
      prompt:
        'Extract the invoice number and total.\n\n' +
        '<document>\nInvoice INV-2024-0042, amount due 15750.50 INR\n</document>',
    })
    const correct = result.invoiceNumber === 'INV-2024-0042' && result.total === 15750.5
    return {
      role,
      model: binding.model,
      honoursSchema: true,
      durationMs: Date.now() - started,
      // Shape and correctness are separate results. A model can satisfy the
      // schema and still read the document wrong, and only the first of those
      // is what this probe is for.
      detail: correct
        ? 'Valid JSON, both fields correct.'
        : `Valid JSON, but values were wrong: ${JSON.stringify(result)}`,
    }
  } catch (error) {
    return {
      role,
      model: binding.model,
      honoursSchema: false,
      durationMs: Date.now() - started,
      detail: error instanceof Error ? error.message.slice(0, 300) : String(error),
    }
  }
}
