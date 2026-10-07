import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { UiSchemaSchema, type UiSchema } from '@ocr/shared'
import { DynamicForm } from './DynamicForm'

/**
 * These tests guard the two form invariants (FR-5.4). Both failure modes are
 * silent in a browser: a mis-bound field renders blank and looks like the model
 * missed it, and a field absent from the layout vanishes while the form still
 * looks complete.
 */

const layout: UiSchema = UiSchemaSchema.parse({
  groups: [
    {
      title: 'Invoice',
      fields: [
        { path: 'invoiceNumber', label: 'Invoice number', type: 'text' },
        { path: 'total', label: 'Total', type: 'number' },
        { path: 'notes', label: 'Notes', type: 'textarea' },
      ],
    },
    { title: 'Vendor', fields: [{ path: 'vendor.name', label: 'Name', type: 'text' }] },
  ],
  tables: [
    {
      path: 'lineItems',
      title: 'Line items',
      addable: true,
      columns: [
        { path: 'description', label: 'Description', type: 'text' },
        { path: 'amount', label: 'Amount', type: 'number' },
      ],
    },
  ],
})

const data = {
  invoiceNumber: 'SVC530754',
  total: 13629.64,
  notes: null,
  vendor: { name: 'Cleartrip Packages and Tours Private Limited', taxId: '27AAHCC1775A1ZX' },
  lineItems: [{ description: 'BASE_FARE', amount: 6051 }],
}

/** Wrapper that actually holds state, so editing behaves as it does in the app. */
function Harness({ initial = data, readOnly = false }: { initial?: object; readOnly?: boolean }) {
  const [current, setCurrent] = useState<Record<string, unknown>>(initial as Record<string, unknown>)
  return (
    <DynamicForm data={current} uiSchema={layout} readOnly={readOnly} onChange={setCurrent} />
  )
}

describe('DynamicForm', () => {
  it('renders without crashing and shows every group and table', () => {
    render(<Harness />)
    expect(screen.getByText('Invoice')).toBeDefined()
    expect(screen.getByText('Vendor')).toBeDefined()
    expect(screen.getByText(/Line items/)).toBeDefined()
  })

  it('binds a top-level value into its field', () => {
    render(<Harness />)
    expect(screen.getByLabelText<HTMLInputElement>('Invoice number').value).toBe('SVC530754')
  })

  it('binds a dotted path into its field (FR-5.3)', () => {
    render(<Harness />)
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(
      'Cleartrip Packages and Tours Private Limited',
    )
  })

  it('never renders a value as blank -- the first invariant', () => {
    render(<Harness />)
    // A binding bug shows up exactly here, and only here: the form looks correct
    // and the user "corrects" a value the model actually got right.
    expect(screen.getByLabelText<HTMLInputElement>('Total').value).toBe('13629.64')
  })

  it('shows a null as an empty control rather than the text "null"', () => {
    render(<Harness />)
    expect(screen.getByLabelText<HTMLTextAreaElement>('Notes').value).toBe('')
  })

  it('never hides extracted data absent from the layout -- the second invariant', () => {
    render(<Harness initial={{ ...data, mysteryField: 'value the layout forgot' }} />)
    expect(screen.getByText('mysteryField')).toBeDefined()
    expect(screen.getByText(/value the layout forgot/)).toBeDefined()
  })

  it('reports an edit through onChange with the dotted path applied', async () => {
    const onChange = vi.fn()
    render(<DynamicForm data={data} uiSchema={layout} onChange={onChange} />)

    await userEvent.type(screen.getByLabelText('Name'), '!')

    expect(onChange).toHaveBeenCalled()
    const next = onChange.mock.calls.at(-1)?.[0] as typeof data
    // Edited through a nested path, and the sibling survives.
    expect(next.vendor.taxId).toBe('27AAHCC1775A1ZX')
  })

  it('clears a field to null rather than to an empty string', async () => {
    const onChange = vi.fn()
    render(<DynamicForm data={data} uiSchema={layout} onChange={onChange} />)

    await userEvent.clear(screen.getByLabelText('Invoice number'))

    // null means "not present in the document", which is what the schema says.
    // An empty string would validate and be wrong.
    const next = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(next['invoiceNumber']).toBeNull()
  })

  it('adds and removes table rows (FR-5.5)', async () => {
    render(<Harness />)
    expect(screen.getByDisplayValue('BASE_FARE')).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: /Add row/ }))
    expect(screen.getByText(/Line items/).textContent).toContain('2')

    const removes = screen.getAllByTitle('Remove this row')
    await userEvent.click(removes[0]!)
    expect(screen.getByText(/Line items/).textContent).toContain('1')
  })

  it('offers no add or remove controls when read-only', () => {
    render(<Harness readOnly />)
    expect(screen.queryByRole('button', { name: /Add row/ })).toBeNull()
    expect(screen.queryByTitle('Remove this row')).toBeNull()
  })

  it('survives a table path holding something that is not an array', () => {
    // Defensive: a layout and a payload can disagree, and the form going blank
    // is a worse outcome than showing an empty table.
    render(<Harness initial={{ ...data, lineItems: null }} />)
    expect(screen.getByText(/None found in the document/)).toBeDefined()
  })
})
