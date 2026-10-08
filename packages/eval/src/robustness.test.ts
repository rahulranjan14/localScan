import { describe, expect, it } from 'vitest'
import { checkRobustness } from './robustness.js'

describe('checkRobustness', () => {
  it('passes clean extracted data', () => {
    const result = checkRobustness({
      invoiceNumber: 'INV-7',
      vendor: { name: 'Bluebird Ltd', address: 'Unit 4, R City Offices, Mumbai 400086' },
      total: 2050,
    })
    expect(result.passed).toBe(true)
    expect(result.fieldsChecked).toBe(3)
  })

  it('catches a base64 blob in a field', () => {
    const result = checkRobustness({ notes: 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(130) })
    expect(result.passed).toBe(false)
    expect(result.findings[0]!.signature).toBe('base64_blob')
  })

  it('catches chat control tokens', () => {
    const result = checkRobustness({ notes: 'Total due<|im_end|>' })
    expect(result.findings[0]!.signature).toBe('chat_control_token')
  })

  it('catches HTML markup', () => {
    const result = checkRobustness({ notes: '<table><tr><td>Notebook</td></tr></table>' })
    expect(result.findings[0]!.signature).toBe('html_markup')
  })

  it('catches a conversational preamble', () => {
    const result = checkRobustness({ notes: 'Here is the information from the document.' })
    expect(result.findings[0]!.signature).toBe('hallucinated_preamble')
  })

  it('catches a refusal stored as a value', () => {
    // Worse than an empty field: it validates, it persists, and it reads as content.
    const result = checkRobustness({ notes: "I cannot read this document clearly." })
    expect(result.findings[0]!.signature).toBe('refusal')
  })

  it('reports the path so a finding can be located', () => {
    const result = checkRobustness({ lineItems: [{ description: '```json' }] })
    expect(result.findings[0]!.path).toBe('lineItems[0].description')
  })

  it('does not flag a real address containing a long alphanumeric run', () => {
    // A GSTIN, an IRN or an account number must not read as base64. False
    // positives here would make the check useless on genuine Indian invoices.
    const result = checkRobustness({
      taxId: '00AAAAA0000A0Z0',
      notes: 'IRN: ab46642b2b46fa2fda07809198bce93e6455500192661009',
    })
    expect(result.passed).toBe(true)
  })

  it('counts every string checked, so a pass is not vacuous', () => {
    // A pass on an object with no strings in it means nothing, and the count is
    // how a reader tells those apart.
    expect(checkRobustness({ total: 100, due: null }).fieldsChecked).toBe(0)
  })
})
