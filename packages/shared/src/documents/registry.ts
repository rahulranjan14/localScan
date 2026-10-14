import type { z } from 'zod'
import { checkInvoice } from './checks.js'
import { InvoiceSchema } from './invoice.js'
import { ResumeSchema } from './resume.js'

/**
 * A document type is three artifacts and one entry here (FR-4.1):
 *
 *   documents/<slug>/schema   — the Zod schema, imported below
 *   documents/<slug>/prompt.md — the extraction prompt
 *   documents/<slug>/ui.json   — the review form layout
 *
 * Nothing in the engine knows the names of any document type. Adding one must
 * not require changing extraction, validation, or the frontend.
 */
export interface DocumentTypeDefinition {
  /** Directory name under documents/, and the key used in prompts and layouts. */
  readonly slug: string
  /** Shown in the interface and in the agent-facing type listing. */
  readonly label: string
  readonly schema: z.ZodType
  /**
   * Optional: values the document relates that a schema cannot compare, such as
   * an invoice whose parts do not add up to its total. Returns one message per
   * inconsistency, for a person to settle. A type without arithmetic omits it.
   */
  readonly check?: (data: unknown) => string[]
}

export const DOCUMENT_TYPES = {
  invoice: {
    slug: 'invoice',
    label: 'Invoice',
    schema: InvoiceSchema,
    check: checkInvoice,
  },
  // The second type exists to prove the first claim in this file: it shares no
  // field with an invoice, and adding it required no engine change.
  resume: {
    slug: 'resume',
    label: 'Resume / CV',
    schema: ResumeSchema,
  },
} as const satisfies Record<string, DocumentTypeDefinition>

export type TypedDocumentType = keyof typeof DOCUMENT_TYPES

/**
 * `generic` is a successful outcome, not a failure (FR-3.3).
 *
 * It has no schema and no form layout, so it is read-only in the interface —
 * there is nothing to validate an edit against. It is still stored and still
 * indexed for retrieval, which is where its value is.
 */
export const GENERIC_TYPE = 'generic' as const

export type DocumentType = TypedDocumentType | typeof GENERIC_TYPE

export const DOCUMENT_STATUSES = [
  'pending',
  'processing',
  'completed',
  'needs_review',
  'failed',
] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export function isTypedDocumentType(type: string): type is TypedDocumentType {
  return Object.hasOwn(DOCUMENT_TYPES, type)
}

export function getDocumentType(type: string): DocumentTypeDefinition | null {
  return isTypedDocumentType(type) ? DOCUMENT_TYPES[type] : null
}

export function listDocumentTypes(): readonly DocumentTypeDefinition[] {
  return Object.values(DOCUMENT_TYPES)
}
