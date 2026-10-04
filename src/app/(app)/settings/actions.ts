'use server'

import { StrKey } from '@stellar/stellar-sdk'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { loginChallenges, organizations } from '@/lib/db/schema'
import {
  consumeChallenge,
  consumeLoginAttempt,
  requireUser,
  sessionIdentity,
  storeChallenge,
} from '@/lib/auth/session'
import { issueChallenge, verifyChallengeSignature } from '@/lib/auth/wallet'
import {
  acceptInvitation,
  IdentityError,
  listMembers,
  organizationById,
  requireRole,
  setSettlementWallet,
} from '@/lib/auth/identity'
import { deliverInvitation } from '@/lib/auth/mail'
import { issueInvitation, normalizeEmail } from '@/lib/auth/email'
import { validateSignerRegistration } from '@/lib/mpp/signer-registration'
import { headers } from 'next/headers'

/**
 * Organization settings: the settlement wallet and the external signer.
 *
 * Both are owner-only, both are deliberately separate from signup, and both moved here out of
 * the login form when sign-in became email-first. Nothing on this page is required to have an
 * account; it is required before an organization can move money, which is a different deadline
 * and belongs to a different moment.
 *
 * The treasury flow is the security-sensitive one, so its shape is worth stating plainly. To
 * change where an organization's money lands, a caller must be all three of:
 *
 *   1. an authenticated owner of that organization,
 *   2. answering a challenge that was minted for that organization,
 *   3. with a signature from the very wallet being installed.
 *
 * Point 3 is why the challenge row records `walletPublicKey` and `organizationId`. A challenge
 * issued to prove control of one wallet, intercepted and replayed against another, fails at
 * the signature check instead of silently redirecting an organization's settlement. And point
 * 1 is why `setSettlementWallet` is not reachable from anywhere but this file: it writes
 * `treasuryVerified` without checking anything itself, and the entire justification for that
 * trust lives in the two steps above it.
 */

export type SettingsFailure =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_wallet'
  | 'challenge_failed'
  | 'signature_failed'
  | 'invalid_signer'
  | 'throttled'
  | 'invalid_email'
  | 'already_member'
  | 'delivery_failed'

export interface ActionResult {
  ok: boolean
  failure?: SettingsFailure
  detail?: string
}

/** The wallet ceremony is expensive and prompts the user; throttle it like any other. */
async function throttleKey(): Promise<string> {
  const hdrs = await headers()
  const fwd = hdrs.get('x-forwarded-for')
  const ip = fwd?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || 'local'
  return ip.slice(0, 64)
}

/**
 * Resolve the caller as an owner of their own active organization.
 *
 * `requireUser()` establishes who they are and which tenant they are acting in;
 * `requireRole` then confirms the membership actually grants owner, so authorization is read
 * from `organization_members` at the point of use rather than trusted from the session copy.
 */
async function requireOwnerOrganizationId(): Promise<{ organizationId: string }> {
  const user = await requireUser()
  if (!requireRole(user.id, user.organizationId, 'owner')) {
    throw new IdentityError('insufficient_role')
  }
  return { organizationId: user.organizationId }
}

/**
 * Step 1 of connecting a treasury: mint a challenge bound to a wallet and an organization.
 *
 * The wallet is bound here, before the signature exists, rather than being trusted from the
 * verification request. If it were only asserted at verification time, a challenge minted for
 * wallet A could be answered by wallet B and the server would have no way to tell that the
 * binding had moved after issuance.
 */
export async function requestTreasuryChallengeAction(
  walletPublicKey: string,
): Promise<{ ok: boolean; challengeId?: string; challenge?: string; failure?: SettingsFailure; detail?: string }> {
  let organizationId = ''
  try {
    ;({ organizationId } = await requireOwnerOrganizationId())
  } catch (error) {
    const failure: SettingsFailure = error instanceof Error && error.message === 'unauthenticated'
      ? 'unauthenticated'
      : 'forbidden'
    return { ok: false, failure }
  }

  const key = `treasury:${await throttleKey()}`
  if (!consumeLoginAttempt(key).allowed) return { ok: false, failure: 'throttled' }

  const wallet = walletPublicKey.trim()
  if (!StrKey.isValidEd25519PublicKey(wallet)) {
    return { ok: false, failure: 'invalid_wallet' }
  }

  const { challenge, expiresAt } = issueChallenge()
  const challengeId = `chl_${crypto.randomUUID()}`
  storeChallenge(challengeId, challenge, 'treasury', expiresAt, wallet, organizationId)

  return { ok: true, challengeId, challenge }
}

/**
 * Step 2: prove control of that wallet, then install it.
 *
 * The order matters. The signature is verified first and the row is only written once it
 * passes, so a failed proof leaves the organization's existing settlement account exactly as
 * it was. The challenge is consumed before verification, so a bad signature cannot be retried
 * against the same challenge.
 */
export async function connectTreasuryAction(input: {
  challengeId: string
  signature: string
  wallet: string
}): Promise<ActionResult> {
  let organizationId = ''
  try {
    ;({ organizationId } = await requireOwnerOrganizationId())
  } catch (error) {
    const failure: SettingsFailure = error instanceof Error && error.message === 'unauthenticated'
      ? 'unauthenticated'
      : 'forbidden'
    return { ok: false, failure }
  }

  const row = consumeChallenge(input.challengeId, 'treasury')
  if (!row) return { ok: false, failure: 'challenge_failed' }

  // The challenge names both the wallet and the organization. Both must still match: a
  // challenge minted for another tenant, or answered by a different wallet than the one it
  // was issued to, is refused before any signature is examined.
  if (row.organizationId !== organizationId) return { ok: false, failure: 'challenge_failed' }
  if (row.walletPublicKey && row.walletPublicKey !== input.wallet.trim()) {
    return { ok: false, failure: 'challenge_failed' }
  }

  const check = verifyChallengeSignature(row.challenge, input.signature, input.wallet, row.walletPublicKey ?? undefined)
  if (!check.ok) return { ok: false, failure: 'signature_failed' }

  try {
    setSettlementWallet({ organizationId, recipient: check.publicKey })
  } catch (error) {
    if (error instanceof IdentityError) return { ok: false, failure: 'invalid_wallet' }
    throw error
  }

  return { ok: true }
}

/**
 * Register or replace the organization's external channel signer.
 *
 * PageSure stores the URL and the *name* of the environment variable holding the token, never
 * the token itself: a compromised dashboard database must not be enough to forge commitments.
 * `validateSignerRegistration` re-checks the host allowlist and token prefix on the way in,
 * so a signer cannot be pointed at an arbitrary endpoint after the fact.
 */
export async function registerSignerAction(input: {
  signerUrl?: string
  signerTokenEnv?: string
}): Promise<ActionResult> {
  let organizationId = ''
  try {
    ;({ organizationId } = await requireOwnerOrganizationId())
  } catch (error) {
    const failure: SettingsFailure = error instanceof Error && error.message === 'unauthenticated'
      ? 'unauthenticated'
      : 'forbidden'
    return { ok: false, failure }
  }

  const key = `signer:${await throttleKey()}`
  if (!consumeLoginAttempt(key).allowed) return { ok: false, failure: 'throttled' }

  const verdict = validateSignerRegistration({
    signerUrl: input.signerUrl?.trim() ?? '',
    signerTokenEnv: input.signerTokenEnv?.trim() ?? '',
  })

  if (!verdict.ok) {
    return { ok: false, failure: 'invalid_signer', detail: verdict.reason }
  }

  db()
    .update(organizations)
    .set({
      commitmentSignerUrl: input.signerUrl?.trim() ?? null,
      commitmentSignerTokenEnv: input.signerTokenEnv?.trim() ?? null,
    })
    .where(eq(organizations.id, organizationId))
    .run()

  // Prune any challenge bound to the previous signer configuration, so a signature captured
  // before this change cannot be presented afterwards.
  db()
    .update(loginChallenges)
    .set({ consumedAt: Date.now() })
    .where(eq(loginChallenges.organizationId, organizationId))
    .run()

  return { ok: true }
}

/**
 * Invite someone into the organization.
 *
 * Owner-only, and the role is an allowlist rather than free text: an invitation is the one
 * place a role is chosen by somebody else, so an unvalidated string here would be a way to
 * create roles the rest of the authorization code has never heard of.
 *
 * The invitation is issued before delivery is attempted, and a failed send reports back
 * rather than pretending to succeed. The token then simply expires unused, which is the
 * correct outcome: the alternative, issuing only after a successful send, would mean holding
 * a token in memory across a network call for no benefit.
 */
export async function inviteMemberAction(input: {
  email: string
  role: 'operator' | 'analyst'
}): Promise<ActionResult> {
  let organizationId = ''
  let inviterName = ''
  let organizationName = ''
  try {
    const user = await requireUser()
    if (!requireRole(user.id, user.organizationId, 'owner')) {
      throw new IdentityError('insufficient_role')
    }
    organizationId = user.organizationId
    inviterName = user.displayName
    organizationName = user.organizationName
  } catch (error) {
    const failure: SettingsFailure = error instanceof Error && error.message === 'unauthenticated'
      ? 'unauthenticated'
      : 'forbidden'
    return { ok: false, failure }
  }

  const key = `invite:${await throttleKey()}`
  if (!consumeLoginAttempt(key).allowed) return { ok: false, failure: 'throttled' }

  const email = normalizeEmail(input.email)
  if (!email) return { ok: false, failure: 'invalid_email' }

  // Already a member? Say so plainly. This is not an account-enumeration surface: the caller
  // is an authenticated owner of this organization and can already read the member list.
  const existing = listMembers(organizationId).find((m) => m.email === email)
  if (existing) return { ok: false, failure: 'already_member' }

  let invitation
  try {
    invitation = issueInvitation({ email, organizationId, role: input.role })
  } catch (error) {
    if (error instanceof Error && error.message.includes('invalid_email')) {
      return { ok: false, failure: 'invalid_email' }
    }
    throw error
  }

  const sent = await deliverInvitation({
    to: email,
    token: invitation.token,
    organizationName,
    inviterName,
  })
  if (!sent.delivered) return { ok: false, failure: 'delivery_failed', detail: sent.reason }

  return { ok: true }
}

/**
 * Accept an invitation from the emailed link.
 *
 * `unauthenticated` is reported separately from `invalid_invitation`, and that is not a token
 * oracle. It describes the caller's own session, which they already know, and every *token*
 * still collapses to the single `invalid_invitation` answer. Splitting the two lets the page
 * tell someone to sign in before sending them back for a link that was never the problem.
 */
export async function acceptInvitationAction(token: string): Promise<
  | { ok: true; organizationName: string }
  | { ok: false; failure: 'invalid_invitation' | 'unauthenticated' }
> {
  // sessionIdentity(), not requireUser(): the person accepting has no membership yet, which is
  // the whole point of accepting. requireUser() resolves through the membership join and would
  // report this invitee as signed out.
  const user = await sessionIdentity()
  if (!user?.email) return { ok: false, failure: 'unauthenticated' }

  try {
    const accepted = acceptInvitation({ token, email: user.email })
    const organization = organizationById(accepted.organizationId)
    return { ok: true, organizationName: organization?.name ?? 'the organization' }
  } catch {
    // Unknown, expired, already-used and forwarded alike.
    return { ok: false, failure: 'invalid_invitation' }
  }
}
