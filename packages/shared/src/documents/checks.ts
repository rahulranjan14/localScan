import { InvoiceSchema } from './invoice.js'

/**
 * Plausibility, which is not the same thing as validity.
 *
 * A schema answers "is this the right shape". It cannot answer "could this be
 * true", and the gap between the two is where a wrong extraction looks exactly
 * like a right one. A SuperStore invoice validated cleanly with `subtotal`
 * holding the total, three line items where the page has one, and two of them
 * carrying the discount and shipping amounts with no description.
 *
 * Every rule here compares values the document itself relates. None of them
 * infers a missing value — an inconsistency is reported for a person to settle,
 * never repaired, because repairing it would make a guess indistinguishable from
 * a reading.
 */

/** Invoices round. A cent of drift is arithmetic, not a finding. */
const TOLERANCE = 0.02

const money = (n: number): string => n.toFixed(2)

export function checkInvoice(value: unknown): string[] {
  const parsed = InvoiceSchema.safeParse(value)
  if (!parsed.success) return []
  const invoice = parsed.data
  const issues: string[] = []

  const { subtotal, taxTotal, discount, shipping, total } = invoice

  if (subtotal !== null && total !== null) {
    const expected = subtotal + (taxTotal ?? 0) + (shipping ?? 0) - (discount ?? 0)
    if (Math.abs(expected - total) > TOLERANCE) {
      issues.push(
        `The totals do not reconcile: subtotal ${money(subtotal)}` +
          (taxTotal !== null ? ` + tax ${money(taxTotal)}` : '') +
          (shipping !== null ? ` + shipping ${money(shipping)}` : '') +
          (discount !== null ? ` − discount ${money(discount)}` : '') +
          ` comes to ${money(expected)}, but the total reads ${money(total)}.`,
      )
    }
  }

  if (invoice.lineItems.length > 0 && subtotal !== null) {
    const summed = invoice.lineItems.reduce((running, item) => running + (item.amount ?? 0), 0)
    if (Math.abs(summed - subtotal) > TOLERANCE) {
      issues.push(
        `The line items add up to ${money(summed)}, but the subtotal reads ${money(subtotal)}.`,
      )
    }
  }

  // An invoice that prints no subtotal still relates its items to its total,
  // and only when nothing else is in between. A laundry invoice listing 462.00,
  // 35.50 and 70.00 against a total of 567.50 came back with two amounts shifted
  // onto the wrong rows and one dropped, which this compares.
  if (
    subtotal === null &&
    total !== null &&
    taxTotal === null &&
    discount === null &&
    shipping === null &&
    invoice.lineItems.length > 0
  ) {
    const summed = invoice.lineItems.reduce((running, item) => running + (item.amount ?? 0), 0)
    if (Math.abs(summed - total) > TOLERANCE) {
      issues.push(
        `The line items add up to ${money(summed)}, but the total reads ${money(total)}.`,
      )
    }
  }

  // A row with an amount and no description is the signature of a totals row
  // read as a purchase — the same tell as an employment entry with no title.
  const undescribed = invoice.lineItems.filter(
    (item) => item.description === null && item.amount !== null,
  ).length
  if (undescribed > 0) {
    issues.push(
      `${undescribed} line item${undescribed === 1 ? ' has' : 's have'} an amount but no ` +
        `description, which usually means a totals row was read as a purchase.`,
    )
  }

  return issues
}
