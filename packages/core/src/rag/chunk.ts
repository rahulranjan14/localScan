import type { PageText } from '../pdf/textLayer.js'

/**
 * Splits document text into chunks that never cross a page boundary.
 *
 * Page-aware is the whole design. An answer has to be able to say *which page* it
 * came from (FR-6.5), and a chunk spanning pages 3 and 4 can cite neither
 * honestly. The cost is some small chunks at page ends; the alternative is
 * citations that are approximately true, which is worse than none — a reader who
 * checks page 3 and finds nothing stops trusting every other citation.
 */

export interface Chunk {
  /** 1-based, as a reader counts pages. */
  page: number
  /** Position within the page, for stable ordering and deduplication. */
  index: number
  content: string
}

export interface ChunkOptions {
  /**
   * Characters, not tokens. Tokenising to split text would mean loading a
   * tokeniser to answer a question about punctuation, and the embedding model
   * has its own limit anyway — this only has to stay comfortably under it.
   */
  targetSize?: number
  /**
   * Repeated tail of the previous chunk.
   *
   * Overlap exists because a fact can straddle a split: "the total payable is" at
   * the end of one chunk and "2,050" at the start of the next retrieves badly for
   * either. The right value is a measured question, and this default is a
   * starting point rather than a tuned one.
   */
  overlap?: number
  /** Below this a chunk is dropped: a page number or a stray header retrieves noise. */
  minSize?: number
}

const DEFAULT_TARGET_SIZE = 1200
const DEFAULT_OVERLAP = 150
const DEFAULT_MIN_SIZE = 80

/**
 * Prefers to split at a paragraph break, then a sentence end, then a space.
 *
 * Splitting mid-word produces a chunk beginning with a fragment, which embeds
 * poorly and reads badly when shown as a citation. Falling back through
 * progressively weaker boundaries keeps that rare without ever failing to split.
 */
function findBreak(text: string, from: number, to: number): number {
  const window = text.slice(from, to)

  const paragraph = window.lastIndexOf('\n\n')
  if (paragraph > window.length * 0.4) return from + paragraph + 2

  const sentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('.\n'),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
  )
  if (sentence > window.length * 0.4) return from + sentence + 2

  const newline = window.lastIndexOf('\n')
  if (newline > window.length * 0.4) return from + newline + 1

  const space = window.lastIndexOf(' ')
  if (space > window.length * 0.4) return from + space + 1

  return to
}

export function chunkPage(page: PageText, options: ChunkOptions = {}): Chunk[] {
  const targetSize = options.targetSize ?? DEFAULT_TARGET_SIZE
  const overlap = options.overlap ?? DEFAULT_OVERLAP
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE

  const text = page.text.trim()
  if (text.length === 0) return []

  // A short page is one chunk, even below minSize. The threshold is for
  // fragments left over from splitting, not for pages that are genuinely brief --
  // dropping a one-line page would silently make it unanswerable.
  if (text.length <= targetSize) {
    return [{ page: page.page, index: 0, content: text }]
  }

  const chunks: Chunk[] = []
  let start = 0

  while (start < text.length) {
    const hardEnd = Math.min(start + targetSize, text.length)
    const end = hardEnd === text.length ? hardEnd : findBreak(text, start, hardEnd)

    const content = text.slice(start, end).trim()
    if (content.length >= minSize || chunks.length === 0) {
      chunks.push({ page: page.page, index: chunks.length, content })
    }

    if (end >= text.length) break
    // Overlap backwards from the break, never past the previous start, which
    // would loop forever on text with no usable break points.
    start = Math.max(end - overlap, start + 1)
  }

  return chunks
}

export function chunkDocument(pages: PageText[], options: ChunkOptions = {}): Chunk[] {
  return pages.flatMap((page) => chunkPage(page, options))
}

/**
 * Recovers pages from text joined by `joinPages`.
 *
 * The pipeline stores one `raw_text` string, so by indexing time the page
 * structure survives only as the markers written into it. Parsing them back is
 * uglier than carrying pages through — and the alternative was changing the
 * stored shape, which would have meant a migration for every existing document.
 */
export function splitJoinedPages(rawText: string): PageText[] {
  const parts = rawText.split(/^--- page (\d+) ---$/m)
  if (parts.length < 3) {
    return [{ page: 1, text: rawText.trim() }]
  }

  const pages: PageText[] = []
  for (let i = 1; i < parts.length; i += 2) {
    const page = Number(parts[i])
    const text = (parts[i + 1] ?? '').trim()
    if (Number.isFinite(page) && text.length > 0) pages.push({ page, text })
  }
  return pages.length > 0 ? pages : [{ page: 1, text: rawText.trim() }]
}
