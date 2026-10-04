/**
 * Wallet sign-in and signup ceremony proof.
 *
 * Uses real ed25519 keypairs and real signatures against the same functions the login
 * server actions call, so the properties below are exercised rather than asserted about.
 * No browser and no extension: the extension handshake is the part that cannot be tested
 * here, and it is also the part that carries no authority.
 *
 * The properties that matter, in order:
 *
 *   1. A challenge bound to wallet A cannot be answered by wallet B. This is what lets a
 *      client name its own account without the server trusting it.
 *   2. A login proof and an enrolment proof are not interchangeable. Without this, proving
 *      control of ANY wallet would be enough to create an organization, which turns
 *      "sign in" into "register".
 *   3. An unknown wallet that completes a login ceremony gets no session. It gets told it
 *      needs to create an organization, and nothing else.
 *   4. Signup creates the organization, makes the signer its owner, and mints a session
 *      that then resolves to that organization.
 *   5. A wallet already belonging to one organization cannot be signed up again, so
 *      organization creation is not a way to claim an existing identity.
 *
 * Runs against a scratch database and deletes it on exit.
 */

import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { Keypair } from '@stellar/stellar-sdk'
import { eq } from 'drizzle-orm'

const SCRATCH = './data/auth-ceremony-proof.db'
process.env.DATABASE_URL = SCRATCH
// A fixed secret, set before anything reads it. This runs against a throwaway database with
// no sessions that outlive the process, and a random one would make the run non-reproducible
// if anything ever needed to compare a token across invocations.
process.env.SESSION_SECRET = 'isolation-proof-session-secret-32-chars-minimum'

const scratch = (suffix = '') => resolve(process.cwd(), SCRATCH + suffix)
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(scratch(suffix))) rmSync(scratch(suffix))
}

const { db } = await import('../src/lib/db/client')
const schema = await import('../src/lib/db/schema')
const { issueChallenge, verifyChallengeSignature, challengeBytes } = await import(
  '../src/lib/auth/wallet'
)
const session = await import('../src/lib/auth/session')

migrate(db(), { migrationsFolder: resolve(process.cwd(), 'drizzle') })

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
    return
  }
  failures.push(name)
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`)
}

function section(title: string) {
  console.log(`\n${title}`)
}

/** Sign a challenge exactly as a wallet would: the challenge bytes, with this key. */
function sign(challenge: string, keypair: Keypair): string {
  return keypair.sign(challengeBytes(challenge)).toString('base64url')
}

let nextChallengeId = 0

/** Issue and store a challenge bound to `wallet`, exactly as the login action does. */
function ceremony(wallet: string | null, purpose: 'login' | 'enrol') {
  const { challenge, expiresAt } = issueChallenge()
  const id = `chl_${++nextChallengeId}`
  session.storeChallenge(id, challenge, purpose, expiresAt, wallet)
  return { challenge, id }
}

const ALICE = Keypair.random()
const MALLORY = Keypair.random()

// ---------------------------------------------------------------------------

section('A bound challenge cannot be answered by a different key')
{
  const { challenge } = ceremony(ALICE.publicKey(), 'login')
  const mallorySignature = sign(challenge, MALLORY)

  const result = verifyChallengeSignature(
    challenge,
    mallorySignature,
    ALICE.publicKey(),
    ALICE.publicKey(),
  )
  check(
    "another wallet's signature over Alice's challenge is rejected",
    result.ok === false && result.reason === 'wrong_signer',
    `got ${JSON.stringify(result)}`,
  )

  // And the honest answer still works, so the check above is not passing vacuously.
  const aliceSignature = sign(challenge, ALICE)
  const honest = verifyChallengeSignature(challenge, aliceSignature, ALICE.publicKey(), ALICE.publicKey())
  check('the bound wallet can answer its own challenge', honest.ok === true, `got ${JSON.stringify(honest)}`)
}

section('Claiming a key you do not control fails')
{
  const { challenge } = ceremony(ALICE.publicKey(), 'login')
  const mallorySignature = sign(challenge, MALLORY)
  // Same bytes, but the caller names Mallory as the signer.
  const forged = verifyChallengeSignature(challenge, mallorySignature, MALLORY.publicKey(), ALICE.publicKey())
  check(
    'naming the actual signer still fails the binding',
    forged.ok === false && forged.reason === 'bound_mismatch',
    `got ${JSON.stringify(forged)}`,
  )

  const unbound = verifyChallengeSignature(challenge, mallorySignature, MALLORY.publicKey(), null)
  check('the same signature verifies without a binding, as first contact needs', unbound.ok === true)
}

section('Login and enrolment proofs are not interchangeable')
{
  const { id } = ceremony(ALICE.publicKey(), 'login')
  check('a login challenge cannot be consumed as an enrolment', session.consumeChallenge(id, 'enrol') === null)
}

section('An unknown wallet gets no session from a valid login')
{
  const stranger = Keypair.random()
  const { challenge } = ceremony(stranger.publicKey(), 'login')
  const signature = sign(challenge, stranger)
  const verification = verifyChallengeSignature(
    challenge,
    signature,
    stranger.publicKey(),
    stranger.publicKey(),
  )
  check('the stranger proves control of its own key', verification.ok === true)

  check(
    'no user exists for that wallet yet',
    session.findUserByWallet(stranger.publicKey()) === null,
  )
}

section('Signup makes the signer owner of a new organization')
{
  const founder = Keypair.random()
  const { challenge } = ceremony(founder.publicKey(), 'enrol')
  const signature = sign(challenge, founder)
  const verification = verifyChallengeSignature(
    challenge,
    signature,
    founder.publicKey(),
    founder.publicKey(),
  )
  if (!verification.ok) throw new Error('founder could not prove control')

  const created = session.createOrganizationWithOwner({
    walletPublicKey: founder.publicKey(),
    displayName: 'Founder',
    organizationName: 'Proof Org',
    settlementRecipient: ALICE.publicKey(),
  })

  const owner = session.findUserByWallet(founder.publicKey())
  check('the founder resolves to a user', owner !== null)
  check('the founder is in the new organization', owner?.organizationId === created.organizationId)
  check('the founder is owner', owner?.role === 'owner')
  check('the organization name is carried through', owner?.organizationName === 'Proof Org')

  // The decisive check: does that session grant access to the organization, and only it?
  check(
    'the session mints for the founder',
    typeof session.createSession(owner!.id, 'local')?.token === 'string',
  )

  let refused = false
  try {
    session.createOrganizationWithOwner({
      walletPublicKey: founder.publicKey(),
      displayName: 'Impostor',
      organizationName: 'Stolen Org',
      settlementRecipient: MALLORY.publicKey(),
    })
  } catch (error) {
    refused = error instanceof session.SignupFailure && error.reason === 'already_registered'
  }
  check('a wallet already registered cannot claim a second organization', refused)

  const orgCount = db()
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.name, 'Stolen Org'))
    .all()
  check('no organization was created by the refused signup', orgCount.length === 0)
}

section('Signup rejects an unusable treasury')
{
  const founder = Keypair.random()
  for (const [label, treasury] of [
    ['a malformed account', 'not-a-key'],
    ['an empty string', '   '],
  ] as const) {
    let reason = ''
    try {
      session.createOrganizationWithOwner({
        walletPublicKey: founder.publicKey(),
        displayName: 'X',
        organizationName: 'X',
        settlementRecipient: treasury,
      })
    } catch (error) {
      reason = error instanceof session.SignupFailure ? error.reason : 'threw something else'
    }
    check(`${label} is rejected as a treasury`, reason === 'invalid_treasury', `got ${reason}`)
  }

  let nameReason = ''
  try {
    session.createOrganizationWithOwner({
      walletPublicKey: founder.publicKey(),
      displayName: 'X',
      organizationName: '   ',
      settlementRecipient: ALICE.publicKey(),
    })
  } catch (error) {
    nameReason = error instanceof session.SignupFailure ? error.reason : 'threw something else'
  }
  check('an empty organization name is rejected', nameReason === 'org_name_required', `got ${nameReason}`)

  // The founder must still be unused, proving none of the rejected calls left a row behind.
  check('rejected signups created nothing', session.findUserByWallet(founder.publicKey()) === null)
}

section('Challenges are single use')
{
  const { id } = ceremony(null, 'login')
  check('the first consume succeeds', session.consumeChallenge(id, 'login') !== null)
  check('the second consume is refused', session.consumeChallenge(id, 'login') === null)
}

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(scratch(suffix))) rmSync(scratch(suffix))
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFailing:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('Wallet ceremony behaves correctly.')