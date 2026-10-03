'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Approving creates a service-scoped, expiring grant. Rejecting writes nothing, so the
 * wallet is held again on retry. Neither path touches the allowlist.
 */
export function ReviewActions({ reviewId }: { reviewId: string }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function submit(action: 'approve' | 'reject') {
    setBusy(action)
    setError(null)
    const response = await fetch(`/api/reviews/${reviewId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, note }),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { detail?: string } | null
      setError(body?.detail ?? `could not ${action} this review`)
      setBusy(null)
      return
    }
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-col gap-2">
        <label htmlFor={`note-${reviewId}`} className="text-[13px] font-medium text-ink">
          Note
        </label>
        <input
          id={`note-${reviewId}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Optional context for the audit trail"
          className="rounded-control border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => submit('approve')}
          disabled={busy !== null}
          className="rounded-control bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
        >
          {busy === 'approve' ? 'Approving…' : 'Approve and grant'}
        </button>
        <button
          type="button"
          onClick={() => submit('reject')}
          disabled={busy !== null}
          className="rounded-control border border-line-strong px-4 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink active:translate-y-px disabled:opacity-50"
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>

      {error ? <p className="text-[12px] text-block">{error}</p> : null}
    </div>
  )
}