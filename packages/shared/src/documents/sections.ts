import { z } from 'zod'

/**
 * A section the schema does not name, kept in the document's own terms.
 *
 * Every typed schema is a bet on which sections matter, and every bet is wrong
 * for some document. A résumé schema with `employment` and `education` has
 * nowhere to put Projects, so a model asked for structured output puts them
 * somewhere plausible instead — Jake Ryan's two projects arrived as employment
 * entries with a null title and a project name in `employer`.
 *
 * The alternative is not a `projects` field. That fixes one document and leaves
 * publications, awards, patents and volunteering to be discovered one résumé at
 * a time. This is the general shape instead: the entry keeps the heading the
 * document printed above it, so a section nobody anticipated survives extraction
 * without the schema having predicted its name.
 *
 * **Flat rather than nested on purpose.** One row per entry, with `section`
 * repeating, renders in the existing table layout with no new form component —
 * which is the whole claim of `uiSchema.ts`. A nested `{ title, entries[] }`
 * would read better as data and would have cost a React change.
 */

const nullableString = z.string().max(500).nullable().default(null)

export const SectionEntrySchema = z.object({
  /** The document's own heading, copied verbatim: `Projects`, `Publications`. */
  section: z.string().max(120),
  /** The entry's own name: a project, an award, a paper. */
  heading: nullableString,
  /** A second line where the document has one: a venue, an organisation, a role. */
  subheading: nullableString,
  startDate: nullableString,
  endDate: nullableString,
  /**
   * A list the document prints inline, as printed — `Python, Flask, React`.
   * A string rather than an array because that is what the page shows, and
   * splitting it is a decision for whoever consumes it.
   */
  tags: nullableString,
  /** The body: bullets joined as written, or the paragraph as printed. */
  text: z.string().max(4000).nullable().default(null),
})
export type SectionEntry = z.infer<typeof SectionEntrySchema>

/**
 * Capped, for the reason the skills list is capped: a container with no schema
 * to constrain it is exactly where a model inclined to pad will keep going.
 */
export const SectionsSchema = z.array(SectionEntrySchema).max(60).default([])
