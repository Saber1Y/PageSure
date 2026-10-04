'use server'

import { cookies, headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import { displayNameFromEmail, IdentityError, newId, newOrganizationFor } from '@/lib/auth/identity'
import {
  clearLoginAttempts,
  consumeLoginAttempt,
  createSession,
  sessionCookieName,
  sessionTtlMs,
  sessionUserId,
} from '@/lib/auth/session'
import { deliverSigninLink } from '@/lib/auth/mail'
import {
  EmailAuthError,
  issueSigninToken,
  normalizeEmail,
  redeemEmailToken,
} from '@/lib/auth/email'

/**
 * Email-first sign-in server actions.
 *
 * This is the primary way into the console. The wallet path still exists and still mints a
 * session, because a crypto-native operator should not have to check an inbox, but it is the
 * shortcut rather than the requirement.
 *
 * Four steps, four actions, because collapsing them would mean collecting an organization
 * name from someone who already has an account, and would put a wallet prompt in front of a
 * finance manager:
 *
 *   1. requestSignin       address in, link out, no session
 *   2. completeSignin      token in, session out; first-time users are sent to onboarding
 *   3. createOrganization  name in, organization out
 *   4. connect a settlement wallet, later, from inside the dashboard (optional)
 *
 * Step 1 never reveals whether an address has an account. That is deliberate: a form that
 * tells a stranger which addresses are registered is an account-enumeration oracle, and it
 * is the reason the "check your email" screen has no confirmation wording beyond it.
 */

export type SigninFailure =
  | 'invalid_email'
  | 'delivery_failed'
  | 'invalid_token'
  | 'org_name_required'
  | 'too_many_attempts'

/**
 * Best-effort client identity for throttling.
 *
 * x-forwarded-for is client-controlled, so on its own it would let an attacker reset their
 * own counter by sending a random header. It only slows casual abuse; the real limits are
 * that a link must be redeemed with a real token and that a token is single-use.
 */
async function throttleKey(): Promise<string> {
  const hdrs = await headers()
  const fwd = hdrs.get('x-forwarded-for')
  const ip = fwd?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || 'local'
  return ip.slice(0, 64)
}

async function mintSession(userId: string): Promise<void> {
  const hdrs = await headers()
  const { token } = createSession(userId, hdrs.get('user-agent'))
  const store = await cookies()
  store.set(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(sessionTtlMs() / 1000),
  })
}

export interface SigninRequestResult {
  ok: boolean
  failure?: SigninFailure
  /** Detail for delivery problems the operator can act on. Never contains the address. */
  detail?: string
}

/**
 * Step 1. Send a sign-in link.
 *
 * Throttled per client address before any work, so a flood cannot be used to generate
 * unbounded rows. The same counter namespace backs the wallet path, so neither can be used
 * to reset the other's limit.
 */
export async function requestSignin(
  rawEmail: string,
  returnTo?: string,
): Promise<SigninRequestResult> {
  const email = normalizeEmail(rawEmail)
  if (!email) return { ok: false, failure: 'invalid_email' }

  const key = `email:${await throttleKey()}`
  if (!consumeLoginAttempt(key).allowed) return { ok: false, failure: 'too_many_attempts' }

  const issued = issueSigninToken(email)
  const delivered = await deliverSigninLink({
    to: email,
    token: issued.token,
    returnTo,
  })

  if (!delivered.delivered) {
    // The stored token is left to expire on its own: nobody holds it, it is only reachable
    // by someone reading the database, and by then it is hashed and long expired.
    return { ok: false, failure: 'delivery_failed', detail: delivered.reason }
  }

  clearLoginAttempts(key)
  return { ok: true }
}

export interface CompleteSigninResult {
  ok: boolean
  next: 'onboarding' | 'dashboard'
  failure?: SigninFailure
}

/**
 * Step 2. Redeem the link.
 *
 * A known address gets a session and the dashboard. An unknown address also gets a session,
 * but with no organization behind it, and is routed to onboarding. Creating the user here
 * rather than in onboarding is what makes "enter your email, then tell us the company name"
 * work without proving the address twice.
 */
export async function completeSignin(token: string): Promise<CompleteSigninResult> {
  const key = `redeem:${await throttleKey()}`
  if (!consumeLoginAttempt(key).allowed) {
    return { ok: false, next: 'dashboard', failure: 'too_many_attempts' }
  }

  let redeemed
  try {
    redeemed = redeemEmailToken(token)
  } catch (error) {
    if (error instanceof EmailAuthError) {
      // One message for unknown, expired and already-used alike. Distinguishing them would
      // let anyone probe which tokens exist.
      return { ok: false, next: 'dashboard', failure: 'invalid_token' }
    }
    throw error
  }

  // An invite token is redeemed by its own callback, which also creates the membership.
  // Accepting it here would mint a session without ever granting the invited role.
  if (redeemed.purpose !== 'signin') {
    return { ok: false, next: 'dashboard', failure: 'invalid_token' }
  }

  const existing = db().select().from(users).where(eq(users.email, redeemed.email)).get()
  if (existing) {
    await mintSession(existing.id)
    clearLoginAttempts(key)
    return { ok: true, next: 'dashboard' }
  }

  const created = newUserWithoutOrganization(redeemed.email)
  await mintSession(created.id)
  clearLoginAttempts(key)
  return { ok: true, next: 'onboarding' }
}

/**
 * Create the account row before the organization exists.
 *
 * `organizationId` is null, which is exactly the state `currentUser()` filters out, so this
 * session cannot read anything organization-scoped. It exists only to carry an identity
 * between "address proven" and "organization named", and it is why onboarding reads the user
 * id through `sessionUserId()` instead of `currentUser()`.
 */
function newUserWithoutOrganization(email: string): { id: string } {
  const id = newId('usr')
  db()
    .insert(users)
    .values({
      id,
      organizationId: null,
      email,
      displayName: displayNameFromEmail(email),
      role: 'owner',
      createdAt: Date.now(),
    })
    .run()
  return { id }
}

export interface CreateOrganizationResult {
  ok: boolean
  failure?: SigninFailure
}

/**
 * Step 3. Name the organization and become its owner.
 *
 * No settlement wallet is collected. Connecting one is a later, optional step inside the
 * dashboard, and the organization is fully usable for everything that does not move money
 * until it happens. Requiring a wallet to finish signup is the single change that would undo
 * the point of this flow.
 */
export async function createOrganizationForCurrentUser(
  organizationName: string,
): Promise<CreateOrganizationResult> {
  const userId = await sessionUserId()
  if (!userId) return { ok: false, failure: 'invalid_token' }

  const user = db().select().from(users).where(eq(users.id, userId)).get()
  if (!user) return { ok: false, failure: 'invalid_token' }
  if (!user.email) return { ok: false, failure: 'invalid_email' }

  // Already in an organization: succeed as a no-op so a retried request after a lost
  // response cannot strand someone on the onboarding screen forever.
  if (user.organizationId) return { ok: true }

  try {
    newOrganizationFor({
      organizationName,
      owner: { id: user.id, email: user.email },
    })
  } catch (error) {
    if (error instanceof IdentityError) {
      if (error.reason === 'org_name_required') return { ok: false, failure: 'org_name_required' }
    }
    throw error
  }

  return { ok: true }
}

/**
 * The pending organization for an authenticated user with no tenant, if any.
 *
 * Drives the onboarding redirect, so the decision lives on the server where the session is
 * read rather than in client state that could disagree with it.
 */
export async function onboardingState(): Promise<{ needsOrganization: boolean }> {
  const userId = await sessionUserId()
  if (!userId) return { needsOrganization: false }
  const user = db().select().from(users).where(eq(users.id, userId)).get()
  return { needsOrganization: !!user && !user.organizationId }
}