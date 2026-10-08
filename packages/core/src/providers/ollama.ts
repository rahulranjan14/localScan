import type { ModelCapabilities, StructuredOutputTier } from '@ocr/shared'
import { z } from 'zod'
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
 * Ollama's default context window is 2048 tokens. A dense multi-page document
 * exceeds that easily, and the failure is silent: the response is well-formed
 * and simply missing everything past the cutoff. Raising the default here costs
 * memory on the inference host, which is why it is a knob rather than a constant.
 */
const DEFAULT_CONTEXT_WINDOW = 8192

/** Long enough for a cold model load on CPU, which can take tens of seconds. */
const DEFAULT_TIMEOUT_MS = 300_000

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
    const body = this.generateBody(options)
    const result = await this.post<OllamaGenerateResponse>('/api/generate', body, options.signal)
    options.onUsage?.(readUsage(result))
    return result.response ?? ''
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

    const result = await this.post<OllamaGenerateResponse>('/api/generate', body, options.signal)
    const usage = readUsage(result)
    options.onUsage?.(usage)
    const raw = result.response ?? ''

    // Hitting the ceiling means the JSON is cut mid-token. Saying so is far
    // more useful than the parse error that follows, which only reports that
    // the text is malformed and not why.
    if (usage.stoppedBecause === 'length') {
      throw new ProviderError(
        `Model "${this.model}" was still generating at the ${usage.outputTokens}-token ceiling. ` +
          `The output is truncated, so it cannot be valid JSON. This is usually a repetition ` +
          `loop rather than a document that is genuinely too large.`,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      // Include the text. "Not JSON" on its own is almost useless -- truncated
      // JSON, an empty string, a prose apology and a markdown code fence are
      // four different problems with four different fixes, and they are
      // indistinguishable without seeing what actually came back.
      throw new ProviderError(
        `Model "${this.model}" returned output that is not JSON despite a schema being ` +
          `requested (${raw.length} chars, ${usage.outputTokens ?? '?'} tokens, ` +
          `stopped: ${usage.stoppedBecause}).\n` +
          `  starts: ${JSON.stringify(raw.slice(0, 220))}\n` +
          `  ends:   ${JSON.stringify(raw.slice(-120))}`,
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
    const result = await this.post<OllamaGenerateResponse>('/api/generate', body, options.signal)
    return result.response ?? ''
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

  private generateBody(options: ChatOptions): Record<string, unknown> {
    return {
      model: this.model,
      prompt: options.prompt,
      ...(options.system ? { system: options.system } : {}),
      stream: false,
      options: {
        temperature: options.temperature ?? 0,
        num_ctx: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        num_predict: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      },
    }
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
      response = await fetch(url, { ...init, signal })
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
