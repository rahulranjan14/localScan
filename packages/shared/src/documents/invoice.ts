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
  /**
   * Discount and shipping are fields rather than `extraFields` entries because
   * a printed total does not reconcile without them.
   *
   * They were missing, and a SuperStore invoice showed what that costs: the
   * model put the two amounts in `lineItems` as rows with no description, and
   * `subtotal` came back as the total. A value the schema cannot hold does not
   * stay out of the output — it lands somewhere worse.
   */
  discount: nullableNumber,
  shipping: nullableNumber,
  total: nullableNumber,

  notes: nullableString,

  /**
   * Anything the model read that this schema has no home for (FR-4.7).
   *
   * Without this, a field the document actually contains is silently dropped on
   * validation, and the loss is invisible — the output still looks complete.
   *
   * A list of pairs rather than a record, and bounded, for the same reason
   * `lineItems` is bounded: a record is an open-ended object in the generated
   * grammar, so constrained decoding never reaches a state where it must stop.
   * A travel invoice sent this into a loop that emitted keys like
   * "Airline Airline Travel Date" until it was killed at the token ceiling. An
   * array with a maximum puts the stop condition where the decoder can see it.
   */
  extraFields: z
    // Nullable, because a required string plus an instruction to answer null
    // produces the word "null" as text, which validates and is wrong. Observed
    // on three fields of one invoice.
    .array(z.object({ key: z.string().max(120), value: z.string().max(2000).nullable() }))
    .max(25)
    .default([]),
})
export type Invoice = z.infer<typeof InvoiceSchema>
