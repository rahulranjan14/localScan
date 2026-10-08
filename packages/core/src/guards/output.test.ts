import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_OUTPUT_LIMITS, OutputRejected, guardOutput } from './output.js'

const limits = { maxStringLength: 20, maxArrayLength: 3, maxDepth: 4 }

describe('guardOutput', () => {
  it('passes conforming data through unchanged', () => {
    const schema = z.object({ name: z.string(), total: z.number() })
    const { data, truncated } = guardOutput({ name: 'Acme', total: 100 }, schema, limits)
    expect(data).toEqual({ name: 'Acme', total: 100 })
    expect(truncated).toEqual([])
  })

  it('rejects data that does not match the schema', () => {
    // Validation comes first, so a bad shape never reaches the capping walk.
    const schema = z.object({ total: z.number() })
    expect(() => guardOutput({ total: 'not a number' }, schema, limits)).toThrow()
  })

  it('caps an over-long string and reports its path', () => {
    const schema = z.object({ notes: z.string() })
    const { data, truncated } = guardOutput({ notes: 'x'.repeat(500) }, schema, limits)
    expect(data.notes).toHaveLength(20)
    expect(truncated).toEqual(['notes'])
  })

  it('caps a string nested inside an object and names the dotted path', () => {
    const schema = z.object({ vendor: z.object({ address: z.string() }) })
    const { truncated } = guardOutput({ vendor: { address: 'y'.repeat(100) } }, schema, limits)
    expect(truncated).toEqual(['vendor.address'])
  })

  it('caps an over-long array and reports the original length', () => {
    const schema = z.object({ skills: z.array(z.string()) })
    const { data, truncated } = guardOutput({ skills: ['a', 'b', 'c', 'd', 'e'] }, schema, limits)
    expect(data.skills).toHaveLength(3)
    expect(truncated[0]).toContain('5 items')
  })

  it('caps strings inside array elements', () => {
    const schema = z.object({ items: z.array(z.object({ description: z.string() })) })
    const { data, truncated } = guardOutput(
      { items: [{ description: 'z'.repeat(100) }] },
      schema,
      limits,
    )
    expect(data.items[0]!.description).toHaveLength(20)
    expect(truncated).toEqual(['items[0].description'])
  })

  it('reports every truncation rather than only the first', () => {
    // Silent truncation is the failure being prevented; reporting one of three
    // would reintroduce most of it.
    const schema = z.object({ a: z.string(), b: z.string() })
    const { truncated } = guardOutput({ a: 'x'.repeat(50), b: 'y'.repeat(50) }, schema, limits)
    expect(truncated).toEqual(['a', 'b'])
  })

  it('rejects output nested deeper than the limit', () => {
    const deep = z.object({ a: z.object({ b: z.object({ c: z.object({ d: z.string() }) }) }) })
    expect(() =>
      guardOutput({ a: { b: { c: { d: 'ok' } } } }, deep, { ...limits, maxDepth: 2 }),
    ).toThrow(OutputRejected)
  })

  it('leaves null and numbers alone', () => {
    const schema = z.object({ due: z.string().nullable(), total: z.number() })
    const { data } = guardOutput({ due: null, total: 42.5 }, schema, limits)
    expect(data).toEqual({ due: null, total: 42.5 })
  })

  it('has defaults generous enough for a real document', () => {
    // A long role summary or a multi-line address must not be clipped by the
    // guard -- it is there for runaway output, not for ordinary content.
    const schema = z.object({ summary: z.string() })
    const realistic = 'A sentence about a role. '.repeat(100) // ~2500 chars
    const { truncated } = guardOutput({ summary: realistic }, schema, DEFAULT_OUTPUT_LIMITS)
    expect(truncated).toEqual([])
  })
})
