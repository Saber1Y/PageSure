/**
 * Settlement routing: which account receives money for a given request.
 *
 * There is exactly one answer to "who gets paid here", and it is
 * `service -> organization -> settlementRecipient`. It used to be a single process-wide
 * `PROVIDER_RECIPIENT_G`, which was correct only while the operator and the provider were
 * the same party. Once a second organization exists, a global recipient means every
 * tenant's revenue lands in whichever treasury was configured last, and the bug is silent:
 * payments succeed, the ledger balances, and the money is simply in the wrong place.
 *
 * So the resolution lives here, in one place, and every call site asks for it rather than
 * reading configuration. The alternative — threading `organizationId` and re-deriving the
 * recipient at each of the six call sites — is how the two paths drift apart in the first
 * place, and the charge path and the channel path settling to different accounts is exactly
 * the failure that would be hardest to notice in a demo.
 */

import { StrKey } from '@stellar/stellar-sdk'
import { db } from '@/lib/db/client'
import { organizations } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

/** What a payer is told to pay, and what a settlement row records. */
export interface SettlementTarget {
  /** Stellar account that receives the funds. */
  recipient: string
  /**
   * G... (med25519) commitment public key, for channel-mode services.
   *
   * Null when the organization has not registered one. Channel open must fail rather than
   * substitute a shared key: a shared commitment key would authorize one organization to
   * sign withdrawals from another organization's channel.
   */
  commitmentPublicKey: string | null
}

export class SettlementUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlementUnavailableError'
  }
}

export function settlementTargetForOrganization(organizationId: string): SettlementTarget | null {
  const row = db()
    .select({
      recipient: organizations.settlementRecipient,
      commitmentPublicKey: organizations.commitmentPublicKey,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get()

  if (!row) return null
  return { recipient: row.recipient, commitmentPublicKey: row.commitmentPublicKey }
}

/**
 * Recipient for a charge-mode payment.
 *
 * Throws rather than returning null: a request that has already passed policy and is about
 * to be charged must not proceed without a destination, and a missing organization here is a
 * data-integrity failure rather than a routine condition to handle upstream.
 */
export function requireSettlementRecipient(organizationId: string): string {
  const target = settlementTargetForOrganization(organizationId)
  if (!target) {
    throw new SettlementUnavailableError(`organization ${organizationId} does not exist`)
  }
  if (!StrKey.isValidEd25519PublicKey(target.recipient)) {
    // Surfaced explicitly because the stored value came from a user during signup, so this
    // is a reachable state rather than a hypothetical corruption.
    throw new SettlementUnavailableError(
      `organization ${organizationId} has an invalid settlement account`,
    )
  }
  return target.recipient
}

/**
 * Commitment key for a channel-mode service.
 *
 * Required only for channels. The raw 32 bytes are returned because the factory contract
 * takes `BytesN<32>`, not a StrKey string: passing the G... encoding would have the SDK read
 * the 56 ASCII characters as bytes and fail at signature time, long after the channel was
 * funded and the money was already escrowed.
 */
export function requireCommitmentKeyBytes(organizationId: string): Buffer {
  const target = settlementTargetForOrganization(organizationId)
  if (!target) {
    throw new SettlementUnavailableError(`organization ${organizationId} does not exist`)
  }
  if (!target.commitmentPublicKey) {
    throw new SettlementUnavailableError(
      'this organization has no channel commitment key, so it cannot open payment channels',
    )
  }
  let decoded: Buffer
  try {
    decoded = Buffer.from(StrKey.decodeMed25519PublicKey(target.commitmentPublicKey))
  } catch {
    throw new SettlementUnavailableError(
      'this organization has a malformed channel commitment key',
    )
  }
  if (decoded.length !== 32) {
    throw new SettlementUnavailableError('channel commitment key must be 32 bytes')
  }
  return decoded
}