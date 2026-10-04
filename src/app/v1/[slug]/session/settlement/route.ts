import { resolveServiceBySlug } from '@/lib/services/registry'
import { network } from '@/lib/mpp/registry'
import {
  authenticateSignerToken,
  settlementIntent,
  SettlementIntentUnauthorizedError,
  SettlementIntentUnavailableError,
} from '@/lib/mpp/settlement-intent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /v1/:slug/session/settlement ->  authoritative cumulative for the organization's signer
 *
 * PageSure does not submit channel withdrawals. The contract requires `to.require_auth()` against
 * the organization's treasury account, and PageSure stores neither that secret nor the commitment
 * key, so the organization's signer service signs the withdrawal and submits it itself.
 *
 * That makes this endpoint the only way the signer learns what to sign. Two properties matter:
 *
 *   - the cumulative is PageSure's own record, never a value the caller supplies
 *   - the caller must present that organization's signer token
 *
 * The response is an intent, not a signature. It binds nothing until the signer signs it, and
 * PageSure re-verifies the binding and the signature before any withdrawal is accepted.
 */

interface SettlementBody {
  sessionId?: string
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const slug = (await ctx.params).slug
  const service = resolveServiceBySlug(slug)
  if (!service) return problem(404, 'service_not_found', `No service is registered at /v1/${slug}`)

  let body: SettlementBody
  try {
    body = (await request.json()) as SettlementBody
  } catch {
    return problem(400, 'invalid_body', 'expected a JSON body')
  }

  const sessionId = body.sessionId?.trim() ?? ''
  if (!sessionId) return problem(400, 'session_id_required', 'sessionId is required')

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
    const intent = settlementIntent({
      organizationId: service.organizationId,
      sessionId,
      network: network(),
    })
    return Response.json(intent)
  } catch (error) {
    if (error instanceof SettlementIntentUnavailableError) {
      return problem(409, 'not_settleable', error.message, { sessionId })
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