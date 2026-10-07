import pg from 'pg'

/**
 * Postgres is expected on loopback (FR-11.5). The connection string is
 * configurable, but the default points at localhost rather than anything that
 * could reach another machine by accident.
 */
export const DATABASE_URL =
  process.env.DATABASE_URL ?? `postgres://localhost:5432/${process.env.PGDATABASE ?? 'ocr'}`

/**
 * `numeric` arrives as a string because it can hold values no JS number can
 * represent. Every numeric in this schema is a money amount from a document, all
 * well inside a double, so parsing is safe here -- and leaving it as a string
 * would silently turn every total in the API into text.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value))
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value))

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  // One user, a handful of concurrent requests. A large pool on a local tool
  // just holds idle connections open.
  max: 8,
  idleTimeoutMillis: 30_000,
})

export async function closePool(): Promise<void> {
  await pool.end()
}
