import { z } from 'zod'

/**
 * Second typed document, and the one that proves the extensibility claim.
 *
 * It shares no fields with an invoice, so if adding it required any change to the
 * engine, the "three files and a registry entry" claim would be false. That is
 * the real reason for a second type — not résumé support for its own sake.
 */

const nullableString = z.string().nullable().default(null)

/**
 * Every collection is bounded, and every field required-but-nullable.
 *
 * Both rules come from D-005, learned on an invoice: an unbounded array gives
 * constrained decoding no state in which it must stop, and an optional field lets
 * a model answer the easy questions and quit. A résumé is more prone to the first
 * than an invoice is — there is no printed total to anchor against, so a model
 * padding a skills list has nothing telling it the document has run out.
 */
export const ContactSchema = z.object({
  name: nullableString,
  email: nullableString,
  phone: nullableString,
  location: nullableString,
  /** LinkedIn, GitHub, a portfolio — whatever the document lists. */
  links: z.array(z.string().max(300)).max(10).default([]),
})
export type Contact = z.infer<typeof ContactSchema>

export const EmploymentSchema = z.object({
  employer: nullableString,
  title: nullableString,
  /** As printed. Résumé dates are rarely in a parseable format. */
  startDate: nullableString,
  endDate: nullableString,
  location: nullableString,
  summary: z.string().max(2000).nullable().default(null),
})
export type Employment = z.infer<typeof EmploymentSchema>

export const EducationSchema = z.object({
  institution: nullableString,
  qualification: nullableString,
  field: nullableString,
  startDate: nullableString,
  endDate: nullableString,
  /** A grade, GPA or classification, as printed rather than normalised. */
  result: nullableString,
})
export type Education = z.infer<typeof EducationSchema>

export const ResumeSchema = z.object({
  contact: ContactSchema,

  /** The candidate's own summary, if the document has one. Never written for it. */
  headline: nullableString,
  summary: z.string().max(3000).nullable().default(null),

  employment: z.array(EmploymentSchema).max(40).default([]),
  education: z.array(EducationSchema).max(20).default([]),

  /**
   * Capped at 60 and the cap matters here more than elsewhere: a skills list has
   * no natural end, so a model inclined to pad will keep going.
   */
  skills: z.array(z.string().max(120)).max(60).default([]),
  certifications: z.array(z.string().max(300)).max(30).default([]),
  languages: z.array(z.string().max(120)).max(20).default([]),

  /** Never discard something the document stated (FR-4.7). */
  extraFields: z
    .array(z.object({ key: z.string().max(120), value: z.string().max(2000) }))
    .max(25)
    .default([]),
})
export type Resume = z.infer<typeof ResumeSchema>
