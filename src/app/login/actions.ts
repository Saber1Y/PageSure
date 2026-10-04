'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { randomBytes } from 'node:crypto'
import { issueChallenge, verifyChallengeSignature } from '@/lib/auth/wallet'
import {
  clearLoginAttempts,
  consumeChallenge,
  consumeLoginAttempt,
  createOrganizationWithOwner,
  createSession,
  findUserByWallet,
  sessionCookieName,
  sessionTtlMs,
  SignupFailure,
  storeChallenge,
  type SignupError,
} from '@/lib/auth/session'

/**
 * Login and signup server actions.
 *
 * Lives in its own module rather than page.tsx. A page that exports an action AND gets
 * imported by a Client Component pulls its whole import graph into the client bundle, which
 * dragged better-sqlite3 into the browser build. Keeping the action in a 'use server' module
 * lets Next split it correctly.
 *
 * There is no password and no configured operator wallet, so there is no secret on the
 * server to compare against. A signature proves only that the caller controls the key it
 * names. What happens next is decided by the database:
 *
 *   known wallet   -> mint a session, go to the dashboard
 *   unknown wallet -> no session. Send them to signup to create an organization.
 *
 * The signature is never, on its own, sufficient for access.
 */

/**
 * Best-effort client identity for throttling.
 *
 * x-forwarded-for is client-controlled, so on its own it would let an attacker reset their
 * own counter by sending a random header. It is therefore used only to slow down casual
 * attempts, never as an identity claim, and the real limit is that a forged signature cannot
 * verify regardless of where it came from.
 */
async function throttleKey(): Promise<string> {
  const hdrs = await headers()
  const fwd = hdrs.get('x-forwarded-for')
  const ip = fwd?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || 'local'
  return ip.slice(0, 64)
}

async function mintSession(userId: string): Promise<void> {
  const hdrs = await headers()
  const store = await cookies()
  const { token } = createSession(userId, hdrs.get('user-agent'))
  store.set(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(sessionTtlMs() / 1000),
  })
}

export interface ChallengeResponse {
  challengeId: string
  challenge: string
  expiresAt: number
}

/**
 * Step 1: server issues random bytes.
 *
 * The challenge is NOT tied to any configured wallet — that concept is gone. When the client
 * already knows which account it will sign with, `wallet` binds the challenge to it so no
 * other key can answer; otherwise any key may answer, which is what first contact needs.
 *
 * `purpose` keeps login and enrolment challenges in one table without letting one satisfy
 * the other: a login proof cannot create an organization, and an enrolment proof cannot mint
 * a session for an account that does not exist yet.
 */
export async function requestChallengeAction(
  wallet?: string,
  purpose: 'login' | 'enrol' = 'login',
): Promise<ChallengeResponse> {
  const { challenge, expiresAt } = issueChallenge()
  const challengeId = `chl_${randomBytes(12).toString('hex')}`
  storeChallenge(challengeId, challenge, purpose, expiresAt, wallet ?? null)
  return { challengeId, challenge, expiresAt }
}

/**
 * Machine-readable failure class.
 *
 * The server previously returned one uniform message for every verification failure, on the
 * theory that telling an attacker why they failed is free information. In practice it was
 * not free: success versus failure is already known to whoever attempted it, and a single
 * opaque string was costing the operator the ability to fix a real misconfiguration. These
 * reasons expose nothing an observer of this page cannot already determine.
 */
export type VerifyFailure =
  | 'throttled'
  | 'challenge'
  | 'wrong_signer'
  | 'malformed'
  | 'bad_claim'
  | 'bound_mismatch'

/**
 * Outcome of a proof of control.
 *
 * `needs_signup` is a SUCCESS of the cryptographic step, not a failure of it. The caller
 * proved control of a key; the database simply has no account for it yet. Collapsing that
 * into the failure branch would be a lie about what happened.
 */
export type VerifyOutcome =
  | { ok: true; kind: 'authenticated' }
  | { ok: true; kind: 'needs_signup' }
  | { ok: false; reason: VerifyFailure; error: string }

const FAILURE_MESSAGES: Record<VerifyFailure, string> = {
  throttled: '',
  challenge: 'That challenge is expired or already used. Request a new one.',
  wrong_signer:
    'That signature did not come from the wallet you said it did. Confirm the active account in your wallet matches the address shown here.',
  malformed:
    'The wallet returned a signature the server could not read. This is a wallet or extension version problem, not a wrong account.',
  bad_claim: 'That does not look like a Stellar account ID (it should start with G and be 56 characters).',
  bound_mismatch:
    'This challenge was issued for a different account. Sign in again so a fresh challenge is issued for the active one.',
}

/**
 * Step 2: the wallet signs the challenge, the server verifies and consumes it.
 *
 * Ordering matters and is deliberate:
 *   throttle -> consume -> verify
 *
 * The challenge is consumed BEFORE verification. If it were verified first, an attacker
 * could burn challenges they cannot sign, and a single failed guess would invalidate a
 * legitimate operator's in-flight challenge.
 */
export async function verifyChallengeAction(input: {
  challengeId: string
  signature: string
  wallet: string
}): Promise<VerifyOutcome> {
  const key = await throttleKey()
  const verdict = consumeLoginAttempt(key)
  if (!verdict.allowed) {
    return {
      ok: false,
      reason: 'throttled',
      error: `Too many attempts. Try again in ${verdict.retryAfterSec}s.`,
    }
  }

  const row = consumeChallenge(input.challengeId, 'login')
  if (!row) {
    return { ok: false, reason: 'challenge', error: FAILURE_MESSAGES.challenge }
  }

  const check = verifyChallengeSignature(row.challenge, input.signature, input.wallet, row.walletPublicKey)
  if (!check.ok) {
    return { ok: false, reason: check.reason, error: FAILURE_MESSAGES[check.reason] }
  }

  // Proof of control established. From here the decision is entirely about the database.
  const user = findUserByWallet(check.publicKey)
  if (!user) return { ok: true, kind: 'needs_signup' }

  await mintSession(user.id)
  clearLoginAttempts(key)
  return { ok: true, kind: 'authenticated' }
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

export interface SignupResult {
  ok: boolean
  reason?: VerifyFailure | SignupError
  error?: string
}

const SIGNUP_MESSAGES: Record<string, string> = {
  invalid_treasury: 'That settlement address is not a valid Stellar account (G..., 56 characters).',
  org_name_required: 'Give your organization a name.',
  already_registered: 'That wallet already belongs to an organization. Sign in instead.',
  invalid_signer_registration:
    'That signer service could not be registered. It must be an https URL on a host this deployment permits, with a token variable this process already has set.',
}

/**
 * Create an organization, with the caller as its owner.
 *
 * The caller re-proves control of the wallet here with a challenge bound to it, rather than
 * the server trusting an identity handed over from the previous step. It costs one extra
 * signature prompt and removes an entire class of "client told us who it was" bugs.
 *
 * What this grants is membership of exactly one new organization. It cannot join, impersonate
 * or administer any other.
 */
export async function signupAction(input: {
  challengeId: string
  signature: string
  wallet: string
  organizationName: string
  settlementRecipient: string
  signerUrl?: string
  signerTokenEnv?: string
  displayName?: string
}): Promise<SignupResult> {
  const key = await throttleKey()
  const verdict = consumeLoginAttempt(key)
  if (!verdict.allowed) {
    return {
      ok: false,
      reason: 'throttled',
      error: `Too many attempts. Try again in ${verdict.retryAfterSec}s.`,
    }
  }

  const row = consumeChallenge(input.challengeId, 'enrol')
  if (!row) return { ok: false, reason: 'challenge', error: FAILURE_MESSAGES.challenge }

  const check = verifyChallengeSignature(row.challenge, input.signature, input.wallet, row.walletPublicKey)
  if (!check.ok) return { ok: false, reason: check.reason, error: FAILURE_MESSAGES[check.reason] }

  try {
    const { userId } = createOrganizationWithOwner({
      walletPublicKey: check.publicKey,
      displayName: input.displayName?.trim() || input.organizationName.trim(),
      organizationName: input.organizationName,
      settlementRecipient: input.settlementRecipient,
      signerUrl: input.signerUrl,
      signerTokenEnv: input.signerTokenEnv,
    })
    await mintSession(userId)
    clearLoginAttempts(key)
    return { ok: true }
  } catch (err) {
    if (err instanceof SignupFailure) {
      return { ok: false, reason: err.reason, error: SIGNUP_MESSAGES[err.reason] }
    }
    throw err
  }
}

/** Server action wrapper so the client can trigger the redirect after success. */
export async function completeLoginAction(): Promise<void> {
  redirect('/overview')
}