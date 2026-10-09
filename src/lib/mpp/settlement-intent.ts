/**
 * Settlement intents: what an organization's signer service is told to sign.
 *
 * PageSure cannot submit the withdrawal itself. The channel contract requires
 * `to.require_auth()` against the organization's treasury account, and the MPP SDK broadcasts
 * the close using a `feePayer.envelopeSigner` that holds that account's secret. Under the
 * external-signer model PageSure stores neither the treasury secret nor the commitment key,
 * so settlement is necessarily driven by the signer.
 *
 * That makes this endpoint the trust boundary in the other direction. The signer needs the
 * authoritative cumulative before it signs anything, and this is where it gets it. Two rules
 * keep that from becoming a way to have PageSure authorise an arbitrary amount:
 *
 *   - the caller must present the organization's own signer token, compared in constant time
 *   - the amount is PageSure's own recorded cumulative, never a value supplied by the caller
 *
 * The signer signs a binding commitment over the value returned here; it cannot choose a
 * different one, and PageSure re-verifies the binding before anything is accepted.
 */

import { timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { organizations, paymentSessions, services } from '@/lib/db/schema'
import { commitmentSignerStatus } from './signer-registry'
import { formatAmount } from '@/lib/money'
import { addSessionEvent } from '@/lib/sessions/gateway'

export class SettlementIntentUnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlementIntentUnauthorizedError'
  }
}

export class SettlementIntentUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlementIntentUnavailableError'
  }
}

/**
 * One message for every authentication failure, so this endpoint discloses nothing about
 * whether an organization exists or how it is configured.
 */
const DENY = 'settlement intents are not available for this organization'

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak the token length, so the
 * lengths are compared first and both sides then go through the same comparison.
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Authenticate a signer token for one organization.
 *
 * The token is never stored: the database holds only the name of the environment variable, so
 * the value comes from this process. A token belonging to a different organization fails here.
 * Every failure reports the same message, so this endpoint discloses nothing about whether an
 * organization exists or is configured.
 */
export function authenticateSignerToken(organizationId: string, presented: string | null): void {
  if (!presented) {
    throw new SettlementIntentUnauthorizedError(
      'settlement intents require the organization signer token as a bearer credential',
    )
  }

  const row = db()
    .select({
      commitmentSignerUrl: organizations.commitmentSignerUrl,
      commitmentSignerTokenEnv: organizations.commitmentSignerTokenEnv,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get()

  const tokenEnv = row?.commitmentSignerTokenEnv ?? null
  const expected = tokenEnv === null ? undefined : process.env[tokenEnv]

  // Every failure below reports the same message, so this endpoint discloses nothing about
  // whether an organization exists or how it is configured.
  if (!row?.commitmentSignerUrl || tokenEnv === null || !expected) {
    throw new SettlementIntentUnauthorizedError(DENY)
  }
  if (!tokensMatch(presented, expected)) {
    throw new SettlementIntentUnauthorizedError(DENY)
  }
}

export interface SettlementIntent {
  sessionId: string
  channelContract: string
  funder: string
  recipient: string
  assetCode: string
  assetContract: string
  decimals: number
  /** PageSure's own recorded cumulative, in base units. This is the only amount that may be signed. */
  cumulativeBase: string
  /** The same cumulative formatted for the asset, which is what the contract expects. */
  cumulativeFormatted: string
  requestCount: number
  commitmentPublicKey: string
  signerUrl: string
  network: string
}

interface SessionForSettlement {
  id: string
  organizationId: string
  serviceId: string
  channelContract: string
  funder: string
  recipient: string
  assetCode: string
  assetContract: string
  decimals: number
  cumulativeBase: string
  requestCount: number
  status: string
}

/**
 * Build the settlement intent for one session.
 *
 * Throws rather than returning a partial intent, and refuses unless the organization is fully
 * able to settle, so a signer is never handed an intent that PageSure would later reject as
 * unbacked by a usable signer registration.
 */
export function settlementIntent(input: {
  organizationId: string
  sessionId: string
  network: string
}): SettlementIntent {
  const status = commitmentSignerStatus(input.organizationId)
  if (!status.ready) {
    throw new SettlementIntentUnavailableError(status.reason)
  }

  const signerUrl = db()
    .select({ commitmentSignerUrl: organizations.commitmentSignerUrl })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .get()?.commitmentSignerUrl
  if (!signerUrl) {
    throw new SettlementIntentUnavailableError('this organization has no channel signer service registered')
  }

  // The asset code lives on the service, not the session, so the two are read together.
  const session = db()
    .select({
      id: paymentSessions.id,
      organizationId: paymentSessions.organizationId,
      serviceId: paymentSessions.serviceId,
      channelContract: paymentSessions.channelContract,
      funder: paymentSessions.funder,
      recipient: paymentSessions.recipient,
      assetCode: services.assetCode,
      assetContract: paymentSessions.assetContract,
      decimals: paymentSessions.decimals,
      cumulativeBase: paymentSessions.cumulativeBase,
      requestCount: paymentSessions.requestCount,
      status: paymentSessions.status,
    })
    .from(paymentSessions)
    .innerJoin(services, eq(paymentSessions.serviceId, services.id))
    .where(eq(paymentSessions.id, input.sessionId))
    .get() as SessionForSettlement | undefined

  if (!session) {
    throw new SettlementIntentUnavailableError('no session exists with that id')
  }

  // Tenant boundary. The session is looked up by id alone, so its organization has to be
  // checked explicitly before any of its financial details are returned. Reported as "not
  // found" so a valid token for one organization cannot probe another's session ids.
  if (session.organizationId !== input.organizationId) {
    throw new SettlementIntentUnavailableError('no session exists with that id')
  }

  if (session.status !== 'active' && session.status !== 'settling') {
    throw new SettlementIntentUnavailableError(
      `session is ${session.status}; only an active or settling session can be settled`,
    )
  }
  if (!session.channelContract) {
    throw new SettlementIntentUnavailableError('this session has no channel contract to settle')
  }
  if (!session.recipient) {
    throw new SettlementIntentUnavailableError(
      'this session has no recorded recipient, so a withdrawal cannot be directed',
    )
  }

  // Claim the session for settlement the first time an intent is issued. From here on the
  // gateway refuses new vouchers (it only serves active/opening sessions), a repeat intent is
  // a retry of the same claim, and a session that has already closed cannot be settled again.
  if (session.status === 'active') {
    db()
      .update(paymentSessions)
      .set({ status: 'settling', updatedAt: Date.now() })
      .where(eq(paymentSessions.id, session.id))
      .run()
    addSessionEvent(
      input.organizationId,
      session.id,
      'close_requested',
      'Settlement intent issued; the organization signer signs the cumulative and submits the close',
      session.cumulativeBase,
    )
  }

  return {
    sessionId: session.id,
    channelContract: session.channelContract,
    funder: session.funder,
    recipient: session.recipient,
    assetCode: session.assetCode,
    assetContract: session.assetContract,
    decimals: session.decimals,
    cumulativeBase: session.cumulativeBase,
    cumulativeFormatted: formatAmount(session.cumulativeBase, session.decimals),
    requestCount: session.requestCount,
    commitmentPublicKey: status.commitmentPublicKey,
    signerUrl,
    network: input.network,
  }
}