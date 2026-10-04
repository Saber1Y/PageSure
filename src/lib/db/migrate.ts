import type { Database } from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve } from 'node:path'
import { db } from './client'

/**
 * Apply pending migrations, then prove the result.
 *
 * Foreign keys are disabled on the connection for the duration, and this is not a
 * convenience. Changing a column's nullability in SQLite means rebuilding the table:
 * drizzle creates a `__new_` copy, copies rows across, drops the original, and renames. That
 * `DROP TABLE` is an implicit `DELETE FROM`, and with foreign keys enabled it fires
 * `ON DELETE CASCADE` into every child table.
 *
 * The damage is invisible in a migration test on an empty database, which is exactly why it
 * survives. On a populated one, the run reports success and leaves `users`, `services` and
 * `activity_events` empty, because `organizations` had children at the moment it was dropped.
 *
 * `PRAGMA foreign_keys` is documented as a no-op inside a transaction, and drizzle's migrator
 * wraps every batch in one. Emitting the pragma as migration SQL therefore does nothing: the
 * generated file asks for foreign keys off, the connection ignores it, and the cascade fires.
 * The only place the setting can still take effect is before the transaction opens, so it is
 * set here, on the connection, rather than in the SQL.
 *
 * Integrity is then re-established and checked in the same step, so a migration that leaves
 * dangling references fails loudly instead of surfacing later as a missing row in production.
 */
export function runMigrations(migrationsFolder = resolve(process.cwd(), 'drizzle')) {
  const target = db()
  const sqlite = target.$client as Database

  sqlite.pragma('foreign_keys = OFF')
  try {
    migrate(target, { migrationsFolder })
    sqlite.pragma('foreign_keys = ON')
    const violations = sqlite.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) {
      throw new Error(
        `migration left ${violations.length} broken foreign key reference(s); first: ${JSON.stringify(violations[0])}`,
      )
    }
  } catch (error) {
    // Restore enforcement even on failure: a connection left with foreign keys off would
    // silently accept orphaned writes for the rest of the process's life.
    sqlite.pragma('foreign_keys = ON')
    throw error
  }
}

// Only apply when executed directly, so proving scripts can import runMigrations from here
// without this file applying the migrations a second time as a side effect of importing.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  runMigrations()
  console.log('migrations applied')
}