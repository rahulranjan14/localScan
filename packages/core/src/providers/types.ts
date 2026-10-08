import type { ModelCapabilities } from '@ocr/shared'
import type { z } from 'zod'

export interface ChatOptions {
  prompt: string
  system?: string
  /**
   * Defaults to 0 everywhere in this codebase. Extraction is not a creative
   * task, and in the predecessor system lowering this was the single largest
   * accuracy improvement of the project.
   */
  temperature?: number
  /**
   * Ollama's default context window truncates dense multi-page documents
   * silently -- the response looks complete and is simply missing the tail.
   */
  contextWindow?: number
  /**
   * Hard ceiling on generated tokens.
   *
   * Not an optimisation. Constrained decoding against a schema containing an
   * unbounded array lets a model that falls into a repetition loop generate
   * forever -- there is no stop condition the grammar can reach. Without this
   * the only thing that ends the request is the timeout, by which point minutes
   * are gone and the output is discarded anyway.
   */
  maxOutputTokens?: number
  signal?: AbortSignal
  /**
   * Reports what the request actually cost. Optional, but the difference
   * between "this model is slow" and "this model never stopped" is only
   * visible here (see `GenerationUsage.stoppedBecause`).
   */
  onUsage?: (usage: GenerationUsage) => void
}

export interface GenerationUsage {
  promptTokens: number | null
  outputTokens: number | null
  /**
   * `stop` means the model finished on its own. `length` means it was cut off
   * at the token ceiling, which is the signature of a runaway generation and
   * means the output is almost certainly truncated and unparseable.
   */
  stoppedBecause: 'stop' | 'length' | 'unknown'
  /** Generation only, excluding model load. */
  outputTokensPerSecond: number | null
  totalMs: number | null
  /** Cold-load cost, which dominates a first request and nothing after it. */
  loadMs: number | null
}

export interface StructuredOptions<T> extends ChatOptions {
  schema: z.ZodType<T>
}

export interface VisionOptions extends ChatOptions {
  images: Uint8Array[]
}

/**
 * One interface, every provider. A role is bound to a provider plus a model, so
 * the pipeline never knows which one it is talking to.
 */
export interface LlmProvider {
  readonly id: string
  readonly model: string

  chat(options: ChatOptions): Promise<string>
  chatStructured<T>(options: StructuredOptions<T>): Promise<T>
  vision(options: VisionOptions): Promise<string>
  embed(texts: string[]): Promise<number[][]>

  /** Cheap reachability check. Must not perform inference (FR-9.4). */
  ping(): Promise<boolean>

  capabilities(): Promise<ModelCapabilities>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Nothing accepted the connection: wrong host, wrong port, or nothing running. */
export class ProviderUnreachableError extends ProviderError {
  constructor(
    readonly baseUrl: string,
    cause?: unknown,
  ) {
    super(`Could not connect to the inference host at ${baseUrl}`, cause)
    this.name = 'ProviderUnreachableError'
  }
}

/**
 * The host accepted the connection and was still working when we gave up.
 *
 * Kept distinct from `ProviderUnreachableError` on purpose. They look alike from
 * the call site -- no response either way -- but they mean opposite things: one
 * says the machine is not there, the other says it is there and the work is
 * genuinely slow. Collapsing them sends you to check the network when what you
 * actually need is a longer timeout or a smaller request.
 */
export class ProviderTimeoutError extends ProviderError {
  constructor(
    readonly baseUrl: string,
    readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(
      `Inference host at ${baseUrl} accepted the request but did not finish within ` +
        `${Math.round(timeoutMs / 1000)}s`,
      cause,
    )
    this.name = 'ProviderTimeoutError'
  }
}

/** The host answered, but does not have the requested model. */
export class ModelNotInstalledError extends ProviderError {
  constructor(
    readonly model: string,
    readonly baseUrl: string,
  ) {
    super(`Model "${model}" is not installed on ${baseUrl}`)
    this.name = 'ModelNotInstalledError'
  }
}
