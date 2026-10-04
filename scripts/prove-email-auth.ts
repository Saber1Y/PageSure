/**
 * Email-first identity: token lifecycle, onboarding, membership and invitation authority.
 *
 * The theme is authority. Every assertion below asks one question: could someone who has not
 * earned it end up with an organization, a role, or a settlement wallet? Tokens are the only
 * credential these flows accept, so the proof is mostly about whether a token is respected as
 * single-use, and whether anything else is accepted in its place.
 *
 * Runs against a throwaway database and deletes it on exit. No server, no wallet, no network,
 * no mail provider: the transport is never exercised here, because a proof that depends on
 * Resend is a proof that fails for reasons unrelated to identity.
 */

import { eq } from 'drizzle-orm'

import { closeScratchDatabase } from './scratch-db'

const SCRATCH = './data/email-auth-proof.db'

// Set before importing anything that opens the database: `db()` caches its handle on first
// use, and the client reads this at construction time.
process.env.DATABASE_URL = SCRATCH
process.env.PAGESURE_PUBLIC_ORIGIN = 'http://localhost:3000'

closeScratchDatabase(SCRATCH)

const { runMigrations } = await import('../src/lib/db/migrate')
const { db } = await import('../src/lib/db/client')
const { users, organizations, organizationMembers, emailTokens } = await import(
  '../src/lib/db/schema'
)
const email = await import('../src/lib/auth/email')
const identity = await import('../src/lib/auth/identity')
const settlement = await import('../src/lib/mpp/settlement')

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

function throws(fn: () => unknown): string {
  try {
    fn()
    return 'did not throw'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const tokenRows = () => db().select().from(emailTokens).all()
const userRows = () => db().select().from(users).all()

console.log('email tokens')
{
  const issued = email.issueSigninToken('Founder@Example.COM')
  const row = tokenRows()[0]!
  check('the address is normalized', row.email === 'founder@example.com', row.email)
  check('the raw token is never stored', !JSON.stringify(tokenRows()).includes(issued.token))
  check('what is stored is a hash', row.tokenHash.length === 64)

  const redeemed = email.redeemEmailToken(issued.token)
  check('the correct token redeems', redeemed.email === 'founder@example.com')
  check('redeeming reports the purpose', redeemed.purpose === 'signin')
  check('a token cannot be replayed', throws(() => email.redeemEmailToken(issued.token)).length > 0)
  check('an unknown token is refused', throws(() => email.redeemEmailToken('not-a-token')).length > 0)
  // Written straight to the table with a past expiry rather than by waiting: `issueSigninToken`
  // always mints a live token, so the only way to test the clock is to insert the row that a
  // fifteen-minute-old token would have left behind.
  const stale = email.issueSigninToken('slow@x.io')
  db()
    .update(emailTokens)
    .set({ expiresAt: Date.now() - 1_000 })
    .where(eq(emailTokens.email, 'slow@x.io'))
    .run()
  // Deliberately reported as `invalid_token` rather than `expired`: the module gives one
  // generic failure for absent, unknown, expired and already-used tokens, so a probe cannot
  // learn whether a token ever existed. Asserting the specific reason here would lock in the
  // leak, so the test asserts the generic reason instead.
  check('an expired token is refused', throws(() => email.redeemEmailToken(stale.token)).includes('invalid_token'))
  check(
    'an expired token is indistinguishable from an unknown one',
    throws(() => email.redeemEmailToken(stale.token)) === throws(() => email.redeemEmailToken('not-a-token')),
  )
  check(
    'an expired token stays refused on a second attempt',
    throws(() => email.redeemEmailToken(stale.token)).includes('invalid_token'),
  )
}

console.log('display names')
{
  check('a dotted address reads as a name', identity.displayNameFromEmail('ada.lovelace@x.io') === 'Ada Lovelace')
  check('an underscored address reads as a name', identity.displayNameFromEmail('ada_lovelace@x.io') === 'Ada Lovelace')
  check('a hyphenated address reads as a name', identity.displayNameFromEmail('ada-lovelace@x.io') === 'Ada Lovelace')
  check('a plain local part is capitalized', identity.displayNameFromEmail('alice@acme.co') === 'Alice')
  check('existing capitalization is preserved', identity.displayNameFromEmail('ADA@x.io') === 'ADA')
  check('a single character does not crash', identity.displayNameFromEmail('a@b.co') === 'A')
}

console.log('onboarding')
const ownerId = identity.newId('usr')
let organizationId = ''
{
  db()
    .insert(users)
    .values({
      id: ownerId,
      organizationId: null,
      email: 'founder@example.com',
      displayName: identity.displayNameFromEmail('founder@example.com'),
      role: 'owner',
      createdAt: Date.now(),
    })
    .run()

  const created = identity.newOrganizationFor({
    organizationName: '  Acme Research  ',
    owner: { id: ownerId, email: 'founder@example.com' },
  })
  organizationId = created.organizationId

  const org = db().select().from(organizations).all()[0]!
  check('the organization name is trimmed', org.name === 'Acme Research', org.name)
  check('a new organization has no settlement wallet', org.settlementRecipient === null)
  check('a new organization is not treasury-verified', org.treasuryVerified === false)
  check('the account now points at the organization', userRows()[0]!.organizationId === organizationId)

  const membership = db().select().from(organizationMembers).all()[0]!
  check('an owner membership exists', membership.role === 'owner' && membership.userId === ownerId)
  check('the membership is already accepted', membership.acceptedAt !== null)
  check('an owner did not invite themselves', membership.invitedBy === null)
}

console.log('onboarding cannot be repeated or forged')
{
  check(
    'one account cannot create a second organization',
    throws(() =>
      identity.newOrganizationFor({ organizationName: 'Second Co', owner: { id: ownerId, email: 'founder@example.com' } }),
    ).includes('already_a_member'),
  )
  check(
    'a blank organization name is refused',
    throws(() =>
      identity.newOrganizationFor({ organizationName: '   ', owner: { id: ownerId, email: 'founder@example.com' } }),
    ).includes('org_name_required'),
  )
  check(
    'an unknown account cannot own an organization',
    throws(() => identity.newOrganizationFor({ organizationName: 'Ghost Co', owner: { id: 'usr_nope', email: 'x@y.z' } })).includes(
      'not_a_member',
    ),
  )
}

console.log('membership roles')
{
  check('the owner role resolves', identity.roleInOrganization(ownerId, organizationId) === 'owner')
  check('a non-member resolves to nothing', identity.roleInOrganization('usr_nope', organizationId) === null)
  check('the owner satisfies an owner check', identity.hasRole(ownerId, organizationId, 'owner'))
  check('the owner satisfies an analyst check', identity.hasRole(ownerId, organizationId, 'analyst'))
  check(
    'an insufficient role is refused',
    throws(() => identity.requireRole('usr_nope', organizationId, 'owner')).includes('not_a_member'),
  )
}

console.log('invitations')
{
  // Each redemption consumes its token, so every assertion gets a fresh invitation. Sharing
  // one across checks would make the second failure look like a permission bug.
  const invite = () => email.issueInvitation({ email: 'Analyst@X.io', organizationId, role: 'analyst' })
  const issued = invite()

  check('an invitation is recorded as an invite', tokenRows().some((t) => t.purpose === 'invite'))
  check('the invited address is normalized', issued.email === 'analyst@x.io', issued.email)
  check('the invitation carries its role', issued.role === 'analyst')
  check(
    'an invitation is not yet a membership',
    db().select().from(organizationMembers).all().length === 1,
    'an issued invitation must not grant access on its own',
  )
  check('redeeming an invitation reports its purpose', email.redeemEmailToken(invite().token).purpose === 'invite')
}

console.log('invitation authority')
{
  check(
    'a forged invitation token is refused',
    throws(() => identity.acceptInvitation({ token: 'forged-token-value' })).includes('invalid_invitation'),
  )
  check(
    'a sign-in token cannot be used as an invitation',
    throws(() => identity.acceptInvitation({ token: email.issueSigninToken('someone@x.io').token })).includes(
      'invalid_invitation',
    ),
  )

  // A forwarded invitation is the interesting failure: somebody else, signed in under a
  // different address, pastes the link. It must be refused *and* leave the token intact, because
  // a refusal that spends the token would let anyone with a glance at the email lock the real
  // invitee out of their own organization.
  //
  // Uses its own address so that "is it still pending?" is unambiguous: other blocks in this
  // script leave invitations for analyst@x.io outstanding on purpose.
  const GUEST = 'newcomer@x.io'
  const forwarded = email.issueInvitation({ email: GUEST, organizationId, role: 'operator' })
  check(
    'a pending invitation is listed for its address',
    identity
      .listPendingInvitations(GUEST)
      .some((i) => i.organizationId === organizationId && i.role === 'operator'),
  )
  check(
    'a pending invitation is invisible to a different address',
    !identity.listPendingInvitations('someone-else@x.io').some((i) => i.organizationId === organizationId),
  )
  check(
    'accepting as the wrong address is refused',
    throws(() => identity.acceptInvitation({ token: forwarded.token, email: 'stranger@x.io' })).includes(
      'invalid_invitation',
    ),
  )
  check(
    'a refused acceptance leaves the invitation usable',
    identity.listPendingInvitations(GUEST).some((i) => i.organizationId === organizationId),
  )

  // The same token the stranger failed on, redeemed by its rightful owner. This is the whole
  // point: one link, one refusal that cost nothing, one successful acceptance afterwards.
  const accepted = identity.acceptInvitation({ token: forwarded.token })
  check(
    'accepting grants the invited role',
    identity.roleInOrganization(accepted.userId, organizationId) === 'operator',
  )
  check(
    'accepting creates the account as part of the same step',
    userRows().some((u) => u.id === accepted.userId && u.email === GUEST),
  )
  check(
    'an invitee with no tenant adopts the organization they joined',
    userRows().find((u) => u.id === accepted.userId)!.organizationId === organizationId,
  )
  check(
    'an invitee who already had a tenant keeps it',
    (() => {
      // Somebody who already has a tenant of their own, invited elsewhere.
      const incumbentEmail = 'incumbent@x.io'
      const incumbent = identity.createOrganizationWithEmailOwner({
        email: incumbentEmail,
        organizationName: 'Incumbent Co',
      })
      const invited = identity.acceptInvitation({
        token: email.issueInvitation({ email: incumbentEmail, organizationId, role: 'operator' }).token,
      })
      return (
        invited.userId === incumbent.userId &&
        userRows().find((u) => u.id === incumbent.userId)!.organizationId === incumbent.organizationId &&
        // the membership was still granted alongside the unchanged tenant
        identity.roleInOrganization(incumbent.userId, organizationId) === 'operator'
      )
    })(),
  )
  check(
    'accepting does not disturb the founder tenant',
    userRows().find((u) => u.id === ownerId)!.organizationId === organizationId,
  )
  check(
    'the invitation stops showing as pending once accepted',
    !identity.listPendingInvitations(GUEST).some((i) => i.organizationId === organizationId),
  )
  check(
    'the same invitation cannot be redeemed a second time',
    throws(() => identity.acceptInvitation({ token: forwarded.token })).includes('invalid_invitation'),
  )
  check(
    'a second invitation for an existing member is refused',
    throws(() =>
      identity.acceptInvitation({ token: email.issueInvitation({ email: 'analyst@x.io', organizationId, role: 'analyst' }).token }),
    ).length > 0,
  )
}

console.log('settlement fails closed without a wallet')
{
  const target = settlement.settlementTargetForOrganization(organizationId)!
  check('a target still resolves without a wallet', target.recipient === null)

  // Passing the organizationId, not the target: the function re-reads the organization, so
  // handing it a target would throw for the wrong reason and this assertion would pass
  // without proving anything about the missing-wallet case.
  const refusal = throws(() => settlement.requireSettlementRecipient(organizationId))
  check('requiring a recipient refuses', refusal.length > 0)
  check('the refusal names the missing setup step', /settlement (wallet|account)/i.test(refusal), refusal)
}

closeScratchDatabase(SCRATCH)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const name of failures) console.error(`  failed: ${name}`)
  process.exit(1)
}
console.log('Email-first identity holds.')