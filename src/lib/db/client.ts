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

export type Db = ReturnType<typeof db>
export { schema }