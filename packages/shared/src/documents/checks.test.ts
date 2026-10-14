import { describe, expect, it } from 'vitest'
import { checkInvoice } from './checks.js'

/**
 * The document behind these cases is a SuperStore invoice that validated
 * cleanly while holding the total in `subtotal`, three line items where the page
 * has one, and the discount and shipping amounts as undescribed rows.
 */

const invoice = (fields: Record<string, unknown>) => ({
  invoiceNumber: null, invoiceDate: null, dueDate: null, poNumber: null, currency: null,
  vendor: { name: null, taxId: null, address: null, email: null, phone: null },
  buyer: { name: null, taxId: null, address: null, email: null, phone: null },
  lineItems: [], subtotal: null, taxTotal: null, discount: null, shipping: null, total: null,
  notes: null, extraFields: [], ...fields,
})

const item = (description: string | null, amount: number | null) => ({
  description, quantity: null, unitPrice: null, taxRate: null, amount,
})

describe('checkInvoice', () => {
  it('passes an invoice whose parts add up', () => {
    expect(checkInvoice(invoice({
      subtotal: 85, taxTotal: 8.5, total: 93.5, lineItems: [item('Web Design', 85)],
    }))).toEqual([])
  })

  it('reconciles a total that includes shipping and a discount', () => {
    expect(checkInvoice(invoice({
      subtotal: 48.71, discount: 9.74, shipping: 11.13, total: 50.1,
      lineItems: [item("Global Push Button Manager's Chair, Indigo", 48.71)],
    }))).toEqual([])
  })

  it('catches a subtotal holding the total', () => {
    const issues = checkInvoice(invoice({
      subtotal: 50.1, total: 50.1,
      lineItems: [item('Chair', 48.71), item('Chairs, Furniture', 9.74), item(null, 11.13)],
    }))
    expect(issues.some((i) => i.includes('line items add up to 69.58'))).toBe(true)
  })

  it('catches a row with an amount and no description', () => {
    const issues = checkInvoice(invoice({ lineItems: [item(null, 11.13)] }))
    expect(issues.some((i) => i.includes('no description'))).toBe(true)
  })

  it('tolerates rounding to the cent', () => {
    expect(checkInvoice(invoice({ subtotal: 10, taxTotal: 1.005, total: 11.01 }))).toEqual([])
  })

  it('says nothing when the document states no totals', () => {
    expect(checkInvoice(invoice({}))).toEqual([])
  })

  it('ignores a value that is not an invoice', () => {
    expect(checkInvoice({ nonsense: true })).toEqual([])
  })
})

describe('checkInvoice without a subtotal', () => {
  it('compares the line items to the total when nothing sits in between', () => {
    const issues = checkInvoice(invoice({
      total: 567.5,
      lineItems: [item('Linens', 70), item('Towels', 35.5), item('Aprons', null)],
    }))
    expect(issues.some((i) => i.includes('add up to 105.50'))).toBe(true)
  })

  it('stays quiet when they agree', () => {
    expect(checkInvoice(invoice({
      total: 567.5,
      lineItems: [item('Linens', 462), item('Towels', 35.5), item('Aprons', 70)],
    }))).toEqual([])
  })

  it('does not compare when tax or shipping sits between items and total', () => {
    expect(checkInvoice(invoice({
      total: 110, taxTotal: 10, lineItems: [item('Thing', 100)],
    }))).toEqual([])
  })
})
