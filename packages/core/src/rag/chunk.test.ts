import { describe, expect, it } from 'vitest'
import { chunkDocument, chunkPage, splitJoinedPages } from './chunk.js'

const sentences = (n: number) =>
  Array.from({ length: n }, (_, i) => `This is sentence number ${i} on the page.`).join(' ')

describe('chunkPage', () => {
  it('returns a short page as a single chunk', () => {
    const chunks = chunkPage({ page: 3, text: 'Invoice INV-7, total 2500.' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.page).toBe(3)
  })

  it('returns nothing for an empty page', () => {
    expect(chunkPage({ page: 1, text: '   ' })).toEqual([])
  })

  it('keeps a brief page even though it is below minSize', () => {
    // The minimum is for fragments left over from splitting, not for pages that
    // are genuinely short. Dropping one would make it silently unanswerable.
    const chunks = chunkPage({ page: 1, text: 'Page 4' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).toBe('Page 4')
  })

  it('splits a long page into multiple chunks', () => {
    const chunks = chunkPage({ page: 1, text: sentences(200) }, { targetSize: 300 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('never produces a chunk spanning two pages', () => {
    // The property citations depend on: a chunk belongs to exactly one page.
    const chunks = chunkDocument(
      [
        { page: 1, text: sentences(100) },
        { page: 2, text: sentences(100) },
      ],
      { targetSize: 300 },
    )
    expect(new Set(chunks.map((c) => c.page))).toEqual(new Set([1, 2]))
    for (const chunk of chunks) {
      expect(Number.isInteger(chunk.page)).toBe(true)
    }
  })

  it('prefers to break at a sentence boundary rather than mid-word', () => {
    const chunks = chunkPage({ page: 1, text: sentences(50) }, { targetSize: 200, overlap: 0 })
    // A chunk starting mid-word embeds poorly and reads badly as a citation.
    for (const chunk of chunks.slice(1)) {
      expect(chunk.content).not.toMatch(/^[a-z]{1,3}\b(?!\w)/)
    }
  })

  it('overlaps consecutive chunks so a fact across a split is still findable', () => {
    const text = sentences(60)
    const withOverlap = chunkPage({ page: 1, text }, { targetSize: 300, overlap: 100 })
    const without = chunkPage({ page: 1, text }, { targetSize: 300, overlap: 0 })
    expect(withOverlap.length).toBeGreaterThanOrEqual(without.length)
  })

  it('terminates on text with no break points at all', () => {
    // A long unbroken string -- a base64 blob, a hash -- must not loop forever.
    const chunks = chunkPage({ page: 1, text: 'x'.repeat(5000) }, { targetSize: 300 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.length).toBeLessThan(100)
  })

  it('numbers chunks within a page from zero', () => {
    const chunks = chunkPage({ page: 7, text: sentences(100) }, { targetSize: 300 })
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
  })
})

describe('splitJoinedPages', () => {
  it('recovers pages from joined text', () => {
    const joined = '--- page 1 ---\nFirst page text\n\n--- page 2 ---\nSecond page text'
    expect(splitJoinedPages(joined)).toEqual([
      { page: 1, text: 'First page text' },
      { page: 2, text: 'Second page text' },
    ])
  })

  it('treats text with no markers as a single page', () => {
    expect(splitJoinedPages('Just some text')).toEqual([{ page: 1, text: 'Just some text' }])
  })

  it('preserves the real page numbers when a subset was processed', () => {
    // Page selection means stored text can start at page 5, and a citation has to
    // say 5 rather than 1.
    const joined = '--- page 5 ---\nFifth\n\n--- page 9 ---\nNinth'
    expect(splitJoinedPages(joined).map((p) => p.page)).toEqual([5, 9])
  })

  it('drops a marker with no text after it', () => {
    const joined = '--- page 1 ---\nReal text\n\n--- page 2 ---\n'
    expect(splitJoinedPages(joined)).toEqual([{ page: 1, text: 'Real text' }])
  })
})
