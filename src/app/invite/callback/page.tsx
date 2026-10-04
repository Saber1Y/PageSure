import { Suspense } from 'react'
import { InviteCallback } from '@/components/dashboard/invite-callback'

export const dynamic = 'force-dynamic'

/**
 * Landing point for an organization invitation.
 *
 * Outside the `(app)` group on purpose. That shell requires a tenant, and the person holding an
 * invitation is by definition not yet in one. Inside the shell they would be redirected to
 * /login before the invitation could ever be read.
 *
 * Dynamic for the same reason as the sign-in callback: the token is in the query string, so a
 * cached copy of this page would hand the same credential to the next visitor.
 */
export default function InviteCallbackPage() {
  return (
    <Suspense fallback={<p className="p-8 text-[14px] text-ink-3">Checking the invitation…</p>}>
      <InviteCallback />
    </Suspense>
  )
}