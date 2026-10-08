import { describe, expect, it } from 'vitest'
import { UnrepairableJson, repairJson } from './repair.js'

describe('repairJson', () => {
  it('returns valid JSON untouched and reports no repairs', () => {
    const { value, applied } = repairJson('{"a":1}')
    expect(value).toEqual({ a: 1 })
    expect(applied).toEqual([])
  })

  it('strips a markdown code fence', () => {
    const { value, applied } = repairJson('```json\n{"a":1}\n```')
    expect(value).toEqual({ a: 1 })
    expect(applied).toContain('removed code fence')
  })

  it('strips an unclosed code fence, which truncation produces', () => {
    expect(repairJson('```json\n{"a":1}').value).toEqual({ a: 1 })
  })

  it('discards prose before and after the object', () => {
    const { value } = repairJson('Here is the JSON you asked for:\n{"a":1}\nHope that helps!')
    expect(value).toEqual({ a: 1 })
  })

  it('removes a trailing comma', () => {
    expect(repairJson('{"a":1,"b":2,}').value).toEqual({ a: 1, b: 2 })
  })

  it('closes a structure the model never finished', () => {
    const { value, applied } = repairJson('{"a":1,"b":{"c":2')
    expect(value).toEqual({ a: 1, b: { c: 2 } })
    expect(applied).toContain('closed truncated structure')
  })

  it('closes a truncated array of objects', () => {
    const { value } = repairJson('{"items":[{"n":1},{"n":2}')
    expect(value).toEqual({ items: [{ n: 1 }, { n: 2 }] })
  })

  it('drops a half-written string rather than closing it', () => {
    // "Acme Suppli" must not become a field value. A plausible-looking partial is
    // worse than a missing one, because nothing downstream can tell it is partial.
    const { value } = repairJson('{"a":"complete","b":"Acme Suppli')
    expect(value).toEqual({ a: 'complete' })
    expect(value).not.toHaveProperty('b')
  })

  it('drops a dangling key with no value', () => {
    expect(repairJson('{"a":1,"b":').value).toEqual({ a: 1 })
  })

  it('is not confused by braces inside string values', () => {
    // A depth count that ignores strings would cut this document short.
    const input = '{"note":"use {this} and [that]","total":5}'
    expect(repairJson(input).value).toEqual({ note: 'use {this} and [that]', total: 5 })
  })

  it('is not confused by an escaped quote inside a string', () => {
    const input = '{"note":"he said \\"hello\\"","n":1}'
    expect(repairJson(input).value).toEqual({ note: 'he said "hello"', n: 1 })
  })

  it('handles a fence and truncation together', () => {
    const { value } = repairJson('```json\n{"a":1,"b":[1,2')
    expect(value).toEqual({ a: 1, b: [1, 2] })
  })

  it('throws when there is no JSON at all, rather than inventing one', () => {
    expect(() => repairJson('I cannot read this document.')).toThrow(UnrepairableJson)
  })

  it('throws on an empty response', () => {
    expect(() => repairJson('')).toThrow(UnrepairableJson)
  })

  it('never fabricates a value', () => {
    // The whole contract. Repairs are structural; a missing value stays missing,
    // because a guessed one validates and is wrong.
    const { value } = repairJson('{"invoiceNumber":"INV-1","total":')
    expect(value).toEqual({ invoiceNumber: 'INV-1' })
  })
})
