import { NextResponse } from 'next/server'
import { StrKey } from '@stellar/stellar-sdk'
import { currentUser } from '@/lib/auth/session'
import { sendChannelRequests } from '@/lib/agent/session-runner'
import { channelService, errorBody } from '../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Send billable requests through an active channel.
 *
 * Each request is an off-chain signed commitment. The gateway re-reads the channel from
 * chain, checks policy, and answers immediately - no transaction touches the network until
 * the session is settled.
 */
interface Body {
  slug?: string
  channelContract?: string
  count?: number
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

  const channelContract = body.channelContract?.trim() ?? ''
  if (!StrKey.isValidContract(channelContract)) {
    return NextResponse.json({ detail: 'channelContract is not a valid contract address' }, { status: 400 })
  }

  const count = Math.min(Math.max(Number(body.count ?? 1) || 1, 1), 20)

  try {
    const result = await sendChannelRequests({ slug, channelContract, count })
    const allOk = result.receipts.every((r) => r.ok)
    return NextResponse.json({ ok: allOk, service, count, ...result })
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: 502 })
  }
}