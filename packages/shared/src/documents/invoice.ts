import { z } from 'zod'

/**
 * Every field is nullable on purpose.
 *
 * A model that cannot find a due date must be able to say so. The alternative —
 * requiring the field — pushes it toward inventing one, which is the failure
 * mode that matters most here: a plausible wrong value is worse than an absent
 * one, because nothing downstream can detect it.
 */
const nullableString = z.string().nullable().default(null)
const nullableNumber = z.number().nullable().default(null)

export const PartySchema = z.object({
  name: nullableString,
  address: nullableString,
  /** GSTIN, VAT number, EIN — whatever the document uses. */
  taxId: nullableString,
  email: nullableString,
  phone: nullableString,
})
export type Party = z.infer<typeof PartySchema>

export const LineItemSchema = z.object({
  description: nullableString,
  quantity: nullableNumber,
  unitPrice: nullableNumber,
  /** Line total as printed. Deliberately not derived — the document is truth. */
  amount: nullableNumber,
  taxRate: nullableNumber,
})
export type LineItem = z.infer<typeof LineItemSchema>

export const InvoiceSchema = z.object({
  invoiceNumber: nullableString,
  /** ISO 8601 where the document allows it; otherwise as printed. */
  invoiceDate: nullableString,
  dueDate: nullableString,
  poNumber: nullableString,
  /** ISO 4217 where recognisable. */
  currency: nullableString,

  vendor: PartySchema,
  buyer: PartySchema,

  /**
   * Bounded deliberately.
   *
   * The limit is not about plausible invoice sizes — it is about the grammar.
   * An unbounded array gives constrained decoding no reason to ever stop, so a
   * model that falls into a repetition loop emits line items until it is killed
   * from outside. A maximum puts the stop condition in the schema itself, where
   * the decoder can see it, rather than relying on a token cap to cut it off.
   */
  lineItems: z.array(LineItemSchema).max(200).default([]),

  subtotal: nullableNumber,
  taxTotal: nullableNumber,
  total: nullableNumber,

  notes: nullableString,

  /**
   * Anything the model read that this schema has no home for (FR-4.7).
   *
   * Without this, a field the document actually contains is silently dropped on
   * validation, and the loss is invisible — the output still looks complete.
   */
  extraFields: z.record(z.string(), z.string()).default({}),
})
export type Invoice = z.infer<typeof InvoiceSchema>
