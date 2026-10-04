'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { acceptInvitationAction } from '@/app/(app)/settings/actions'

/**
 * Where an invitation link lands.
 *
 * Requires a session, because acceptance is recorded against a real account: the caller must
 * already have proved the address the invitation was sent to. Someone arriving without a
 * session is told to sign in first rather than being silently given a membership, because the
 * alternative is a link that appears to work and produces an organization the person is not in.
 *
 * Like the sign-in callback, the token is captured once on first render and dropped from the
 * address bar immediately, so a reload cannot spend it twice.
 */
export function InviteCallback() {
  const params = useSearchParams()
  const router = useRouter()
  const [token] = useState(() => params.get('token'))
  const attempted = useRef(false)
  const [state, setState] = useState<'working' | 'joined' | 'failed' | 'signin'>('working')
  const [organizationName, setOrganizationName] = useState('')

  useEffect(() => {
    if (!token || attempted.current) return
    attempted.current = true

    void (async () => {
      const result = await acceptInvitationAction(token)
      if (result.ok) {
        // Only a definitive outcome is allowed to drop the credential from the address bar. If
        // the caller is not signed in yet, the token has not been spent, so it stays in the URL
        // and survives the sign-in round trip. Stripping it early would turn "sign in, then come
        // back" into a dead end with no way to recover the link.
        window.history.replaceState(null, '', window.location.pathname)
        setOrganizationName(result.organizationName)
        setState('joined')
        return
      }
      if (result.failure === 'unauthenticated') {
        setState('signin')
        return
      }
      window.history.replaceState(null, '', window.location.pathname)
      setState('failed')
    })()
  }, [token])

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        {state === 'working' ? (
          <p role="status" className="text-[14px] leading-relaxed text-ink-3">
            Joining the organization…
          </p>
        ) : null}

        {state === 'joined' ? (
          <>
            <p className="text-[15px] font-medium text-ink">You are in.</p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
              You joined {organizationName} as a member.
            </p>
            <button
              type="button"
              onClick={() => {
                router.push('/overview')
                router.refresh()
              }}
              className="mt-5 rounded-control bg-ink px-4 py-2.5 text-[14px] font-medium text-canvas transition-opacity hover:opacity-90"
            >
              Go to the dashboard
            </button>
          </>
        ) : null}

        {state === 'signin' ? (
          <>
            <p className="text-[14px] leading-relaxed text-ink">
              Sign in with the invited address first.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
              An invitation can only be accepted by the person it was sent to. We will bring you
              straight back here afterwards.
            </p>
            <a
              href="/login?returnTo=%2Finvite%2Fcallback%3Ftoken%3D${encodeURIComponent(token ?? '')}"
              className="mt-5 inline-block rounded-control bg-ink px-4 py-2.5 text-[14px] font-medium text-canvas transition-opacity hover:opacity-90"
            >
              Sign in
            </a>
          </>
        ) : null}

        {state === 'failed' ? (
          <>
            <p role="alert" className="text-[14px] leading-relaxed text-danger">
              That invitation is invalid, has expired, or has already been used.
            </p>
            <a
              href="/login"
              className="mt-4 inline-block text-[13px] text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              Back to sign in
            </a>
          </>
        ) : null}
      </div>
    </div>
  )
}