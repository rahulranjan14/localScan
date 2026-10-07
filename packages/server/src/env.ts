import { existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { config } from 'dotenv'

/**
 * Side-effect module: loads .env, once, for whichever entry point ran.
 *
 * It lives on its own and is imported first by both the config module and the
 * database pool, because the two have no import relationship -- the migration
 * runner touches only the pool. Loading .env inside just one of them means the
 * migrate script silently ignores DATABASE_URL from the file while the server
 * honours it, and that inconsistency is very hard to see from the symptom.
 */

/**
 * The file is searched for upwards from the working directory, rather than being
 * read from it.
 *
 * npm runs a workspace script with its cwd set to that package, so `npm run dev`
 * starts the server in packages/server -- where dotenv's default lookup finds
 * nothing, and the root .env the user actually edited is ignored. The symptom is
 * the worst kind: no error, just defaults quietly winning. Walking up finds one
 * .env for the whole workspace regardless of which package was invoked.
 */
function findEnvFile(from: string = process.cwd()): string | null {
  const { root } = parse(from)
  let directory = from

  while (true) {
    const candidate = join(directory, '.env')
    if (existsSync(candidate)) return candidate
    if (directory === root) return null
    directory = dirname(directory)
  }
}

const envFile = findEnvFile()

if (envFile) {
  // `override: false` keeps a real environment variable ahead of the file, so
  // OLLAMA_BASE_URL=... npm run dev still wins.
  config({ path: envFile, override: false, quiet: true })
}

/** Exported so startup can report which file was used, or that none was found. */
export const loadedEnvFile = envFile
