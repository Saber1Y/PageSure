'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { detectWallet, promptWalletAccess, readSigningAddress, signChallenge, walletDetectionMessage } from '@/lib/wallet/detect'
import {
  connectTreasuryAction,
  registerSignerAction,
  requestTreasuryChallengeAction,
} from '@/app/(app)/settings/actions'

/**
 * Settlement wallet and external signer.
 *
 * Both panels are opt-in, and both are clearly marked as such. The page a new operator lands
 * on says "not connected" next to two things they have not heard of yet, which is alarming
 * out of proportion to how optional they are, so the framing leads with what still works
 * without them.
 *
 * The wallet panel runs a real ceremony and refuses to claim success without one. There is no
 * "paste your address and we will trust it" path here, and that is the point: an address typed
 * into a form is a claim, and an address that signed a challenge for this specific
 * organization is a fact.
 */
export function TreasuryPanel({
  recipient,
  verified,
}: {
  recipient: string | null
  verified: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const connect = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const detection = await detectWallet()
      if (detection.kind !== 'ready') {
        setError(walletDetectionMessage(detection))
        return
      }
      const access = await promptWalletAccess()
      if (!access.ok) {
        setError(
          /reject|cancel|denied/i.test(access.error)
            ? 'The wallet declined the request.'
            : `The wallet did not grant access. ${access.error}`.trim(),
        )
        return
      }

      // Read the account AFTER the access prompt. This challenge is bound to the address it is
      // issued against, so a stale one is not a failed signature but a challenge nobody can
      // satisfy. The access prompt is the most likely moment for the active account to change.
      const claimed = (await readSigningAddress()) ?? detection.publicKey ?? ''

      const issued = await requestTreasuryChallengeAction(claimed)
      if (!issued.ok || !issued.challenge || !issued.challengeId) {
        setError(
          issued.failure === 'forbidden'
            ? 'Only an owner can change where this organization is paid.'
            : issued.failure === 'invalid_wallet'
              ? 'The wallet returned an address this server does not recognise.'
              : issued.failure === 'throttled'
                ? 'Too many attempts. Wait a minute and try again.'
                : 'A challenge could not be issued.',
        )
        return
      }

      const signed = await signChallenge(issued.challenge)
      if (!signed.ok) {
        setError(signed.error || 'The wallet could not sign the challenge.')
        return
      }

      const result = await connectTreasuryAction({
        challengeId: issued.challengeId,
        signature: signed.signature,
        wallet: claimed,
      })
      if (!result.ok) {
        if (result.failure === 'signature_failed') {
          // Almost always an account switch rather than a broken wallet: name both addresses.
          const active = await readSigningAddress()
          setError(
            active && active !== claimed
              ? `Freighter signed with ${active} but the page was expecting ${claimed}. Lock the extension, select one account, unlock it, and try again. Nothing has been changed.`
              : 'That signature did not verify. Nothing has been changed.',
          )
          return
        }
        setError(
          result.failure === 'forbidden'
            ? 'Only an owner can change where this organization is paid.'
            : 'The wallet could not be connected. Nothing has been changed.',
        )
        return
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The wallet could not be used.')
    } finally {
      setBusy(false)
    }
  }, [router])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium text-ink">Settlement account</p>
        <span
          className={`text-[12px] ${verified ? 'text-ok' : recipient ? 'text-review' : 'text-ink-4'}`}
        >
          {verified ? 'Connected' : recipient ? 'Awaiting proof' : 'Not connected'}
        </span>
      </div>

      {recipient ? (
        <p className="mono text-[13px] break-all text-ink-2">
          {recipient}
          {!verified ? (
            <span className="ml-2 font-sans text-[12px] text-review">
              stated but never proven. It cannot receive anything until you sign.
            </span>
          ) : null}
        </p>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-3">
          Where settled payments are delivered. Until this is connected, services can be
          published and everything works except actually taking money.
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={connect}
          disabled={busy}
          className="rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Waiting for your wallet…' : recipient ? 'Connect a different wallet' : 'Connect a wallet'}
        </button>
      </div>

      <p className="text-[12px] leading-relaxed text-ink-4">
        You will be asked to sign once to prove this account is yours. PageSure stores the
        address and never the key.
      </p>

      {error ? (
        <p role="alert" className="text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * External channel signer registration.
 *
 * This is the piece that is genuinely optional and genuinely advanced: it is only needed to
 * open channels, where many requests settle in one on-chain transaction. The wording says so
 * before asking for anything, because "signer service" means nothing to someone who has not
 * come looking for one, and a blank panel with two fields invites the wrong answer.
 */
export function SignerPanel({
  signerUrl,
  signerTokenEnv,
  registrationAllowed,
  registered,
}: {
  signerUrl: string | null
  signerTokenEnv: string | null
  registrationAllowed: boolean
  registered: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const router = useRouter()

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setBusy(true)
      setError(null)
      const form = new FormData(event.currentTarget)
      const result = await registerSignerAction({
        signerUrl: String(form.get('signerUrl') ?? ''),
        signerTokenEnv: String(form.get('signerTokenEnv') ?? ''),
      })
      setBusy(false)
      if (!result.ok) {
        setError(
          result.failure === 'forbidden'
            ? 'Only an owner can register a signer.'
            : result.detail ?? 'The signer could not be registered.',
        )
        return
      }
      setDone(true)
      router.refresh()
    },
    [router],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium text-ink">External channel signer</p>
        <span className={`text-[12px] ${registered ? 'text-ok' : 'text-ink-4'}`}>
          {registered ? 'Registered' : 'Optional'}
        </span>
      </div>

      <p className="text-[13px] leading-relaxed text-ink-3">
        Only needed to open payment channels, where many requests settle in one on-chain
        transaction. Your signer service holds the key and signs commitments on request:
        PageSure never sees it, and stores only the address to call and the name of the
        environment variable holding the token.
      </p>

      {registered && signerUrl ? (
        <p className="mono text-[12px] break-all text-ink-2">{signerUrl}</p>
      ) : null}

      {!registrationAllowed ? (
        <p className="text-[12px] leading-relaxed text-ink-4">
          This deployment does not allow self-service signer registration. An operator has to
          allow the host and set the token prefix first.
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <input
            name="signerUrl"
            defaultValue={signerUrl ?? ''}
            placeholder="https://signer.your-company.com"
            aria-label="Signer service URL"
            className="rounded-control border border-line-strong bg-surface px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
          />
          <input
            name="signerTokenEnv"
            defaultValue={signerTokenEnv ?? ''}
            placeholder="ENV_VAR_HOLDING_SIGNER_TOKEN"
            aria-label="Environment variable holding the signer token"
            className="rounded-control border border-line-strong bg-surface px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="self-start rounded-control border border-line-strong bg-surface px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-accent disabled:opacity-50"
          >
            {busy ? 'Saving…' : registered ? 'Replace signer' : 'Register signer'}
          </button>
        </form>
      )}

      {done && !error ? (
        <p role="status" className="text-[12px] text-ok">
          Signer registered.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}