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
   * Default 200. Measured on a 5-page document: 150 DPI peaks at 156 MB,
   * 200 at 203 MB, 300 at 282 MB — all affordable, because the application host
   * never loads a model (D-001). 200 is a starting point to be revisited once
   * the harness can measure accuracy against it, not a tuned value.
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

const DEFAULT_DPI = 200
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
