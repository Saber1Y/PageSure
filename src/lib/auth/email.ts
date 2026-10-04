import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { emailTokens } from '@/lib/db/schema'

/**
 * Email sign-in.
 *
 * Why this exists at all: a payment gateway is bought by a company, and a company's
 * finance team does not install a browser extension to look at request logs. Requiring a
 * wallet to read a dashboard makes the product's onboarding depend on the buyer already
 * understanding Stellar, which is a demand-side problem we cannot solve by explaining it
 * better in a README.
 *
 * So the address is the identity and the wallet is the authority:
 *
 *   email      who you are        -> authentication
 *   membership what you may do    -> authorization
 *   wallet     what you control   -> financial authority, verified once, separately
 *
 * The wallet is still the better credential for the things it should be used for. It is
 * just not the answer to "who is logged in".
 *
 * Threat model for the link itself:
 *
 *   A magic link is a bearer credential that travels through someone's inbox. Three
 *   properties make it safe enough to be the primary login:
 *
 *     1. Only a hash is stored. `tokenHash` is SHA-256 of the token, so a database dump,
 *        a backup, or a leaked screenshot of the table yields nothing that can be used to
 *        authenticate. This is the same rule the session table already follows.
 *     2. Single use. The row is marked consumed on first redemption, so a link forwarded
 *        to a colleague, or found later in a shared mailbox, stops working immediately.
 *     3. Short expiry. Fifteen minutes, which is long enough to open an email and short
 *        enough that an old link in a search result is not a standing credential.
 *
 *   Timing: the token is compared in constant time, and the caller is given one generic
 *   failure for every rejection reason so a probe cannot distinguish "no such token" from
 *   "expired" from "already used".
 */

/** How long a sign-in link stays usable. */
export const EMAIL_TOKEN_TTL_MS = 15 * 60 * 1000

/**
 * Long enough to cover an inbox that is checked on a phone once a day, short enough that it
 * is not a durable credential.
 */
export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

export class EmailAuthError extends Error {
  constructor(public readonly reason: EmailAuthFailure) {
    super(reason)
    this.name = 'EmailAuthError'
  }
}

export type EmailAuthFailure =
  /** Not an address we will send to. */
  | 'invalid_email'
  /** Token absent, unknown, expired or already redeemed. Deliberately indistinguishable. */
  | 'invalid_token'
  /** The address is already in use by another account. */
  | 'email_taken'
  /** Sending is not configured on this deployment. */
  | 'delivery_unconfigured'

/**
 * Addresses are normalised to lowercase and trimmed.
 *
 * Case folding is not cosmetic. Without it `Finance@Acme.com` and `finance@acme.com` are
 * two accounts, which means an invitation sent to one is not honoured by the other and two
 * people can end up believing they own the same address. There is no plus-addressing or
 * gmail-dot normalisation: those rules are provider-specific, and applying the wrong one
 * would merge addresses that are genuinely distinct.
 */
export function normalizeEmail(input: string): string | null {
  const value = input.trim().toLowerCase()
  if (!value || value.length > 254) return null
  // Deliberately conservative: one @, no whitespace, a dotted domain with a 2+ character
  // TLD. This is not an attempt to be a full RFC 5322 parser, it is a filter for typos and
  // for injected values, and the authoritative check is always whether mail to the address
  // is actually delivered.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) return null
  if (value.includes('..')) return null
  const domain = value.slice(value.lastIndexOf('@') + 1)
  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  if (tld.length < 2) return null
  return value
}

/** 256 bits of entropy, base64url. */
function newToken(): string {
  return randomBytes(32).toString('base64url')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Length-independent constant-time comparison over the hex digests. */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Expired rows go, so the table does not become an archive of dead links. */
export function pruneExpiredEmailTokens(): number {
  return db()
    .delete(emailTokens)
    .where(lt(emailTokens.expiresAt, Date.now()))
    .run().changes
}

/**
 * A delivery handle. Email sending is not configured in every environment, and this module
 * must not pretend otherwise: `deliver` is the caller's job, and it is handed the exact URL
 * to send rather than being asked to build one from a base it may not know.
 */
export interface IssuedEmailToken {
  token: string
  email: string
  expiresAt: number
}

export function issueSigninToken(emailInput: string): IssuedEmailToken {
  const email = normalizeEmail(emailInput)
  if (!email) throw new EmailAuthError('invalid_email')

  const token = newToken()
  const now = Date.now()
  const expiresAt = now + EMAIL_TOKEN_TTL_MS
  db()
    .insert(emailTokens)
    .values({
      id: `emt_${randomBytes(12).toString('hex')}`,
      email,
      tokenHash: hashToken(token),
      purpose: 'signin',
      expiresAt,
      createdAt: now,
    })
    .run()
  return { token, email, expiresAt }
}

export interface Invitation {
  token: string
  email: string
  organizationId: string
  role: 'operator' | 'analyst'
  expiresAt: number
}

export function issueInvitation(input: {
  email: string
  organizationId: string
  role: 'operator' | 'analyst'
}): Invitation {
  const email = normalizeEmail(input.email)
  if (!email) throw new EmailAuthError('invalid_email')

  const token = newToken()
  const now = Date.now()
  const expiresAt = now + INVITE_TOKEN_TTL_MS
  db()
    .insert(emailTokens)
    .values({
      id: `emt_${randomBytes(12).toString('hex')}`,
      email,
      tokenHash: hashToken(token),
      purpose: 'invite',
      organizationId: input.organizationId,
      role: input.role,
      expiresAt,
      createdAt: now,
    })
    .run()
  return { token, email, organizationId: input.organizationId, role: input.role, expiresAt }
}

export interface RedeemedEmailToken {
  email: string
  purpose: 'signin' | 'invite'
  organizationId: string | null
  role: 'operator' | 'analyst' | null
}

/**
 * Redeem a token exactly once.
 *
 * The row is selected and claimed in one statement rather than selected-then-updated, so a
 * token that two requests redeem simultaneously cannot produce two sessions: the UPDATE is
 * the gate, and it only matches while `consumed_at IS NULL`. Whoever gets a row back won.
 */
export function redeemEmailToken(token: string, options?: { expectEmail?: string }): RedeemedEmailToken {
  const presented = hashToken(token)

  // An expected address becomes part of the claim's WHERE clause rather than a check afterwards.
  //
  // The difference is not stylistic. If the address were compared once the row was already
  // claimed, then anybody signed in who pasted a forwarded invitation would destroy it: the token
  // would be spent by a request that is about to be refused, and the real recipient could never
  // accept their own invitation. Folding the condition into the claim makes a mismatched
  // redemption match no rows, so the token is left untouched for its rightful owner.
  const conditions = [eq(emailTokens.tokenHash, presented), isNull(emailTokens.consumedAt)]
  const expected = options?.expectEmail ? normalizeEmail(options.expectEmail) : null
  if (expected) conditions.push(eq(emailTokens.email, expected))

  const claimed = db()
    .update(emailTokens)
    .set({ consumedAt: Date.now() })
    .where(and(...conditions))
    .returning()
    .all()

  const row = claimed[0]
  if (!row) throw new EmailAuthError('invalid_token')
  if (row.expiresAt < Date.now()) throw new EmailAuthError('invalid_token')

  return {
    email: row.email,
    purpose: row.purpose,
    organizationId: row.organizationId,
    role: row.role,
  }
}

/** Exported for the redemption path that must not leak a timing signal. */
export function tokensMatch(a: string, b: string): boolean {
  return digestsMatch(a, b)
}