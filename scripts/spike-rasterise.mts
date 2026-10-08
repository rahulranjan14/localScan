/**
 * Rasterisation spike: which library, and at what DPI.
 *
 *   npm run spike:rasterise -- <file.pdf> [--dpi 150,200,300]
 *
 * This is committed rather than thrown away because the numbers it produced are
 * cited in DECISIONS.md, and a decision justified by measurements nobody can
 * reproduce is just an assertion with numbers in it.
 *
 * Two things are measured, and the second is the one that matters:
 *
 *   1. Image quality -- can a vision model actually read the output.
 *   2. **Peak resident memory on a multi-page document.** Rasterising at 300 DPI
 *      is the memory ceiling of the whole pipeline. The predecessor Python system
 *      hit it and responded by disabling Pillow's decompression-bomb guard
 *      (Image.MAX_IMAGE_PIXELS = None), which removes the warning rather than the
 *      problem.
 *
 * node-poppler is deliberately not a candidate: it needs a poppler binary
 * installed outside npm, which makes setup heavier for a tool whose selling point
 * is running on your own machine with no ceremony.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dpi: { type: 'string', default: '150,200,300' },
    out: { type: 'string', default: 'spike-out' },
  },
})

const file = positionals[0]
if (!file) {
  console.error('usage: npm run spike:rasterise -- <file.pdf> [--dpi 150,200,300]')
  process.exit(2)
}

const dpis = values.dpi!.split(',').map(Number)
const outDir = values.out!
await mkdir(outDir, { recursive: true })

const bytes = new Uint8Array(await readFile(file))
console.log(`\n${basename(file)} — ${(bytes.byteLength / 1024).toFixed(0)} KB\n`)

/** RSS sampled while work runs; a before/after pair misses the actual peak. */
function trackPeakRss(): { stop: () => number } {
  let peak = process.memoryUsage().rss
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss
    if (rss > peak) peak = rss
  }, 25)
  return {
    stop: () => {
      clearInterval(timer)
      return peak
    },
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`

// ── Candidate A: pdfjs-dist + @napi-rs/canvas ───────────────────────────────
// More code, but full control over scale, and pages are released individually.
async function viaCanvas(dpi: number) {
  const canvasLib = await import('@napi-rs/canvas')

  // pdfjs builds each glyph as a Path2D and reads the constructor off the global
  // scope, which does not exist in Node. Without these three it fails inside
  // paintChar with "Value is none of these types String, Path" -- an error that
  // names neither pdfjs nor the missing global.
  for (const name of ['Path2D', 'DOMMatrix', 'ImageData'] as const) {
    if (!(name in globalThis)) {
      ;(globalThis as Record<string, unknown>)[name] = canvasLib[name]
    }
  }

  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const { createCanvas } = canvasLib

  const require = createRequire(import.meta.url)
  const standardFontDataUrl = join(
    dirname(require.resolve('pdfjs-dist/package.json')),
    'standard_fonts/',
  )

  const scale = dpi / 72 // PDF user space is 72 units per inch
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl,
    isEvalSupported: false,
  }).promise

  const sizes: number[] = []
  let dimensions = ''

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    if (n === 1) dimensions = `${canvas.width}×${canvas.height}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvasContext: canvas.getContext('2d') as any, viewport }).promise
    const png = canvas.toBuffer('image/png')
    sizes.push(png.byteLength)
    if (n === 1) await writeFile(join(outDir, `canvas-${dpi}dpi-p1.png`), png)
    page.cleanup()
  }

  await doc.destroy()
  return { pages: doc.numPages, sizes, dimensions }
}

// ── Candidate B: pdf-to-img ─────────────────────────────────────────────────
// Less code; an async iterator over pages, scale instead of DPI.
async function viaPdfToImg(dpi: number) {
  const { pdf } = await import('pdf-to-img')
  const document = await pdf(Buffer.from(bytes), { scale: dpi / 72 })

  const sizes: number[] = []
  let dimensions = ''
  let n = 0
  for await (const page of document) {
    n++
    sizes.push(page.byteLength)
    if (n === 1) {
      await writeFile(join(outDir, `pdftoimg-${dpi}dpi-p1.png`), page)
      dimensions = '(not reported)'
    }
  }
  return { pages: n, sizes, dimensions }
}

const results: Array<Record<string, string | number>> = []

for (const dpi of dpis) {
  for (const [name, fn] of [
    ['pdfjs+canvas', viaCanvas],
    ['pdf-to-img', viaPdfToImg],
  ] as const) {
    if (global.gc) global.gc()
    const tracker = trackPeakRss()
    const started = Date.now()
    try {
      const { pages, sizes, dimensions } = await fn(dpi)
      const peak = tracker.stop()
      const total = sizes.reduce((a, b) => a + b, 0)
      results.push({
        library: name,
        dpi,
        pages,
        'peak RSS': mb(peak),
        'total PNG': mb(total),
        'largest page': mb(Math.max(...sizes)),
        'page 1': dimensions,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
      })
    } catch (error) {
      tracker.stop()
      results.push({
        library: name,
        dpi,
        pages: 0,
        'peak RSS': '—',
        'total PNG': '—',
        'largest page': '—',
        'page 1': '—',
        seconds: '—',
        error: error instanceof Error ? error.message.slice(0, 60) : String(error),
      })
    }
  }
}

console.table(results)
console.log(`\nPage-1 images written to ${outDir}/ — look at them before trusting any number above.\n`)
