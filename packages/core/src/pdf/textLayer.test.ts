import { describe, expect, it } from 'vitest'
import { hasUsableTextLayer, shouldUseTextLayer, type TextLayerResult } from './textLayer.js'

const layer = (texts: string[]): TextLayerResult => {
  const pages = texts.map((text, i) => ({ page: i + 1, text }))
  return {
    pages,
    pagesWithText: pages.filter((p) => p.text.length >= 100).length,
    totalPages: pages.length,
  }
}

const dense = 'x'.repeat(200)
const scannerNoise = 'Page 1'

describe('hasUsableTextLayer', () => {
  it('accepts a document where every page carries text', () => {
    expect(hasUsableTextLayer(layer([dense, dense]))).toBe(true)
  })

  it('rejects a document with no text at all', () => {
    expect(hasUsableTextLayer(layer(['', '']))).toBe(false)
  })

  it('rejects pages carrying only scanner noise', () => {
    // The reason the threshold is 100 characters rather than "any text": a scan
    // often leaves a header or a page number, and treating that as a text layer
    // would route the document down the cheap path and return almost nothing.
    expect(hasUsableTextLayer(layer([scannerNoise, scannerNoise]))).toBe(false)
  })

  it('accepts a mostly-digital document with one scanned page', () => {
    expect(hasUsableTextLayer(layer([dense, dense, scannerNoise]))).toBe(true)
  })

  it('rejects a mostly-scanned document with one digital page', () => {
    expect(hasUsableTextLayer(layer([dense, scannerNoise, scannerNoise]))).toBe(false)
  })

  it('rejects an empty document rather than dividing by zero', () => {
    expect(hasUsableTextLayer(layer([]))).toBe(false)
  })
})

describe('shouldUseTextLayer', () => {
  it('auto follows the usability threshold', () => {
    expect(shouldUseTextLayer('auto', layer([dense]))).toBe(true)
    expect(shouldUseTextLayer('auto', layer([scannerNoise]))).toBe(false)
  })

  it('always_vlm ignores a perfectly good text layer', () => {
    // Deliberate: a mangled text layer can be worse than a rendered page, so
    // this mode exists to be measured against auto rather than assumed worse.
    expect(shouldUseTextLayer('always_vlm', layer([dense, dense]))).toBe(false)
  })

  it('prefer_text accepts even a trace of text, and never calls a model', () => {
    expect(shouldUseTextLayer('prefer_text', layer([scannerNoise]))).toBe(true)
  })

  it('prefer_text still returns false when there is genuinely no text', () => {
    // Otherwise the pipeline would extract from an empty string and report
    // success on a document it never read.
    expect(shouldUseTextLayer('prefer_text', layer(['', '']))).toBe(false)
  })
})
