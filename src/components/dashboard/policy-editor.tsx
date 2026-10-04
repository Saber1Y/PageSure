'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  addPolicyListAction,
  removePolicyListAction,
  setPolicyServicesAction,
  updatePolicyAction,
  type PolicyActionFailure,
} from '@/app/(app)/policies/actions'
import type { UnknownAction } from '@/lib/policy/manage'

/**
 * Edit one policy: its caps, how it treats unknown wallets, who is allowlisted or denylisted, and
 * which services it covers.
 *
 * One component rather than four because these are not four features. A cap below a service price
 * combined with an unknown-wallet action of `block` is a single access-control decision, and
 * splitting it across screens would hide that.
 *
 * The list is the important half. `ALLOW` is otherwise unreachable without waiting out a 24-hour
 * grant, because unknown wallets are reviewed by default and a grant is scoped to one service.
 */

export interface PolicyRecord {
  id: string
  name: string
  description: string
  unknownAction: UnknownAction
  maxAmountPerRequest: string
  dailyCapPerWallet: string
  ungrantedSpendCap: string
  rateLimitPerMin: string
  active: boolean
}

export interface AllowEntry {
  wallet: string
  label: string
}

export interface DenyEntry {
  wallet: string
  label: string
  reason: string
}

export interface ServiceOption {
  id: string
  name: string
  slug: string
  boundHere: boolean
}

const INPUT =
  'rounded-control border border-line-strong bg-surface px-3 py-2.5 text-[14px] text-ink transition-colors placeholder:text-ink-4 focus:border-accent focus:outline-none'

function describe(failure: PolicyActionFailure | 'unknown'): string {
  switch (failure) {
    case 'unauthenticated':
      return 'Sign in again to change this policy.'
    case 'forbidden':
      return 'Only an owner or operator can change access policies. Analysts can read everything and change nothing.'
    case 'throttled':
      return 'Too many changes from this network. Wait a minute and try again.'
    case 'not_found':
      return 'That policy is not yours, or it no longer exists.'
    case 'name_required':
      return 'Give the policy a name of 80 characters or fewer.'
    case 'name_taken':
      return 'You already have a policy with that name.'
    case 'description_too_long':
      return 'Keep the description under 300 characters.'
    case 'unknown_action_invalid':
      return 'Choose what happens to a wallet you do not recognise.'
    case 'cap_invalid':
      return 'Caps are plain decimals with no currency symbol, and blank means no limit.'
    case 'cap_zero':
      return 'A cap of zero would hold every request for review. Leave it blank for no limit.'
    case 'rate_invalid':
      return 'The rate limit is a whole number of requests per minute, or blank for none.'
    case 'wallet_invalid':
      return 'That does not look like a Stellar account. It should start with G and be 56 characters.'
    case 'wallet_exists':
      return 'That address is already on this list.'
    case 'wallet_missing':
      return 'That address is not on this list.'
    case 'service_invalid':
      return 'One of those services is not yours, so nothing was changed.'
    default:
      return 'That change could not be applied. Nothing was changed.'
  }
}

export default function PolicyEditor({
  policy,
  allowlist,
  denylist,
  services,
}: {
  policy: PolicyRecord
  allowlist: AllowEntry[]
  denylist: DenyEntry[]
  services: ServiceOption[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, fn: () => Promise<{ ok: boolean; warning?: string; failure?: PolicyActionFailure }>, success: string) => {
      setBusy(key)
      setError(null)
      setNotice(null)
      const result = await fn()
      setBusy(null)
      if (!result.ok) {
        setError(describe(result.failure ?? 'unknown'))
        return false
      }
      setNotice(result.warning ?? success)
      router.refresh()
      return true
    },
    [router],
  )

  const save = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const form = new FormData(event.currentTarget)
      void run(
        'save',
        () =>
          updatePolicyAction(policy.id, {
            name: String(form.get('name') ?? ''),
            description: String(form.get('description') ?? ''),
            unknownAction: String(form.get('unknownAction') ?? 'review'),
            maxAmountPerRequest: String(form.get('maxAmountPerRequest') ?? ''),
            dailyCapPerWallet: String(form.get('dailyCapPerWallet') ?? ''),
            ungrantedSpendCap: String(form.get('ungrantedSpendCap') ?? ''),
            rateLimitPerMin: String(form.get('rateLimitPerMin') ?? ''),
            active: form.get('active') === 'on',
          }),
        'Policy saved.',
      )
    },
    [policy.id, run],
  )

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <form onSubmit={save} className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="name" className="text-[13px] font-medium text-ink-2">
              Name
            </label>
            <input id="name" name="name" required maxLength={80} defaultValue={policy.name} className={INPUT} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="unknownAction" className="text-[13px] font-medium text-ink-2">
              A wallet you do not recognise
            </label>
            <select id="unknownAction" name="unknownAction" defaultValue={policy.unknownAction} className={INPUT}>
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
          <input id="description" name="description" maxLength={300} defaultValue={policy.description} className={INPUT} />
        </div>

        <fieldset className="flex flex-col gap-4">
          <legend className="text-[13px] font-medium text-ink-2">Spending caps</legend>
          <p className="text-[12px] leading-relaxed text-ink-3">
            Plain decimals in USDC. Leave one blank for no limit. A request over a cap is held for
            review, not refused, and nothing is charged while it waits.
          </p>
          <div className="grid gap-5 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="maxAmountPerRequest" className="text-[12px] text-ink-3">
                Per request
              </label>
              <input
                id="maxAmountPerRequest"
                name="maxAmountPerRequest"
                inputMode="decimal"
                placeholder="no limit"
                defaultValue={policy.maxAmountPerRequest}
                className={INPUT}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dailyCapPerWallet" className="text-[12px] text-ink-3">
                Per wallet, rolling 24h
              </label>
              <input
                id="dailyCapPerWallet"
                name="dailyCapPerWallet"
                inputMode="decimal"
                placeholder="no limit"
                defaultValue={policy.dailyCapPerWallet}
                className={INPUT}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ungrantedSpendCap" className="text-[12px] text-ink-3">
                Ungranted spend
              </label>
              <input
                id="ungrantedSpendCap"
                name="ungrantedSpendCap"
                inputMode="decimal"
                placeholder="no limit"
                defaultValue={policy.ungrantedSpendCap}
                className={INPUT}
              />
            </div>
          </div>
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="rateLimitPerMin" className="text-[13px] font-medium text-ink-2">
              Requests per minute
            </label>
            <input
              id="rateLimitPerMin"
              name="rateLimitPerMin"
              inputMode="numeric"
              placeholder="no limit"
              defaultValue={policy.rateLimitPerMin}
              className={INPUT}
            />
            <p className="text-[12px] text-ink-3">
              Refused outright, with no payment. Blank means no limit.
            </p>
          </div>
          <div className="flex items-end gap-2 pb-2.5">
            <input id="active" name="active" type="checkbox" defaultChecked={policy.active} className="h-4 w-4 accent-[var(--accent)]" />
            <label htmlFor="active" className="text-[13px] text-ink-2">
              Enabled
            </label>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="submit"
            disabled={busy !== null}
            className="self-start rounded-control bg-accent px-4 py-3 text-[14px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
          >
            {busy === 'save' ? 'Saving…' : 'Save policy'}
          </button>
          {!policy.active ? (
            <p className="text-[12px] leading-relaxed text-ink-3">
              This policy is disabled, so every service bound to it is refused with{' '}
              <span className="font-mono">policy is disabled</span>.
            </p>
          ) : null}
        </div>
      </form>

      <section className="flex flex-col gap-4">
        <h2 className="text-[15px] font-medium text-ink">Allowlist</h2>
        <p className="text-[12px] leading-relaxed text-ink-3">
          A wallet on this list may pay without being reviewed. An allowlist entry is a standing
          relationship; a grant from approving a held request is temporary and scoped to one
          service.
        </p>
        <ListEditor
          kind="allow"
          policyId={policy.id}
          entries={allowlist.map((e) => ({ wallet: e.wallet, label: e.label, reason: '' }))}
          busy={busy}
          run={run}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-[15px] font-medium text-ink">Denylist</h2>
        <p className="text-[12px] leading-relaxed text-ink-3">
          Refused at check 5, before caps, grants or the rate limit, and before any challenge
          exists. No payment is taken.
        </p>
        <ListEditor
          kind="deny"
          policyId={policy.id}
          entries={denylist.map((e) => ({ wallet: e.wallet, label: e.label, reason: e.reason }))}
          busy={busy}
          run={run}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-[15px] font-medium text-ink">Services</h2>
        <p className="text-[12px] leading-relaxed text-ink-3">
          A service has exactly one policy. Moving one here takes it off whichever policy it was
          on, and a service left on none is refused with{' '}
          <span className="font-mono">no policy attached to this service</span>.
        </p>
        <ServicePicker policyId={policy.id} services={services} busy={busy} run={run} />
      </section>

      {notice ? (
        <p role="status" className="text-[13px] leading-relaxed text-ok">
          {notice}
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

type Outcome = { ok: boolean; warning?: string; failure?: PolicyActionFailure }
type RunFn = (
  key: string,
  fn: () => Promise<Outcome>,
  success: string,
) => Promise<boolean>

function ListEditor({
  kind,
  policyId,
  entries,
  busy,
  run,
}: {
  kind: 'allow' | 'deny'
  policyId: string
  entries: { wallet: string; label: string; reason: string }[]
  busy: string | null
  run: RunFn
}) {
  const [wallet, setWallet] = useState('')
  const [label, setLabel] = useState('')
  const [reason, setReason] = useState('')

  const add = useCallback(() => {
    if (wallet.trim() === '') return
    void run(
      `${kind}-add`,
      () => addPolicyListAction(policyId, kind, wallet, label, reason),
      kind === 'allow' ? 'Wallet allowlisted.' : 'Wallet denylisted.',
    ).then((ok) => {
      if (ok) {
        setWallet('')
        setLabel('')
        setReason('')
      }
    })
  }, [kind, policyId, wallet, label, reason, run])

  return (
    <div className="flex flex-col gap-3">
      {entries.length === 0 ? (
        <p className="text-[13px] text-ink-3">Nothing here yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((e) => (
            <li
              key={e.wallet}
              className="flex items-center justify-between gap-3 rounded-control border border-line px-3 py-2"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-[12px] text-ink">{e.wallet}</span>
                {e.label || e.reason ? (
                  <span className="truncate text-[12px] text-ink-3">{e.label || e.reason}</span>
                ) : null}
              </span>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    `${kind}-remove-${e.wallet}`,
                    () => removePolicyListAction(policyId, kind, e.wallet),
                    'Entry removed.',
                  )
                }
                className="shrink-0 rounded-control border border-line-strong px-2 py-1 text-[12px] text-ink-2 transition-colors hover:border-accent disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="G… account address"
          aria-label={kind === 'allow' ? 'Wallet to allowlist' : 'Wallet to denylist'}
          className={`${INPUT} font-mono`}
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          aria-label="Label"
          className={`${INPUT} sm:w-40`}
        />
        {kind === 'deny' ? (
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason"
            aria-label="Reason"
            className={`${INPUT} sm:w-48`}
          />
        ) : null}
        <button
          type="button"
          onClick={add}
          disabled={busy !== null || wallet.trim() === ''}
          className="shrink-0 rounded-control border border-line-strong px-3 py-2.5 text-[13px] font-medium text-ink transition-colors hover:border-accent disabled:opacity-50"
        >
          {busy === `${kind}-add` ? 'Adding…' : 'Add'}
        </button>
      </div>
    </div>
  )
}

function ServicePicker({
  policyId,
  services,
  busy,
  run,
}: {
  policyId: string
  services: ServiceOption[]
  busy: string | null
  run: RunFn
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(services.map((s) => [s.id, s.boundHere])),
  )

  const save = useCallback(() => {
    const ids = services.filter((s) => selected[s.id]).map((s) => s.id)
    void run('services', () => setPolicyServicesAction(policyId, ids), 'Services updated.')
  }, [policyId, services, selected, run])

  return (
    <div className="flex flex-col gap-3">
      {services.length === 0 ? (
        <p className="text-[13px] text-ink-3">
          No services yet. Create one first, then point it at this policy.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {services.map((s) => (
              <li key={s.id}>
                <label className="flex items-center gap-3 rounded-control border border-line px-3 py-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={selected[s.id] ?? false}
                    onChange={(e) => setSelected((prev) => ({ ...prev, [s.id]: e.target.checked }))}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  <span className="flex-1">{s.name}</span>
                  <span className="font-mono text-[12px] text-ink-3">/v1/{s.slug}</span>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={save}
            disabled={busy !== null}
            className="self-start rounded-control border border-line-strong px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-accent disabled:opacity-50"
          >
            {busy === 'services' ? 'Saving…' : 'Save services'}
          </button>
        </>
      )}
    </div>
  )
}
