import { describe, expect, it } from 'vitest'
import { DEFAULT_INPUT_LIMITS, InputRejected, validatePdfInput } from './input.js'

const pdf = (body = '') => new TextEncoder().encode(`%PDF-1.7\n${body}`)

function rejectionReason(bytes: Uint8Array, limits = DEFAULT_INPUT_LIMITS): string {
  try {
    validatePdfInput(bytes, limits)
  } catch (error) {
    if (error instanceof InputRejected) return error.reason
    throw error
  }
  return 'accepted'
}

describe('validatePdfInput', () => {
  it('accepts a file beginning with the PDF magic bytes', () => {
    expect(() => validatePdfInput(pdf())).not.toThrow()
  })

  it('rejects an empty file', () => {
    expect(rejectionReason(new Uint8Array())).toBe('empty')
  })

  it('rejects a file that is not a PDF whatever it is named', () => {
    const executable = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03])
    expect(rejectionReason(executable)).toBe('not_a_pdf')
  })

  it('rejects a file over the size limit', () => {
    const big = new Uint8Array(1024)
    big.set(pdf().subarray(0, 5))
    expect(rejectionReason(big, { maxBytes: 512, maxPages: 10 })).toBe('too_large')
  })

  it('rejects a document with more page objects than the limit', () => {
    const manyPages = pdf('/Type /Page\n'.repeat(12))
    expect(rejectionReason(manyPages, { maxBytes: 1_000_000, maxPages: 10 })).toBe('too_many_pages')
  })

  it('checks size before inspecting content, so a huge file is never scanned', () => {
    // A 2 MB file of page markers would be expensive to scan and is rejected on
    // length alone. Ordering matters here: the cheap check has to come first.
    const huge = new TextEncoder().encode('/Type /Page\n'.repeat(200_000))
    expect(rejectionReason(huge, { maxBytes: 1024, maxPages: 10 })).toBe('too_large')
  })

  it('does not count /Type /Pages, which is the page tree rather than a page', () => {
    const tree = pdf('/Type /Pages\n'.repeat(50))
    expect(rejectionReason(tree, { maxBytes: 1_000_000, maxPages: 10 })).toBe('accepted')
  })
})
