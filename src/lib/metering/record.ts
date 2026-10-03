import { db } from '@/lib/db/client'
import {
  activityEvents,
  incidents,
  requests,
  settlements,
} from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { PolicyTrace } from '@/lib/policy/types'

/**
 * Single writer for gateway outcomes. Every dashboard number is a query over these
 * tables; there are no cached counters that can drift from reality.
 */

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

export interface RecordRequestInput {
  /** Optional: caller supplies the id so MPP externalId can reference it. */
  id?: string
  serviceId: string
  policyId: string | null
  sessionId: string | null
  reviewId: string | null
  claimedPayer: string | null
  verifiedPayer: string | null
  mode: 'charge' | 'channel'
  amountBase: string
  status:
    | 'challenged'
    | 'paid'
    | 'blocked'
    | 'review_pending'
    | 'rejected_mismatch'
    | 'charged_not_delivered'
    | 'failed'
  policyDecision: 'allow' | 'review' | 'block' | 'none'
  policyTrace: PolicyTrace
  receiptReference?: string | null
  paymentTxHash?: string | null
  settlementId?: string | null
  upstreamProvider?: string | null
  upstreamStatus?: number | null
  latencyMs?: number | null
}

export function recordRequest(input: RecordRequestInput): string {
  const id = input.id ?? newId('req')
  db()
    .insert(requests)
    .values({
      id,
      serviceId: input.serviceId,
      policyId: input.policyId,
      sessionId: input.sessionId,
      reviewId: input.reviewId,
      // Store the JSON trace as-is. Drizzle serialises mode:'json' columns.
      policyTrace: input.policyTrace,
      claimedPayer: input.claimedPayer,
      verifiedPayer: input.verifiedPayer,
      mode: input.mode,
      amountBase: input.amountBase,
      status: input.status,
      policyDecision: input.policyDecision,
      receiptReference: input.receiptReference ?? null,
      paymentTxHash: input.paymentTxHash ?? null,
      settlementId: input.settlementId ?? null,
      upstreamProvider: input.upstreamProvider ?? null,
      upstreamStatus: input.upstreamStatus ?? null,
      latencyMs: input.latencyMs ?? null,
      createdAt: Date.now(),
    })
    .run()
  return id
}

export function updateRequest(
  id: string,
  patch: Partial<RecordRequestInput>,
): void {
  const values: Record<string, unknown> = {}
  if (patch.status !== undefined) values.status = patch.status
  if (patch.policyDecision !== undefined) values.policyDecision = patch.policyDecision
  if (patch.policyTrace !== undefined) values.policyTrace = patch.policyTrace
  if (patch.verifiedPayer !== undefined) values.verifiedPayer = patch.verifiedPayer
  if (patch.receiptReference !== undefined) values.receiptReference = patch.receiptReference
  if (patch.paymentTxHash !== undefined) values.paymentTxHash = patch.paymentTxHash
  if (patch.settlementId !== undefined) values.settlementId = patch.settlementId
  if (patch.upstreamProvider !== undefined) values.upstreamProvider = patch.upstreamProvider
  if (patch.upstreamStatus !== undefined) values.upstreamStatus = patch.upstreamStatus
  if (patch.latencyMs !== undefined) values.latencyMs = patch.latencyMs
  if (patch.reviewId !== undefined) values.reviewId = patch.reviewId
  if (Object.keys(values).length === 0) return
  db().update(requests).set(values).where(eq(requests.id, id)).run()
}

export interface RecordSettlementInput {
  kind: 'charge' | 'session'
  requestId: string | null
  sessionId: string | null
  requestCount: number
  amountBase: string
  assetContract: string
  assetCode: string
  decimals: number
  payer: string
  recipient: string
  network: string
  txHash: string
  status: 'pending' | 'confirmed' | 'failed'
  ledger?: number | null
  explorerUrl?: string | null
}

export function recordSettlement(input: RecordSettlementInput): string {
  const id = newId('stl')
  const now = Date.now()
  db()
    .insert(settlements)
    .values({
      id,
      kind: input.kind,
      requestId: input.requestId,
      sessionId: input.sessionId,
      requestCount: input.requestCount,
      amountBase: input.amountBase,
      assetContract: input.assetContract,
      assetCode: input.assetCode,
      decimals: input.decimals,
      payer: input.payer,
      recipient: input.recipient,
      network: input.network,
      txHash: input.txHash,
      status: input.status,
      ledger: input.ledger ?? null,
      explorerUrl: input.explorerUrl ?? explorerUrl(input.network, input.txHash),
      createdAt: now,
      confirmedAt: input.status === 'confirmed' ? now : null,
    })
    .run()
  return id
}

export function explorerUrl(network: string, txHash: string): string {
  const host = network === 'stellar:pubnet' ? 'stellar.expert' : 'stellar.expert'
  const suffix = network === 'stellar:pubnet' ? 'mainnet' : 'testnet'
  return `https://${host}/explorer/${suffix}/tx/${txHash}`
}

export interface RecordIncidentInput {
  kind:
    | 'charged_not_delivered'
    | 'settlement_failed'
    | 'upstream_failed'
    | 'channel_dispute'
  requestId: string | null
  sessionId: string | null
  serviceId: string | null
  payer: string
  amountBase: string
  assetCode: string
  decimals: number
  reason: string
  policyTrace: PolicyTrace | null
  paymentTxHash: string | null
}

export function recordIncident(input: RecordIncidentInput): string {
  const id = newId('inc')
  db()
    .insert(incidents)
    .values({
      id,
      kind: input.kind,
      requestId: input.requestId,
      sessionId: input.sessionId,
      serviceId: input.serviceId,
      payer: input.payer,
      amountBase: input.amountBase,
      assetCode: input.assetCode,
      decimals: input.decimals,
      reason: input.reason,
      policyTrace: input.policyTrace,
      paymentTxHash: input.paymentTxHash,
      createdAt: Date.now(),
    })
    .run()
  return id
}

export interface RecordActivityInput {
  type:
    | 'request_paid'
    | 'session_opened'
    | 'session_settled'
    | 'payment_blocked'
    | 'review_pending'
    | 'review_resolved'
    | 'service_created'
    | 'incident'
  ok?: boolean
  message: string
  serviceId?: string | null
  sessionId?: string | null
  requestId?: string | null
  amountBase?: string | null
  assetCode?: string | null
  decimals?: number | null
}

export function recordActivity(input: RecordActivityInput): void {
  db()
    .insert(activityEvents)
    .values({
      id: newId('act'),
      type: input.type,
      ok: input.ok ?? true,
      message: input.message,
      serviceId: input.serviceId ?? null,
      sessionId: input.sessionId ?? null,
      requestId: input.requestId ?? null,
      amountBase: input.amountBase ?? null,
      assetCode: input.assetCode ?? null,
      decimals: input.decimals ?? null,
      createdAt: Date.now(),
    })
    .run()
}