import type { z } from 'zod'

/**
 * Last check before anything is persisted (FR-11.3).
 *
 * The schemas already cap individual strings, so this is deliberately redundant.
 * It exists because the cap that matters is the one that holds when a schema
 * forgets: a new document type added by someone following the three-file recipe
 * will not necessarily put `.max()` on every field, and the consequence of
 * missing one is a model writing megabytes into a JSONB column.
 *
 * Defence in depth is the right shape here precisely because adding document
 * types is supposed to be easy — easy to add means easy to add incompletely.
 */

export interface OutputLimits {
  /** Generous for an address or a role summary, far below a runaway. */
  maxStringLength: number
  maxArrayLength: number
  /** Catches a model that nests rather than one that repeats. */
  maxDepth: number
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  maxStringLength: 8_000,
  maxArrayLength: 500,
  maxDepth: 12,
}

export interface OutputGuardResult<T> {
  data: T
  /** Paths that were cut, for logging. Silent truncation would be worse. */
  truncated: string[]
}

export class OutputRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutputRejected'
  }
}

/**
 * Validates against the schema, then caps.
 *
 * In that order on purpose: validating first means the shape is known before
 * walking it, and a value that fails validation is never persisted at all — so
 * capping it would be work in service of something already rejected.
 */
export function guardOutput<T>(
  data: unknown,
  schema: z.ZodType<T>,
  limits: OutputLimits = DEFAULT_OUTPUT_LIMITS,
): OutputGuardResult<T> {
  const parsed = schema.parse(data)
  const truncated: string[] = []
  const capped = cap(parsed, limits, truncated, '', 0)
  return { data: capped as T, truncated }
}

function cap(
  value: unknown,
  limits: OutputLimits,
  truncated: string[],
  path: string,
  depth: number,
): unknown {
  if (depth > limits.maxDepth) {
    throw new OutputRejected(
      `Output nests deeper than ${limits.maxDepth} levels at "${path}", which no document schema here requires.`,
    )
  }

  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength) {
      truncated.push(path || '(root)')
      return value.slice(0, limits.maxStringLength)
    }
    return value
  }

  if (Array.isArray(value)) {
    const items = value.length > limits.maxArrayLength ? value.slice(0, limits.maxArrayLength) : value
    if (items.length !== value.length) truncated.push(`${path}[] (${value.length} items)`)
    return items.map((item, index) => cap(item, limits, truncated, `${path}[${index}]`, depth + 1))
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        cap(child, limits, truncated, path ? `${path}.${key}` : key, depth + 1),
      ]),
    )
  }

  return value
}
