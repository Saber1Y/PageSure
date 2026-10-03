'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { startRegistration } from '@simplewebauthn/browser'

/** Interactive leaf: needs state and a router, so it is a Client Component. */
export function AccountChip({
  name,
  email,
  wallet,
}: {
  name: string
  email: string | null
  wallet: string | null
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)
  const router = useRouter()

  async function signOut() {
    setBusy(true)
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  /**
   * Register an additional passkey.
   *
   * Reached only from an authenticated session, which is the whole security property:
   * this endpoint cannot be used to create the first credential. The label is collected
   * with a plain prompt rather than a bespoke dialog, because the menu has room for one
   * field and not for a form.
   */
  async function addPasskey() {
    setPasskeyError(null)
    if (typeof window.PublicKeyCredential === 'undefined') {
      setPasskeyError('This browser does not support passkeys.')
      return
    }
    setPasskeyBusy(true)
    try {
      const res = await fetch('/api/auth/passkey/register/begin', { method: 'POST' })
      if (!res.ok) {
        setPasskeyError('Could not start passkey registration.')
        return
      }
      const options = await res.json()
      const label = window.prompt('Name this passkey (for example "MacBook Touch ID"):', 'Passkey')
      if (label === null) {
        setPasskeyBusy(false)
        return
      }
      const credential = await startRegistration({ optionsJSON: options })
      const done = await fetch('/api/auth/passkey/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: options.challengeId, response: credential, label }),
      })
      if (!done.ok) {
        const detail = await done.json().catch(() => ({}))
        setPasskeyError(detail.error ?? 'Passkey registration failed.')
        return
      }
      setOpen(false)
      router.refresh()
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : 'Passkey registration failed.')
    } finally {
      setPasskeyBusy(false)
    }
  }

  // Prefer the email when one exists (a future contact field), but never render an empty
  // slot: a wallet identity is shown as a truncated address instead.
  const identity = email ?? (wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : name)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-control border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <span className={email ? '' : 'mono text-[11px]'}>{identity}</span>
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-card border border-line bg-surface p-1 shadow-lg">
          <div className="px-3 py-2">
            <p className="text-[13px] font-medium text-ink">{name}</p>
            {email ? <p className="mono text-[11px] text-ink-4">{email}</p> : null}
            {wallet ? (
              <p className="mono text-[11px] text-ink-4" title={wallet}>
                {wallet.slice(0, 6)}…{wallet.slice(-4)}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={addPasskey}
            disabled={passkeyBusy}
            className="w-full rounded-control px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            {passkeyBusy ? 'Follow your device prompt…' : 'Add a passkey'}
          </button>
          <button
            type="button"
            onClick={signOut}
            disabled={busy}
            className="w-full rounded-control px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
          {passkeyError ? (
            <p role="alert" className="px-3 pb-2 text-[12px] leading-relaxed text-danger">
              {passkeyError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}