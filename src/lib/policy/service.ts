import { db } from '@/lib/db/client'
import { requests, services } from '@/lib/db/schema'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { toBig } from '@/lib/money'
import { evaluate, loadPolicySnapshot } from './engine'
import type { PolicyContext, PolicySnapshot, PolicyTrace } from './types'

/**
 * Glue between the DB and the pure engine. Owns the two-phase call sites so the
 * gateway reads as a pipeline rather than as policy plumbing.
 */

/** Rolling 24h settled spend for a payer, base units. */
export function payerSpend24h(payer: string): string {
  const since = Date.now() - 24 * 60 * 60 * 1000
  const rows = db()
    .select({ amount: requests.amountBase })
    .from(requests)
    .innerJoin(services, eq(requests.serviceId, services.id))
    .where(
      and(
        inArray(requests.status, ['paid', 'charged_not_delivered']),
        sql`coalesce(${requests.verifiedPayer}, ${requests.claimedPayer}) = ${payer}`,
        gte(requests.createdAt, since),
      ),
    )
    .all()
  return rows.reduce<bigint>((acc, r) => acc + toBig(r.amount), 0n).toString()
}

export interface EvaluateInput {
  serviceId: string
  serviceName: string
  serviceStatus: 'live' | 'paused' | 'draft'
  servicePolicyId: string | null
  assetContract: string
  amountBase: string
  mode: 'charge' | 'channel'
  network: string
  payer: string
}

function buildContext(input: EvaluateInput): PolicyContext {
  return {
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    serviceStatus: input.serviceStatus,
    servicePolicyId: input.servicePolicyId,
    network: input.network,
    assetContract: input.assetContract,
    amountBase: input.amountBase,
    mode: input.mode,
    payer: input.payer,
    payerSpend24hBase: payerSpend24h(input.payer),
  }
}

export interface Evaluation {
  snapshot: PolicySnapshot | null
  trace: PolicyTrace
}

/**
 * PHASE 1 - preflight. This is the enforcement point: it runs before any payment
 * exists, so a block or review here means no challenge, no payment, no upstream call.
 * Counts against the rate limiter.
 */
export function evaluatePreflight(input: EvaluateInput): Evaluation {
  const snapshot = input.servicePolicyId ? loadPolicySnapshot(input.servicePolicyId, input.serviceId) : null
  const trace = evaluate(snapshot, buildContext(input), 'preflight', { countRateLimit: true })
  return { snapshot, trace }
}

/**
 * PHASE 2 - authoritative. Runs on the cryptographically verified payer after mppx
 * has verified the credential, which in charge mode is after settlement. May only
 * return ALLOW or BLOCK, and a BLOCK is recorded as a charged_not_delivered incident.
 * Does not re-count the rate limit.
 */
export function evaluateAuthoritative(input: EvaluateInput, snapshot: PolicySnapshot | null): PolicyTrace {
  const trace = evaluate(snapshot, buildContext(input), 'authoritative', { countRateLimit: false })
  // A REVIEW cannot legitimately appear here: REVIEW is decided in preflight where
  // nothing has been charged. Treat it as a block rather than serving for free.
  if (trace.decision === 'review') {
    trace.decision = 'block'
    trace.reason = trace.reason ?? 'held for review'
  }
  return trace
}