/**
 * Migration safety for databases that already have data in them.
 *
 * Everything else in this repository's proofs builds a database from empty and then exercises
 * application logic. That shape cannot see the failure this file exists for: a migration that is
 * correct on an empty database and silently destructive on a populated one.
 *
 * The specific hazard here is the introduction of `organization_members`. `currentUser()`
 * authorizes a session by joining that table, so an upgrade that creates the table without
 * backfilling it leaves every pre-existing tenant user signed in, holding a valid session, and
 * locked out of every page - a redirect loop between /login and the dashboard, with no error and
 * no log line to explain it. Creating the table and migrating the data into it are one task, and
 * this proof fails if they ever come apart again.
 *
 * So this runs the real chain against a database seeded at the last pre-membership migration,
 * then checks three things a naive migration gets wrong:
 *
 *   - rows that exist before the upgrade still exist after it
 *   - every user who had a tenant now has a membership, carrying the role they actually had
 *   - a user with no tenant still has none, because inventing access is worse than losing it
 *
 * Runs against a throwaway database. Nothing here touches a real one.
 */

import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'

const SCRATCH = './data/migration-upgrade-proof.db'

// Removed before the script imports anything that opens a database handle. The WAL and SHM
// sidecars go too: better-sqlite3 checkpoints into them, so deleting only the main file leaves
// the previous run's data sitting next to the new database.
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(`${SCRATCH}${suffix}`)) rmSync(`${SCRATCH}${suffix}`)
}

process.env.DATABASE_URL = SCRATCH

/**
 * Apply the migrations that predate `organization_members`, and record them in the ledger.
 *
 * The ledger matters as much as the SQL. `runMigrations()` decides what still needs applying by
 * comparing journal entries against `__drizzle_migrations`, so seeding the schema without the
 * hashes would make the next run replay 0000 against a database that already has it - which fails
 * with "table already exists" long before reaching the interesting part.
 */
async function seedPreMembershipSchema(): Promise<string[]> {
  const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')) as {
    entries: Array<{ tag: string; when: number }>
  }
  const membershipMigration = journal.entries.findIndex((entry) =>
    entry.tag.includes('bumpy_lilandra'),
  )
  if (membershipMigration < 0) {
    throw new Error('cannot locate the organization_members migration in the journal')
  }

  const { default: Database } = await import('better-sqlite3')
  const database = new Database(SCRATCH)
  // Drizzle creates this table itself on its first run, so it does not exist yet in a database
  // that has never been migrated. Created here with the same shape it would have used.
  database.exec(
    'create table __drizzle_migrations (id integer primary key autoincrement, hash text not null, created_at numeric)',
  )
  const applied: string[] = []
  for (const entry of journal.entries.slice(0, membershipMigration)) {
    const sql = readFileSync(`./drizzle/${entry.tag}.sql`, 'utf8')
    database
      .prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)')
      .run(createHash('sha256').update(sql).digest('hex'), entry.when)
    database.exec(sql)
    applied.push(entry.tag)
  }
  database.close()
  return applied
}

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`)
  }
}

/** A syntactically plausible settlement address; the upgrade never validates it. */
const RECIPIENT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

const seedTag = await seedPreMembershipSchema()

const { default: Database } = await import('better-sqlite3')
{
  const database = new Database(SCRATCH)
  const org = database.prepare(
    'insert into organizations (id, name, settlement_recipient, created_at) values (?, ?, ?, ?)',
  )
  org.run('org_live', 'Live Co', RECIPIENT, 1000)
  org.run('org_other', 'Other Co', RECIPIENT, 1000)

  const user = database.prepare(
    'insert into users (id, organization_id, email, display_name, role, created_at) values (?, ?, ?, ?, ?, ?)',
  )
  user.run('usr_owner', 'org_live', 'owner@acme.co', 'Owner', 'owner', 1000)
  user.run('usr_operator', 'org_live', 'op@acme.co', 'Op', 'operator', 1500)
  user.run('usr_analyst', 'org_other', 'an@acme.co', 'An', 'analyst', 1500)
  // Signed in, proven address, nowhere to belong yet: an unaccepted invitation.
  user.run('usr_tenantless', null, 'new@acme.co', 'New', 'operator', 1500)
  database.close()
}

console.log(`upgrading a populated database (through ${seedTag.at(-1)})`)

const { runMigrations } = await import('../src/lib/db/migrate')
const { db } = await import('../src/lib/db/client')
const { organizationMembers, organizations, users } = await import('../src/lib/db/schema')

runMigrations()

console.log('existing rows survive the upgrade')
{
  check('organizations are preserved', db().select().from(organizations).all().length === 2)
  check(
    'settlement accounts are preserved',
    db()
      .select()
      .from(organizations)
      .all()
      .every((o) => o.settlementRecipient === RECIPIENT),
  )
  check('users are preserved', db().select().from(users).all().length === 4)
  check(
    'emails are preserved',
    db()
      .select()
      .from(users)
      .all()
      .some((u) => u.email === 'owner@acme.co'),
  )
}

console.log('memberships are backfilled, because they are what grants access')
{
  const memberships = db().select().from(organizationMembers).all()
  check('a membership exists for every tenant user', memberships.length === 3, `got ${memberships.length}`)

  const roleFor = (userId: string): string | undefined =>
    memberships.find((m) => m.userId === userId)?.role
  const tenantFor = (userId: string): string | undefined =>
    memberships.find((m) => m.userId === userId)?.organizationId

  check('the owner keeps the owner role', roleFor('usr_owner') === 'owner', roleFor('usr_owner'))
  check('the operator keeps the operator role', roleFor('usr_operator') === 'operator')
  check('the analyst keeps the analyst role', roleFor('usr_analyst') === 'analyst')
  check('memberships point at the right organization', tenantFor('usr_analyst') === 'org_other')
  check(
    'backfilled memberships are already accepted',
    memberships.every((m) => m.acceptedAt !== null && m.acceptedAt > 0),
  )
  check(
    'a tenantless user is not given an organization',
    tenantFor('usr_tenantless') === undefined,
    tenantFor('usr_tenantless'),
  )
}

console.log('the upgraded database is internally consistent')
{
  const database = new Database(SCRATCH, { readonly: true })
  const violations = database.pragma('foreign_key_check') as unknown[]
  database.close()
  check('no foreign key violations', violations.length === 0, JSON.stringify(violations))

  const duplicate = db()
    .select()
    .from(organizationMembers)
    .all()
    .filter((m, index, all) => all.findIndex((o) => o.userId === m.userId) !== index)
  check('no user ends up with two memberships in one organization', duplicate.length === 0)
}

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(`${SCRATCH}${suffix}`)) rmSync(`${SCRATCH}${suffix}`)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  failed: ${name}`)
  process.exit(1)
}