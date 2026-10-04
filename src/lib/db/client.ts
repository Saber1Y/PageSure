import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { resolve } from 'node:path'
import * as schema from './schema'

/**
 * Single long-running Node process by design.
 *
 * MPP's `Store` requires a linearizable compare-and-set for charge dedup and channel
 * cumulative monotonicity. `Store.memory()` satisfies that within one process. Running
 * multiple instances with `Store.memory()` silently loses replay protection and
 * monotonicity, because each instance has its own state. See README.
 */

const DEFAULT_URL = './data/pagesure.db'

function databasePath(): string {
  const url = process.env.DATABASE_URL ?? DEFAULT_URL
  return url.startsWith('file:') ? url.slice('file:'.length) : url
}

let instance: ReturnType<typeof create> | null = null

function create() {
  const path = resolve(process.cwd(), databasePath())
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  return drizzle(sqlite, { schema })
}

export function db() {
  if (!instance) instance = create()
  return instance
}

/**
 * Close the database, if one was ever opened.
 *
 * Only the proof scripts need this. They delete their scratch database on the way out, and
 * deleting the main file out from under an open handle leaves the `-wal` and `-shm` sidecars
 * behind on disk - so the next run starts against a database whose journal belongs to a
 * database that no longer exists. Closing first is the difference between cleaning up and
 * appearing to clean up.
 */
export function closeDatabase(): void {
  if (!instance) return
  instance.$client.close()
  instance = null
}

export type Db = ReturnType<typeof db>
export { schema }