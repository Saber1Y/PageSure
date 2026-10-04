'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createPolicyAction, type PolicyActionFailure } from '@/app/(app)/policies/actions'

/**
 * Create a policy.
 *
 * Caps start blank, which means no limit, rather than pre-filled with round numbers. A cap that
 * looks authoritative but was never chosen is worse than an obvious blank: the first thing an
 * operator should notice is that they have not decided this yet.
 */

const INPUT =
  'rounded-control border border-line-strong bg-surface px-3 py-2.5 text-[14px] text-ink transition-colors placeholder:text-ink-4 focus:border-accent focus:outline-none'

function describe(failure: PolicyActionFailure): string {
  switch (failure) {
    case 'unauthenticated':
      return 'Sign in again to create a policy.'
    case 'forbidden':
      return 'Only an owner or operator can create a policy.'
    case 'throttled':
      return 'Too many attempts from this network. Wait a minute and try again.'
    case 'name_required':
      return 'Give the policy a name of 80 characters or fewer.'
    case 'name_taken':
      return 'You already have a policy with that name.'
    case 'description_too_long':
      return 'Keep the description under 300 characters.'
    case 'unknown_action_invalid':
      return 'Choose what happens to a wallet you do not recognise.'
    case 'cap_invalid':
      return 'Caps are plain decimals with no currency symbol.'
    case 'cap_zero':
      return 'A cap of zero would hold every request for review. Leave it blank for no limit.'
    case 'rate_invalid':
      return 'The rate limit is a whole number of requests per minute, or blank for none.'
    default:
      return 'The policy could not be created. Nothing was changed.'
  }
}

export default function NewPolicyForm() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setBusy(true)
      setError(null)
      const form = new FormData(event.currentTarget)
      void createPolicyAction({
        name: String(form.get('name') ?? ''),
        description: String(form.get('description') ?? ''),
        unknownAction: String(form.get('unknownAction') ?? 'review'),
        maxAmountPerRequest: String(form.get('maxAmountPerRequest') ?? ''),
        dailyCapPerWallet: String(form.get('dailyCapPerWallet') ?? ''),
        ungrantedSpendCap: String(form.get('ungrantedSpendCap') ?? ''),
        rateLimitPerMin: String(form.get('rateLimitPerMin') ?? ''),
      }).then((result) => {
        setBusy(false)
        if (!result.ok) {
          setError(describe(result.failure))
          return
        }
        router.replace(`/policies/${result.policyId}`)
        router.refresh()
      })
    },
    [router],
  )

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="name" className="text-[13px] font-medium text-ink-2">
            Name
          </label>
          <input id="name" name="name" required maxLength={80} placeholder="Restricted" className={INPUT} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="unknownAction" className="text-[13px] font-medium text-ink-2">
            A wallet you do not recognise
          </label>
          <select id="unknownAction" name="unknownAction" defaultValue="review" className={INPUT}>
            <option value="review">Hold it for review</option>
            <option value="allow">Let it pay</option>
            <option value="block">Refuse it</option>
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="description" className="text-[13px] font-medium text-ink-2">
          Description <span className="font-normal text-ink-4">optional</span>
        </label>
        <input
          id="description"
          name="description"
          maxLength={300}
          placeholder="Who this is for, and what they are allowed to spend."
          className={INPUT}
        />
      </div>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-[13px] font-medium text-ink-2">Spending caps</legend>
        <p className="text-[12px] leading-relaxed text-ink-3">
          Plain decimals in USDC, blank for no limit. A request over a cap is held for review, not
          refused, and nothing is charged while it waits.
        </p>
        <div className="grid gap-5 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="maxAmountPerRequest" className="text-[12px] text-ink-3">
              Per request
            </label>
            <input id="maxAmountPerRequest" name="maxAmountPerRequest" inputMode="decimal" placeholder="no limit" className={INPUT} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="dailyCapPerWallet" className="text-[12px] text-ink-3">
              Per wallet, rolling 24h
            </label>
            <input id="dailyCapPerWallet" name="dailyCapPerWallet" inputMode="decimal" placeholder="no limit" className={INPUT} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ungrantedSpendCap" className="text-[12px] text-ink-3">
              Ungranted spend
            </label>
            <input id="ungrantedSpendCap" name="ungrantedSpendCap" inputMode="decimal" placeholder="no limit" className={INPUT} />
          </div>
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="rateLimitPerMin" className="text-[13px] font-medium text-ink-2">
          Requests per minute
        </label>
        <input id="rateLimitPerMin" name="rateLimitPerMin" inputMode="numeric" placeholder="no limit" className={INPUT} />
        <p className="text-[12px] leading-relaxed text-ink-3">
          Refused outright, before any challenge exists, so no payment is taken. Blank means no
          limit.
        </p>
      </div>

      <p className="text-[12px] leading-relaxed text-ink-3">
        USDC on Testnet is registered for this policy automatically. Without it the policy would
        block every service bound to it at the asset check.
      </p>

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
        {busy ? 'Creating…' : 'Create policy'}
      </button>
    </form>
  )
}
