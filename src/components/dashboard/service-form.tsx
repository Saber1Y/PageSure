'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createServiceAction } from '@/app/(app)/services/actions'
import { UPSTREAMS, type UpstreamKind } from '@/lib/upstream/kinds'
import { slugify } from '@/lib/services/slug'

/**
 * Create a service.
 *
 * The slug is prefilled from the name and stays editable, because a derived slug is a suggestion
 * and the person publishing knows whether `search` or `web-search` is what an agent will expect.
 * It is not rewritten on blur: silently changing the URL out from under someone who already
 * shared it is how a payment challenge ends up naming an endpoint that no longer exists.
 *
 * Failure copy names the correction rather than the rejection. "That address is reserved by
 * PageSure" teaches something; "invalid slug" does not.
 */

export interface PolicyOption {
  id: string
  name: string
  unknownAction: 'allow' | 'review' | 'block'
}

const INPUT =
  'rounded-control border border-line-strong bg-surface px-3 py-2.5 text-[14px] text-ink transition-colors placeholder:text-ink-4 focus:border-accent focus:outline-none'

function describe(failure: string, detail?: string): string {
  switch (failure) {
    case 'unauthenticated':
      return 'Sign in again to create a service.'
    case 'forbidden':
      return 'Only an owner or operator can create a service. Analysts can read everything and change nothing.'
    case 'throttled':
      return 'Too many attempts from this network. Wait a minute and try again.'
    case 'name_required':
      return 'Give the service a name of 80 characters or fewer.'
    case 'description_too_long':
      return 'Keep the description under 300 characters.'
    case 'slug_invalid':
      return detail ?? 'That address cannot be used.'
    case 'slug_taken':
      return 'That address is already taken. Slugs are global, so another organization may have it.'
    case 'price_invalid':
      return 'Enter a price like 0.01. Amounts are plain decimals, with no currency symbol.'
    case 'price_zero':
      return 'A price of zero would let anyone call this endpoint for free.'
    case 'upstream_invalid':
      return 'Choose what this service actually calls.'
    case 'mode_invalid':
      return 'Choose a payment mode.'
    case 'policy_invalid':
      return detail ?? 'That policy cannot be used for this service.'
    default:
      return 'The service could not be created. Nothing was changed.'
  }
}

export default function ServiceForm({ policies }: { policies: PolicyOption[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [upstreamKind, setUpstreamKind] = useState<UpstreamKind>('search')

  // UPSTREAMS is non-empty and `upstreamKind` only ever holds one of its values, so the
  // fallback is unreachable in practice; it exists to keep the type total.
  const selected = UPSTREAMS.find((u) => u.kind === upstreamKind) ?? UPSTREAMS[0]!

  // Only fill the slug while the user has not taken it over. After that it is theirs.
  const effectiveSlug = slugTouched ? slug : slugify(name)

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setBusy(true)
      setError(null)
      const form = new FormData(event.currentTarget)
      const result = await createServiceAction({
        name: String(form.get('name') ?? ''),
        slug: String(form.get('slug') ?? ''),
        description: String(form.get('description') ?? ''),
        price: String(form.get('price') ?? ''),
        upstreamKind: String(form.get('upstreamKind') ?? ''),
        mode: String(form.get('mode') ?? 'charge'),
        policyId: String(form.get('policyId') ?? ''),
        status: String(form.get('status') ?? 'live'),
      })
      setBusy(false)
      if (!result.ok) {
        setError(describe(result.failure, result.detail))
        return
      }
      router.replace(`/services/${result.serviceId}`)
      router.refresh()
    },
    [router],
  )

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="name" className="text-[13px] font-medium text-ink-2">
          Name
        </label>
        <input
          id="name"
          name="name"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="PageSure Search"
          className={INPUT}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="slug" className="text-[13px] font-medium text-ink-2">
          Address
        </label>
        <input
          id="slug"
          name="slug"
          required
          maxLength={40}
          value={effectiveSlug}
          onChange={(e) => {
            setSlugTouched(true)
            setSlug(e.target.value)
          }}
          placeholder="search"
          aria-describedby="slug-help"
          className={`${INPUT} font-mono`}
        />
        <p id="slug-help" className="text-[12px] leading-relaxed text-ink-3">
          Your agents call this at <span className="font-mono text-ink-2">/v1/{effectiveSlug || 'your-address'}</span>.
          Lowercase letters, numbers and single dashes. Address names are global across every
          organization, so pick one your callers will type.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="description" className="text-[13px] font-medium text-ink-2">
          Description <span className="font-normal text-ink-4">optional</span>
        </label>
        <input
          id="description"
          name="description"
          maxLength={300}
          placeholder="What an agent gets for this call."
          className={INPUT}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="price" className="text-[13px] font-medium text-ink-2">
            Price per call (USDC)
          </label>
          <input
            id="price"
            name="price"
            required
            inputMode="decimal"
            placeholder="0.01"
            aria-describedby="price-help"
            className={INPUT}
          />
          <p id="price-help" className="text-[12px] text-ink-3">
            A plain decimal. 0.01 is 100000 base units.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="upstreamKind" className="text-[13px] font-medium text-ink-2">
            What it calls
          </label>
          <select
            id="upstreamKind"
            name="upstreamKind"
            value={upstreamKind}
            onChange={(e) => setUpstreamKind(e.target.value as UpstreamKind)}
            aria-describedby="upstream-help"
            className={INPUT}
          >
            {UPSTREAMS.map((u) => (
              <option key={u.kind} value={u.kind}>
                {u.label}
              </option>
            ))}
          </select>
          <p id="upstream-help" className="text-[12px] leading-relaxed text-ink-3">
            Callers send <span className="font-mono text-ink-2">{selected.clientHint}</span>. Needs{' '}
            {selected.requires}.
          </p>
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="mode" className="text-[13px] font-medium text-ink-2">
            Payment mode
          </label>
          <select id="mode" name="mode" defaultValue="charge" className={INPUT}>
            <option value="charge">Charge - one transaction per call</option>
            <option value="channel">Session - many calls, one settlement</option>
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="status" className="text-[13px] font-medium text-ink-2">
            Publish as
          </label>
          <select id="status" name="status" defaultValue="live" className={INPUT}>
            <option value="live">Live - accepts paid calls now</option>
            <option value="draft">Draft - answers 403 until published</option>
            <option value="paused">Paused - answers 403 for now</option>
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="policyId" className="text-[13px] font-medium text-ink-2">
          Policy
        </label>
        <select id="policyId" name="policyId" defaultValue="" className={INPUT}>
          <option value="">
            {policies.length === 0
              ? 'Create a default policy for me'
              : `Use ${policies[0]?.name ?? 'the first policy'}`}
          </option>
          {policies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} - unknown wallets are {p.unknownAction === 'allow' ? 'allowed' : p.unknownAction === 'review' ? 'reviewed' : 'blocked'}
            </option>
          ))}
        </select>
        <p className="text-[12px] leading-relaxed text-ink-3">
          A service with no policy is blocked outright, so one is always attached. If you have no
          policies yet a conservative one is created for you, and this organization keeps it.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="self-start rounded-control bg-accent px-4 py-3 text-[14px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
      >
        {busy ? 'Creating…' : 'Create service'}
      </button>
    </form>
  )
}
