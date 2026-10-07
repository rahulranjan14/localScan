import { describe, expect, it } from 'vitest'
import { UiSchemaSchema, getByPath, pathsNotInLayout, setByPath } from './uiSchema.js'

describe('getByPath', () => {
  const data = { total: 100, vendor: { name: 'Acme', address: { city: 'Mumbai' } }, notes: null }

  it('reads a top-level value', () => {
    expect(getByPath(data, 'total')).toBe(100)
  })

  it('reads a nested value', () => {
    expect(getByPath(data, 'vendor.address.city')).toBe('Mumbai')
  })

  it('distinguishes a null value from a missing one', () => {
    // The form has to tell these apart: null is an answer the model gave, and
    // undefined means the field was never there (FR-5.4).
    expect(getByPath(data, 'notes')).toBeNull()
    expect(getByPath(data, 'nope')).toBeUndefined()
  })

  it('returns undefined rather than throwing when the path runs through a gap', () => {
    expect(getByPath(data, 'buyer.address.city')).toBeUndefined()
  })
})

describe('setByPath', () => {
  it('sets a top-level value without mutating the input', () => {
    const before = { total: 100 }
    const after = setByPath(before, 'total', 200)
    expect(after.total).toBe(200)
    expect(before.total).toBe(100)
  })

  it('sets a nested value and leaves siblings alone', () => {
    const before = { vendor: { name: 'Acme', taxId: 'GST1' } }
    const after = setByPath(before, 'vendor.name', 'Globex')
    expect(after.vendor).toEqual({ name: 'Globex', taxId: 'GST1' })
    expect(before.vendor.name).toBe('Acme')
  })

  it('creates intermediate objects that do not exist yet', () => {
    const after = setByPath({} as Record<string, unknown>, 'buyer.address.city', 'Pune')
    expect(getByPath(after, 'buyer.address.city')).toBe('Pune')
  })

  it('replaces a null on the way through rather than failing', () => {
    const after = setByPath({ buyer: null }, 'buyer.name', 'Acme')
    expect(getByPath(after, 'buyer.name')).toBe('Acme')
  })
})

describe('pathsNotInLayout', () => {
  const layout = UiSchemaSchema.parse({
    groups: [{ title: 'Invoice', fields: [{ path: 'invoiceNumber', label: 'No.' }] }],
    tables: [{ path: 'lineItems', title: 'Lines', columns: [{ path: 'description', label: 'D' }] }],
  })

  it('reports data the layout does not mention', () => {
    // This is what stops a layout that has fallen behind its schema from
    // silently hiding extracted values (FR-5.4).
    expect(pathsNotInLayout(layout, { invoiceNumber: 'A', lineItems: [], mystery: 'x' })).toEqual([
      'mystery',
    ])
  })

  it('reports nothing when the layout covers everything', () => {
    expect(pathsNotInLayout(layout, { invoiceNumber: 'A', lineItems: [] })).toEqual([])
  })

  it('treats a nested path as covering its root', () => {
    const nested = UiSchemaSchema.parse({
      groups: [{ title: 'Vendor', fields: [{ path: 'vendor.name', label: 'Name' }] }],
    })
    expect(pathsNotInLayout(nested, { vendor: { name: 'Acme', taxId: 'X' } })).toEqual([])
  })
})
