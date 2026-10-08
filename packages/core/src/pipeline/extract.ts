import type { z } from 'zod'
import type { GenerationUsage, LlmProvider } from '../providers/types.js'
import { renderPrompt, scanForInjection, type InjectionScan } from '../guards/prompt.js'

export interface ExtractInput<T> {
  provider: LlmProvider
  schema: z.ZodType<T>
  /** Markdown template containing a {{DOCUMENT}} placeholder. */
  promptTemplate: string
  text: string
  contextWindow?: number
  maxOutputTokens?: number
  signal?: AbortSignal
  onUsage?: (usage: GenerationUsage) => void
}

export type ExtractOutcome<T> =
  | { ok: true; data: T; injection: InjectionScan; durationMs: number }
  | { ok: false; reason: string; injection: InjectionScan; durationMs: number }

/**
 * Text plus a schema in, validated data or an explicit failure out.
 *
 * There is no third outcome. A result that did not validate is **not** returned
 * as partial data (FR-4.6): the caller would have no way to tell which fields
 * were trustworthy, and storing it would make an unvalidated value
 * indistinguishable from a checked one the moment it reaches the database.
 */
export async function extractStructured<T>(input: ExtractInput<T>): Promise<ExtractOutcome<T>> {
  const injection = scanForInjection(input.text)
  const prompt = renderPrompt(input.promptTemplate, input.text)
  const started = Date.now()

  try {
    const data = await input.provider.chatStructured({
      schema: input.schema,
      prompt,
      // Extraction is not a creative task. In the predecessor system this single
      // setting was the largest accuracy improvement made to the project.
      temperature: 0,
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onUsage ? { onUsage: input.onUsage } : {}),
    })
    return { ok: true, data, injection, durationMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      injection,
      durationMs: Date.now() - started,
    }
  }
}

export interface ExtractWithFallbackInput<T> extends ExtractInput<T> {
  /**
   * Tried once if the primary fails validation (FR-4.5).
   *
   * This must be a *different* model to be worth anything. Retrying the same
   * model with the same inputs at temperature 0 is a no-op -- the predecessor
   * system's "self-healing retry" was exactly that, and so never healed
   * anything.
   */
  fallbackProvider?: LlmProvider | undefined
}

export async function extractWithFallback<T>(
  input: ExtractWithFallbackInput<T>,
): Promise<ExtractOutcome<T> & { usedFallback: boolean }> {
  const first = await extractStructured(input)
  if (first.ok || !input.fallbackProvider) {
    return { ...first, usedFallback: false }
  }

  if (input.fallbackProvider.model === input.provider.model) {
    return { ...first, usedFallback: false }
  }

  const second = await extractStructured({ ...input, provider: input.fallbackProvider })
  return { ...second, usedFallback: true }
}
