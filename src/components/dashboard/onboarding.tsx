'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Onboarding, step 2: name the organization.
 *
 * The wallet step that used to live here is gone, and that is the whole change. An operator
 * can reach a working dashboard with an email address and nothing else, and connect the
 * settlement account whenever they are ready. Requiring a wallet to get past this screen is
 * what made the product unusable to anyone who had not already bought into Stellar.
 *
 * The copy keeps the wallet visible rather than pretending it does not exist, because the
 * next thing they will hit is a service that cannot take money until it is connected. Saying
 * so here is cheaper than letting them discover it at checkout.
 */
export function NameOrganization({ email }: { email: string }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      setBusy(true)
      setError(null)
      const { createOrganizationForCurrentUser } = await import('@/app/login/email-actions')
      const result = await createOrganizationForCurrentUser(name)
      setBusy(false)
      if (!result.ok) {
        setError(
          result.failure === 'org_name_required'
            ? 'Give the organization a name.'
            : 'The organization could not be created. Try again.',
        )
        return
      }
      router.replace('/overview')
      router.refresh()
    },
    [name, router],
  )

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="org-name" className="text-[13px] font-medium text-ink-2">
          Organization name
        </label>
        <input
          id="org-name"
          required
          autoFocus
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Research"
          className="rounded-control border border-line-strong bg-surface px-3 py-2.5 text-[14px] text-ink transition-colors placeholder:text-ink-4 focus:border-accent focus:outline-none"
        />
        <p className="text-[12px] leading-relaxed text-ink-3">
          Shown on your services and on settlement records. You can change it later.
        </p>
      </div>

      <div className="rounded-control border border-line bg-surface-2 px-3 py-3">
        <p className="text-[13px] font-medium text-ink-2">Settlement wallet: optional for now</p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
          Signed in as {email}. Everything except taking money works without a wallet. Connect
          one when you are ready to publish a payable service, and we will ask you to sign once
          to prove it is yours. PageSure never stores the key.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy || name.trim().length === 0}
        className="rounded-control bg-accent px-4 py-3 text-[14px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
      >
        {busy ? 'Creating…' : 'Continue to dashboard'}
      </button>
    </form>
  )
}