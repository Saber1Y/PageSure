import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { paymentSessions, sessionEvents } from '@/lib/db/schema'
import type { ResolvedService } from '@/lib/services/registry'
import { evaluateAuthoritative } from '@/lib/policy/service'
import { loadPolicySnapshot } from '@/lib/policy/engine'
import { buildChannelMppx, network } from '@/lib/mpp/registry'
import { requireSettlementRecipient } from '@/lib/mpp/settlement'
import { runUpstream, UpstreamError } from '@/lib/upstream'
import { newId, recordIncident, recordRequest } from '@/lib/metering/record'
import { formatAmount, toBig } from '@/lib/money'
import type { PolicyTrace } from '@/lib/policy/types'

/**
 * Session (MPP channel) request path.
 *
 * This is where PageSure's security model is cleanest. The funder is fixed when the
 * channel is opened and is read back from chain, so:
 *
 *   - identity is AUTHORITATIVE from the first request, with no advisory phase
 *   - policy runs BEFORE anything is committed to the cumulative
 *   - a BLOCK mid-session costs the payer nothing: the cumulative simply does not
 *     advance, so the eventual on-chain settlement pays only for delivered requests
 *
 * There is no charged_not_delivered state in this path, by construction.
 */

interface ChannelRequestInput {
  request: Request
  service: ResolvedService
  url: URL
  startedAt: number
}

export async function handleChannelRequest(input: ChannelRequestInput): Promise<Response> {
  const { request, service, url, startedAt } = input
  const amountBase = service.priceBase

  // The credential names the channel. Decode it to find which session this is, and whether
  // the caller is asking for service (a voucher) or for settlement (a close).
  const credential = readCredential(request)
  const channelAddress = credential.channel
  if (!channelAddress) {
    return problem(
      400,
      'channel_required',
      'This service runs in session mode. Open a session first and present its voucher credential.',
    )
  }

  const session = db()
    .select()
    .from(paymentSessions)
    .where(eq(paymentSessions.channelContract, channelAddress))
    .get()

  if (!session) {
    return problem(404, 'session_not_found', 'No session exists for the presented channel.')
  }
  if (session.serviceId !== service.id) {
    return problem(
      403,
      'session_service_mismatch',
      'This channel was opened against a different service.',
    )
  }
  if (session.status !== 'active' && session.status !== 'opening') {
    return problem(
      409,
      'session_not_active',
      `Session is ${session.status}. Open a new session to continue.`,
      { sessionId: session.id, status: session.status },
    )
  }

  // ---- Settlement requests are not billable service requests ----------------
  //
  // A `close` credential asks the channel contract to withdraw the cumulative, not to buy
  // the service. It must branch here, ahead of policy evaluation and the upstream call,
  // because running it down the voucher path would price a settlement as a service request
  // and advance the cumulative for a withdrawal rather than for delivered work.
  //
  // PageSure deliberately cannot execute the withdrawal itself. The channel contract requires
  // `to.require_auth()`, where `to` is the organization's treasury account, and the MPP SDK
  // submits the close with a `feePayer.envelopeSigner` holding that account's secret. Under the
  // external-signer model PageSure stores neither the treasury secret nor the commitment key,
  // so it has no authority to broadcast. The organization's signer service signs the withdrawal
  // with the commitment key and submits it with its own treasury account.
  if (credential.action === 'close') {
    addSessionEvent(
      service.organizationId,
      session.id,
      'close_requested',
      `Close credential presented for ${channelAddress}`,
      '0',
      null,
    )
    return problem(
      501,
      'settlement_not_submitted_by_pagesure',
      'This channel settles through the organization signer service, not through PageSure. ' +
        'Fetch the authoritative cumulative from the settlement endpoint, sign it with the ' +
        'organization commitment key, and submit the withdrawal with the organization treasury account.',
      {
        sessionId: session.id,
        channel: channelAddress,
        cumulativeBase: session.cumulativeBase,
        requestCount: session.requestCount,
        settlementEndpoint: `/v1/${service.slug}/session/settlement`,
      },
    )
  }

  // ---- AUTHORITATIVE policy. Identity comes from the channel, not a header. --
  const snapshot = service.policyId ? loadPolicySnapshot(service.organizationId, service.policyId, service.id) : null
  const trace: PolicyTrace = evaluateAuthoritative(
    {
      organizationId: service.organizationId,
      serviceId: service.id,
      serviceName: service.name,
      serviceStatus: service.status,
      servicePolicyId: service.policyId,
      assetContract: service.assetContract,
      amountBase,
      mode: 'channel',
      network: network(),
      payer: session.funder,
    },
    snapshot,
  )

  if (trace.decision !== 'allow') {
    const requestId = recordRequest({
      organizationId: service.organizationId,
      serviceId: service.id,
      policyId: service.policyId,
      sessionId: session.id,
      reviewId: null,
      claimedPayer: session.funder,
      verifiedPayer: session.funder,
      mode: 'channel',
      amountBase,
      status: 'blocked',
      policyDecision: 'block',
      policyTrace: trace,
    })
    addSessionEvent(service.organizationId, session.id, 'blocked', `Blocked: ${trace.reason ?? 'policy decision'}`, amountBase, requestId)
    // Nothing was committed, so the payer owes nothing for this request.
    return policyResponse(403, 'blocked', trace, {
      requestId,
      sessionId: session.id,
      payment: 'not_committed',
      service: 'not_executed',
      message:
        'Blocked before the cumulative advanced. This request is not billed and the session settlement will not include it.',
    })
  }

  // ---- Commit the voucher off-chain -------------------------------------
  const requestId = newId('req')
  let challengeResponse: Response
  try {
    const mppx = buildChannelMppx({
      channel: session.channelContract,
      commitmentPublicKey: session.commitmentPublicKey,
      // The account this channel was actually opened against, not the organization's current
      // treasury. Editing the treasury must not repoint a channel that already has funds
      // escrowed against a different `to`; the contract would reject the withdrawal.
      recipient: session.recipient || requireSettlementRecipient(service.organizationId),
      currency: service.assetContract,
    })
    const result = await mppx.channel(
      { amount: formatAmount(amountBase, service.decimals), description: service.name },
    )(request)

    if (result.status === 402) {
      const challenge = result.challenge
      const headers = new Headers(challenge.headers)
      headers.set('X-Pagesure-Decision', 'allow')
      headers.set('X-Pagesure-Session-Id', session.id)
      headers.set('X-Pagesure-Price-Base', amountBase)
      challengeResponse = new Response(await challenge.text(), { status: 402, headers })
    } else {
      challengeResponse = problem(400, 'unexpected_state', 'channel state could not be determined')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'voucher rejected'
    return problem(402, 'voucher_failed', message, { sessionId: session.id })
  }
  if (challengeResponse.status === 400) return challengeResponse

  // ---- Upstream ---------------------------------------------------------
  const requestBody = await readJsonBody(request)
  const cumulativeAfter = toBig(session.cumulativeBase) + toBig(amountBase)

  try {
    const result = await runUpstream({
      serviceId: service.id,
      serviceName: service.name,
      upstreamKind: service.upstreamKind,
      config: service.upstreamConfig,
      search: url.searchParams,
      body: requestBody,
    })

    const recordedId = recordRequest({
      organizationId: service.organizationId,
      id: requestId,
      serviceId: service.id,
      policyId: service.policyId,
      sessionId: session.id,
      reviewId: null,
      claimedPayer: session.funder,
      verifiedPayer: session.funder,
      mode: 'channel',
      amountBase,
      status: 'paid',
      policyDecision: 'allow',
      policyTrace: trace,
      upstreamProvider: result.provider,
      upstreamStatus: result.status,
      latencyMs: Date.now() - startedAt,
    })

    db()
      .update(paymentSessions)
      .set({
        cumulativeBase: cumulativeAfter.toString(),
        requestCount: sql`${paymentSessions.requestCount} + 1`,
        status: 'active',
        updatedAt: Date.now(),
      })
      .where(eq(paymentSessions.id, session.id))
      .run()

    addSessionEvent(service.organizationId, session.id, 'request', `${service.name} request delivered`, amountBase, recordedId)

    return json(200, result.body, {
      'X-Pagesure-Decision': 'allow',
      'X-Pagesure-Request-Id': recordedId,
      'X-Pagesure-Session-Id': session.id,
      'X-Pagesure-Cumulative-Base': cumulativeAfter.toString(),
      'X-Pagesure-Provider': result.provider,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'upstream failed'
    const status = error instanceof UpstreamError ? error.status : 502
    recordRequest({
      organizationId: service.organizationId,
      id: requestId,
      serviceId: service.id,
      policyId: service.policyId,
      sessionId: session.id,
      reviewId: null,
      claimedPayer: session.funder,
      verifiedPayer: session.funder,
      mode: 'channel',
      amountBase,
      status: 'failed',
      policyDecision: 'allow',
      policyTrace: trace,
      upstreamStatus: status,
      latencyMs: Date.now() - startedAt,
    })
    recordIncident({
      organizationId: service.organizationId,
      kind: 'upstream_failed',
      requestId,
      sessionId: session.id,
      serviceId: service.id,
      payer: session.funder,
      amountBase: '0',
      assetCode: service.assetCode,
      decimals: service.decimals,
      reason: message,
      policyTrace: null,
      paymentTxHash: null,
    })
    // The voucher may already be committed, but no service was delivered, so the
    // session cumulative is left unchanged and the payer is not billed for it.
    return problem(status, 'upstream_failed', message, {
      sessionId: session.id,
      payment: 'not_committed',
      service: 'failed',
    })
  }
}

export function addSessionEvent(
  organizationId: string,
  sessionId: string,
  type:
    | 'created'
    | 'policy_approved'
    | 'channel_funded'
    | 'request'
    | 'blocked'
    | 'close_requested'
    | 'settled'
    | 'failed',
  detail: string,
  amountBase?: string | null,
  requestId?: string | null,
): void {
  db()
    .insert(sessionEvents)
    .values({
      id: newId('sev'),
      organizationId,
      sessionId,
      type,
      detail,
      amountBase: amountBase ?? null,
      requestId: requestId ?? null,
      createdAt: Date.now(),
    })
    .run()
}

/**
 * What the presented credential asks for.
 *
 * The credential payload is `{ action, amount, signature }`, and `action` decides which path
 * runs. This was previously ignored: a `close` credential fell through to the voucher branch,
 * where it was billed as if it were a service request. That is wrong in the direction that
 * matters — a settlement request would be treated as a payable voucher and the cumulative
 * would advance for a withdrawal rather than for delivered work.
 */
type CredentialAction = 'voucher' | 'close'

interface ParsedCredential {
  channel: string | null
  action: CredentialAction
}

/**
 * Read the channel address and requested action from the presented credential.
 *
 * The voucher payload is signed by the commitment key and bound to the channel, but this read
 * is only used to LOCATE the session. The commitment itself is verified by mppx inside
 * `mppx.channel()`, which is the sole authority on whether the cumulative advanced.
 *
 * An absent action is treated as a voucher, since that is what the field has always meant.
 */
function readCredential(request: Request): ParsedCredential {
  const raw = request.headers.get('authorization') ?? request.headers.get('Payment-Authorization')
  if (!raw) return { channel: null, action: 'voucher' }
  const match = /^Payment\s+(.+)$/i.exec(raw.trim())
  if (!match?.[1]) return { channel: null, action: 'voucher' }
  try {
    const base64 = match[1].trim().replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
      challenge?: { request?: string }
      payload?: { channel?: string; action?: string }
    }

    const action: CredentialAction = parsed.payload?.action === 'close' ? 'close' : 'voucher'

    if (typeof parsed.payload?.channel === 'string') return { channel: parsed.payload.channel, action }

    // Fall back to decoding the challenge request blob, which carries the channel.
    const requestBlob = parsed.challenge?.request
    if (typeof requestBlob === 'string') {
      const b64 = requestBlob.replace(/-/g, '+').replace(/_/g, '/')
      const p = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
      const decoded = JSON.parse(Buffer.from(p, 'base64').toString('utf8')) as { channel?: string }
      if (typeof decoded.channel === 'string') return { channel: decoded.channel, action }
    }
    return { channel: null, action }
  } catch {
    return { channel: null, action: 'voucher' }
  }
}

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
