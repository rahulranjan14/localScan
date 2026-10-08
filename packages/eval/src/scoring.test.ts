import { describe, expect, it } from 'vitest'
import { flatten, scoreCorpus, scoreDocument, valuesMatch } from './scoring.js'

const score = (expected: unknown, actual: unknown) =>
  scoreDocument({
    fixture: 'test.pdf',
    expectedType: 'invoice',
    actualType: 'invoice',
    expected,
    actual,
  })

describe('flatten', () => {
  it('flattens nested objects to dotted paths', () => {
    expect([...flatten({ vendor: { name: 'Acme' } }).entries()]).toEqual([['vendor.name', 'Acme']])
  })

  it('indexes array elements rather than matching them', () => {
    // Index alignment on purpose: line items emitted in the wrong order is a real
    // error, and best-effort matching would hide it behind a good score.
    const flat = flatten({ items: [{ n: 1 }, { n: 2 }] })
    expect([...flat.keys()]).toEqual(['items[0].n', 'items[1].n'])
  })

  it('treats an empty array as a single null, so it can be compared', () => {
    expect(flatten({ items: [] }).get('items')).toBeNull()
  })

  it('treats an empty object as a single null', () => {
    expect(flatten({ vendor: {} }).get('vendor')).toBeNull()
  })
})

describe('valuesMatch', () => {
  it('compares numbers numerically across types', () => {
    expect(valuesMatch(2500, 2500.0)).toBe(true)
    expect(valuesMatch(2500, '2500')).toBe(true)
  })

  it('collapses incidental whitespace in strings', () => {
    expect(valuesMatch('Acme Ltd', 'Acme  Ltd')).toBe(true)
    expect(valuesMatch('Acme Ltd', ' Acme Ltd ')).toBe(true)
  })

  it('does not forgive a changed character', () => {
    // The error class that matters most: AIR_INDIA -> AIR_I NDIA is a real
    // transcription fault, and a scorer that forgives it forgives changed digits.
    expect(valuesMatch('AIR_INDIA', 'AIR_I NDIA')).toBe(false)
    expect(valuesMatch('2026-01-15', '2023-01-15')).toBe(false)
    expect(valuesMatch(10000, 100000)).toBe(false)
  })
})

describe('scoreDocument', () => {
  it('counts an exact match as correct', () => {
    const result = score({ total: 100 }, { total: 100 })
    expect(result.counts.correct).toBe(1)
    expect(result.f1).toBe(1)
  })

  it('separates a wrong value from a fabricated one', () => {
    // The distinction this whole file exists for. A wrong value can be caught by
    // a reviewer holding it against the page; a fabricated one looks real.
    const result = score(
      { total: 100, invoiceDate: null },
      { total: 999, invoiceDate: '2024-03-04' },
    )
    expect(result.counts.wrong).toBe(1)
    expect(result.counts.fabricated).toBe(1)
  })

  it('counts a value the document had but the model missed', () => {
    const result = score({ total: 100 }, { total: null })
    expect(result.counts.missed).toBe(1)
    expect(result.recall).toBe(0)
  })

  it('does not reward correctly leaving an absent field empty', () => {
    // Otherwise a schema with many null fields inflates every score, and a model
    // that returns nothing at all looks excellent.
    const result = score({ a: null, b: null, total: 100 }, { a: null, b: null, total: 100 })
    expect(result.counts.absent).toBe(2)
    expect(result.counts.correct).toBe(1)
    expect(result.precision).toBe(1)
  })

  it('scores a fabricated field at a path the ground truth never mentions', () => {
    // How fabrication hid before: iterating only the expected fields never looks
    // at extraFields the labels do not contain.
    const result = score({ total: 100 }, { total: 100, extraFields: [{ key: 'x', value: 'y' }] })
    expect(result.counts.fabricated).toBeGreaterThan(0)
    expect(result.precision).toBeLessThan(1)
  })

  it('reproduces the run-002 failure the old manual check called 5/5', () => {
    const expected = {
      invoiceNumber: 'INV-7',
      total: 2500,
      subtotal: null,
      vendor: { name: 'Bluebird Ltd', taxId: null },
      lineItems: [],
      extraFields: [],
    }
    const actual = {
      invoiceNumber: 'INV-7',
      total: 2500,
      subtotal: 2500,
      vendor: { name: 'Bluebird Ltd', taxId: 'Bluebird Ltd' },
      lineItems: [{ amount: 2500, description: null }],
      extraFields: [{ key: 'paymentTerms', value: 'Net 30' }],
    }
    const result = score(expected, actual)

    expect(result.counts.correct).toBe(3)
    // subtotal, vendor.taxId, lineItems[0].amount, extraFields[0].key/value
    expect(result.counts.fabricated).toBeGreaterThanOrEqual(5)
    expect(result.precision).toBeLessThan(0.5)
  })

  it('scores every expected field as missed when extraction failed', () => {
    const result = scoreDocument({
      fixture: 'x.pdf',
      expectedType: 'invoice',
      actualType: null,
      expected: { total: 100, invoiceNumber: 'A' },
      actual: null,
    })
    expect(result.counts.missed).toBe(2)
    expect(result.recall).toBe(0)
    expect(result.type!.correct).toBe(false)
  })
})

describe('scoreCorpus', () => {
  it('pools field counts rather than averaging per-document scores', () => {
    // A one-field document must not weigh as much as a forty-field one.
    const small = score({ a: 'x' }, { a: 'x' })
    const large = score(
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 'v'])),
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 'WRONG'])),
    )
    const corpus = scoreCorpus([small, large])

    expect(corpus.counts.correct).toBe(1)
    expect(corpus.counts.wrong).toBe(10)
    // Averaging per document would give 0.5; pooling gives 1/11.
    expect(corpus.precision).toBeCloseTo(1 / 11, 5)
  })

  it('reports classification accuracy separately from field accuracy', () => {
    const right = scoreDocument({
      fixture: 'a', expectedType: 'invoice', actualType: 'invoice',
      expected: { a: 1 }, actual: { a: 1 },
    })
    const wrongType = scoreDocument({
      fixture: 'b', expectedType: 'invoice', actualType: 'generic',
      expected: { a: 1 }, actual: { a: 1 },
    })
    const corpus = scoreCorpus([right, wrongType])

    expect(corpus.classificationAccuracy).toBe(0.5)
    expect(corpus.f1).toBe(1)
  })
})
