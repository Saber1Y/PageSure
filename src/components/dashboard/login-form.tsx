'use client'

import { useCallback, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { requestChallengeAction, verifyChallengeAction } from '@/app/login/actions'
import { requestSignin } from '@/app/login/email-actions'
import { safeReturnTo } from '@/lib/auth/return-to'
import type { WalletProbe } from '@/lib/wallet/detect'
import { detectWallet, promptWalletAccess, signChallenge, walletDetectionMessage } from '@/lib/wallet/detect'

type Stage = 'idle' | 'requesting' | 'signing' | 'verifying' | 'error' | 'sent'

/**
 * Sign-in.
 *
 * Email leads, wallet is the alternative, and the order is the message: the first thing on
 * screen is an ordinary email field, because most people arriving here are being asked to
 * evaluate a payments product and should not be told to install a browser extension before
 * they can see what they are evaluating.
 *
 * The wallet path is not decoration. It mints the same session, skips the inbox entirely, and
 * is the right choice for someone who already lives in Stellar and would rather not wait on
 * an email round trip.
 */
export function LoginPanel({
  configuredWallet,
  returnTo,
}: {
  configuredWallet?: string | null
  /** Same-origin path to return to after a successful sign-in. Untrusted; sanitized on use. */
  returnTo?: string
}) {
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [probe, setProbe] = useState<WalletProbe | null>(null)
  const [email, setEmail] = useState('')
  const router = useRouter()

  const passkeyReady = useSyncExternalStore(
    () => () => {},
    () => typeof window.PublicKeyCredential !== 'undefined' && !!navigator.credentials,
    () => false,
  )

  const busy = stage === 'requesting' || stage === 'signing' || stage === 'verifying'

  const sendLink = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      setError(null)
      setNotice(null)
      setStage('requesting')
      const result = await requestSignin(email, returnTo)
      if (result.ok) {
        setStage('sent')
        return
      }
      setStage('error')
      if (result.failure === 'delivery_failed') {
        // This one is worth being explicit about. "Check your email" when nothing was sent is
        // the failure mode that makes an onboarding flow impossible to debug.
        setError(
          `The sign-in email could not be sent. ${result.detail ?? ''}`.trim(),
        )
        return
      }
      if (result.failure === 'too_many_attempts') {
        setError('Too many sign-in emails from here. Wait a minute and try again.')
        return
      }
      setError('That does not look like a valid email address.')
    },
    [email, returnTo],
  )

  const signWithWallet = useCallback(async () => {
    setError(null)
    setNotice(null)
    setProbe(null)
    setStage('requesting')
    try {
      const challenge = await requestChallengeAction()
      const detection = await detectWallet()

      if (detection.kind !== 'ready') {
        setStage('error')
        setError(walletDetectionMessage(detection))
        setProbe(null)
        return
      }

      if (detection.network && !/testnet/i.test(detection.network)) {
        setNotice(
          `Freighter is on the ${detection.network} network. This environment is Testnet, so switch the wallet before sending payments.`,
        )
      }

      setStage('requesting')
      const access = await promptWalletAccess()
      if (!access.ok) {
        setStage('error')
        setError(
          /reject|cancel|denied/i.test(access.error)
            ? 'Access request rejected in your wallet.'
            : `Freighter did not grant access. ${access.error}`.trim(),
        )
        return
      }

      setStage('signing')
      const signed = await signChallenge(challenge.challenge)
      if (!signed.ok) {
        setStage('error')
        setError(
          /lock|unlock|password|not\s*logged|not\s*allow|permission/i.test(signed.error)
            ? `Freighter is locked or has not been allowed here. ${signed.error}`
            : /reject|cancel|denied/i.test(signed.error)
              ? 'Request rejected in your wallet.'
              : signed.error || 'Freighter could not sign the challenge.',
        )
        return
      }

      setStage('verifying')
      const result = await verifyChallengeAction({
        challengeId: challenge.challengeId,
        signature: signed.signature,
        // Reported by the extension, and treated as an untrusted claim: the server checks the
        // signature against it and rejects a mismatch, so naming the wrong account here can
        // only fail the attempt, never redirect it somewhere else.
        wallet: detection.publicKey ?? '',
      })
      if (!result.ok) {
        setStage('error')
        setError(result.error ?? 'The signature could not be verified.')
        return
      }
      router.push(safeReturnTo(returnTo, '/overview'))
      router.refresh()
    } catch (err) {
      setStage('error')
      setError(err instanceof Error ? err.message : 'The wallet could not be used.')
    }
  }, [router, returnTo])

  return (
    <div className="flex flex-col gap-5">
      {stage === 'sent' ? (
        <div className="flex flex-col gap-4">
          <div role="status" className="rounded-control border border-line bg-surface-2 px-3 py-3">
            <p className="text-[14px] leading-relaxed text-ink">
              Check {email} for your sign-in link.
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
              The link works once and expires in 15 minutes. If it does not arrive, check spam
              before asking for another one.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setStage('idle')
              setError(null)
            }}
            className="text-[13px] text-ink-3 underline underline-offset-2 transition-colors hover:text-ink"
          >
            Use a different email
          </button>
        </div>
      ) : (
        <>
          <form onSubmit={sendLink} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-2">Work email</span>
              <input
                type="email"
                required
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="rounded-control border border-line-strong bg-surface px-3 py-2.5 text-[14px] text-ink transition-colors placeholder:text-ink-4 focus:border-accent focus:outline-none"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-control bg-accent px-4 py-3 text-[14px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
            >
              {stage === 'requesting' && !busy ? 'Sending…' : busy && stage === 'requesting' ? 'Sending…' : 'Continue with email'}
            </button>
          </form>

          {passkeyReady ? (
            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-line" />
              <span className="text-[12px] text-ink-4">or</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          ) : (
            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-line" />
              <span className="text-[12px] text-ink-4">or</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          )}

          <button
            type="button"
            onClick={signWithWallet}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-control border border-line-strong bg-surface px-4 py-3 text-[14px] font-medium text-ink transition-colors hover:border-accent active:translate-y-px disabled:opacity-50"
          >
            {stage === 'requesting'
              ? 'Approve in wallet…'
              : stage === 'signing'
                ? 'Waiting for signature…'
                : stage === 'verifying'
                  ? 'Verifying signature…'
                  : 'Continue with wallet'}
          </button>

          {configuredWallet ? (
            <p className="text-[12px] leading-relaxed text-ink-4">
              Wallet sign-in proves control of the settlement wallet{' '}
              <span className="mono">{configuredWallet.slice(0, 6)}…{configuredWallet.slice(-4)}</span>.
              No password is involved either way.
            </p>
          ) : null}
        </>
      )}

      {notice ? (
        <p role="status" className="rounded-control border border-review/30 bg-review-soft px-3 py-2 text-[13px] leading-relaxed text-review">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-control border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      {probe ? (
        <details className="rounded-control border border-line bg-surface-2 px-3 py-2">
          <summary className="cursor-pointer text-[12px] font-medium text-ink-3">
            What this page can see
          </summary>
          <dl className="mt-2 flex flex-col gap-1 text-[12px] text-ink-4">
            <div className="flex flex-col">
              <dt className="text-ink-3">origin</dt>
              <dd className="mono">{probe.origin}</dd>
            </div>
            {probe.globals.length ? (
              <div className="flex flex-col">
                <dt className="text-ink-3">wallet globals</dt>
                <dd className="mono break-all">{probe.globals.join(', ')}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}

    </div>
  )
}
