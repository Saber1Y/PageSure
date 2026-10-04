import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { paymentSessions, policyGrants, reviewDecisions } from '@/lib/db/schema'
import { randomUUID } from 'node:crypto'

/**
 * REVIEW lifecycle.
 *
 * REVIEW genuinely holds: preflight returns it BEFORE any challenge is issued, so no
 * payment is taken and no upstream call happens. The client retries with the returned
 * review id; if a human approved in the meantime, a time-boxed policy_grants row
 * exists and preflight now returns ALLOW.
 *
 * Approving a review NEVER mutates the allowlist. Allowlist is a standing
 * relationship; a grant is a scoped, expiring authorisation for one service.
 */

export function createReview(input: {
  organizationId: string
  policyId: string
  serviceId: string
  wallet: string
  reason: string
  amountBase: string
  policyTrace: unknown
  ttlMs?: number
}): string {
  const id = `rev_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const now = Date.now()
  db()
    .insert(reviewDecisions)
    .values({
      id,
      organizationId: input.organizationId,
      policyId: input.policyId,
      serviceId: input.serviceId,
      wallet: input.wallet,
      reason: input.reason,
      policyTrace: input.policyTrace,
      amountBase: input.amountBase,
      status: 'pending',
      expiresAt: now + (input.ttlMs ?? 24 * 60 * 60 * 1000),
      note: '',
      replays: 0,
      createdAt: now,
    })
    .run()
  return id
}

/**
 * Look up a review the client presented, scoped so one service cannot reuse another's.
 * The organizationId comes from the resolved service, never from client input.
 */
export function findPresentedReview(organizationId: string, reviewId: string, serviceId: string, wallet: string) {
  return db()
    .select()
    .from(reviewDecisions)
    .where(
      and(
        eq(reviewDecisions.organizationId, organizationId),
        eq(reviewDecisions.id, reviewId),
        eq(reviewDecisions.serviceId, serviceId),
        eq(reviewDecisions.wallet, wallet),
      ),
    )
    .get()
}

/**
 * Resolve a review. Approving writes a policy_grants row scoped to this service and
 * bounded in time. Rejecting writes nothing, so the wallet is held again on retry.
 *
 * `organizationId` is the caller's organization from `requireUser()`, never a value from
 * the request body. Without it, any signed-in operator could resolve any organization's
 * review by id — an approval is an authorization grant, so that would be a tenant-escalation
 * bug, not an information leak. A review belonging to another organization is reported as
 * not found for the same reason.
 */
export function resolveReview(input: {
  organizationId: string
  reviewId: string
  resolvedBy: string
  /** Explicit. The note is audit text and is never interpreted. */
  action: 'approve' | 'reject'
  note: string
  grantTtlMs?: number
}): { ok: true; grantId: string | null; status: 'approved' | 'rejected' } | { ok: false; reason: string } {
  const target = db()
  const review = target
    .select()
    .from(reviewDecisions)
    .where(and(eq(reviewDecisions.organizationId, input.organizationId), eq(reviewDecisions.id, input.reviewId)))
    .get()
  if (!review) return { ok: false, reason: 'review not found' }
  if (review.status !== 'pending') return { ok: false, reason: `review already ${review.status}` }
  if (review.expiresAt < Date.now()) {
    target
      .update(reviewDecisions)
      .set({ status: 'expired', resolvedAt: Date.now(), resolvedBy: input.resolvedBy, note: input.note })
      .where(and(eq(reviewDecisions.organizationId, input.organizationId), eq(reviewDecisions.id, input.reviewId)))
      .run()
    return { ok: false, reason: 'review expired' }
  }

  const now = Date.now()

  if (input.action === 'reject') {
    target
      .update(reviewDecisions)
      .set({ status: 'rejected', resolvedAt: now, resolvedBy: input.resolvedBy, note: input.note })
      .where(and(eq(reviewDecisions.organizationId, input.organizationId), eq(reviewDecisions.id, input.reviewId)))
      .run()
    return { ok: true, grantId: null, status: 'rejected' }
  }

  const grantTtl = input.grantTtlMs ?? 24 * 60 * 60 * 1000
  const grantId = `grn_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  target
    .insert(policyGrants)
    .values({
      id: grantId,
      organizationId: review.organizationId,
      policyId: review.policyId,
      serviceId: review.serviceId,
      wallet: review.wallet,
      grantedFromReviewId: review.id,
      expiresAt: now + grantTtl,
      revokedAt: null,
      createdAt: now,
    })
    .run()

  target
    .update(reviewDecisions)
    .set({ status: 'approved', resolvedAt: now, resolvedBy: input.resolvedBy, note: input.note })
    .where(and(eq(reviewDecisions.organizationId, input.organizationId), eq(reviewDecisions.id, input.reviewId)))
    .run()

  return { ok: true, grantId, status: 'approved' }
}

export function countPendingReviews(organizationId: string): number {
  const row = db()
    .select({ n: sql<number>`count(*)` })
    .from(reviewDecisions)
    .where(and(eq(reviewDecisions.organizationId, organizationId), eq(reviewDecisions.status, 'pending')))
    .get()
  return row?.n ?? 0
}

export function openReviews(organizationId: string, limit = 50) {
  return db()
    .select()
    .from(reviewDecisions)
    .where(and(eq(reviewDecisions.organizationId, organizationId), eq(reviewDecisions.status, 'pending')))
    .orderBy(sql`${reviewDecisions.createdAt} desc`)
    .limit(limit)
    .all()
}

/** Active sessions, newest first, for one organization only. */
export function activeSessions(organizationId: string, limit = 50) {
  return db()
    .select()
    .from(paymentSessions)
    .where(
      and(
        eq(paymentSessions.organizationId, organizationId),
        sql`${paymentSessions.status} in ('opening','active','settling')`,
      ),
    )
    .orderBy(sql`${paymentSessions.createdAt} desc`)
    .limit(limit)
    .all()
}