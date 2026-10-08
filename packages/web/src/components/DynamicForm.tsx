import { useMemo } from 'react'
import {
  getByPath,
  pathsNotInLayout,
  setByPath,
  type UiField,
  type UiSchema,
  type UiTable,
} from '@ocr/shared'

/**
 * Renders a document entirely from the layout the server supplied.
 *
 * There is no invoice screen, and there will be no résumé screen. That is the
 * whole point: adding a document type must be three files, which it cannot be if
 * the frontend needs a component per type (FR-5.2).
 *
 * Two invariants, both load-bearing:
 *
 *   - **Never show a blank field that has a value.** A binding bug here is
 *     invisible in the worst way -- the form looks fine and the user "corrects"
 *     a value the model actually got right.
 *   - **Never hide extracted data.** Anything present in the data but absent
 *     from the layout is still rendered, below. A layout that falls behind its
 *     schema must degrade into showing too much, never too little.
 */

type Data = Record<string, unknown>

interface Props {
  data: Data
  uiSchema: UiSchema
  readOnly?: boolean
  onChange: (next: Data) => void
}

export function DynamicForm({ data, uiSchema, readOnly = false, onChange }: Props) {
  const orphans = useMemo(() => pathsNotInLayout(uiSchema, data), [uiSchema, data])

  return (
    <div>
      {uiSchema.groups.map((group) => (
        <section className="group" key={group.title}>
          <h3>{group.title}</h3>
          {group.fields.map((field) => (
            <Field
              key={field.path}
              field={field}
              value={getByPath(data, field.path)}
              readOnly={readOnly}
              onChange={(value) => onChange(setByPath(data, field.path, value))}
            />
          ))}
        </section>
      ))}

      {uiSchema.tables.map((table) => (
        <Table
          key={table.path}
          table={table}
          rows={asRows(getByPath(data, table.path))}
          readOnly={readOnly}
          onChange={(rows) => onChange(setByPath(data, table.path, rows))}
        />
      ))}

      {orphans.length > 0 && (
        <section className="group">
          <h3>Not in the form layout</h3>
          <p className="dim" style={{ marginTop: -2, fontSize: 13 }}>
            The document produced these and <code>ui.json</code> has no place for them. Shown
            because hiding extracted data would be worse than showing it untidily.
          </p>
          {orphans.map((path) => (
            <div className="field" key={path}>
              <label className="mono">{path}</label>
              <div className="raw" style={{ maxHeight: 160 }}>
                {JSON.stringify(getByPath(data, path), null, 2)}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function Field({
  field,
  value,
  readOnly,
  onChange,
}: {
  field: UiField
  value: unknown
  readOnly: boolean
  onChange: (value: unknown) => void
}) {
  // null and undefined both render as an empty control, but they mean different
  // things -- the model answered "not present" versus the field never existed.
  // The label is dimmed for both; what matters is that a *value* never renders
  // blank, which is the first invariant.
  const isEmpty = value === null || value === undefined || value === ''
  const text = isEmpty ? '' : String(value)

  const commit = (raw: string) => {
    if (raw === '') {
      onChange(null)
      return
    }
    if (field.type === 'number') {
      const parsed = Number(raw)
      onChange(Number.isFinite(parsed) ? parsed : raw)
      return
    }
    onChange(raw)
  }

  return (
    <div className={`field${isEmpty ? ' empty' : ''}`}>
      <label htmlFor={field.path}>{field.label}</label>
      {field.type === 'textarea' ? (
        <textarea
          id={field.path}
          value={text}
          readOnly={readOnly}
          onChange={(event) => commit(event.target.value)}
        />
      ) : (
        <input
          id={field.path}
          type={field.type === 'number' ? 'number' : 'text'}
          value={text}
          readOnly={readOnly}
          onChange={(event) => commit(event.target.value)}
        />
      )}
    </div>
  )
}

function Table({
  table,
  rows,
  readOnly,
  onChange,
}: {
  table: UiTable
  rows: Data[]
  readOnly: boolean
  onChange: (rows: Data[]) => void
}) {
  const blank = (): Data => Object.fromEntries(table.columns.map((c) => [c.path, null]))

  return (
    <section className="group">
      <h3>
        {table.title} <span className="dim">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="dim" style={{ fontSize: 13 }}>None found in the document.</p>
      ) : (
        <table>
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column.path} style={column.width ? { width: column.width } : undefined}>
                  {column.label}
                </th>
              ))}
              {!readOnly && <th style={{ width: '2.5rem' }} />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {table.columns.map((column) => {
                  const value = getByPath(row, column.path)
                  return (
                    <td key={column.path}>
                      <input
                        type={column.type === 'number' ? 'number' : 'text'}
                        value={value === null || value === undefined ? '' : String(value)}
                        readOnly={readOnly}
                        onChange={(event) => {
                          const raw = event.target.value
                          const next =
                            raw === ''
                              ? null
                              : column.type === 'number' && Number.isFinite(Number(raw))
                                ? Number(raw)
                                : raw
                          onChange(rows.map((r, i) => (i === index ? setByPath(r, column.path, next) : r)))
                        }}
                      />
                    </td>
                  )
                })}
                {!readOnly && (
                  <td>
                    <button
                      className="subtle tiny"
                      title="Remove this row"
                      onClick={() => onChange(rows.filter((_, i) => i !== index))}
                    >
                      ✕
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!readOnly && table.addable && (
        <button className="subtle tiny" style={{ marginTop: 6 }} onClick={() => onChange([...rows, blank()])}>
          + Add row
        </button>
      )}
    </section>
  )
}

/** Tolerates a non-array where the layout expects one, rather than crashing. */
function asRows(value: unknown): Data[] {
  return Array.isArray(value) ? (value as Data[]) : []
}
