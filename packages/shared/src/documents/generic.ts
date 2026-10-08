import { z } from 'zod'

/**
 * The shape for a document that is not one of the typed ones.
 *
 * Flat key-values, no nesting, no document-specific fields — because there is
 * nothing to be specific about. This is why `generic` is read-only in the
 * interface (FR-5.7): with no schema behind it, there is nothing an edit could be
 * validated against, so an edit button would imply a guarantee that does not
 * exist.
 *
 * It is still a *successful* outcome. The raw text is stored and, from Phase 4,
 * indexed — so a generic document is fully answerable with page citations even
 * though it cannot be edited. That is where retrieval earns its keep hardest:
 * there is no structured data to read, so you query it instead.
 */
export const GenericSchema = z.object({
  /**
   * A short label for what this document appears to be. Not a type — a type would
   * imply a schema. This is for the library listing, so a generic document is not
   * just a row of identifiers.
   */
  documentLabel: z.string().max(200).nullable().default(null),

  /**
   * Bounded, like every model-facing collection (D-005). More so here: with no
   * schema telling the model what to look for, nothing says when it has finished,
   * so an unbounded list is an invitation to invent.
   */
  fields: z
    .array(z.object({ key: z.string().max(200), value: z.string().max(4000) }))
    .max(60)
    .default([]),
})
export type Generic = z.infer<typeof GenericSchema>
