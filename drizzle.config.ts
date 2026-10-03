import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'drizzle-kit'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? './data/pagesure.db',
  },
  verbose: true,
  strict: true,
})