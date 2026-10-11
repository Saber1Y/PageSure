import { requireSettlementRecipient } from '@/lib/mpp/settlement'
import { resolveClaimedPayer } from '@/lib/identity/payer'
import { resolveServiceBySlug, type ResolvedService } from '@/lib/services/registry'
import { evaluatePreflight, evaluateAuthoritative } from '@/lib/policy/service'
import { createReview, findPresentedReview } from '@/lib/policy/review'
import {
  buildChargeMppx,
  markVerified,
  network,
  payerFromDid,
  settledPayment,
  type VerifiedPayment,
} from '@/lib/mpp/registry'
import { runUpstream, UpstreamError } from '@/lib/upstream'
import {
  newId,
  recordActivity,
  recordIncident,
  recordRequest,
  recordSettlement,
  updateRequest,
} from '@/lib/metering/record'
import { formatAmount } from '@/lib/money'
import type { PolicyTrace } from '@/lib/policy/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * THE GATEWAY. This pipeline is the product.
 *
 *   resolve service
 *     -> preflight policy        (ENFORCEMENT POINT: nothing has been charged yet)
 *     -> mppx charge             (402 issued, or payment verified AND settled)
 *     -> authoritative policy    (verified payer; may only tighten)
 *     -> upstream
 *     -> metering + settlement
 *     -> response
 *
 * Two facts shape this file:
 *
 *  1. In charge mode mppx settles INSIDE verify(). A post-verification block therefore
 *     CANNOT be "no payment, no service". It is recorded as a charged_not_delivered
 *     incident and surfaced. Session mode has no such gap: the funder is on-chain, so
 *     policy runs authoritatively before anything is committed.
 *
 *  2. The claimed payer is untrusted. It selects a policy and can be denied early. It
 *     can never authorise an upstream call.
 *
 * One logical request is ONE metering row: the row id is passed to MPP as
 * `externalId`, so the 402 attempt and the paid retry update the same row.
 */

export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  return handle(request, (await ctx.params).slug)
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  return handle(request, (await ctx.params).slug)
}

async function handle(rawRequest: Request, slug: string): Promise<Response> {
  const startedAt = Date.now()
  const service = resolveServiceBySlug(slug)
  if (!service) return problem(404, 'service_not_found', `No service is registered at /v1/${slug}`)

  const url = new URL(rawRequest.url)
  const amountBase = service.priceBase
  const assetNetwork = network()

  // Session mode is handled separately: identity is on-chain, so there is no
  // advisory phase and nothing is ever charged before a decision.
  if (service.mode === 'channel') {
    const { handleChannelRequest } = await import('@/lib/sessions/gateway')
    return handleChannelRequest({ request: rawRequest, service, url, startedAt })
  }

  const claimed = resolveClaimedPayer(rawRequest)
  const presentedReviewId = url.searchParams.get('review')

  if (!claimed.address) {
    return problem(
      400,
      'payer_required',
      'Declare the paying account with the X-Pagesure-Payer header or ?payer=, or present an MPP credential.',
    )
  }
  const payer = claimed.address

  // ---- PHASE 1: preflight policy. The enforcement point. ----------------
  const preflightArgs = {
    organizationId: service.organizationId,
    serviceId: service.id,
    serviceName: service.name,
    serviceStatus: service.status,
    servicePolicyId: service.policyId,
    assetContract: service.assetContract,
    amountBase,
    mode: 'charge' as const,
    network: assetNetwork,
    payer,
  }
  let pre = evaluatePreflight(preflightArgs)

  // A held request becomes ALLOW only if a human approved it, which created a
  // service-scoped, expiring grant. Re-run so the trace records the grant hit.
  if (presentedReviewId) {
    const review = findPresentedReview(service.organizationId, presentedReviewId, service.id, payer)
    if (review?.status === 'approved') {
      pre = evaluatePreflight(preflightArgs)
    }
  }
  const preflightTrace = pre.trace

  const baseRow = {
    organizationId: service.organizationId,
    serviceId: service.id,
    policyId: service.policyId,
    sessionId: null,
    reviewId: presentedReviewId,
    claimedPayer: payer,
    verifiedPayer: null,
    mode: 'charge' as const,
    amountBase,
  }

  if (preflightTrace.decision === 'block') {
    const requestId = recordRequest({
      ...baseRow,
      status: 'blocked',
      policyDecision: 'block',
      policyTrace: preflightTrace,
    })
    recordActivity({
      organizationId: service.organizationId,
      type: 'payment_blocked',
      ok: false,
      message: `Blocked ${payer} on ${service.name}`,
      serviceId: service.id,
      requestId,
      amountBase,
      assetCode: service.assetCode,
      decimals: service.decimals,
    })
    return policyResponse(403, 'blocked', preflightTrace, {
      requestId,
      payment: 'not_started',
      service: 'not_executed',
    })
  }

  if (preflightTrace.decision === 'review') {
    const reviewId = createReview({
      organizationId: service.organizationId,
      policyId: service.policyId ?? '',
      serviceId: service.id,
      wallet: payer,
      reason: preflightTrace.reason ?? 'held for review',
      amountBase,
      policyTrace: preflightTrace,
    })
    const requestId = recordRequest({
      ...baseRow,
      reviewId,
      status: 'review_pending',
      policyDecision: 'review',
      policyTrace: preflightTrace,
    })
    recordActivity({
      organizationId: service.organizationId,
      type: 'review_pending',
      ok: true,
      message: `Held ${payer} on ${service.name} for review`,
      serviceId: service.id,
      requestId,
    })
    return policyResponse(202, 'review_pending', preflightTrace, {
      reviewId,
      requestId,
      payment: 'not_started',
      service: 'not_executed',
      message:
        'Held for provider review. No payment was taken and the service was not executed. Retry with ?review=<reviewId> once approved.',
    })
  }

  // ---- PHASE 2: payment. mppx verifies AND settles. ---------------------
  // The row is created up front and its id becomes MPP's externalId, so the 402
  // attempt and the eventual paid retry are the SAME row.
  const requestId = newId('req')
  recordRequest({
    ...baseRow,
    id: requestId,
    status: 'challenged',
    policyDecision: 'allow',
    policyTrace: preflightTrace,
  } as Parameters<typeof recordRequest>[0])

  // Set when the caller must be challenged, or when the request is malformed. Left null on the
  // success path, where `payment` is what matters.
  let challengeResponse: Response | null = null
  let payment: VerifiedPayment | null = null
  try {
    const mppx = buildChargeMppx({
      recipient: requireSettlementRecipient(service.organizationId),
      currency: service.assetContract,
    })
    const result = await mppx.charge(
      { amount: formatAmount(amountBase, service.decimals), description: service.name, externalId: requestId },
    )(rawRequest)

    if (result.status === 402) {
      const challenge = result.challenge
      const headers = new Headers(challenge.headers)
      headers.set('X-Pagesure-Decision', 'allow')
      headers.set('X-Pagesure-Price-Base', amountBase)
      headers.set('X-Pagesure-Asset', service.assetContract)
      headers.set('X-Pagesure-Request-Id', requestId)
      challengeResponse = new Response(await challenge.text(), { status: 402, headers })
    } else {
      // Not a challenge, so either the payment settled or the caller is unpayable.
      //
      // This WAITS rather than reading `captured` directly, because `payment.success` is emitted
      // asynchronously after charge() returns. A synchronous read always missed, and a miss here is
      // expensive: mppx settles inside verify(), so the money had already left the payer while the
      // gateway answered 400, served nothing, and left the request row reading `challenged` - not
      // even the charged_not_delivered incident path could fire, because nothing recorded that a
      // payment had happened at all.
      // Scoped to this mppx instance, not to requestId: the settlement reports the externalId
      // from the challenge minted on the PREVIOUS http request, so a lookup by the id minted here
      // would always miss even though the money had moved.
      payment = await settledPayment(mppx)
      if (!payment) {
        // No credential supplied, no challenge, and no receipt: the caller claims to have paid in an
        // earlier request but there is no evidence of it. Refuse rather than serve for free.
        challengeResponse = problem(400, 'unexpected_state', 'payment state could not be determined')
      }
    }
  } catch (error) {
    updateRequest(requestId, { status: 'failed' })
    const message = error instanceof Error ? error.message : 'payment failed'
    recordActivity({
      organizationId: service.organizationId,
      type: 'payment_blocked',
      ok: false,
      message: `Payment failed on ${service.name}`,
      serviceId: service.id,
      requestId,
    })
    return problem(402, 'payment_failed', message, { requestId })
  }

  // Only reached on the malformed path; a settled payment skips it entirely.
  if (challengeResponse?.status === 400) return challengeResponse

  if (!payment) {
    return (
      challengeResponse ??
      problem(400, 'unexpected_state', 'payment state could not be determined')
    )
  }

  // ---- PHASE 3: authoritative policy on the verified payer. -------------
  const verifiedPayer = payerFromDid(payment.source)
  if (!verifiedPayer) {
    updateRequest(requestId, { status: 'failed', paymentTxHash: payment.reference })
    return problem(
      500,
      'payer_unreadable',
      'Payment verified but the payer identity could not be read from the receipt.',
      { requestId },
    )
  }

  const auth = evaluateAuthoritative({ ...preflightArgs, payer: verifiedPayer }, pre.snapshot)

  if (verifiedPayer !== payer) {
    // Declared one wallet, paid with another. Refuse and do not call upstream.
    updateRequest(requestId, {
      status: 'rejected_mismatch',
      policyDecision: 'block',
      policyTrace: auth,
      verifiedPayer,
      paymentTxHash: payment.reference,
      receiptReference: payment.reference,
    })
    const incidentId = recordIncident({
      organizationId: service.organizationId,
      kind: 'charged_not_delivered',
      requestId,
      sessionId: null,
      serviceId: service.id,
      payer: verifiedPayer,
      amountBase,
      assetCode: service.assetCode,
      decimals: service.decimals,
      reason: `declared payer ${payer} did not match verified payer ${verifiedPayer}`,
      policyTrace: auth,
      paymentTxHash: payment.reference,
    })
    return policyResponse(403, 'rejected_mismatch', auth, {
      requestId,
      incidentId,
      payment: 'settled',
      service: 'not_executed',
      message: `Declared payer ${payer} does not match the verified payer ${verifiedPayer}.`,
    })
  }

  if (auth.decision === 'block') {
    updateRequest(requestId, {
      status: 'charged_not_delivered',
      policyDecision: 'block',
      policyTrace: auth,
      verifiedPayer,
      paymentTxHash: payment.reference,
      receiptReference: payment.reference,
    })
    recordIncident({
      organizationId: service.organizationId,
      kind: 'charged_not_delivered',
      requestId,
      sessionId: null,
      serviceId: service.id,
      payer: verifiedPayer,
      amountBase,
      assetCode: service.assetCode,
      decimals: service.decimals,
      reason: auth.reason ?? 'blocked after payment verification',
      policyTrace: auth,
      paymentTxHash: payment.reference,
    })
    recordActivity({
      organizationId: service.organizationId,
      type: 'incident',
      ok: false,
      message: `Charged but not delivered on ${service.name}`,
      serviceId: service.id,
      requestId,
      amountBase,
      assetCode: service.assetCode,
      decimals: service.decimals,
    })
    return policyResponse(403, 'charged_not_delivered', auth, {
      requestId,
      payment: 'settled',
      service: 'not_executed',
      message:
        'The payment settled before this policy decision applied. No service was delivered. Recorded as an incident.',
    })
  }

  // Payment is verified, settled, and authorised. Persist the verified identity.
  markVerified(requestId, payment, auth)

  // ---- PHASE 4: upstream -----------------------------------------------
  const requestBody = await readJsonBody(rawRequest)
  try {
    const result = await runUpstream({
      serviceId: service.id,
      serviceName: service.name,
      upstreamKind: service.upstreamKind,
      config: service.upstreamConfig,
      search: url.searchParams,
      body: requestBody,
      signal: rawRequest.signal,
    })

    const settlementId = recordSettlement({
      organizationId: service.organizationId,
      kind: 'charge',
      requestId,
      sessionId: null,
      requestCount: 1,
      amountBase,
      assetContract: service.assetContract,
      assetCode: service.assetCode,
      decimals: service.decimals,
      payer: verifiedPayer,
      recipient: requireSettlementRecipient(service.organizationId),
      network: assetNetwork,
      txHash: payment.reference,
      status: 'confirmed',
    })

    updateRequest(requestId, {
      settlementId,
      upstreamProvider: result.provider,
      upstreamStatus: result.status,
      latencyMs: Date.now() - startedAt,
    })

    recordActivity({
      organizationId: service.organizationId,
      type: 'request_paid',
      ok: true,
      message: `${service.name} paid and delivered via ${result.provider}`,
      serviceId: service.id,
      requestId,
      amountBase,
      assetCode: service.assetCode,
      decimals: service.decimals,
    })

    return json(200, result.body, {
      'X-Pagesure-Decision': 'allow',
      'X-Pagesure-Request-Id': requestId,
      'X-Pagesure-Provider': result.provider,
      'X-Pagesure-Settlement-Id': settlementId,
      'X-Pagesure-Payment-Tx': payment.reference,
      'Payment-Receipt': payment.reference,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'upstream failed'
    const status = error instanceof UpstreamError ? error.status : 502
    updateRequest(requestId, { upstreamStatus: status, latencyMs: Date.now() - startedAt })
    recordIncident({
      organizationId: service.organizationId,
      kind: 'upstream_failed',
      requestId,
      sessionId: null,
      serviceId: service.id,
      payer: verifiedPayer,
      amountBase,
      assetCode: service.assetCode,
      decimals: service.decimals,
      reason: message,
      policyTrace: null,
      paymentTxHash: payment.reference,
    })
    return problem(status, 'upstream_failed', message, {
      requestId,
      payment: 'settled',
      service: 'failed',
    })
  }
}

// ---------------------------------------------------------------------------

async function readJsonBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return null
  try {
    const text = await request.text()
    if (!text) return null
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })
}

function problem(status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { type: 'about:blank', title: code, status, detail, ...extra })
}

function policyResponse(
  status: number,
  code: string,
  trace: PolicyTrace,
  extra: Record<string, unknown>,
): Response {
  return json(status, {
    type: 'about:blank',
    title: code,
    status,
    decision: trace.decision,
    reason: trace.reason,
    policyTrace: trace,
    ...extra,
  })
}

export type { ResolvedService }
