import { config } from 'dotenv'

/**
 * Side-effect module: loads .env, once, for whichever entry point ran.
 *
 * It lives on its own and is imported first by both the config module and the
 * database pool, because the two have no import relationship -- the migration
 * runner touches only the pool. Loading .env inside just one of them means
 * `npm run migrate` silently ignores DATABASE_URL from the file while the server
 * honours it, and that inconsistency is very hard to see from the symptom.
 *
 * `override: false` keeps a real environment variable ahead of the file, so
 * OLLAMA_BASE_URL=... npm run dev still wins.
 */
config({ override: false, quiet: true })
