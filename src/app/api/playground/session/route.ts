import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/session'
import { openChannelSession } from '@/lib/agent/session-runner'
import { channelService, errorBody } from './_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Open a channel-mode session on behalf of the operator's own service.
 *
 * The browser cannot hold a signing key, so - exactly like the charge-mode playground - the
 * server runs the real MPP channel client with the demo payer: it reserves the session,
 * deploys and funds the channel through the factory, and confirms it. The organization is
 * the only one that can open sessions against its own service.
 */
interface Body {
  slug?: string
  fundedBase?: string
  refundWaitingPeriodSeconds?: number
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

  if (body.fundedBase !== undefined && !/^\d+$/.test(body.fundedBase)) {
    return NextResponse.json({ detail: 'fundedBase must be an integer string in base units' }, { status: 400 })
  }

  try {
    const result = await openChannelSession({
      slug,
      fundedBase: body.fundedBase,
      refundWaitingPeriodSeconds: body.refundWaitingPeriodSeconds,
    })
    return NextResponse.json({
      ok: true,
      service,
      ...result,
    })
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: 502 })
  }
}
