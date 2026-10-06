import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

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
