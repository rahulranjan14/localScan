import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/**
 * Prompts are markdown on disk, not string literals in the source (FR-4.2).
 *
 * The reason is that tuning a prompt is the highest-frequency change in a system
 * like this, and it should not require a rebuild, a release, or a developer. The
 * cost is that the directory has to be found at runtime.
 */

const here = dirname(fileURLToPath(import.meta.url))

/** packages/core/dist/documents → repo root. */
const DEFAULT_DOCUMENTS_DIR = resolve(here, '../../../..', 'documents')

export function documentsDir(): string {
  return process.env.OCR_DOCUMENTS_DIR ?? DEFAULT_DOCUMENTS_DIR
}

const cache = new Map<string, string>()

export async function loadPrompt(slug: string): Promise<string> {
  const cached = cache.get(slug)
  if (cached !== undefined) return cached

  const path = join(documentsDir(), slug, 'prompt.md')
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (cause) {
    throw new Error(`No prompt found for document type "${slug}" at ${path}`, { cause })
  }

  cache.set(slug, contents)
  return contents
}

/** Used by tests and by the eval harness, which edits prompts between runs. */
export function clearPromptCache(): void {
  cache.clear()
}
