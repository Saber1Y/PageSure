/**
 * Resolving an organization's channel signer.
 *
 * Charge mode needs a recipient and nothing else. Channel mode additionally needs someone who
 * can sign a withdrawal with the organization's commitment key, and PageSure is deliberately
 * not that someone.
 *
 * The gate here is what keeps that true in practice: `requireCommitmentSigner` is the only way
 * to obtain a usable signer, and it refuses when any part is missing rather than falling back
 * to a process-wide default. A shared fallback would let one organization's settlement be
 * signed by another's key.
 */

import { db } from '@/lib/db/client'
import { organizations } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import type { OrganizationSigner } from './signer-client'

export class CommitmentSignerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommitmentSignerUnavailableError'
  }
}

interface SignerRow {
  commitmentPublicKey: string | null
  commitmentSignerUrl: string | null
  commitmentSignerTokenEnv: string | null
}

function row(organizationId: string): SignerRow | undefined {
  return db()
    .select({
      commitmentPublicKey: organizations.commitmentPublicKey,
      commitmentSignerUrl: organizations.commitmentSignerUrl,
      commitmentSignerTokenEnv: organizations.commitmentSignerTokenEnv,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get()
}

/** Why channel settlement is unavailable, or the signer's public details if it is. */
export function commitmentSignerStatus(
  organizationId: string,
): { ready: true; commitmentPublicKey: string } | { ready: false; reason: string } {
  const found = row(organizationId)
  if (!found) return { ready: false, reason: `organization ${organizationId} does not exist` }

  if (!found.commitmentPublicKey) {
    return {
      ready: false,
      reason: 'this organization has no channel commitment key, so it cannot open payment channels',
    }
  }
  if (!found.commitmentSignerUrl) {
    return {
      ready: false,
      reason:
        'this organization has no channel signer service registered, so it cannot authorize a withdrawal',
    }
  }
  if (!found.commitmentSignerTokenEnv) {
    return {
      ready: false,
      reason: 'this organization has no signer token environment variable configured',
    }
  }
  if (!process.env[found.commitmentSignerTokenEnv]) {
    // The variable name is recorded but the operator has not set it in this process. Naming the
    // variable is the whole point of storing a name rather than a value.
    return {
      ready: false,
      reason: `signer token environment variable ${found.commitmentSignerTokenEnv} is not set in this process`,
    }
  }

  return { ready: true, commitmentPublicKey: found.commitmentPublicKey }
}

/**
 * The organization's signer, ready to use. Throws rather than returning a partial signer.
 */
export function requireCommitmentSigner(
  organizationId: string,
): OrganizationSigner & { commitmentPublicKey: string } {
  const status = commitmentSignerStatus(organizationId)
  if (!status.ready) {
    throw new CommitmentSignerUnavailableError(status.reason)
  }

  const found = row(organizationId)
  const tokenEnv = found?.commitmentSignerTokenEnv
  if (!found?.commitmentSignerUrl || !tokenEnv) {
    // Unreachable: status.ready already established both are present. Kept so this cannot
    // silently return a signer with an empty token if the two ever diverge.
    throw new CommitmentSignerUnavailableError(
      `organization ${organizationId} signer registration is incomplete`,
    )
  }

  const token = process.env[tokenEnv]
  if (!token) {
    throw new CommitmentSignerUnavailableError(
      `signer token environment variable ${tokenEnv} is not set in this process`,
    )
  }

  return {
    url: found.commitmentSignerUrl,
    token,
    commitmentPublicKey: status.commitmentPublicKey,
  }
}