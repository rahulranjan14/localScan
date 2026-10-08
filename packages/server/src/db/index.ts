/**
 * The storage layer, exported for the worker.
 *
 * The worker runs activities that must write to the same tables the HTTP API
 * writes to. Re-implementing the SQL there would give two places for the schema
 * to drift from, so the repositories are shared and the worker imports them
 * rather than owning queries of its own.
 */
export * from '../repositories/files.js'
export * from '../repositories/documents.js'
export * from '../repositories/chunks.js'
export { pool, closePool } from './pool.js'
