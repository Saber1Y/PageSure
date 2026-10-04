import { Suspense } from 'react'
import { SigninCallback } from '@/components/dashboard/signin-callback'

export const dynamic = 'force-dynamic'

/**
 * Landing point for a sign-in email link.
 *
 * The redirect carries the token in the query string, so this route must not be statically
 * rendered or cached: a cached copy of it would hand the same token to the next visitor who
 * hit the path. The Suspense boundary exists because `useSearchParams` opts the subtree into
 * client rendering, and the page reads the token on the very first render.
 */
export default function LoginCallbackPage() {
  return (
    <Suspense fallback={<p className="p-8 text-[14px] text-ink-3">Signing you in…</p>}>
      <SigninCallback />
    </Suspense>
  )
}