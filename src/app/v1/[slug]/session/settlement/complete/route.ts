import { resolveServiceBySlug } from '@/lib/services/registry'
import { network } from '@/lib/mpp/registry'
import {
  authenticateSignerToken,
  SettlementIntentUnauthorizedError,
} from '@/lib/mpp/settlement-intent'
import { completeSettlement, SettlementCompleteError } from '@/lib/mpp/settlement-complete'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /v1/:slug/session/settlement/complete ->  accept a settlement the signer already submitted
 *
 * The organization signer submits `close()` itself and reports the transaction hash here.
 * PageSure re-derives everything from chain before the session moves to `closed` (see
 * settlement-complete.ts); the report itself is only a pointer at what to verify. Guarded by
 * the same organization signer token as the intent endpoint, because it advances the same
 * session's money state.
 *
 * Re-reporting the same transaction for a closed session is an idempotent replay; a different
 * transaction for a closed session is refused.
 */

interface CompleteBody {
  sessionId?: string
  txHash?: string
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const slug = (await ctx.params).slug
  const service = resolveServiceBySlug(slug)
  if (!service) return problem(404, 'service_not_found', `No service is registered at /v1/${slug}`)

  let body: CompleteBody
  try {
    body = (await request.json()) as CompleteBody
  } catch {
    return problem(400, 'invalid_body', 'expected a JSON body')
  }

  const sessionId = body.sessionId?.trim() ?? ''
  const txHash = body.txHash?.trim().toLowerCase() ?? ''
  if (!sessionId || !txHash) {
    return problem(400, 'invalid_body', 'sessionId and txHash are required')
  }
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    return problem(400, 'invalid_tx_hash', 'txHash must be a 64-character hex transaction hash')
  }

  const presented = readBearer(request)

  try {
    authenticateSignerToken(service.organizationId, presented)
  } catch (error) {
    if (error instanceof SettlementIntentUnauthorizedError) {
      return problem(401, 'signer_unauthorized', error.message)
    }
    throw error
  }

  try {
    const result = await completeSettlement({
      organizationId: service.organizationId,
      sessionId,
      txHash,
      network: network(),
    })
    return Response.json(result)
  } catch (error) {
    if (error instanceof SettlementCompleteError) {
      if (error.failure === 'session_not_found') return problem(404, 'session_not_found', error.message)
      if (error.failure === 'not_settleable') return problem(409, 'not_settleable', error.message)
      return problem(422, 'settlement_unverified', error.message, { sessionId, txHash })
    }
    throw error
  }
}

function readBearer(request: Request): string | null {
  const raw = request.headers.get('authorization') ?? request.headers.get('Payment-Authorization')
  if (!raw) return null
  const match = /^(?:Bearer|Payment)\s+(.+)$/i.exec(raw.trim())
  return match?.[1]?.trim() ?? null
}

/**
 * Same problem shape as the sibling session routes, so an agent parsing this endpoint parses it
 * the same way it parses every other /v1 failure.
 */
function problem(status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Response {
  return Response.json(
    { type: 'about:blank', title: code, status, detail, ...extra },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}
