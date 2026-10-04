import { randomBytes } from 'node:crypto'
import { StrKey } from '@stellar/stellar-sdk'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { emailTokens, organizationMembers, organizations, users } from '@/lib/db/schema'
import { normalizeEmail, redeemEmailToken } from '@/lib/auth/email'

/**
 * Organizations, memberships and roles.
 *
 * The split this module exists to enforce:
 *
 *   user        a person, identified by email address
 *   membership  what that person may do inside one organization
 *   wallet      which account that organization is paid into
 *
 * The previous model had one of each and made them the same thing: the wallet that signed
 * in was simultaneously the identity, the owner, and the treasury. That is a fine shortcut
 * for a single-operator demo and actively wrong for a company, where the person reading
 * request logs has no business holding the key that moves the money, and where the person
 * who holds that key should be able to hand off day-to-day access without handing over
 * authority.
 *
 * Two rules keep this from becoming a second source of truth:
 *
 *   1. A user always has exactly one "active" organization, mirrored on `users.organizationId`
 *      so the many existing queries that scope by it keep working unchanged. Membership is the
 *      authority for *what you may do*; that column is only where you currently are.
 *   2. Authorization reads the membership table, never `users.role`. The legacy role column
 *      is still written for compatibility but is not consulted, so the two cannot disagree
 *      in a way that silently grants access.
 */

/** What a member may do. Ordered: higher includes everything below it. */
export type Role = 'owner' | 'operator' | 'analyst'

const RANK: Record<Role, number> = { analyst: 1, operator: 2, owner: 3 }

/** Roles an owner may hand out. The owner role is not delegable by invitation. */
export type GrantableRole = 'operator' | 'analyst'

export class IdentityError extends Error {
  constructor(public readonly reason: IdentityFailure) {
    super(reason)
    this.name = 'IdentityError'
  }
}

export type IdentityFailure =
  | 'invalid_email'
  | 'email_taken'
  | 'org_name_required'
  | 'invalid_treasury'
  | 'not_a_member'
  | 'insufficient_role'
  | 'already_a_member'
  | 'invalid_invitation'
  | 'organization_not_found'

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

export { displayNameFromEmail }

function normalizeName(input: string): string {
  return input.trim().slice(0, 120)
}

/**
 * Fallback display name for an address that has never been given one.
 *
 * The local part is used rather than the whole address because the address is already
 * rendered beside it, and a name field repeating the login is noise. `noUncheckedIndexedAccess`
 * makes the split result optional, hence the second fallback: a display name is NOT NULL and
 * every account has one.
 */
function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0]
  if (!local) return email.slice(0, 120)

  // Addresses are conventionally lower case, and "ada.lovelace" is a poor thing to put in
  // the top-right corner of a payments console next to a real name. Separators are treated as
  // word breaks so both dotted and underscored conventions survive. Anything already
  // capitalised is left alone rather than being flattened to "Adalovelace" or shouted to
  // "ALICE", since corporate addresses are often `Firstname.Lastname@...`.
  const words = local.split(/[._-]+/).filter(Boolean)
  if (!words.length) return local.slice(0, 120)
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .slice(0, 120)
}

/**
 * Create the organization together with its owner.
 *
 * No wallet is required, and that is the point of the change. Signup collects a work email
 * and an organization name; the settlement wallet is connected afterwards, optionally, from
 * inside the dashboard. Requiring it here would mean nobody without a browser extension could
 * evaluate the product at all.
 *
 * `users.organizationId` and the owner membership row are written together so a user can
 * never exist without a tenant, which `currentUser()` relies on when it discards such rows.
 */
export function createOrganizationWithEmailOwner(input: {
  email: string
  displayName?: string
  organizationName: string
}): { organizationId: string; userId: string } {
  const email = input.email.trim().toLowerCase()
  const orgName = normalizeName(input.organizationName)
  if (!orgName) throw new IdentityError('org_name_required')

  const existing = db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .get()
  if (existing) throw new IdentityError('email_taken')

  const organizationId = newId('org')
  const userId = newId('usr')
  const now = Date.now()
  const displayName = normalizeName(input.displayName ?? '') || displayNameFromEmail(email)

  db().transaction((tx) => {
    tx.insert(organizations)
      .values({
        id: organizationId,
        name: orgName,
        // Payment destination is a later step. Null here is the documented "not connected yet".
        settlementRecipient: null,
        createdAt: now,
      })
      .run()
    tx.insert(users)
      .values({
        id: userId,
        organizationId,
        email,
        displayName,
        role: 'owner',
        createdAt: now,
      })
      .run()
    tx.insert(organizationMembers)
      .values({
        id: newId('mem'),
        organizationId,
        userId,
        role: 'owner',
        invitedBy: null,
        // The creator is not invited by anyone, so this is set immediately rather than left
        // pending an acceptance that will never come.
        acceptedAt: now,
        createdAt: now,
      })
      .run()
  })

  return { organizationId, userId }
}

/**
 * Attach an organization to an account that already exists.
 *
 * This is the onboarding path, and it is separate from `createOrganizationWithEmailOwner`
 * because the two differ in who owns the `users` row. Signup-from-scratch creates the user
 * and the organization in one transaction; here the user was created when their address was
 * proven, a step earlier, so this only has to write the tenant link and the membership.
 * Folding them together would mean either duplicating the user insert or deleting and
 * recreating a row that owns sessions and passkeys.
 */
export function newOrganizationFor(input: {
  organizationName: string
  owner: { id: string; email: string }
}): { organizationId: string } {
  const orgName = normalizeName(input.organizationName)
  if (!orgName) throw new IdentityError('org_name_required')

  const owner = db().select().from(users).where(eq(users.id, input.owner.id)).get()
  if (!owner) throw new IdentityError('not_a_member')
  // Two organizations for one account would make the tenant pointer ambiguous, and the
  // dashboard has exactly one active organization. Multi-organization membership is a
  // deliberate future feature; silently allowing it here would make `users.organizationId`
  // mean something different depending on which screen last wrote it.
  if (owner.organizationId) throw new IdentityError('already_a_member')

  const organizationId = newId('org')
  const now = Date.now()

  db().transaction((tx) => {
    tx.insert(organizations)
      .values({
        id: organizationId,
        name: orgName,
        settlementRecipient: null,
        createdAt: now,
      })
      .run()
    tx.update(users).set({ organizationId }).where(eq(users.id, owner.id)).run()
    tx.insert(organizationMembers)
      .values({
        id: newId('mem'),
        organizationId,
        userId: owner.id,
        role: 'owner',
        invitedBy: null,
        acceptedAt: now,
        createdAt: now,
      })
      .run()
  })

  return { organizationId }
}

/** The role a user holds in an organization, or null if they are not a member. */
export function roleInOrganization(userId: string, organizationId: string): Role | null {
  const row = db()
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .get()
  return (row?.role as Role | undefined) ?? null
}

export function hasRole(userId: string, organizationId: string, required: Role): boolean {
  const role = roleInOrganization(userId, organizationId)
  return role !== null && RANK[role] >= RANK[required]
}

/**
 * Assert membership and a minimum role, or throw.
 *
 * Membership is checked before role on purpose: a user who is not in the organization must
 * be indistinguishable from one who is, or the endpoint becomes a membership oracle.
 */
export function requireRole(userId: string, organizationId: string, required: Role): Role {
  const role = roleInOrganization(userId, organizationId)
  if (!role) throw new IdentityError('not_a_member')
  if (RANK[role] < RANK[required]) throw new IdentityError('insufficient_role')
  return role
}

export interface Membership {
  userId: string
  email: string | null
  displayName: string
  role: Role
  joinedAt: number
}

/**
 * Invitations sent to an address that have not been accepted yet.
 *
 * Used to tell somebody who arrives with no organization that they already have somewhere to
 * go, instead of showing them a form to create a second one. The token itself is not recoverable
 * here and deliberately not returned: only its hash is stored, so the page can name the
 * organization and explain that the email still has to be opened, and cannot manufacture a link.
 */
export function listPendingInvitations(email: string): Array<{
  organizationId: string
  organizationName: string
  role: Role
  expiresAt: number
}> {
  const normalized = normalizeEmail(email)
  if (!normalized) return []

  const rows = db()
    .select({
      organizationId: emailTokens.organizationId,
      role: emailTokens.role,
      expiresAt: emailTokens.expiresAt,
      organizationName: organizations.name,
    })
    .from(emailTokens)
    .innerJoin(organizations, eq(organizations.id, emailTokens.organizationId))
    .where(
      and(
        eq(emailTokens.email, normalized),
        eq(emailTokens.purpose, 'invite'),
        isNull(emailTokens.consumedAt),
        gt(emailTokens.expiresAt, Date.now()),
      ),
    )
    .all()

  const result: Array<{
    organizationId: string
    organizationName: string
    role: Role
    expiresAt: number
  }> = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.organizationId || !row.role) continue
    // Several invitations may exist for one organization; the newest is the only useful one.
    if (seen.has(row.organizationId)) continue
    seen.add(row.organizationId)
    result.push({
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      role: row.role as Role,
      expiresAt: row.expiresAt,
    })
  }
  return result
}

export function listMembers(organizationId: string): Membership[] {
  return db()
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: organizationMembers.role,
      joinedAt: organizationMembers.acceptedAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId))
    .all()
    .map((row) => ({
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      role: row.role as Role,
      joinedAt: row.joinedAt ?? 0,
    }))
}

/**
 * Accept an invitation, proving it with the token that was emailed.
 *
 * The organization and the role are read from the redeemed token, never from the caller.
 * An earlier version of this took `{ email, organizationId, role }`, which meant that anyone
 * who could guess or learn those three values could grant themselves a membership in an
 * organization they were never invited to: the function had no way to tell an invitation
 * from a claim. Deriving both from the token makes the emailed link the only authority, which
 * is what "invitation" has to mean for it to be worth anything.
 *
 * Accepting also never changes the active tenant of somebody who already has one. A user who
 * owns Acme and is invited to Beta joins Beta as a member, but their dashboard stays on Acme;
 * silently moving them would hand the inviter control of a session they were already using.
 */
export function acceptInvitation(input: {
  token: string
  /**
   * The address of whoever is redeeming, when the caller already has a proven session.
   *
   * The token alone proves control of the *invited* address. Without this, one signed-in user
   * could paste somebody else's invitation into their own browser: nothing would be gained, but
   * the invitation would be spent by a refused request and the real recipient locked out. It is
   * enforced inside the claim itself, so a mismatch costs the attacker nothing and destroys
   * nothing.
   */
  email?: string
}): { userId: string; organizationId: string; role: Role } {
  let redeemed
  try {
    redeemed = redeemEmailToken(input.token, { expectEmail: input.email })
  } catch {
    // Normalized to one failure on purpose. An expired link, an already-used one and a
    // forged one are indistinguishable to the caller, which is the same rule the sign-in
    // callback follows, and it keeps callers from having to handle two error types.
    throw new IdentityError('invalid_invitation')
  }
  if (redeemed.purpose !== 'invite') throw new IdentityError('invalid_invitation')
  if (!redeemed.organizationId) throw new IdentityError('invalid_invitation')
  if (!redeemed.role) throw new IdentityError('invalid_invitation')

  const organizationId = redeemed.organizationId
  const email = redeemed.email
  const role = redeemed.role
  const now = Date.now()

  const organization = db()
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get()
  // An invitation can outlive the organization it was sent for, which happens whenever
  // someone is invited and then the workspace is deleted before they click.
  if (!organization) throw new IdentityError('organization_not_found')

  const user = db().select({ id: users.id, organizationId: users.organizationId }).from(users).where(eq(users.email, email)).get()

  if (!user) {
    /*
     * Accepting creates the account as part of the same step. Asking someone to sign up and
     * then separately accept is two chances to drop out for no benefit, and the address is
     * already proven by the token.
     *
     * They adopt the inviting organization as their active tenant. They have no other, so the
     * alternative is an account that exists but cannot reach anything: `currentUser()` resolves
     * a tenant through the membership join, and a membership with no active organization leaves
     * a signed-in person bouncing between /login and /onboarding forever. Adopting is the only
     * choice that leaves them able to use what they just joined.
     */
    const userId = newId('usr')
    db().transaction((tx) => {
      tx.insert(users)
        .values({
          id: userId,
          organizationId,
          email,
          displayName: displayNameFromEmail(email),
          role,
          createdAt: now,
        })
        .run()
      tx.insert(organizationMembers)
        .values({
          id: newId('mem'),
          organizationId,
          userId,
          role,
          invitedBy: null,
          acceptedAt: now,
          createdAt: now,
        })
        .run()
    })
    return { userId, organizationId, role }
  }

  if (roleInOrganization(user.id, organizationId)) {
    // Clicking an old link twice is not a failure worth showing anyone: the membership they
    // wanted already exists. The token is still consumed above, so it cannot be replayed.
    return { userId: user.id, organizationId, role: roleInOrganization(user.id, organizationId)! }
  }

  db().transaction((tx) => {
    tx.insert(organizationMembers)
      .values({
        id: newId('mem'),
        organizationId,
        userId: user.id,
        role,
        invitedBy: null,
        acceptedAt: now,
        createdAt: now,
      })
      .run()
    /*
     * Adopt the inviting organization as the active tenant only when they have none.
     *
     * Someone who already belongs somewhere keeps their current tenant: switching it silently
     * would move the ground under an existing session, and which organization somebody should
     * land in is a product decision, not something an emailed link gets to decide. The
     * membership is recorded either way, so access is granted regardless of which tenant is
     * active.
     */
    if (!user.organizationId) {
      tx.update(users).set({ organizationId }).where(eq(users.id, user.id)).run()
    }
  })

  return { userId: user.id, organizationId, role }
}

/**
 * Set or replace the organization's settlement wallet.
 *
 * Called only after the wallet has signed a treasury challenge, so by the time this runs the
 * address is already proven. It writes `treasuryVerified` alongside the address rather than
 * inferring verification from the address being present, because "we were told this address"
 * and "someone proved they control it" are different facts and the UI needs to tell them
 * apart.
 */
export function setSettlementWallet(input: {
  organizationId: string
  recipient: string
}): void {
  const recipient = input.recipient.trim()
  if (!StrKey.isValidEd25519PublicKey(recipient)) throw new IdentityError('invalid_treasury')

  db()
    .update(organizations)
    .set({ settlementRecipient: recipient, treasuryVerified: true })
    .where(eq(organizations.id, input.organizationId))
    .run()
}

export function organizationById(organizationId: string): typeof organizations.$inferSelect | null {
  return (
    db()
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .get() ?? null
  )
}