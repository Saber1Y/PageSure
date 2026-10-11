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

import { db } from '@/lib/db/client'
import { StrKey } from '@stellar/stellar-sdk'
import { organizations } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

/** What a payer is told to pay, and what a settlement row records. */
export interface SettlementTarget {
  /**
   * Stellar account that receives the funds, or null when the organization has not connected
   * one yet.
   *
   * Null is a normal state during onboarding, not a fault. Every caller that needs somewhere
   * to send money must handle it, because "we know who you are but not where to pay you" is
   * the honest answer for an organization that signed up with an email and stopped there.
   */
  recipient: string | null
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
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get()

  if (!row) return null
  // A null recipient is a legitimate state, not corruption: signup completes on email alone
  // and the settlement wallet is connected later. It is carried through as null so the
  // callers that need a payable account fail with a precise reason instead of passing an
  // empty string down into a payment instruction.
  return { recipient: row.recipient }
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
  if (!target.recipient) {
    // The organization completed signup but has not connected a settlement wallet. This is a
    // setup step the operator can finish, so the message says so rather than implying the
    // data is broken.
    throw new SettlementUnavailableError(
      `organization ${organizationId} has no settlement account connected yet`,
    )
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
