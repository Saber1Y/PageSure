import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/session'
import { settleChannelSession } from '@/lib/agent/session-runner'
import { channelService, errorBody } from '../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Settle and close an active channel session.
 *
 * The organization's signer service (a separate process holding the treasury key) signs and
 * submits the on-chain close, then reports it so PageSure can verify against chain. The
 * response includes the close hash and the session PageSure recorded, so an operator can
 * confirm with the explorer that the recorded payout is real.
 */
interface Body {
  slug?: string
  sessionId?: string
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser()
  if (!user) return NextResponse.json({ detail: 'unauthenticated' }, { status: 401 })

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ detail: 'expected a JSON body' }, { status: 400 })
  }

  const slug = body.slug?.trim() ?? ''
  const service = channelService(user.organizationId, slug)
  if (!service) {
    return NextResponse.json(
      { detail: `no live channel-mode service is registered at /v1/${slug}` },
      { status: 404 },
    )
  }

  const sessionId = body.sessionId?.trim() ?? ''
  if (!sessionId.startsWith('ses_')) {
    return NextResponse.json({ detail: 'sessionId must look like ses_…' }, { status: 400 })
  }

  try {
    const result = await settleChannelSession({ slug, sessionId })
    return NextResponse.json({ ok: true, service, ...result })
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: 502 })
  }
}