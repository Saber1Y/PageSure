import { and, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  activityEvents,
  incidents,
  paymentSessions,
  requests,
  reviewDecisions,
  services,
  settlements,
} from '@/lib/db/schema'
import { toBig } from '@/lib/money'
import type { PolicyTrace } from '@/lib/policy/types'

/**
 * Every dashboard number is a query over the write tables. No cached counters, so a
 * figure can never disagree with the rows behind it.
 *
 * TENANT SCOPE: every function takes the caller's organizationId and filters on it. There
 * is deliberately no unscoped overload and no "trusted internal caller" escape hatch —
 * a code path that can read every organization's rows is a cross-tenant read waiting to
 * happen, and the compiler cannot catch that.
 *
 * Scoping an id lookup like `requestDetail` is the important case. Filtering only on the
 * primary key would let any signed-in operator guess or steal another organization's row
 * id and read it; adding `organizationId` to the WHERE clause makes a foreign id resolve to
 * the same thing a nonexistent id does, which is `null`.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface OverviewStats {
  totalRequests: number
  paidRequests: number
  paymentVolumeBase: string
  activeSessions: number
  policyAllowed: number
  policyBlocked: number
  policyReview: number
  todayVolumeBase: string
  pendingSessionsBase: string
  settledBase: string
  pendingReviews: number
  openIncidents: number
}

export function overviewStats(organizationId: string): OverviewStats {
  const target = db()
  const todayStart = Date.now() - DAY_MS
  const org = eq(requests.organizationId, organizationId)

  const requestCounts = target
    .select({ status: requests.status, n: count() })
    .from(requests)
    .where(org)
    .groupBy(requests.status)
    .all()

  const byStatus = new Map(requestCounts.map((r) => [r.status, r.n]))
  const sum = (statuses: string[]): number =>
    statuses.reduce((acc, s) => acc + (byStatus.get(s as never) ?? 0), 0)

  const paid = sum(['paid'])
  const blocked = sum(['blocked', 'rejected_mismatch', 'charged_not_delivered'])
  const review = sum(['review_pending'])

  const volumeRows = target
    .select({ amount: requests.amountBase })
    .from(requests)
    .where(and(org, inArray(requests.status, ['paid'])))
    .all()
  const totalVolume = volumeRows.reduce<bigint>((acc, r) => acc + toBig(r.amount), 0n)

  const todayRows = target
    .select({ amount: requests.amountBase })
    .from(requests)
    .where(and(org, inArray(requests.status, ['paid']), gte(requests.createdAt, todayStart)))
    .all()
  const todayVolume = todayRows.reduce<bigint>((acc, r) => acc + toBig(r.amount), 0n)

  const sessions = target
    .select({ status: paymentSessions.status, cumulative: paymentSessions.cumulativeBase })
    .from(paymentSessions)
    .where(and(eq(paymentSessions.organizationId, organizationId), inArray(paymentSessions.status, ['opening', 'active', 'settling'])))
    .all()

  const pendingSessions = sessions.reduce<bigint>(
    (acc, s) => acc + toBig(s.cumulative),
    0n,
  )

  const settledRows = target
    .select({ amount: settlements.amountBase })
    .from(settlements)
    .where(and(eq(settlements.organizationId, organizationId), eq(settlements.status, 'confirmed')))
    .all()
  const settled = settledRows.reduce<bigint>((acc, r) => acc + toBig(r.amount), 0n)

  const pendingReviews = target
    .select({ n: count() })
    .from(reviewDecisions)
    .where(and(eq(reviewDecisions.organizationId, organizationId), eq(reviewDecisions.status, 'pending')))
    .get()

  const openIncidents = target
    .select({ n: count() })
    .from(incidents)
    .where(and(eq(incidents.organizationId, organizationId), isNull(incidents.acknowledgedAt)))
    .get()

  const totalRequests = target
    .select({ n: count() })
    .from(requests)
    .where(org)
    .get()

  return {
    totalRequests: totalRequests?.n ?? 0,
    paidRequests: paid,
    paymentVolumeBase: totalVolume.toString(),
    activeSessions: sessions.length,
    policyAllowed: paid,
    policyBlocked: blocked,
    policyReview: review,
    todayVolumeBase: todayVolume.toString(),
    pendingSessionsBase: pendingSessions.toString(),
    settledBase: settled.toString(),
    pendingReviews: pendingReviews?.n ?? 0,
    openIncidents: openIncidents?.n ?? 0,
  }
}

export interface ServiceRollup {
  id: string
  slug: string
  name: string
  status: string
  mode: string
  priceBase: string
  assetCode: string
  decimals: number
  policyId: string | null
  description: string
  requestCount: number
  paidCount: number
  volumeBase: string
  lastRequestAt: number | null
}

export function serviceRollups(organizationId: string): ServiceRollup[] {
  const target = db()
  const rows = target
    .select()
    .from(services)
    .where(eq(services.organizationId, organizationId))
    .orderBy(desc(services.createdAt))
    .all()
  return rows.map((svc) => {
    // Scoped on organization as well as service: the two must agree, and a service id from
    // another tenant must never contribute numbers even if it somehow matched.
    const stats = target
      .select({ n: count(), last: sql<number | null>`max(${requests.createdAt})` })
      .from(requests)
      .where(and(eq(requests.organizationId, organizationId), eq(requests.serviceId, svc.id)))
      .get()
    const paidRows = target
      .select({ amount: requests.amountBase })
      .from(requests)
      .where(
        and(
          eq(requests.organizationId, organizationId),
          eq(requests.serviceId, svc.id),
          eq(requests.status, 'paid'),
        ),
      )
      .all()
    return {
      id: svc.id,
      slug: svc.slug,
      name: svc.name,
      status: svc.status,
      mode: svc.mode,
      priceBase: svc.priceBase,
      assetCode: svc.assetCode,
      decimals: svc.decimals,
      policyId: svc.policyId,
      description: svc.description,
      requestCount: stats?.n ?? 0,
      paidCount: paidRows.length,
      volumeBase: paidRows.reduce<bigint>((a, r) => a + toBig(r.amount), 0n).toString(),
      lastRequestAt: stats?.last ?? null,
    }
  })
}

export interface ActivityRow {
  id: string
  type: string
  ok: boolean
  message: string
  createdAt: number
  amountBase: string | null
  assetCode: string | null
  decimals: number | null
  requestId: string | null
  sessionId: string | null
}

export function recentActivity(organizationId: string, limit = 20): ActivityRow[] {
  return db()
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.organizationId, organizationId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit)
    .all()
}

export interface SettlementRow {
  id: string
  kind: string
  amountBase: string
  assetCode: string
  decimals: number
  payer: string
  recipient: string
  network: string
  txHash: string
  status: string
  requestCount: number
  explorerUrl: string | null
  createdAt: number
  confirmedAt: number | null
}

export function settlementRows(organizationId: string, limit = 100): SettlementRow[] {
  return db()
    .select()
    .from(settlements)
    .where(eq(settlements.organizationId, organizationId))
    .orderBy(desc(settlements.createdAt))
    .limit(limit)
    .all()
}

export interface RequestDetailRow {
  id: string
  serviceId: string
  serviceName: string
  status: string
  policyDecision: string
  policyTrace: PolicyTrace | null
  claimedPayer: string | null
  verifiedPayer: string | null
  amountBase: string
  assetCode: string
  decimals: number
  mode: string
  receiptReference: string | null
  paymentTxHash: string | null
  upstreamProvider: string | null
  upstreamStatus: number | null
  latencyMs: number | null
  createdAt: number
}

/**
 * Returns null for a request that does not exist OR belongs to another organization. The
 * two cases are deliberately indistinguishable to the caller.
 */
export function requestDetail(organizationId: string, requestId: string): RequestDetailRow | null {
  const target = db()
  const row = target
    .select()
    .from(requests)
    .innerJoin(services, eq(requests.serviceId, services.id))
    .where(and(eq(requests.organizationId, organizationId), eq(requests.id, requestId)))
    .get()
  if (!row) return null
  const request = row.requests
  return {
    id: request.id,
    serviceId: request.serviceId,
    serviceName: row.services.name,
    status: request.status,
    policyDecision: request.policyDecision,
    policyTrace: request.policyTrace as PolicyTrace | null,
    claimedPayer: request.claimedPayer,
    verifiedPayer: request.verifiedPayer,
    amountBase: request.amountBase,
    assetCode: row.services.assetCode,
    decimals: row.services.decimals,
    mode: request.mode,
    receiptReference: request.receiptReference,
    paymentTxHash: request.paymentTxHash,
    upstreamProvider: request.upstreamProvider,
    upstreamStatus: request.upstreamStatus,
    latencyMs: request.latencyMs,
    createdAt: request.createdAt,
  }
}

export function incidentRows(organizationId: string, limit = 100) {
  return db()
    .select()
    .from(incidents)
    .where(eq(incidents.organizationId, organizationId))
    .orderBy(desc(incidents.createdAt))
    .limit(limit)
    .all()
}