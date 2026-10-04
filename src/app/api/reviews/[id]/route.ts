import { currentUser } from '@/lib/auth/session'
import { resolveReview } from '@/lib/policy/review'
import { recordActivity } from '@/lib/metering/record'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  action?: 'approve' | 'reject'
  note?: string
  grantTtlMs?: number
}

/**
 * Resolve a held review. Auth is required: a grant widens what a wallet can reach, so
 * it is never granted anonymously.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await currentUser()
  if (!user) {
    return Response.json({ detail: 'unauthenticated' }, { status: 401 })
  }

  const { id } = await ctx.params

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return Response.json({ detail: 'expected a JSON body' }, { status: 400 })
  }

  const action = body.action === 'approve' ? 'approve' : 'reject'
  const note = (body.note ?? '').slice(0, 500)

  // organizationId comes from the session, never from the body. resolveReview refuses any
  // review outside it, so a valid session for one organization cannot approve another
  // organization's held request by id.
  const result = resolveReview({
    organizationId: user.organizationId,
    reviewId: id,
    resolvedBy: user.id,
    action,
    note,
    grantTtlMs: body.grantTtlMs,
  })

  if (!result.ok) {
    return Response.json({ detail: result.reason }, { status: 409 })
  }

  recordActivity({
    organizationId: user.organizationId,
    type: 'review_resolved',
    ok: result.status === 'approved',
    message:
      result.status === 'approved'
        ? `Review ${id.slice(0, 12)} approved, grant created`
        : `Review ${id.slice(0, 12)} rejected`,
  })

  return Response.json({ ok: true, status: result.status, grantId: result.grantId })
}