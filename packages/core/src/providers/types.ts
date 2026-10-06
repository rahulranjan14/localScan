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
  signal?: AbortSignal
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

/** The provider host did not answer at all, as distinct from answering badly. */
export class ProviderUnreachableError extends ProviderError {
  constructor(
    readonly baseUrl: string,
    cause?: unknown,
  ) {
    super(`Inference host did not respond at ${baseUrl}`, cause)
    this.name = 'ProviderUnreachableError'
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
