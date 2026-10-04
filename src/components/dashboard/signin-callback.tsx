'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { safeReturnTo } from '@/lib/auth/return-to'
import { completeSignin } from '@/app/login/email-actions'

/**
 * Where a magic link lands.
 *
 * This page exists as its own route, not as a query on /login, for one reason: the token is in
 * the URL and must be redeemed exactly once. A page that could be re-rendered, prefetched, or
 * restored from bfcache while still holding a valid token would be a page that can sign
 * someone in twice, and the second redemption would fail confusingly for a reason that has
 * nothing to do with what the person did.
 *
 * So the flow is guarded rather than merely attempted:
 *
 *   - the exchange runs inside a ref, so React strict mode's double effect, a fast refresh, or
 *     a re-render cannot fire a second redemption
 *   - the token is swapped out of the address bar with replace() as soon as it is read, so the
 *     credential does not sit in history, in a bookmark, or in a referrer header
 *   - any failure shows one message, because "expired", "unknown" and "already used" are not
 *     distinctions a visitor can act on
 */
export function SigninCallback() {
  const params = useSearchParams()
  const router = useRouter()
  const exchanged = useRef(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * Captured once, on first render, and never re-read.
   *
   * The obvious implementation is `const token = params.get('token')`, and it is wrong: the
   * effect below rewrites the address bar to drop the credential, `useSearchParams` re-renders
   * from that new URL, and the token reads back as null while the redemption is still in
   * flight. The page then decides the link was malformed and replaces itself with "that link
   * is missing its token" - which is exactly what happened on a replayed link, and it is a
   * race that only sometimes lands the right way.
   *
   * Reading it once into state makes the token a value this page owns rather than something
   * it keeps re-deriving from a URL it is busy sanitising.
   */
  const [token] = useState(() => params.get('token'))
  // Captured the same way and for the same reason. Rewriting the address bar to drop the token
  // re-renders from the new URL, so re-deriving returnTo later would lose it.
  const [returnTo] = useState(() => params.get('returnTo'))

  useEffect(() => {
    if (!token || exchanged.current) return
    exchanged.current = true

    // Take the credential out of the address bar before anything slow happens. `replace`
    // rather than `push` so it does not become a history entry either.
    window.history.replaceState(null, '', window.location.pathname)

    void (async () => {
      const result = await completeSignin(token)
      if (!result.ok) {
        setError(
          result.failure === 'too_many_attempts'
            ? 'Too many attempts from here. Wait a minute and request a new link.'
            : 'That sign-in link is invalid, has expired, or has already been used.',
        )
        return
      }
      // A returnTo only overrides the ordinary landing when the caller actually got a
      // membership. If onboarding is still required, onboarding wins: dropping somebody on a
      // dashboard they have no organization for would be a worse outcome than ignoring a
      // convenience parameter.
      const fallback = result.next === 'onboarding' ? '/onboarding' : '/overview'
      router.replace(safeReturnTo(returnTo, fallback))
      router.refresh()
    })()
  }, [token, returnTo, router])

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        {!token ? (
          <>
            <p role="alert" className="text-[14px] leading-relaxed text-danger">
              That link is missing its token. Request a new one.
            </p>
            <a
              href="/login"
              className="mt-4 inline-block text-[13px] text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              Back to sign in
            </a>
          </>
        ) : error ? (
          <>
            <p role="alert" className="text-[14px] leading-relaxed text-danger">
              {error}
            </p>
            <a
              href="/login"
              className="mt-4 inline-block text-[13px] text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              Back to sign in
            </a>
          </>
        ) : (
          <p role="status" className="text-[14px] leading-relaxed text-ink-3">
            Signing you in…
          </p>
        )}
      </div>
    </div>
  )
}