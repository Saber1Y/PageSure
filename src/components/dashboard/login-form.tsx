'use client'

import { useCallback, useState, useSyncExternalStore } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import { useRouter } from 'next/navigation'
import { requestChallengeAction, verifyChallengeAction } from '@/app/login/actions'
import { detectWallet, walletDetectionMessage } from '@/lib/wallet/detect'

/**
 * Console sign-in.
 *
 * Two paths, no password field anywhere:
 *
 *   Wallet   request a challenge -> the browser wallet extension signs it -> the server
 *            verifies against the configured settlement wallet.
 *   Passkey  WebAuthn. Registered from an already-signed-in session, so this button only
 *            does something once a passkey exists.
 *
 * The wallet path needs an extension (Freighter, Albedo) and is the only way to create
 * the very first session. The passkey path is the everyday path afterwards.
 *
 * Failure messages are deliberately uniform. Telling an attacker whether a wallet was
 * wrong, a challenge was stale, or a rate limit had tripped is free information.
 */

type Stage = 'idle' | 'requesting' | 'signing' | 'verifying' | 'error'

export function LoginPanel({ wallet }: { wallet: string }) {
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const router = useRouter()

  /**
   * A browser with no authenticator cannot complete the ceremony, so do not offer a
   * button that can only fail.
   *
   * useSyncExternalStore rather than useEffect + setState: PublicKeyCredential does not
   * exist during SSR, so the value is genuinely external to React, and reading it this
   * way avoids the setState-in-effect render cascade. The server snapshot is always
   * false, so the first paint matches the server and the real value arrives on hydration.
   */
  const passkeyReady = useSyncExternalStore(
    () => () => {},
    () => typeof window.PublicKeyCredential !== 'undefined' && !!navigator.credentials,
    () => false,
  )

  const signWithWallet = useCallback(async () => {
    setError(null)
    setNotice(null)
    setStage('requesting')
    try {
      const challenge = await requestChallengeAction()

      // Poll for the extension rather than reading window.freighter once. Content scripts
      // inject asynchronously, so a single read races the injector and reports an
      // installed wallet as missing. This also tells "not installed" apart from "installed
      // but locked", which need opposite instructions.
      const detection = await detectWallet()

      if (detection.kind !== 'ready') {
        setStage('error')
        setError(walletDetectionMessage(detection))
        return
      }

      // Advisory only: the challenge is network-agnostic, but a wallet sitting on the
      // wrong network is worth surfacing before the user reasons about a failure.
      if (detection.network && !/testnet/i.test(detection.network)) {
        setNotice(
          `${detection.provider.name} is on the ${detection.network} network. This environment is Testnet, so switch the wallet before sending payments.`,
        )
      }

      setStage('signing')
      let signature: string
      try {
        signature = await detection.provider.signMessage(challenge.challenge)
      } catch (err) {
        // A locked wallet and a user-cancelled prompt both reject here. They are the two
        // likely reasons a correctly-installed wallet fails at exactly this step.
        const detail = err instanceof Error ? err.message : String(err)
        setStage('error')
        setError(
          /lock|unlock|password|not\s*logged|connect/i.test(detail)
            ? `${detection.provider.name} is locked. Unlock the extension and try again.`
            : /reject|cancel|denied/i.test(detail)
              ? 'Request rejected in your wallet.'
              : `${detection.provider.name} could not sign the challenge. ${detail || 'Please try again.'}`,
        )
        return
      }

      setStage('verifying')
      const result = await verifyChallengeAction({
        challengeId: challenge.challengeId,
        signature,
      })

      if (!result.ok) {
        setStage('error')
        setError(result.error ?? 'Verification failed.')
        return
      }
      // push + refresh rather than a hard navigation: the cookie was just set by the
      // server action, and refresh drops the now-stale unauthenticated RSC payload from
      // the client router cache so the shell re-reads the session.
      router.push('/overview')
      router.refresh()
    } catch (err) {
      setStage('error')
      setError(err instanceof Error ? err.message : 'Could not complete sign-in.')
    }
  }, [router])

  const signWithPasskey = useCallback(async () => {
    setError(null)
    setStage('requesting')
    try {
      const opts = await fetch('/api/auth/passkey/authenticate/begin', { method: 'POST' })
      if (opts.status === 401) {
        setStage('error')
        setError('No passkey is registered for this browser yet. Sign in with the wallet once first.')
        return
      }
      const options = await opts.json()

      setStage('signing')
      const assertion = await startAuthentication({ optionsJSON: options })

      setStage('verifying')
      const res = await fetch('/api/auth/passkey/authenticate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: options.challengeId, response: assertion }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}))
        setStage('error')
        setError(detail.error ?? 'Passkey verification failed.')
        return
      }
      router.push('/overview')
      router.refresh()
    } catch (err) {
      setStage('error')
      setError(err instanceof Error ? err.message : 'Passkey sign-in failed.')
    }
  }, [router])

  const busy = stage === 'requesting' || stage === 'signing' || stage === 'verifying'

  return (
    <div className="flex flex-col gap-5">
      <button
        type="button"
        onClick={signWithWallet}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-control bg-accent px-4 py-3 text-[14px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
      >
        {stage === 'signing' || stage === 'verifying' ? 'Verifying signature' : 'Sign in with wallet'}
      </button>

      {passkeyReady ? (
        <>
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            <span className="text-[12px] text-ink-4">or</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          <button
            type="button"
            onClick={signWithPasskey}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-control border border-line-strong bg-surface px-4 py-3 text-[14px] font-medium text-ink transition-colors hover:border-accent active:translate-y-px disabled:opacity-50"
          >
            Use a passkey
          </button>
        </>
      ) : null}

      {notice ? (
        <p role="status" className="rounded-control border border-review/30 bg-review-soft px-3 py-2 text-[13px] leading-relaxed text-review">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-control border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5 border-t border-line pt-4">
        <p className="text-[12px] leading-relaxed text-ink-3">
          Wallet sign-in proves control of the settlement wallet. There is no password, and
          nothing to seed.
        </p>
        <p className="mono truncate text-[12px] text-ink-4" title={wallet}>
          {wallet}
        </p>
      </div>
    </div>
  )
}