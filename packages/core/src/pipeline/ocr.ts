import type { PageText } from '../pdf/textLayer.js'
import type { RasterizedPage } from '../pdf/rasterize.js'
import type { LlmProvider } from '../providers/types.js'

/**
 * Vision transcription, for documents with no usable text layer.
 *
 * Reached only when `hasUsableTextLayer` is false. Most invoices are digital and
 * take the free path; this is the expensive fallback, not the default (FR-2.2).
 */

export interface OcrInput {
  provider: LlmProvider
  /** `_ocr.md`, external so it can be tuned without a rebuild (FR-4.2). */
  promptTemplate: string
  pages: RasterizedPage[]
  /**
   * A full page of dense text is well over 1000 tokens, and truncation here is
   * silent -- the transcription simply stops and extraction never knows there was
   * more page.
   */
  maxTokensPerPage?: number
  signal?: AbortSignal
  /** Called as each page finishes, because a multi-page document takes minutes. */
  onPage?: (page: number, of: number, durationMs: number) => void
}

export interface OcrResult {
  pages: PageText[]
  /** Pages the model failed on. Kept rather than thrown so the rest survive. */
  failures: Array<{ page: number; reason: string }>
}

const DEFAULT_MAX_TOKENS_PER_PAGE = 4096

/**
 * One request per page, not one request with every image.
 *
 * Three reasons, in order of importance: a failure costs one page rather than the
 * document; peak memory stays at one image; and the page number stays attached to
 * its text, which page citations depend on. Batching would be faster and would
 * lose all three.
 */
export async function ocrPages(input: OcrInput): Promise<OcrResult> {
  const pages: PageText[] = []
  const failures: Array<{ page: number; reason: string }> = []

  for (const [index, page] of input.pages.entries()) {
    const started = Date.now()
    try {
      const text = await input.provider.vision({
        prompt: input.promptTemplate,
        images: [page.png],
        temperature: 0,
        maxOutputTokens: input.maxTokensPerPage ?? DEFAULT_MAX_TOKENS_PER_PAGE,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      pages.push({ page: page.page, text: text.trim() })
    } catch (error) {
      failures.push({
        page: page.page,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    input.onPage?.(index + 1, input.pages.length, Date.now() - started)
  }

  return { pages, failures }
}
