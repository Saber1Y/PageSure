import { existsSync, rmSync } from 'node:fs'
import { closeDatabase } from '../src/lib/db/client'

/**
 * Tear down a proof's scratch database.
 *
 * The database is closed first, which is the part that matters. better-sqlite3 runs in WAL mode,
 * so an open handle keeps a `-wal` and an `-shm` sidecar next to the main file. Deleting only the
 * main file leaves those behind, and the next run then starts against a database whose journal
 * belongs to a database that no longer exists - which passes, silently, because SQLite recovers
 * from it.
 *
 * Called before the run as well as after, so a proof that failed partway through cannot poison
 * the one after it.
 */
export function closeScratchDatabase(path: string): void {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${path}${suffix}`
    if (existsSync(file)) rmSync(file)
  }
}