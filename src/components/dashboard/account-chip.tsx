'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/** Interactive leaf: needs state and a router, so it is a Client Component. */
export function AccountChip({ name, email }: { name: string; email: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function signOut() {
    setBusy(true)
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-control border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <span className="mono text-[11px] text-ink-4">{email}</span>
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-2 w-56 rounded-card border border-line bg-surface p-1 shadow-lg">
          <div className="px-3 py-2">
            <p className="text-[13px] font-medium text-ink">{name}</p>
            <p className="mono text-[11px] text-ink-4">{email}</p>
          </div>
          <button
            type="button"
            onClick={signOut}
            disabled={busy}
            className="w-full rounded-control px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  )
}