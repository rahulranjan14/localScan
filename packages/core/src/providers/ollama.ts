import type { ModelCapabilities, StructuredOutputTier } from '@ocr/shared'
import { z } from 'zod'
import { Agent, fetch as undiciFetch } from 'undici'
import { repairJson } from '../pipeline/repair.js'
import {
  type GenerationUsage,
  ModelNotInstalledError,
  ProviderError,
  ProviderTimeoutError,
  ProviderUnreachableError,
  type ChatOptions,
  type LlmProvider,
  type StructuredOptions,
  type VisionOptions,
} from './types.js'

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

/**
 * Undici's own timeouts, disabled, so this class is the only thing that decides
 * when a request has waited too long.
 *
 * Node's built-in fetch is undici, and it enforces **two** 300-second limits:
 * `headersTimeout` before response headers arrive, and `bodyTimeout` between body
 * chunks. Both are invisible from the call site and both report as a connection
 * failure rather than a timeout.
 *
 * Streaming alone was not enough. It fixed the first -- headers arrive at once --
 * and then `bodyTimeout` killed the same request at 303s, because a vision model
 * spends minutes encoding the page image before it emits a single token. There is
 * nothing to stream during that silence.
 *
 * Two 300s ceilings had to be removed before a 30-minute timeout meant anything.
 * `AbortSignal.timeout` is now the single authority, which is also simply correct:
 * one timeout, set per role, visible where it is configured.
 */
const dispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  // Connecting is the one thing that *should* fail fast: a host that will not
  // accept a TCP connection in ten seconds is not going to.
  connectTimeout: 10_000,
})

/**
 * Ollama's default context window is 2048 tokens. A dense multi-page document
 * exceeds that easily, and the failure is silent: the response is well-formed
 * and simply missing everything past the cutoff. Raising the default here costs
 * memory on the inference host, which is why it is a knob rather than a constant.
 */
const DEFAULT_CONTEXT_WINDOW = 8192

/**
 * Thirty minutes, and that is not a safety margin — it is the measured cost.
 *
 * A vision model on CPU spends most of its time encoding the page image before
 * emitting a single token. The predecessor system took 10-15 minutes per document
 * and worked. An earlier 300s default here produced two timeouts that were then
 * misread as the model being incapable, when the request simply had not finished.
 *
 * A timeout should answer "has this stopped making progress", not "is this slower
 * than I would like". Those are different questions and only the first has a
 * right answer in a constant. Per-role values are in TIMEOUTS below; a caller
 * that knows better passes its own.
 */
const DEFAULT_TIMEOUT_MS = 1_800_000

/**
 * Per-role ceilings, because one number cannot serve all five.
 *
 * Vision on CPU and a two-field classification differ by two orders of
 * magnitude. A single global value is wrong in both directions at once: high
 * enough for OCR means a wedged classification call hangs for half an hour, and
 * low enough for classification means OCR is killed mid-work.
 */
export const TIMEOUTS = {
  /** Image encoding dominates, and on CPU it dominates heavily. */
  ocr: 1_800_000,
  /** A full document schema, up to ~2000 tokens of output. */
  extract: 1_200_000,
  fallback: 1_200_000,
  /** Short work, but a cold model load alone can take minutes on CPU. */
  classify: 900_000,
  /** No generation, yet a first call still pays the model load. */
  embed: 900_000,
} as const satisfies Record<string, number>

/**
 * Nothing here is below ten minutes, deliberately.
 *
 * Earlier values of 5 and 2 minutes were set from how long the work *ought* to
 * take. That is the wrong question. A timeout exists to detect that something has
 * stopped making progress, and on CPU inference the honest answer to "how long
 * might this legitimately take" is minutes-to-tens-of-minutes for every role,
 * because a cold model load is paid before the first token regardless of how
 * small the request is.
 *
 * Setting these tight produced exactly one outcome in practice: work that was
 * progressing normally got killed, and the result was misread as the model being
 * incapable. A generous ceiling costs nothing when the work succeeds, and the
 * failure it is supposed to catch -- a wedged request -- is just as detectable at
 * twenty minutes as at five.
 *
 * `ping` is the one exception and is not in this table: it is a liveness check on
 * a 30-second poll, performs no inference, and must fail fast or the health
 * indicator stalls and polls pile up behind it.
 */

/**
 * Generous for a filled invoice (a few hundred tokens) and still a hard stop.
 *
 * The failure this prevents is specific: a schema with an unbounded array gives
 * a repetition loop nowhere to terminate, so the model emits line items until
 * something external intervenes. Without a cap that something is the timeout.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 2048

/** Cheap checks must stay cheap -- they run on a 30s poll (FR-9.4). */
const PING_TIMEOUT_MS = 3_000

interface OllamaGenerateResponse {
  response?: string
  error?: string
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  eval_duration?: number
  load_duration?: number
  total_duration?: number
}

/** Ollama reports durations in nanoseconds. */
function nsToMs(ns: number | undefined): number | null {
  return typeof ns === 'number' ? Math.round(ns / 1e6) : null
}

function readUsage(r: OllamaGenerateResponse): GenerationUsage {
  const evalMs = nsToMs(r.eval_duration)
  const outputTokens = r.eval_count ?? null
  return {
    promptTokens: r.prompt_eval_count ?? null,
    outputTokens,
    stoppedBecause:
      r.done_reason === 'stop' ? 'stop' : r.done_reason === 'length' ? 'length' : 'unknown',
    outputTokensPerSecond:
      outputTokens !== null && evalMs !== null && evalMs > 0
        ? Math.round((outputTokens / evalMs) * 1000 * 10) / 10
        : null,
    totalMs: nsToMs(r.total_duration),
    loadMs: nsToMs(r.load_duration),
  }
}

interface OllamaTagsResponse {
  models?: Array<{ name: string; size: number; details?: { families?: string[] } }>
}

interface OllamaShowResponse {
  details?: { families?: string[] | null }
  capabilities?: string[]
  error?: string
}

export interface OllamaProviderOptions {
  model: string
  /** Inference normally lives on another machine here (FR-8.3). */
  baseUrl?: string | null
  timeoutMs?: number
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama'
  readonly model: string
  readonly baseUrl: string

  private readonly timeoutMs: number
  private capabilitiesCache: ModelCapabilities | null = null

  constructor(options: OllamaProviderOptions) {
    this.model = options.model
    this.baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async chat(options: ChatOptions): Promise<string> {
    const { text } = await this.generate(this.generateBody(options), options)
    return text
  }

  /**
   * Constrained generation. Ollama takes a JSON Schema in `format` and enforces
   * it during decoding, so the model cannot emit a shape that violates it.
   *
   * It still cannot be trusted to produce *correct* values, so the result is
   * validated against the Zod schema afterwards rather than cast.
   */
  async chatStructured<T>(options: StructuredOptions<T>): Promise<T> {
    const { schema, ...rest } = options
    const body = {
      ...this.generateBody(rest),
      format: toOllamaJsonSchema(schema),
    }

    const { text: raw, usage } = await this.generate(body, options)

    let parsed: unknown
    try {
      // Repair before giving up (FR-4.4). Attempted even when the generation hit
      // the token ceiling, which is safe here for a specific reason: every
      // model-facing field is required (D-005), so a truncated object cannot
      // satisfy the schema. Zod is the backstop, which means repair can be
      // permissive without risking a partial result being accepted as complete.
      const repaired = repairJson(raw)
      if (repaired.applied.length > 0) {
        options.onRepair?.(repaired.applied, usage.stoppedBecause)
      }
      parsed = repaired.value
    } catch (cause) {
      // Include the text. "Not JSON" on its own is almost useless -- truncated
      // JSON, an empty string, a prose apology and a markdown code fence are
      // four different problems with four different fixes, and they are
      // indistinguishable without seeing what actually came back.
      throw new ProviderError(
        `Model "${this.model}" returned output that is not JSON despite a schema being ` +
          `requested (${raw.length} chars, ${usage.outputTokens ?? '?'} tokens, ` +
          `stopped: ${usage.stoppedBecause}).` +
          (usage.stoppedBecause === 'length'
            ? ` It was still generating at the token ceiling, which usually means a repetition ` +
              `loop rather than a document that is genuinely too large.`
            : '') +
          `\n  starts: ${JSON.stringify(raw.slice(0, 220))}` +
          `\n  ends:   ${JSON.stringify(raw.slice(-120))}`,
        cause,
      )
    }

    return schema.parse(parsed)
  }

  async vision(options: VisionOptions): Promise<string> {
    const { images, ...rest } = options
    const body = {
      ...this.generateBody(rest),
      images: images.map((image) => Buffer.from(image).toString('base64')),
    }
    const { text } = await this.generate(body, options)
    return text
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await this.post<{ embeddings?: number[][] }>('/api/embed', {
      model: this.model,
      input: texts,
    })
    if (!result.embeddings) {
      throw new ProviderError(`Model "${this.model}" returned no embeddings`)
    }
    return result.embeddings
  }

  async ping(): Promise<boolean> {
    try {
      await this.fetchJson<OllamaTagsResponse>('/api/tags', { method: 'GET' }, PING_TIMEOUT_MS)
      return true
    } catch {
      return false
    }
  }

  async listModels(): Promise<Array<{ name: string; sizeBytes: number }>> {
    const result = await this.fetchJson<OllamaTagsResponse>(
      '/api/tags',
      { method: 'GET' },
      PING_TIMEOUT_MS,
    )
    return (result.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size }))
  }

  /**
   * Vision and embedding support are reported by the host and can simply be
   * read. Structured-output reliability is not reported by anything, so it is
   * left at the pessimistic default here and established by probe elsewhere
   * (FR-8.9).
   */
  async capabilities(): Promise<ModelCapabilities> {
    if (this.capabilitiesCache) return this.capabilitiesCache

    const show = await this.post<OllamaShowResponse>('/api/show', { model: this.model })
    if (show.error) {
      throw new ModelNotInstalledError(this.model, this.baseUrl)
    }

    const declared = show.capabilities ?? []
    const families = show.details?.families ?? []

    const capabilities: ModelCapabilities = {
      // `capabilities` is authoritative; `families` is only a fallback for hosts
      // too old to report it.
      //
      // The families heuristic -- "a vision model's families contains clip or
      // mllama" -- is widely repeated and wrong. qwen2.5vl:3b reports
      // families ['qwen25vl'] with no clip at all, while its capabilities array
      // says vision. Trusting families alone silently excludes that model from
      // the ocr role, and the symptom is a dropdown that is simply missing an
      // option rather than any error.
      vision: declared.includes('vision') || families.some((f) => f === 'clip' || f === 'mllama'),
      embedding: declared.includes('embedding') || families.some((f) => f.endsWith('bert')),
      // Not reported by anything. Established by probe and cached (FR-8.9).
      structuredOutput: 'loose' satisfies StructuredOutputTier,
    }

    this.capabilitiesCache = capabilities
    return capabilities
  }

  /**
   * Every generation goes through here, and it streams.
   *
   * Streaming is not for progress -- it is the only way the request survives.
   * Node's built-in fetch is undici, whose `headersTimeout` defaults to **300
   * seconds**, and with `stream: false` Ollama sends no response headers until
   * the whole generation is finished. So any request taking over five minutes
   * was aborted by the HTTP client no matter what timeout this class asked for,
   * and it surfaced as a *connection* error rather than a timeout -- which is
   * what made it look like the inference host had gone away.
   *
   * Streaming fixes both halves: headers arrive immediately, and the chunks that
   * follow keep undici's body timer alive for as long as the model is working.
   * The progress callback is a side benefit.
   */
  private async generate(
    body: Record<string, unknown>,
    options: Pick<ChatOptions, 'signal' | 'onUsage' | 'onProgress'>,
  ): Promise<{ text: string; usage: GenerationUsage }> {
    const response = await this.openStream({ ...body, stream: true }, options.signal)

    let text = ''
    let final: OllamaGenerateResponse | null = null

    for await (const chunk of readNdjson<OllamaGenerateResponse>(response)) {
      if (chunk.error) throw new ProviderError(`Ollama: ${chunk.error}`)
      if (chunk.response) {
        text += chunk.response
        options.onProgress?.(text.length)
      }
      // The last object carries the counts and the stop reason; the rest carry
      // only a token, so stats must be taken from the final one.
      if (chunk.done) final = chunk
    }

    const usage = readUsage(final ?? {})
    options.onUsage?.(usage)
    return { text, usage }
  }

  private generateBody(options: ChatOptions): Record<string, unknown> {
    return {
      model: this.model,
      prompt: options.prompt,
      ...(options.system ? { system: options.system } : {}),
      options: {
        temperature: options.temperature ?? 0,
        num_ctx: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        num_predict: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      },
    }
  }

  /**
   * Opens a streaming POST and hands back the response unread.
   *
   * Separate from `fetchJson` because that one awaits the whole body, which is
   * exactly the behaviour being avoided here.
   */
  private async openStream(body: unknown, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/api/generate`
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    let response: Response
    try {
      response = (await undiciFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
        dispatcher,
      })) as unknown as Response
    } catch (cause) {
      if (timeout.aborted) throw new ProviderTimeoutError(this.baseUrl, this.timeoutMs, cause)
      throw new ProviderUnreachableError(this.baseUrl, cause)
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      if (response.status === 404) throw new ModelNotInstalledError(this.model, this.baseUrl)
      throw new ProviderError(
        `Ollama responded ${response.status} for /api/generate: ${detail.slice(0, 200)}`,
      )
    }

    if (!response.body) throw new ProviderError('Ollama returned no response body')
    return response
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.fetchJson<T>(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
      this.timeoutMs,
    )
  }

  private async fetchJson<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout

    let response: Response
    try {
      response = (await undiciFetch(url, {
        ...(init as unknown as Parameters<typeof undiciFetch>[1]),
        signal,
        dispatcher,
      })) as unknown as Response
    } catch (cause) {
      // Which of these it is determines what the user should do, so they must
      // not be collapsed: a timeout means the host is working and too slow, an
      // unreachable host means it is not there at all (FR-9.3).
      if (timeout.aborted) {
        throw new ProviderTimeoutError(this.baseUrl, timeoutMs, cause)
      }
      throw new ProviderUnreachableError(this.baseUrl, cause)
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      if (response.status === 404) {
        throw new ModelNotInstalledError(this.model, this.baseUrl)
      }
      throw new ProviderError(`Ollama responded ${response.status} for ${path}: ${detail.slice(0, 200)}`)
    }

    return (await response.json()) as T
  }
}

/**
 * Ollama accepts a JSON Schema object. Zod emits one with a `$schema` key that
 * Ollama does not expect, so it is removed.
 *
 * `io: 'output'` rather than `'input'`, and the difference is not cosmetic. On
 * the input side a field with a default is *optional*, so the generated grammar
 * lets the model omit it — and a model asked for 25 fields it may skip will
 * answer the easy ones and stop. On the output side those fields are required,
 * so every key must be emitted with either a value or an explicit null.
 *
 * Requiring the key is what makes the model look for the value. Observed
 * directly: the input-side schema produced an invoice with vendor, buyer and
 * extras filled in and no invoice number, date, total or line items at all.
 */
export function toOllamaJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>
  const { $schema: _ignored, ...rest } = jsonSchema
  return rest
}

/**
 * Yields each JSON object from an NDJSON stream.
 *
 * Buffers partial lines, because a chunk boundary falls wherever TCP decides and
 * routinely lands mid-object. Parsing per chunk rather than per line produces
 * intermittent syntax errors on long responses -- the failure appears only under
 * load, which is the worst way to find it.
 */
async function* readNdjson<T>(response: Response): AsyncGenerator<T> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield JSON.parse(line) as T
      }
    }

    const last = buffer.trim()
    if (last) yield JSON.parse(last) as T
  } finally {
    // Releasing matters on an early exit -- an abandoned reader holds the socket.
    reader.releaseLock()
  }
}
