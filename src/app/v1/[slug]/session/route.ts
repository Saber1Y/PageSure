import { StrKey } from '@stellar/stellar-sdk'
import { resolveServiceBySlug } from '@/lib/services/registry'
import { evaluatePreflight } from '@/lib/policy/service'
import { network } from '@/lib/mpp/registry'
import { requireSettlementRecipient } from '@/lib/mpp/settlement'
import { channelOpenInstructions, createSessionRow } from '@/lib/sessions/manager'
import { recordActivity } from '@/lib/metering/record'
import { formatAmount } from '@/lib/money'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /v1/:slug/session  ->  open a payment session
 *
 * The payer deploys its own channel instance through the factory and signs the invoke,
 * so funds never sit in an account PageSure controls. This route reserves the session
 * row, runs preflight policy, and returns the exact factory arguments to submit.
 * Confirmation and on-chain verification happen in /session/confirm.
 *
 * Preflight applies here too: a blocked wallet must not be able to open a channel and
 * escrow funds, because a channel with a blocked funder could otherwise be settled
 * later.
 */

interface OpenBody {
  funder?: string
  fundedBase?: string
  refundWaitingPeriodSeconds?: number
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const slug = (await ctx.params).slug
  const service = resolveServiceBySlug(slug)
  if (!service) return problem(404, 'service_not_found', `No service is registered at /v1/${slug}`)
  if (service.mode !== 'channel') {
    return problem(400, 'not_session_service', `${service.name} is a charge-mode service`)
  }

  let body: OpenBody
  try {
    body = (await request.json()) as OpenBody
  } catch {
    return problem(400, 'invalid_body', 'expected a JSON body')
  }

  const funder = body.funder?.trim() ?? ''
  if (!funder || !StrKey.isValidEd25519PublicKey(funder)) {
    return problem(400, 'invalid_funder', 'funder must be a valid Stellar account')
  }

  const fundedBase = body.fundedBase?.trim() || '0'
  if (!/^\d+$/.test(fundedBase) || fundedBase === '0') {
    return problem(400, 'invalid_amount', 'fundedBase must be a positive integer string in base units')
  }

  const { trace } = evaluatePreflight({
    organizationId: service.organizationId,
    serviceId: service.id,
    serviceName: service.name,
    serviceStatus: service.status,
    servicePolicyId: service.policyId,
    assetContract: service.assetContract,
    amountBase: fundedBase,
    mode: 'channel',
    network: network(),
    payer: funder,
  })

  if (trace.decision === 'block') {
    return policyResponse(403, 'blocked', trace, {
      payment: 'not_started',
      service: 'channel_not_opened',
    })
  }
  if (trace.decision === 'review') {
    return policyResponse(202, 'review_pending', trace, {
      payment: 'not_started',
      service: 'channel_not_opened',
      message:
        'This funder is held for provider review. No channel was opened and no funds were moved.',
    })
  }

  let instructions
  try {
    instructions = channelOpenInstructions({
      organizationId: service.organizationId,
      serviceId: service.id,
      funder,
      assetContract: service.assetContract,
      decimals: service.decimals,
      fundedBase,
      refundWaitingPeriodSeconds: body.refundWaitingPeriodSeconds ?? 100,
    })
  } catch (error) {
    return problem(503, 'channels_unavailable', (error as Error).message)
  }

  const sessionId = createSessionRow({
    organizationId: service.organizationId,
    serviceId: service.id,
    funder,
    assetContract: service.assetContract,
    decimals: service.decimals,
    fundedBase,
    refundWaitingPeriodSeconds: body.refundWaitingPeriodSeconds ?? 100,
  })

  recordActivity({
    organizationId: service.organizationId,
    type: 'session_opened',
    ok: true,
    message: `Session reserved for ${funder} on ${service.name}`,
    serviceId: service.id,
    sessionId,
    amountBase: fundedBase,
    assetCode: service.assetCode,
    decimals: service.decimals,
  })

  return json(200, {
    sessionId,
    service: { id: service.id, slug: service.slug, name: service.name },
    pricePerRequestBase: service.priceBase,
    pricePerRequest: formatAmount(service.priceBase, service.decimals),
    asset: { code: service.assetCode, contract: service.assetContract, decimals: service.decimals },
    recipient: requireSettlementRecipient(service.organizationId),
    open: instructions,
    next:
      `Submit the factory open invoke with your own key, then POST /v1/${slug}/session/confirm ` +
      'with { sessionId, channelContract, txHash }.',
  })
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
  trace: { decision: string; reason?: string; checks: unknown[] },
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