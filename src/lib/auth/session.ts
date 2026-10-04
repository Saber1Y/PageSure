import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { StrKey } from '@stellar/stellar-sdk'
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { db } from '@/lib/db/client'
import { validateSignerRegistration } from '@/lib/mpp/signer-registration'
import {
  authAttempts,
  loginChallenges,
  organizationMembers,
  organizations,
  sessions,
  users,
} from '@/lib/db/schema'

/**
 * Dashboard auth.
 *
 * There is no password. Two mechanisms, one session layer:
 *
 *   wallet sign-in   SEP-0007 challenge, self-certifying. Proves control of whatever key
 *                    the client names. Anyone can sign up; nothing is pre-provisioned.
 *   passkey          WebAuthn. Registered only from an authenticated session, so it is
 *                    a second and revocable way in, never the way in.
 *
 * Both mint the same signed session token. The cookie holds `token.signature`; only an
 * HMAC of the token is stored, so a database leak yields no usable sessions.
 *
 * Authentication and authorization are deliberately separate concerns:
 *
 *   signature  ->  proves CONTROL of a key. Worthless on its own as access.
 *   membership ->  user -> organization -> role. This is what grants access.
 *
 * requireUser() is the only gate provider data passes through, and it guarantees a
 * non-null organizationId so no query can be written without a tenant scope.
 *
 * The gateway and the playground stay PUBLIC on purpose: agents have no session, and
 * they authenticate by paying, which is the entire point of the product.
 */

const COOKIE = 'pagesure_session'
const SESSION_TTL_MS = 8 * 60 * 60 * 1000

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET is not set or is shorter than 32 characters')
  }
  return secret
}

function sign(value: string): string {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url')
}

function tokenHash(token: string): string {
  return createHmac('sha256', sessionSecret()).update(`tok:${token}`).digest('hex')
}

export function createSession(userId: string, userAgent: string | null): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  db()
    .insert(sessions)
    .values({
      id: tokenHash(token),
      userId,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
      userAgent,
    })
    .run()
  return { token: `${token}.${sign(token)}`, expiresAt }
}

export async function destroySession(): Promise<void> {
  const store = await cookies()
  const raw = store.get(COOKIE)?.value
  if (!raw) return
  db().delete(sessions).where(eq(sessions.id, tokenHash(raw.split('.')[0] ?? ''))).run()
  store.delete(COOKIE)
}

export interface AuthedUser {
  id: string
  /**
   * The tenant this user belongs to. Non-null on every AuthedUser by construction:
   * currentUser() drops rows without an organization rather than returning them, so no
   * caller can forget to scope a query.
   */
  organizationId: string
  /** Rendered in the dashboard shell so the active tenant is never ambiguous. */
  organizationName: string
  email: string | null
  displayName: string
  /**
   * Copy of the active membership role, surfaced so the UI can hide controls the viewer
   * cannot use. Authorization itself reads `organization_members`, not this.
   */
  role: 'owner' | 'operator' | 'analyst'
  walletPublicKey: string | null
}

/**
 * The authenticated person, resolved from the session cookie, before any tenant filtering.
 *
 * This is the primitive `currentUser()` is built on, split out because onboarding needs an
 * identity for someone who does not have an organization yet: the account is created when
 * the address is proven and the organization is named in the next step, so between the two
 * there is a valid session belonging to a user with no tenant.
 *
 * Only the cookie signature is trusted here. It answers "which account is this?", never
 * "what may it read?", so nothing organization-scoped may be authorized off this return
 * value. Callers that need tenant scope must go through `currentUser`.
 */
export async function sessionUserId(): Promise<string | null> {
  const store = await cookies()
  const raw = store.get(COOKIE)?.value
  if (!raw) return null

  const [token, signature] = raw.split('.')
  if (!token || !signature) return null

  // Verify the signature before touching the database.
  const expected = sign(token)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const row = db()
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.id, tokenHash(token)), gt(sessions.expiresAt, Date.now())))
    .get()

  return row?.userId ?? null
}

/**
 * Identity for somebody who has proven their address but has no organization yet.
 *
 * `currentUser()` inner-joins `organization_members`, so it returns null for exactly the person
 * who is midway through joining a team: the account exists, the address is proven, the
 * membership does not. Accepting an invitation happens at precisely that moment, which made
 * `requireUser()` the wrong gate there - the invitee was told to sign in while already signed in.
 *
 * Like `sessionUserId()`, this answers "who is this?" and never "what may they read?". Nothing
 * organization-scoped may be authorized from its return value; callers that need tenant scope
 * must go through `currentUser`.
 */
export async function sessionIdentity(): Promise<{ id: string; email: string | null } | null> {
  const userId = await sessionUserId()
  if (!userId) return null
  const row = db()
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .get()
  return row ?? null
}

export async function currentUser(): Promise<AuthedUser | null> {
  const store = await cookies()
  const raw = store.get(COOKIE)?.value
  if (!raw) return null

  const [token, signature] = raw.split('.')
  if (!token || !signature) return null

  // Verify the signature before touching the database.
  const expected = sign(token)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const row = db()
    .select({
      // id must be the USER id. Passing the session id here would let anything keyed on
      // AuthedUser.id (passkey enrolment writes userId) point at a session row instead.
      id: users.id,
      sessionId: sessions.id,
      organizationId: users.organizationId,
      organizationName: organizations.name,
      email: users.email,
      displayName: users.displayName,
      // Read from the membership row, not from users.role. The denormalized column on
      // `users` is a cache for display, and an earlier revision of this query trusted it -
      // which meant a demotion recorded in organization_members had no effect here, and the
      // dashboard kept offering owner-only controls to someone who had just been demoted.
      // Every path that creates a user with a tenant also creates their membership, so this
      // join costs no legitimate session.
      role: organizationMembers.role,
      walletPublicKey: users.walletPublicKey,
    })
    .from(sessions)
    // innerJoin on organizations is what makes a user without a tenant fall out of the query
    // entirely, rather than being returned with a null organizationId that a caller might
    // forget to check.
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(organizations, eq(users.organizationId, organizations.id))
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, users.id),
        eq(organizationMembers.organizationId, organizations.id),
      ),
    )
    .where(and(eq(sessions.id, tokenHash(token)), gt(sessions.expiresAt, Date.now())))
    .get()

  // No organization means no tenant scope, so there is nothing this session may read. A
  // valid signature alone never grants access — membership does. Dropping the row here is
  // what makes requireUser() safe to trust as the single gate for every provider query.
  if (!row?.organizationId) return null

  db().update(sessions).set({ lastSeenAt: Date.now() }).where(eq(sessions.id, row.sessionId)).run()

  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    email: row.email,
    displayName: row.displayName,
    role: row.role as AuthedUser['role'],
    walletPublicKey: row.walletPublicKey,
  }
}

/**
 * The single gate for provider-owned data.
 *
 * Every read and write of an organization-scoped table goes through here and filters on
 * the returned organizationId. Centralising it is the point: tenant isolation that depends
 * on every call site remembering a filter is isolation that eventually leaks.
 */
export async function requireUser(): Promise<AuthedUser> {
  const user = await currentUser()
  if (!user) throw new Error('unauthenticated')
  return user
}

/**
 * Page-facing gate.
 *
 * Identical to requireUser() except an unauthenticated visitor is redirected instead of
 * throwing. Throwing from a Server Component surfaces as a 500 error page, which would tell
 * a signed-out visitor that something broke rather than that they need to sign in. The
 * dashboard layout already redirects, so this is the defence for any page reached directly.
 */
export async function requireUserPage(): Promise<AuthedUser> {
  const user = await currentUser()
  if (!user) redirect('/login')
  return user
}

/** Owner-only page gate. Operator sees 404 rather than a 403 so the surface is not disclosed. */
export async function requireOwnerPage(): Promise<AuthedUser> {
  const user = await requireUserPage()
  if (user.role !== 'owner') notFound()
  return user
}

/**
 * Privileged operations — treasury changes, team management — are owner-only.
 *
 * Operators run day-to-day services, policies and reviews; they cannot move the money or
 * add people. This is the check that makes `role` mean something.
 */
export async function requireOwner(): Promise<AuthedUser> {
  const user = await requireUser()
  if (user.role !== 'owner') throw new Error('forbidden: owner role required')
  return user
}

// ---------------------------------------------------------------------------
// Login attempt throttling
// ---------------------------------------------------------------------------

/**
 * Fixed-window counter on the client IP.
 *
 * This is the control the old password form was missing entirely. Without it, a console
 * protected by a public key is still brute-forceable at the verification step, because
 * there is no oracle cost to guessing.
 *
 * A separate table from rate_limit_buckets on purpose: those are scoped to a policy and
 * a wallet, and the attacker controls neither here.
 */
const AUTH_WINDOW_MS = 15 * 60 * 1000
const AUTH_MAX_ATTEMPTS = 10

export type AttemptVerdict = { allowed: true } | { allowed: false; retryAfterSec: number }

export function consumeLoginAttempt(clientKey: string): AttemptVerdict {
  const target = db()
  const windowStart = Math.floor(Date.now() / AUTH_WINDOW_MS) * AUTH_WINDOW_MS
  const key = `login:${clientKey}`

  const inserted = target
    .insert(authAttempts)
    .values({ key, count: 1, windowStart, updatedAt: Date.now() })
    .onConflictDoNothing()
    .run()

  if (inserted.changes > 0) return { allowed: true }

  const bumped = target
    .update(authAttempts)
    .set({ count: sql`${authAttempts.count} + 1`, updatedAt: Date.now() })
    .where(and(eq(authAttempts.key, key), lt(authAttempts.count, AUTH_MAX_ATTEMPTS)))
    .run()

  if (bumped.changes > 0) return { allowed: true }

  const retryAfterSec = Math.max(1, Math.ceil((windowStart + AUTH_WINDOW_MS - Date.now()) / 1000))
  return { allowed: false, retryAfterSec }
}

/** Clear the counter after a success, so a legitimate operator is not punished. */
export function clearLoginAttempts(clientKey: string): void {
  db().delete(authAttempts).where(eq(authAttempts.key, `login:${clientKey}`)).run()
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

/**
 * Persist a challenge so it can be consumed exactly once.
 *
 * Storing the row is what makes a captured signature worthless on replay: the consume is
 * a conditional UPDATE, so two concurrent submissions cannot both win.
 *
 * `walletPublicKey` binds the challenge to one identity when the client already knows which
 * wallet it is signing with. Left null, any key may answer it — correct for first-contact
 * signup, where the server has never heard of the wallet before.
 */
export function storeChallenge(
  id: string,
  challenge: string,
  purpose: 'enrol' | 'login' | 'treasury',
  expiresAt: number,
  walletPublicKey?: string | null,
  organizationId?: string | null,
): void {
  db()
    .insert(loginChallenges)
    .values({
      id,
      challenge,
      purpose,
      expiresAt,
      walletPublicKey: walletPublicKey ?? null,
      organizationId: organizationId ?? null,
      createdAt: Date.now(),
    })
    .run()
}

/**
 * Atomically claim a challenge. Returns the row only for the first caller.
 *
 * The `isNull(consumedAt)` guard is the whole point: without it, a signature replayed
 * within the TTL would be accepted again.
 */
export function consumeChallenge(id: string, purpose: 'enrol' | 'login' | 'treasury') {
  const claimed = db()
    .update(loginChallenges)
    .set({ consumedAt: Date.now() })
    .where(
      and(
        eq(loginChallenges.id, id),
        eq(loginChallenges.purpose, purpose),
        isNull(loginChallenges.consumedAt),
        gt(loginChallenges.expiresAt, Date.now()),
      ),
    )
    .run()

  if (claimed.changes === 0) return null
  return db().select().from(loginChallenges).where(eq(loginChallenges.id, id)).get() ?? null
}

export function pruneExpiredChallenges(): number {
  return db().delete(loginChallenges).where(lt(loginChallenges.expiresAt, Date.now())).run().changes
}

// ---------------------------------------------------------------------------
// Organizations and operator provisioning
// ---------------------------------------------------------------------------

/** Errors a signup can legitimately fail with, mapped to copy by the caller. */
export type SignupError =
  | 'invalid_treasury'
  | 'org_name_required'
  | 'already_registered'
  | 'invalid_signer_registration'

/**
 * Find the operator behind a wallet.
 *
 * Returns null for a wallet that has never signed in. This is NOT an error: an unknown
 * wallet is exactly the self-serve signup case, and nothing about it is pre-provisioned.
 */
export function findUserByWallet(walletPublicKey: string): AuthedUser | null {
  // Explicit projection rather than select(): users and organizations both define `id`,
  // and an unqualified select over a join silently lets one table's column shadow the
  // other's. Naming each field makes the intended source of every value unambiguous.
  const row = db()
    .select({
      id: users.id,
      organizationId: users.organizationId,
      organizationName: organizations.name,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      walletPublicKey: users.walletPublicKey,
    })
    .from(users)
    .innerJoin(organizations, eq(users.organizationId, organizations.id))
    .where(eq(users.walletPublicKey, walletPublicKey))
    .get()

  if (!row?.organizationId) return null
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    email: row.email,
    displayName: row.displayName,
    role: row.role as AuthedUser['role'],
    walletPublicKey: row.walletPublicKey,
  }
}

/**
 * Create an organization and its first owner, in one step.
 *
 * The caller has already proven control of `walletPublicKey` — that proof is
 * authentication and is deliberately not re-checked here. What this establishes is
 * authorization: the signer becomes `owner` OF THEIR OWN new organization and of nothing
 * else. No wallet is granted authority over an organization it did not create, and no
 * private key is ever received or stored.
 *
 * `settlementRecipient` is the organization's treasury. It is validated as a Stellar
 * account here so an unpayable address cannot be persisted, but it is NOT a credential:
 * PageSure never signs for it, it only appears as the destination on a payment.
 */
export function createOrganizationWithOwner(input: {
  walletPublicKey: string
  displayName: string
  organizationName: string
  settlementRecipient: string
  signerUrl?: string
  signerTokenEnv?: string
}): { organizationId: string; userId: string } {
  const treasury = input.settlementRecipient.trim()
  if (!StrKey.isValidEd25519PublicKey(treasury)) throw new SignupFailure('invalid_treasury')

  const orgName = input.organizationName.trim()
  if (!orgName) throw new SignupFailure('org_name_required')
  // Bounded on the server: this row is rendered in the dashboard shell and in settlement
  // records, so an unbounded client string would be stored verbatim and break every layout
  // that shows it. Validation belongs here, not in the form.
  if (orgName.length > 120) throw new SignupFailure('org_name_required')

  const displayName = input.displayName.trim().slice(0, 120) || orgName
  if (displayName.length > 120) throw new SignupFailure('org_name_required')

  // Optional external signer registration, constrained by operator policy rather than by the
  // tenant. Only validated when the operator actually offered a signer URL; without one the
  // organization simply settles through whatever channel mode it can support.
  let signer: { signerUrl: string; signerTokenEnv: string } | null = null
  if (input.signerUrl?.trim() || input.signerTokenEnv?.trim()) {
    const result = validateSignerRegistration({
      signerUrl: input.signerUrl,
      signerTokenEnv: input.signerTokenEnv,
    })
    if (!result.ok) throw new SignupFailure('invalid_signer_registration')
    signer = { signerUrl: result.signerUrl, signerTokenEnv: result.signerTokenEnv }
  }

  if (findUserByWallet(input.walletPublicKey)) throw new SignupFailure('already_registered')

  const organizationId = `org_${randomBytes(12).toString('hex')}`
  const userId = `usr_${randomBytes(12).toString('hex')}`
  const now = Date.now()

  db().transaction((tx) => {
    tx.insert(organizations)
      .values({
        id: organizationId,
        name: orgName,
        settlementRecipient: treasury,
        commitmentSignerUrl: signer?.signerUrl ?? null,
        commitmentSignerTokenEnv: signer?.signerTokenEnv ?? null,
        createdAt: now,
      })
      .run()
    tx.insert(users)
      .values({
        id: userId,
        organizationId,
        walletPublicKey: input.walletPublicKey,
        displayName,
        // First member of a brand-new organization is its owner. There is no path that
        // makes someone owner of an organization they did not create.
        role: 'owner',
        createdAt: now,
      })
      .run()
  })

  return { organizationId, userId }
}

export class SignupFailure extends Error {
  constructor(public readonly reason: SignupError) {
    super(reason)
    this.name = 'SignupFailure'
  }
}

export function sessionCookieName(): string {
  return COOKIE
}

export function sessionTtlMs(): number {
  return SESSION_TTL_MS
}

export function pruneExpiredSessions(): number {
  return db().delete(sessions).where(lt(sessions.expiresAt, Date.now())).run().changes
}