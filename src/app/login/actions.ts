'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { randomBytes } from 'node:crypto'
import {
  configuredOperatorWallet,
  issueChallenge,
  verifyChallengeSignature,
} from '@/lib/auth/wallet'
import {
  clearLoginAttempts,
  consumeChallenge,
  consumeLoginAttempt,
  createSession,
  operatorForWallet,
  sessionCookieName,
  sessionTtlMs,
  storeChallenge,
} from '@/lib/auth/session'

/**
 * Login server actions.
 *
 * Lives in its own module rather than page.tsx. A page that exports an action AND gets
 * imported by a Client Component pulls its whole import graph into the client bundle,
 * which dragged better-sqlite3 into the browser build. Keeping the action in a
 * 'use server' module lets Next split it correctly.
 *
 * The client signs the challenge with a wallet extension and posts the signature back.
 * There is no password field, so there is no secret on the server to compare against:
 * the only question is whether the signature verifies against the CONFIGURED settlement
 * wallet.
 */

/**
 * Best-effort client identity for throttling.
 *
 * x-forwarded-for is client-controlled, so on its own it would let an attacker reset
 * their own counter by sending a random header. It is therefore used only to slow down
 * casual attempts, never as an identity claim, and the real limit is that a forged
 * signature cannot verify regardless of where it came from.
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
  wallet: string
  expiresAt: number
}

/** Step 1: server issues random bytes for the configured settlement wallet. */
export async function requestChallengeAction(): Promise<ChallengeResponse> {
  const wallet = configuredOperatorWallet()
  const { challenge, expiresAt } = issueChallenge()
  const challengeId = `chl_${randomBytes(12).toString('hex')}`
  storeChallenge(challengeId, challenge, 'login', expiresAt)
  return { challengeId, challenge, wallet, expiresAt }
}

export interface VerifyResult {
  ok: boolean
  error?: string
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
}): Promise<VerifyResult> {
  const key = await throttleKey()
  const verdict = consumeLoginAttempt(key)
  if (!verdict.allowed) {
    return { ok: false, error: `Too many attempts. Try again in ${verdict.retryAfterSec}s.` }
  }

  const row = consumeChallenge(input.challengeId, 'login')
  if (!row) return { ok: false, error: 'That challenge is expired or already used. Request a new one.' }

  const expected = configuredOperatorWallet()
  const check = verifyChallengeSignature(row.challenge, input.signature, expected)
  if (!check.ok) {
    // Deliberately does not distinguish 'malformed' from 'wrong_signer' in the message
    // the caller sees: the only thing worth telling an attacker is that it failed.
    return { ok: false, error: 'Signature did not verify against the configured settlement wallet.' }
  }

  const user = operatorForWallet(check.publicKey)
  await mintSession(user.id)
  clearLoginAttempts(key)
  return { ok: true }
}

/** Server action wrapper so the client can trigger the redirect after success. */
export async function completeLoginAction(): Promise<void> {
  redirect('/overview')
}
