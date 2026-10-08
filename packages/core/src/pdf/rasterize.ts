import { PDFiumLibrary } from '@hyzyla/pdfium'
import sharp from 'sharp'

/**
 * PDF pages to PNG, for documents with no usable text layer.
 *
 * PDFium compiled to WebAssembly, not a native canvas. The reason is isolation
 * rather than speed: `pdfjs-dist` with `@napi-rs/canvas` segfaulted on ordinary
 * documents — page 2 of a 5-page report, both pages of an invoice — and a
 * segfault cannot be caught. No try/catch and no rejected promise intercepts it;
 * the process dies and the run is lost rather than failed. WASM traps instead,
 * so a malformed page fails like any other error. With untrusted PDFs as input
 * that property is worth more than throughput. See DECISIONS.md D-006.
 */

export interface RasterizeOptions {
  /**
   * Default 150, lowered from 200 after measuring what it costs downstream.
   *
   * Memory was never the constraint — 150 DPI peaks at 156 MB and 300 at 282 MB,
   * both unremarkable, because the application host loads no model (D-001). The
   * constraint is the *vision model*, whose cost scales with image area and worse
   * than linearly, since attention over vision tokens is quadratic:
   *
   *   110 DPI   934×1210  (1.1 MP)   granite3.2-vision: 30.8s
   *   200 DPI  1700×2200  (3.7 MP)   granite3.2-vision: >10 min
   *
   * 3.3× the pixels cost far more than 3.3× the time, and a vision model
   * downscales its input internally anyway — so the extra pixels are paid for and
   * then discarded. 200 was chosen from print-quality intuition, which is the
   * wrong frame entirely.
   *
   * 150 is a compromise pending accuracy measurement across DPI in Phase 3. The
   * evidence so far suggests transcription errors are model-bound rather than
   * resolution-bound: at 110 DPI gemma3:12b was perfect on a document where
   * granite3.2-vision made three mistakes (see BENCHMARKS.md run 001).
   */
  dpi?: number
  /** 1-based page numbers. Omitted means every page. */
  pages?: number[]
  /** Guards against a document that is large and dense at once. */
  maxPages?: number
}

export interface RasterizedPage {
  /** 1-based, matching what a reader sees, because citations quote it. */
  page: number
  png: Uint8Array
  width: number
  height: number
}

const DEFAULT_DPI = 150
const DEFAULT_MAX_PAGES = 50

/** PDF user space is 72 units to the inch, so this is the scale factor. */
const PDF_UNITS_PER_INCH = 72

export async function rasterizePdf(
  bytes: Uint8Array,
  options: RasterizeOptions = {},
): Promise<RasterizedPage[]> {
  const dpi = options.dpi ?? DEFAULT_DPI
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES

  const library = await PDFiumLibrary.init()
  try {
    const document = await library.loadDocument(Buffer.from(bytes))
    try {
      const wanted = options.pages ? new Set(options.pages) : null
      const output: RasterizedPage[] = []

      for (const page of document.pages()) {
        const pageNumber = page.number + 1
        if (wanted && !wanted.has(pageNumber)) continue
        if (output.length >= maxPages) break

        const rendered = await page.render({
          scale: dpi / PDF_UNITS_PER_INCH,
          // PDFium hands back raw RGBA; sharp does the PNG encoding. Keeping the
          // encoder separate means the format can change without touching the
          // renderer -- relevant because some vision models prefer JPEG.
          render: ({ data, width, height }) =>
            sharp(data, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer(),
        })

        output.push({
          page: pageNumber,
          png: new Uint8Array(rendered.data),
          width: rendered.width,
          height: rendered.height,
        })
      }

      return output
    } finally {
      document.destroy()
    }
  } finally {
    // WASM holds its heap outside the JS one, so the garbage collector will not
    // reclaim it. Not releasing here leaks for the process lifetime.
    library.destroy()
  }
}
