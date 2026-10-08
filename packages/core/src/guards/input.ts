/**
 * Validation that runs before anything parses the file.
 *
 * Deliberately implemented without a PDF library (FR-1.2). The usual shape of a
 * PDF vulnerability is a malformed document that crashes or exploits the parser,
 * so the checks that decide whether to parse at all must not themselves parse.
 * Magic bytes, a length, and a count of page objects are enough to reject the
 * obvious cases, and all three are byte inspection.
 */

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // "%PDF-"

export interface InputLimits {
  maxBytes: number
  maxPages: number
}

export const DEFAULT_INPUT_LIMITS: InputLimits = {
  /** 32 MB. Large enough for a long scanned document, small enough to bound memory. */
  maxBytes: 32 * 1024 * 1024,
  maxPages: 200,
}

export type InputRejectionReason =
  | 'empty'
  | 'not_a_pdf'
  | 'too_large'
  | 'too_many_pages'

export class InputRejected extends Error {
  constructor(
    readonly reason: InputRejectionReason,
    message: string,
  ) {
    super(message)
    this.name = 'InputRejected'
  }
}

/**
 * Counts `/Type /Page` markers without parsing.
 *
 * This is an estimate and is only ever used as an upper-bound guard, never as
 * the real page count -- a document can legitimately contain the string inside
 * a stream. Over-counting rejects a file that might have been fine; the
 * alternative is running a parser on input we have not yet accepted.
 */
function estimatePageCount(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString('latin1')
  const matches = text.match(/\/Type\s*\/Page[^s]/g)
  return matches?.length ?? 0
}

export function validatePdfInput(
  bytes: Uint8Array,
  limits: InputLimits = DEFAULT_INPUT_LIMITS,
): void {
  if (bytes.byteLength === 0) {
    throw new InputRejected('empty', 'The file is empty.')
  }

  if (bytes.byteLength > limits.maxBytes) {
    const mb = (bytes.byteLength / 1024 / 1024).toFixed(1)
    const capMb = (limits.maxBytes / 1024 / 1024).toFixed(0)
    throw new InputRejected('too_large', `The file is ${mb} MB; the limit is ${capMb} MB.`)
  }

  const header = bytes.subarray(0, PDF_MAGIC.length)
  if (!PDF_MAGIC.every((byte, i) => header[i] === byte)) {
    throw new InputRejected('not_a_pdf', 'The file does not begin with %PDF-, so it is not a PDF.')
  }

  const pages = estimatePageCount(bytes)
  if (pages > limits.maxPages) {
    throw new InputRejected(
      'too_many_pages',
      `The document appears to have ${pages} pages; the limit is ${limits.maxPages}.`,
    )
  }
}
