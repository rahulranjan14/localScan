import type { ModelCapabilities, StructuredOutputTier } from '@ocr/shared'
import { z } from 'zod'
import {
  ModelNotInstalledError,
  ProviderError,
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

/** Cheap checks must stay cheap -- they run on a 30s poll (FR-9.4). */
const PING_TIMEOUT_MS = 3_000

interface OllamaGenerateResponse {
  response?: string
  error?: string
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
    const raw = result.response ?? ''

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new ProviderError(
        `Model "${this.model}" returned output that is not JSON despite a schema being requested`,
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

    const families = show.details?.families ?? []
    const declared = show.capabilities ?? []

    const capabilities: ModelCapabilities = {
      vision: families.some((f) => f === 'clip' || f === 'mllama') || declared.includes('vision'),
      embedding: declared.includes('embedding'),
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
      // A refused connection and a timeout are the same thing to the caller:
      // the host is not answering. What matters is reporting the URL tried,
      // so the user can see which machine is unreachable (FR-9.3).
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
 */
export function toOllamaJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  const { $schema: _ignored, ...rest } = jsonSchema
  return rest
}
