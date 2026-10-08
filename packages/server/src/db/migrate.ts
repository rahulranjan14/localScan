/**
 * Migration runner: ordered .sql files, each applied once, inside a transaction.
 *
 * No migration framework. For a single-developer local application the whole
 * requirement is "run these files in order, once each, and stop on failure",
 * which is this file. A framework would add a dependency, a config file and a
 * CLI to learn in exchange for features -- branching histories, multi-tenant
 * schemas, generated rollbacks -- that nothing here uses.
 *
 *   npm run migrate -w @ocr/server
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closePool, pool } from './pool.js'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

export async function migrate(): Promise<string[]> {
  await ensureMigrationsTable()

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations')
  const applied = new Set(rows.map((r) => r.name))

  const ran: string[] = []

  for (const file of files) {
    if (applied.has(file)) continue

    const sql = await readFile(join(migrationsDir, file), 'utf8')
    const client = await pool.connect()
    try {
      // DDL is transactional in Postgres, so a migration that fails halfway
      // leaves no partial schema behind.
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
      ran.push(file)
    } catch (error) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : error}`, {
        cause: error,
      })
    } finally {
      client.release()
    }
  }

  return ran
}

// Run directly rather than imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const ran = await migrate()
    console.log(ran.length === 0 ? 'Schema already up to date.' : `Applied: ${ran.join(', ')}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await closePool()
  }
}
