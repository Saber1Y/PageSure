import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve } from 'node:path'
import { db } from './client'

const target = db()
migrate(target, { migrationsFolder: resolve(process.cwd(), 'drizzle') })
console.log('migrations applied')