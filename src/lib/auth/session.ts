import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { db } from '@/lib/db/client'
import { sessions, users } from '@/lib/db/schema'
import { hashPassword, verifyPassword } from './password'

/**
 * Dashboard auth.
 *
 * One seeded provider account for the hackathon demo. The session cookie holds a random
 * token; only its SHA-256 is stored, so a database leak does not yield usable sessions.
 * The cookie is HTTP-only and SameSite=Lax.
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
  email: string
  displayName: string
  role: 'owner' | 'operator'
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
      id: sessions.id,
      expiresAt: sessions.expiresAt,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, tokenHash(token)), gt(sessions.expiresAt, Date.now())))
    .get()

  if (!row) return null
  db().update(sessions).set({ lastSeenAt: Date.now() }).where(eq(sessions.id, row.id)).run()

  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role }
}

export async function requireUser(): Promise<AuthedUser> {
  const user = await currentUser()
  if (!user) throw new Error('unauthenticated')
  return user
}

export function verifyLogin(email: string, password: string): AuthedUser | null {
  const row = db().select().from(users).where(eq(users.email, email.toLowerCase().trim())).get()
  if (!row) {
    // Spend comparable time so a missing account is not distinguishable by timing.
    verifyPassword(password, hashPassword('placeholder'))
    return null
  }
  if (!verifyPassword(password, row.passwordHash)) return null
  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role }
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