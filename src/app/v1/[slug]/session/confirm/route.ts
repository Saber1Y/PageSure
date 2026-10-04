import { resolveServiceBySlug } from '@/lib/services/registry'
import { requireSettlementRecipient } from '@/lib/mpp/settlement'
import { confirmSession } from '@/lib/sessions/manager'
import { getSession } from '@/lib/sessions/lookup'
import { recordActivity, recordIncident } from '@/lib/metering/record'
import { formatAmount } from '@/lib/money'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /v1/:slug/session/confirm  ->  verify the deployed channel against chain
 *
 * The payer deployed its own channel instance; nothing about it is trusted. Every field
 * is read from chain via getChannelState and compared to what PageSure expected before
 * the session is allowed to go active. Verification staying on this side of the boundary
 * is the point: a client that simply claimed "here is my channel" could settle to a third
 * party or in a worthless token.
 */

interface ConfirmBody {
  sessionId?: string
  channelContract?: string
  txHash?: string
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const slug = (await ctx.params).slug
  const service = resolveServiceBySlug(slug)
  if (!service) return problem(404, 'service_not_found', `No service is registered at /v1/${slug}`)

  let body: ConfirmBody
  try {
    body = (await request.json()) as ConfirmBody
  } catch {
    return problem(400, 'invalid_body', 'expected a JSON body')
  }

  const sessionId = body.sessionId?.trim() ?? ''
  const channelContract = body.channelContract?.trim() ?? ''
  if (!sessionId || !channelContract) {
    return problem(400, 'invalid_body', 'sessionId and channelContract are required')
  }

  // Scoped on organization AND service: a session id from another tenant or another service
  // must not be confirmable here. The organization check is what makes the service check
  // below meaningful rather than cosmetic.
  const session = getSession(service.organizationId, sessionId)
  if (!session) return problem(404, 'session_not_found', 'No such session')
  if (session.serviceId !== service.id) {
    return problem(403, 'session_service_mismatch', 'This session belongs to a different service')
  }
  if (session.status !== 'opening' && session.status !== 'active') {
    return problem(409, 'session_not_confirmable', `Session is ${session.status}`)
  }

  const result = await confirmSession({
    organizationId: service.organizationId,
    sessionId,
    channelContract,
    expected: {
      funder: session.funder,
      recipient: session.recipient || requireSettlementRecipient(service.organizationId),
      assetContract: service.assetContract,
      commitmentPublicKeyG: session.commitmentPublicKey,
    },
  })

  if (!result.ok) {
    recordIncident({
      organizationId: service.organizationId,
      kind: 'upstream_failed',
      requestId: null,
      sessionId,
      serviceId: service.id,
      payer: session.funder,
      amountBase: '0',
      assetCode: service.assetCode,
      decimals: service.decimals,
      reason: `channel verification failed: ${result.reason}`,
      policyTrace: null,
      paymentTxHash: body.txHash ?? null,
    })
    return problem(400, 'channel_verification_failed', result.reason, { sessionId })
  }

  recordActivity({
    organizationId: service.organizationId,
    type: 'session_opened',
    ok: true,
    message: `Channel ${channelContract.slice(0, 12)}... verified and active`,
    serviceId: service.id,
    sessionId,
  })

  return json(200, {
    sessionId,
    channelContract,
    status: 'active',
    funder: session.funder,
    recipient: session.recipient,
    fundedBase: result.balanceBase,
    fundedAmount: formatAmount(result.balanceBase, service.decimals),
    next: `Send requests to /v1/${slug} presenting your voucher credential.`,
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