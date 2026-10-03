import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { db } from '@/lib/db/client'
import { authAttempts, loginChallenges, sessions, users } from '@/lib/db/schema'

/**
 * Dashboard auth.
 *
 * There is no password. Two mechanisms, one session layer:
 *
 *   wallet sign-in   SEP-0007 challenge. Proves control of PROVIDER_RECIPIENT_G, the
 *                    settlement key. This is the ROOT: the first successful proof
 *                    creates the operator row, so nothing needs seeding.
 *   passkey          WebAuthn. Registered only from an authenticated session, so it is
 *                    a second and revocable way in, never the way in.
 *
 * Both mint the same signed session token. The cookie holds `token.signature`; only an
 * HMAC of the token is stored, so a database leak yields no usable sessions.
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
  email: string | null
  displayName: string
  role: 'owner' | 'operator'
  walletPublicKey: string | null
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
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      walletPublicKey: users.walletPublicKey,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, tokenHash(token)), gt(sessions.expiresAt, Date.now())))
    .get()

  if (!row) return null
  db().update(sessions).set({ lastSeenAt: Date.now() }).where(eq(sessions.id, row.sessionId)).run()

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    walletPublicKey: row.walletPublicKey,
  }
}

export async function requireUser(): Promise<AuthedUser> {
  const user = await currentUser()
  if (!user) throw new Error('unauthenticated')
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
 */
export function storeChallenge(id: string, challenge: string, purpose: 'enrol' | 'login', expiresAt: number): void {
  db()
    .insert(loginChallenges)
    .values({ id, challenge, purpose, expiresAt, createdAt: Date.now() })
    .run()
}

/**
 * Atomically claim a challenge. Returns the row only for the first caller.
 *
 * The `isNull(consumedAt)` guard is the whole point: without it, a signature replayed
 * within the TTL would be accepted again.
 */
export function consumeChallenge(id: string, purpose: 'enrol' | 'login') {
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
// Operator provisioning
// ---------------------------------------------------------------------------

/**
 * Find the operator by wallet, creating the account on first proof.
 *
 * Self-provisioning is the point: the alternative was a seeded row with a password in
 * .env. Here the first person to prove control of the configured settlement wallet
 * becomes the owner, and there is nothing to rotate or leak beforehand.
 */
export function operatorForWallet(walletPublicKey: string): AuthedUser {
  const target = db()
  const existing = target.select().from(users).where(eq(users.walletPublicKey, walletPublicKey)).get()

  if (existing) {
    return {
      id: existing.id,
      email: existing.email,
      displayName: existing.displayName,
      role: existing.role,
      walletPublicKey: existing.walletPublicKey,
    }
  }

  const id = `usr_${randomBytes(12).toString('hex')}`
  const displayName = process.env.PROVIDER_LABEL ?? 'PageSure Provider'
  target
    .insert(users)
    .values({ id, walletPublicKey, displayName, role: 'owner', createdAt: Date.now() })
    .run()

  return { id, email: null, displayName, role: 'owner', walletPublicKey }
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