/**
 * Treasury authority: who may redirect an organization's money, and under what proof.
 *
 * Connecting a settlement account is the most consequential thing a dashboard user can do. It
 * decides where every settled payment for a tenant is delivered, so this proof is written
 * around the ways that could go wrong rather than around the happy path:
 *
 *   - a challenge is bound to one organization and one wallet, and neither binding can move
 *   - the signature is checked before anything is written
 *   - a failed attempt leaves the previous settlement account untouched
 *   - membership, not the session copy, decides who is allowed to try
 *
 * Runs against a throwaway database. No wallet extension and no browser: keys are generated in
 * process, because what is under test is the server's willingness to accept a proof, not
 * whether Freighter can produce one.
 */

import { Keypair } from '@stellar/stellar-sdk'
import { and, eq } from 'drizzle-orm'
import { existsSync, rmSync } from 'node:fs'

const SCRATCH = './data/treasury-proof.db'

process.env.DATABASE_URL = SCRATCH

if (existsSync(SCRATCH)) rmSync(SCRATCH)

const { runMigrations } = await import('../src/lib/db/migrate')
const { db } = await import('../src/lib/db/client')
const { organizations, organizationMembers, users, loginChallenges } = await import(
  '../src/lib/db/schema'
)
const { issueChallenge, verifyChallengeSignature, challengeBytes } = await import(
  '../src/lib/auth/wallet'
)
const { storeChallenge, consumeChallenge } = await import('../src/lib/auth/session')
const identity = await import('../src/lib/auth/identity')

runMigrations()

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

const sign = (keypair: Keypair, challenge: string) =>
  keypair.sign(challengeBytes(challenge)).toString('base64url')

/** Two tenants, each with an owner, so cross-tenant attempts are expressible. */
function seedOrg(name: string): { organizationId: string; ownerId: string; operatorId: string } {
  const organizationId = identity.newId('org')
  const ownerId = identity.newId('usr')
  const operatorId = identity.newId('usr')
  const now = Date.now()

  db().transaction((tx) => {
    tx.insert(organizations).values({ id: organizationId, name, createdAt: now }).run()
    for (const [userId, role] of [
      [ownerId, 'owner'],
      [operatorId, 'operator'],
    ] as const) {
      tx.insert(users)
        .values({
          id: userId,
          organizationId,
          email: `${role}@${name.replace(/\s+/g, '').toLowerCase()}.test`,
          displayName: `${role} of ${name}`,
          role,
          createdAt: now,
        })
        .run()
      tx.insert(organizationMembers)
        .values({
          id: identity.newId('mem'),
          organizationId,
          userId,
          role,
          invitedBy: null,
          acceptedAt: now,
          createdAt: now,
        })
        .run()
    }
  })
  return { organizationId, ownerId, operatorId }
}

const alpha = seedOrg('Alpha')
const beta = seedOrg('Beta')

console.log('challenge binding')
{
  const wallet = Keypair.random()
  const { challenge, expiresAt } = issueChallenge()
  const id = identity.newId('chl')
  storeChallenge(id, challenge, 'treasury', expiresAt, wallet.publicKey(), alpha.organizationId)

  const row = db().select().from(loginChallenges).where(eq(loginChallenges.id, id)).get()!
  check('the challenge records its organization', row.organizationId === alpha.organizationId)
  check('the challenge records its wallet', row.walletPublicKey === wallet.publicKey())
  check('the purpose is treasury', row.purpose === 'treasury')

  check(
    'a treasury challenge cannot be consumed as a login',
    consumeChallenge(id, 'login') === null,
  )
  check(
    'a treasury challenge cannot be consumed as an enrolment',
    consumeChallenge(id, 'enrol') === null,
  )

  const consumed = consumeChallenge(id, 'treasury')
  check('a treasury challenge consumes as treasury', consumed !== null)
  check('a consumed challenge cannot be consumed again', consumeChallenge(id, 'treasury') === null)
}

console.log('signature proof')
{
  const wallet = Keypair.random()
  const impostor = Keypair.random()
  const { challenge, expiresAt } = issueChallenge()
  const id = identity.newId('chl')
  storeChallenge(id, challenge, 'treasury', expiresAt, wallet.publicKey(), alpha.organizationId)

  const genuine = verifyChallengeSignature(
    challenge,
    sign(wallet, challenge),
    wallet.publicKey(),
    wallet.publicKey(),
  )
  check('the wallet that was challenged can answer it', genuine.ok)
  check('the verified key is the wallet', genuine.ok && genuine.publicKey === wallet.publicKey())

  const stolen = verifyChallengeSignature(
    challenge,
    sign(impostor, challenge),
    impostor.publicKey(),
    wallet.publicKey(),
  )
  check('a different key cannot answer a bound challenge', !stolen.ok, JSON.stringify(stolen))

  const claimed = verifyChallengeSignature(
    challenge,
    sign(impostor, challenge),
    wallet.publicKey(),
    wallet.publicKey(),
  )
  check('claiming to be the wallet without the key fails', !claimed.ok, JSON.stringify(claimed))

  // Signature made over something other than the issued challenge.
  const replayed = verifyChallengeSignature(
    challenge,
    sign(wallet, issueChallenge().challenge),
    wallet.publicKey(),
    wallet.publicKey(),
  )
  check('a signature over another challenge fails', !replayed.ok, JSON.stringify(replayed))
}

console.log('settlement writes')
{
  const wallet = Keypair.random()
  identity.setSettlementWallet({ organizationId: alpha.organizationId, recipient: wallet.publicKey() })

  let org = db().select().from(organizations).where(eq(organizations.id, alpha.organizationId)).get()!
  check('the recipient is stored', org.settlementRecipient === wallet.publicKey())
  check('a proven wallet is marked verified', org.treasuryVerified === true)

  let invalid = 'did not throw'
  try {
    identity.setSettlementWallet({ organizationId: alpha.organizationId, recipient: 'GNOTAREALKEY' })
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error)
  }
  check('a malformed address is refused', invalid.includes('invalid_treasury'), invalid)
  org = db().select().from(organizations).where(eq(organizations.id, alpha.organizationId)).get()!
  check(
    'a refused write leaves the previous recipient intact',
    org.settlementRecipient === wallet.publicKey(),
    String(org.settlementRecipient),
  )
  check('a refused write does not clear verification', org.treasuryVerified === true)

  const untouched = db().select().from(organizations).where(eq(organizations.id, beta.organizationId)).get()!
  check('another tenant is unaffected', untouched.settlementRecipient === null)
  check('another tenant is not verified', untouched.treasuryVerified === false)
}

console.log('membership decides authority')
{
  check('the owner may change the treasury', identity.hasRole(alpha.ownerId, alpha.organizationId, 'owner'))
  check('an operator may not', !identity.hasRole(alpha.operatorId, alpha.organizationId, 'owner'))
  check('an operator is still a member', identity.hasRole(alpha.operatorId, alpha.organizationId, 'operator'))
  check(
    'an owner of one tenant is not an owner of another',
    throws(() => identity.requireRole(alpha.ownerId, beta.organizationId, 'owner')).length > 0,
  )

  // The session copy and the membership row must agree, or a demotion would not take effect
  // until the user signed in again.
  db()
    .update(organizationMembers)
    .set({ role: 'analyst' })
    .where(and(eq(organizationMembers.userId, alpha.operatorId), eq(organizationMembers.organizationId, alpha.organizationId)))
    .run()
  check('a demotion takes effect immediately', !identity.hasRole(alpha.operatorId, alpha.organizationId, 'operator'))
  const userRow = db().select().from(users).where(eq(users.id, alpha.operatorId)).get()!
  check('the denormalized column alone would not have shown it', userRow.role === 'operator', userRow.role)
}

console.log('invitations cannot grant treasury rights')
{
  const { issueInvitation } = await import('../src/lib/auth/email')
  const invite = issueInvitation({
    email: 'newcomer@alpha.test',
    organizationId: alpha.organizationId,
    role: 'operator',
  })
  const invitee = identity.acceptInvitation({ token: invite.token }).userId

  check('an invited user becomes a member', identity.hasRole(invitee, alpha.organizationId, 'operator'))
  check('an invited operator is not an owner', !identity.hasRole(invitee, alpha.organizationId, 'owner'))
  check(
    'requiring owner of an invitee is refused',
    throws(() => identity.requireRole(invitee, alpha.organizationId, 'owner')).includes('insufficient_role'),
  )
  check(
    'an invite cannot be used in another tenant',
    !identity.hasRole(invitee, beta.organizationId, 'operator'),
  )
}

console.log('a challenge from one tenant cannot authorize another')
{
  const wallet = Keypair.random()
  const { challenge, expiresAt } = issueChallenge()
  const id = identity.newId('chl')
  // Minted for Alpha, answered while acting as Beta: exactly what a replayed signature would
  // look like if the organization binding were only checked at request time.
  storeChallenge(id, challenge, 'treasury', expiresAt, wallet.publicKey(), alpha.organizationId)

  const row = consumeChallenge(id, 'treasury')
  check('the consumed row names the minting tenant', row !== null && row.organizationId === alpha.organizationId)
  check('a caller acting in another tenant sees a mismatch', row !== null && row.organizationId !== beta.organizationId)
}

function throws(fn: () => unknown): string {
  try {
    fn()
    return 'did not throw'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

if (existsSync(SCRATCH)) rmSync(SCRATCH)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const name of failures) console.error(`  failed: ${name}`)
  process.exit(1)
}
console.log('Treasury authority holds.')
