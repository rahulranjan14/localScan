import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { UiSchemaSchema, type UiSchema } from '@ocr/shared'

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
const uiCache = new Map<string, UiSchema | null>()

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
  uiCache.clear()
}

/**
 * Form layouts live beside prompts and schemas, as JSON on disk.
 *
 * Loaded per request rather than stored per document. Storing a copy on each
 * document would freeze the layout at extraction time, so editing `ui.json`
 * would change nothing for anything already processed -- which defeats the point
 * of the layout being data. One file per type, read fresh, is the behaviour the
 * design intends.
 */
export async function loadUiSchema(slug: string): Promise<UiSchema | null> {
  const cached = uiCache.get(slug)
  if (cached !== undefined) return cached

  const path = join(documentsDir(), slug, 'ui.json')
  let parsed: UiSchema | null
  try {
    parsed = UiSchemaSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    // A missing layout is legitimate: `generic` has none, by design (FR-5.7).
    // A malformed one is not, and must not be silently treated as absent.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      parsed = null
    } else {
      throw new Error(`Form layout for "${slug}" at ${path} is not valid`, { cause: error })
    }
  }

  uiCache.set(slug, parsed)
  return parsed
}

/**
 * The classifier prompt is a single file at the root of `documents/`, not inside
 * a type directory, because it is not owned by any one type -- it is what chooses
 * between them.
 */
export async function loadClassifierPrompt(): Promise<string> {
  return loadRootPrompt('_classifier')
}

/** The page-transcription prompt, shared by every document type. */
export async function loadOcrPrompt(): Promise<string> {
  return loadRootPrompt('_ocr')
}

async function loadRootPrompt(name: string): Promise<string> {
  const cached = cache.get(name)
  if (cached !== undefined) return cached

  const path = join(documentsDir(), `${name}.md`)
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (cause) {
    throw new Error(`Prompt not found at ${path}`, { cause })
  }

  cache.set(name, contents)
  return contents
}
