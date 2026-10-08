import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { TextMode } from '@ocr/shared'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/**
 * pdfjs loads metrics for the 14 standard PDF fonts from disk, and warns on
 * every document when it cannot find them. We only ever read text, so the
 * metrics change nothing -- but the warning is per-document noise that would
 * train everyone to ignore this script's output.
 *
 * Despite the name this must be a filesystem path, not a file:// URL. Under
 * Node pdfjs reads it with fs rather than fetch, and a URL silently fails to
 * resolve -- producing exactly the warning it is supposed to prevent.
 */
const standardFontDataUrl = (() => {
  const require = createRequire(import.meta.url)
  const pkg = require.resolve('pdfjs-dist/package.json')
  return join(dirname(pkg), 'standard_fonts/')
})()

/**
 * Most invoices are generated digitally and already carry their text. Reading it
 * costs nothing and is exact, where a vision model costs minutes and guesses.
 *
 * So the pipeline asks this question first, and only rasterises when the answer
 * is no (FR-2.1, FR-2.2). The predecessor system rendered every page at 300 DPI
 * regardless, which is why it was slow on documents that needed no model at all.
 */

export interface PageText {
  /** 1-based, matching what a reader sees, because citations quote it (FR-6.5). */
  page: number
  text: string
}

export interface TextLayerResult {
  pages: PageText[]
  /** Pages carrying enough text to be worth using, as opposed to stray labels. */
  pagesWithText: number
  totalPages: number
}

/**
 * A scanned page is not always empty of text: a scanner may leave a header, a
 * stamp, or a few characters of noise. So "has a text layer" cannot mean "has
 * any text at all" -- it has to mean enough text that extracting it beats
 * looking at the pixels.
 */
const MIN_CHARS_PER_PAGE = 100

export async function readTextLayer(bytes: Uint8Array): Promise<TextLayerResult> {
  // pdfjs transfers ownership of the buffer it is handed and leaves the caller's
  // copy detached. The caller still needs these bytes -- to hash, to store, and
  // possibly to rasterise -- so it gets a copy.
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    // No network fetches for fonts or colour profiles: this runs offline, and a
    // document should not be able to cause an outbound request.
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl,
  }).promise

  try {
    const pages: PageText[] = []

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim()
        pages.push({ page: pageNumber, text })
      } finally {
        page.cleanup()
      }
    }

    return {
      pages,
      pagesWithText: pages.filter((p) => p.text.length >= MIN_CHARS_PER_PAGE).length,
      totalPages: doc.numPages,
    }
  } finally {
    await doc.destroy()
  }
}

/**
 * True when the text layer is good enough to skip the vision model entirely.
 *
 * The threshold is a majority of pages rather than all of them: a digital
 * invoice with one scanned annexe should still take the cheap path for the part
 * that has text. Mixed documents are handled per page later; this is the
 * document-level decision.
 */
export function hasUsableTextLayer(result: TextLayerResult): boolean {
  if (result.totalPages === 0) return false
  return result.pagesWithText / result.totalPages >= 0.5
}

/** Joins pages with markers, so a later citation can name the page (FR-6.1). */
export function joinPages(pages: PageText[]): string {
  return pages.map((p) => `--- page ${p.page} ---\n${p.text}`).join('\n\n')
}

/**
 * Decides where a document's text should come from, given the configured mode.
 *
 * Pulled out of the ingestion service so it can be tested without a database or
 * an inference host. The logic is three lines and the consequences are minutes of
 * compute per document, which is exactly the ratio that deserves a unit test.
 */
export function shouldUseTextLayer(mode: TextMode, result: TextLayerResult): boolean {
  switch (mode) {
    // Any text at all, and never call a vision model.
    case 'prefer_text':
      return result.pages.some((page) => page.text.length > 0)
    // Rasterise and transcribe regardless of what the file already contains.
    case 'always_vlm':
      return false
    case 'auto':
      return hasUsableTextLayer(result)
  }
}
