/**
 * Recovers JSON from output that is nearly JSON (FR-4.4).
 *
 * Constrained decoding makes this rare on Ollama, but it is not the only path:
 * a model with no schema support, a response cut off at a token ceiling, or a
 * model that wraps its answer in a code fence all produce text that is one
 * mechanical fix away from parsing.
 *
 * The rule throughout is **never invent a value.** Every repair here is
 * structural — closing a bracket the model did not reach, dropping a fence it
 * added, discarding a trailing fragment. Nothing fills in a field. Guessing at a
 * missing value would produce output that validates and is wrong, which is the
 * one failure mode this project consistently treats as worse than an error.
 */

export interface RepairResult {
  value: unknown
  /** Which repairs were applied, in order. Empty means it parsed as-is. */
  applied: string[]
}

export class UnrepairableJson extends Error {
  constructor(
    readonly text: string,
    readonly attempted: string[],
  ) {
    super(
      `Could not recover JSON after ${attempted.length} attempt(s): ${attempted.join(', ') || 'none applicable'}`,
    )
    this.name = 'UnrepairableJson'
  }
}

export function repairJson(raw: string): RepairResult {
  const applied: string[] = []

  const direct = tryParse(raw)
  if (direct.ok) return { value: direct.value, applied }

  let text = raw

  // 1. Code fences. A model told to return JSON often returns it in markdown.
  const fenced = stripCodeFence(text)
  if (fenced !== text) {
    text = fenced
    applied.push('removed code fence')
    const parsed = tryParse(text)
    if (parsed.ok) return { value: parsed.value, applied }
  }

  // 2. Prose on either side. "Here is the JSON you asked for: {...}" — the
  //    braces are the answer, the sentence is not.
  const sliced = sliceToOutermostJson(text)
  if (sliced !== null && sliced !== text) {
    text = sliced
    applied.push('discarded surrounding prose')
    const parsed = tryParse(text)
    if (parsed.ok) return { value: parsed.value, applied }
  }

  // 3. Trailing commas, which are valid in JavaScript and not in JSON.
  const decommaed = removeTrailingCommas(text)
  if (decommaed !== text) {
    text = decommaed
    applied.push('removed trailing comma')
    const parsed = tryParse(text)
    if (parsed.ok) return { value: parsed.value, applied }
  }

  // 4. Truncation: the model stopped mid-structure. Close what is open and drop
  //    whatever fragment it was in the middle of writing.
  const closed = closeTruncated(text)
  if (closed !== null) {
    applied.push('closed truncated structure')
    const parsed = tryParse(closed)
    if (parsed.ok) return { value: parsed.value, applied }
  }

  throw new UnrepairableJson(raw, applied)
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function stripCodeFence(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (match?.[1]) return match[1].trim()
  // An opening fence with no closing one, which a truncated response produces.
  const open = text.match(/```(?:json)?\s*([\s\S]*)$/i)
  return open?.[1]?.trim() ?? text
}

/**
 * Takes the span from the first `{` or `[` to its matching close.
 *
 * String-aware, because a brace inside a value — an address, a note — would
 * otherwise throw the depth count off and truncate a valid document.
 */
function sliceToOutermostJson(text: string): string | null {
  const start = text.search(/[{[]/)
  if (start === -1) return null

  const opener = text[start]!
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const char = text[i]!

    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (char === opener) depth++
    else if (char === closer) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  // Unbalanced: everything from the first brace on, for closeTruncated to finish.
  return text.slice(start)
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1')
}

/**
 * Closes a structure the model never finished.
 *
 * Walks the text tracking open brackets and whether we are inside a string. An
 * unterminated string is cut back to before it started rather than closed, since
 * closing it would keep a half-written value — `"Acme Suppli` becoming a real
 * field value is the kind of plausible wrongness this file exists to avoid.
 */
function closeTruncated(text: string): string | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  /** Index of the key or value currently being written, to cut back to. */
  let lastCleanBoundary = -1

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!

    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']')
    else if (char === '}' || char === ']') stack.pop()
    else if (char === ',') lastCleanBoundary = i
  }

  if (stack.length === 0 && !inString) return null

  let body = text
  if (inString) {
    // Mid-string: drop back to the last complete entry.
    if (lastCleanBoundary === -1) return null
    body = text.slice(0, lastCleanBoundary)
    // Recount, because cutting may have closed structures.
    return closeFrom(body)
  }

  // Mid-structure but not mid-string: a dangling key or comma may remain.
  body = body.replace(/,\s*$/, '').replace(/"[^"]*"\s*:\s*$/, '').replace(/,\s*$/, '')
  return body + stack.reverse().join('')
}

function closeFrom(body: string): string | null {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (const char of body) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']')
    else if (char === '}' || char === ']') stack.pop()
  }

  if (inString) return null
  return body + stack.reverse().join('')
}
