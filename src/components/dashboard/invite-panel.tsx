'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { inviteMemberAction } from '@/app/(app)/settings/actions'

/**
 * Invite someone into the organization.
 *
 * The role select offers only the two roles an inviter can actually grant. `owner` is absent
 * deliberately: handing over an organization is a transfer, not an invitation, and offering it
 * here would mean a single mis-sent email quietly produced a second owner with full control of
 * the treasury.
 */
export function InvitePanel({ isOwner }: { isOwner: boolean }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'operator' | 'analyst'>('operator')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const router = useRouter()

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      setBusy(true)
      setError(null)
      setSent(null)

      const result = await inviteMemberAction({ email, role })
      setBusy(false)

      if (!result.ok) {
        setError(
          result.failure === 'forbidden'
            ? 'Only an owner can invite people.'
            : result.failure === 'already_member'
              ? 'That person is already a member of this organization.'
              : result.failure === 'delivery_failed'
                ? `The invitation was not sent. ${result.detail ?? ''}`.trim()
                : result.failure === 'throttled'
                  ? 'Too many invitations from this network. Try again in about 15 minutes.'
                  : 'That does not look like a valid email address.',
        )
        return
      }
      setSent(`Invitation sent to ${email}.`)
      setEmail('')
      router.refresh()
    },
    [email, role, router],
  )

  if (!isOwner) return null

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          <span className="text-[12px] text-ink-3">Email address</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@company.com"
            aria-label="Email address to invite"
            className="rounded-control border border-line-strong bg-surface px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-3">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value === 'analyst' ? 'analyst' : 'operator')}
            aria-label="Role to grant"
            className="rounded-control border border-line-strong bg-surface px-2.5 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
          >
            <option value="operator">Operator</option>
            <option value="analyst">Analyst</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || email.trim().length === 0}
          className="rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Invite'}
        </button>
      </div>

      <p className="text-[12px] leading-relaxed text-ink-4">
        An operator can manage services, policies and reviews. An analyst can read everything
        and change nothing. Both can be changed later.
      </p>

      {sent ? (
        <p role="status" className="text-[12px] text-ok">
          {sent}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}
    </form>
  )
}