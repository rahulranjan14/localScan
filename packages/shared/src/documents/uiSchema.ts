import { z } from 'zod'

/**
 * The form layout a document type publishes to the interface.
 *
 * The frontend has no screen per document type; it renders whatever arrives here
 * (FR-5.2). That is what makes adding a type three files rather than three files
 * and a React component.
 */

export const UiFieldSchema = z.object({
  /** Dotted path into the document data, e.g. `vendor.address` (FR-5.3). */
  path: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'textarea', 'number']).default('text'),
  width: z.string().optional(),
})
export type UiField = z.infer<typeof UiFieldSchema>

export const UiGroupSchema = z.object({
  title: z.string().min(1),
  fields: z.array(UiFieldSchema),
})
export type UiGroup = z.infer<typeof UiGroupSchema>

export const UiTableSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  addable: z.boolean().default(false),
  columns: z.array(UiFieldSchema),
})
export type UiTable = z.infer<typeof UiTableSchema>

export const UiSchemaSchema = z.object({
  groups: z.array(UiGroupSchema).default([]),
  tables: z.array(UiTableSchema).default([]),
})
export type UiSchema = z.infer<typeof UiSchemaSchema>

/** Reads a dotted path. Returns undefined rather than throwing on a gap. */
export function getByPath(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, data)
}

/** Writes a dotted path, creating intermediate objects, without mutating input. */
export function setByPath<T>(data: T, path: string, value: unknown): T {
  const keys = path.split('.')
  const clone = structuredClone(data) as Record<string, unknown>

  let cursor: Record<string, unknown> = clone
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key]
    cursor[key] = next !== null && typeof next === 'object' ? { ...(next as object) } : {}
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[keys[keys.length - 1]!] = value
  return clone as T
}

/**
 * Paths the layout does not mention, so the interface can still show them.
 *
 * This exists to enforce the second form invariant: never hide extracted data
 * (FR-5.4). A layout that falls behind its schema would otherwise silently drop
 * fields from view, and the form would look complete while concealing values the
 * model actually read.
 */
export function pathsNotInLayout(layout: UiSchema, data: unknown): string[] {
  if (data === null || typeof data !== 'object') return []

  const covered = new Set<string>()
  for (const group of layout.groups) {
    for (const field of group.fields) covered.add(field.path.split('.')[0]!)
  }
  for (const table of layout.tables) covered.add(table.path.split('.')[0]!)

  return Object.keys(data as Record<string, unknown>).filter((key) => !covered.has(key))
}
