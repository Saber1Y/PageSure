import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  policyAllowlist,
  policyAssets,
  policyDenylist,
  policyNetworks,
  policies,
  policyServiceLinks,
  services,
} from '@/lib/db/schema'
import { newId } from '@/lib/auth/identity'
import { fromBig, parseAmount, toBig } from '@/lib/money'
import { isValidStellarAccount } from '@/lib/identity/payer'
import { network, USDC_SAC_TESTNET } from '@/lib/mpp/registry'

/**
 * Creating and editing access policies.
 *
 * Until now a policy could be created only as a side effect of creating a service, and never
 * changed. So an organization's entire access control was whatever default it was handed: caps
 * fixed, unknown wallets always handled the same way, and no way to allowlist a wallet by hand.
 * The only route to `ALLOW` was approving a held request, which issues a grant scoped to one
 * service for 24 hours - useful, but not the same as a standing relationship.
 *
 * In lib rather than inside the server action, so it can be proven without a browser or a cookie.
 *
 * Four decisions worth stating:
 *
 * 1. NO DELETE. `services.policyId` carries no foreign key, so deleting a policy that services
 *    point at leaves them bound to nothing, and `evaluate` blocks that at check 2 with "no policy
 *    attached to this service". A silently dead service is the worst thing this module could do.
 *    `active: false` is the retirement path: the engine blocks with "policy is disabled", which
 *    names the cause instead of pretending the policy is absent.
 *
 * 2. A CAP OF ZERO IS REFUSED, AND EMPTY MEANS NO LIMIT. `exceeds(amount, '0')` is true for every
 *    positive amount, so a zero cap does not mean "free" - it means "review every request
 *    forever". "No cap" is already expressible as null, so zero is strictly a footgun with no
 *    legitimate reading. Refusing it is better than accepting a setting whose effect is invisible
 *    until traffic arrives.
 *
 * 3. A CAP BELOW A BOUND SERVICE'S PRICE IS A WARNING, NOT A REFUSAL. It is a legitimate way to
 *    say "review everything on this service", so it is permitted - but the outcome carries a
 *    warning naming the services it affects, because the consequence is otherwise invisible until
 *    requests start held.
 *
 * 4. LIST ENTRIES ARE VALIDATED AS STELLAR ACCOUNTS. The engine matches them byte-for-byte
 *    against the verified payer, so a typo is a silently ineffective entry: the wallet looks
 *    allowlisted on /policies and is still reviewed at request time. `isValidStellarAccount` is
 *    used rather than the raw SDK so a malformed paste returns false instead of throwing.
 */

export type UnknownAction = 'allow' | 'review' | 'block'

export type PolicyFailure =
  | 'not_found'
  | 'name_required'
  | 'name_taken'
  | 'description_too_long'
  | 'unknown_action_invalid'
  | 'cap_invalid'
  | 'cap_zero'
  | 'rate_invalid'
  | 'wallet_invalid'
  | 'wallet_exists'
  | 'wallet_missing'
  | 'service_invalid'

export type PolicyOutcome =
  | { ok: true; policyId: string; warning?: string }
  | { ok: false; failure: PolicyFailure }

export interface PolicyInput {
  name: string
  description?: string
  unknownAction: string
  /** Human decimals, or '' / undefined for no limit. */
  maxAmountPerRequest?: string
  dailyCapPerWallet?: string
  ungrantedSpendCap?: string
  /** Integer per minute, or '' / undefined for no limit. */
  rateLimitPerMin?: string
  active?: boolean
}

const NAME_MAX = 80
const DESCRIPTION_MAX = 300
const RATE_MIN = 1
const RATE_MAX = 10000

/** Parse an optional cap. Empty means "no limit", which the engine reads as null. */
function parseCap(value: string | undefined, field: string): { ok: true; value: string | null } | { ok: false; failure: PolicyFailure } {
  const raw = (value ?? '').trim()
  if (raw === '') return { ok: true, value: null }
  let base: string
  try {
    base = parseAmount(raw, 7)
  } catch {
    return { ok: false, failure: 'cap_invalid' }
  }
  // See decision 2. Zero means "review everything", not "no limit".
  if (base === '0') return { ok: false, failure: 'cap_zero' }
  void field
  return { ok: true, value: base }
}

function parseRate(value: string | undefined): { ok: true; value: number | null } | { ok: false; failure: PolicyFailure } {
  const raw = (value ?? '').trim()
  if (raw === '') return { ok: true, value: null }
  if (!/^\d+$/.test(raw)) return { ok: false, failure: 'rate_invalid' }
  const n = Number(raw)
  if (n < RATE_MIN || n > RATE_MAX) return { ok: false, failure: 'rate_invalid' }
  return { ok: true, value: n }
}

/**
 * Bound services priced above a cap will be held on every request.
 *
 * Surfaced rather than enforced: it is a legitimate configuration, but one whose effect is
 * invisible until traffic arrives.
 */
function capWarning(policyId: string, capBase: string | null): string | undefined {
  if (capBase === null) return undefined
  const bound = db()
    .select({ slug: services.slug, name: services.name, priceBase: services.priceBase })
    .from(services)
    .where(and(eq(services.policyId, policyId), eq(services.status, 'live')))
    .all()
  const over = bound.filter((s) => {
    try {
      return toBig(s.priceBase) > toBig(capBase)
    } catch {
      return false
    }
  })
  if (over.length === 0) return undefined
  const names = over.map((s) => s.name).join(', ')
  return `This cap is below the price of ${names}, so every paid call to ${over.length === 1 ? 'it' : 'them'} will be held for review rather than charged.`
}

function ownedPolicy(organizationId: string, policyId: string) {
  return db()
    .select()
    .from(policies)
    .where(and(eq(policies.id, policyId), eq(policies.organizationId, organizationId)))
    .get()
}

/**
 * Create a policy, registering the asset and network the engine requires.
 *
 * The registration is not optional decoration: check 3 compares the deployment network against
 * `policy_networks` and check 4 compares the service's asset against `policy_assets`, so a policy
 * without them blocks everything it is bound to. Creating a policy that cannot price anything
 * would be creating a dead policy.
 */
export function createPolicy(
  organizationId: string,
  input: PolicyInput,
): PolicyOutcome {
  const name = input.name.trim()
  if (name.length === 0 || name.length > NAME_MAX) return { ok: false, failure: 'name_required' }

  const description = (input.description ?? '').trim()
  if (description.length > DESCRIPTION_MAX) return { ok: false, failure: 'description_too_long' }

  if (!['allow', 'review', 'block'].includes(input.unknownAction)) {
    return { ok: false, failure: 'unknown_action_invalid' }
  }
  const unknownAction = input.unknownAction as UnknownAction

  const perRequest = parseCap(input.maxAmountPerRequest, 'maxAmountPerRequest')
  if (!perRequest.ok) return perRequest
  const daily = parseCap(input.dailyCapPerWallet, 'dailyCapPerWallet')
  if (!daily.ok) return daily
  const ungranted = parseCap(input.ungrantedSpendCap, 'ungrantedSpendCap')
  if (!ungranted.ok) return ungranted

  const rate = parseRate(input.rateLimitPerMin)
  if (!rate.ok) return rate

  const existing = db()
    .select({ id: policies.id })
    .from(policies)
    .where(and(eq(policies.organizationId, organizationId), eq(policies.name, name)))
    .get()
  if (existing) return { ok: false, failure: 'name_taken' }

  const policyId = newId('pol')
  const now = Date.now()

  db().transaction((tx) => {
    tx.insert(policies)
      .values({
        id: policyId,
        organizationId,
        name,
        description,
        unknownAction,
        maxAmountPerRequestBase: perRequest.value,
        dailyCapPerWalletBase: daily.value,
        ungrantedSpendCapBase: ungranted.value,
        rateLimitPerMin: rate.value,
        active: input.active ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    tx.insert(policyAssets)
      .values({ id: newId('pa'), organizationId, policyId, assetContract: USDC_SAC_TESTNET })
      .run()
    tx.insert(policyNetworks)
      .values({ id: newId('pn'), organizationId, policyId, network: network() })
      .run()
  })

  return { ok: true, policyId }
}

/**
 * Change a policy's settings.
 *
 * `not_found` is returned for a policy belonging to another organization, not a distinct
 * failure: whether a given id exists is not something a caller in one tenant should be able to
 * learn from another tenant's screen.
 */
export function updatePolicy(
  organizationId: string,
  policyId: string,
  input: PolicyInput,
): PolicyOutcome {
  if (!ownedPolicy(organizationId, policyId)) return { ok: false, failure: 'not_found' }

  const name = input.name.trim()
  if (name.length === 0 || name.length > NAME_MAX) return { ok: false, failure: 'name_required' }

  const description = (input.description ?? '').trim()
  if (description.length > DESCRIPTION_MAX) return { ok: false, failure: 'description_too_long' }

  if (!['allow', 'review', 'block'].includes(input.unknownAction)) {
    return { ok: false, failure: 'unknown_action_invalid' }
  }

  const perRequest = parseCap(input.maxAmountPerRequest, 'maxAmountPerRequest')
  if (!perRequest.ok) return perRequest
  const daily = parseCap(input.dailyCapPerWallet, 'dailyCapPerWallet')
  if (!daily.ok) return daily
  const ungranted = parseCap(input.ungrantedSpendCap, 'ungrantedSpendCap')
  if (!ungranted.ok) return ungranted

  const rate = parseRate(input.rateLimitPerMin)
  if (!rate.ok) return rate

  const clash = db()
    .select({ id: policies.id })
    .from(policies)
    .where(and(eq(policies.organizationId, organizationId), eq(policies.name, name)))
    .get()
  if (clash && clash.id !== policyId) return { ok: false, failure: 'name_taken' }

  db()
    .update(policies)
    .set({
      name,
      description,
      unknownAction: input.unknownAction as UnknownAction,
      maxAmountPerRequestBase: perRequest.value,
      dailyCapPerWalletBase: daily.value,
      ungrantedSpendCapBase: ungranted.value,
      rateLimitPerMin: rate.value,
      active: input.active ?? true,
      updatedAt: Date.now(),
    })
    .where(and(eq(policies.id, policyId), eq(policies.organizationId, organizationId)))
    .run()

  const warning = capWarning(policyId, perRequest.value)
  return warning ? { ok: true, policyId, warning } : { ok: true, policyId }
}

export type ListName = 'allow' | 'deny'

export function addListEntry(
  organizationId: string,
  policyId: string,
  list: ListName,
  wallet: string,
  label?: string,
  reason?: string,
): PolicyOutcome {
  if (!ownedPolicy(organizationId, policyId)) return { ok: false, failure: 'not_found' }
  if (!isValidStellarAccount(wallet.trim())) return { ok: false, failure: 'wallet_invalid' }
  const address = wallet.trim()

  const table = list === 'allow' ? policyAllowlist : policyDenylist
  const dupe = db()
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.policyId, policyId), eq(table.wallet, address)))
    .get()
  if (dupe) return { ok: false, failure: 'wallet_exists' }

  const id = newId(list === 'allow' ? 'pal' : 'pdl')
  const cleanLabel = (label ?? '').trim().slice(0, 80)
  if (list === 'allow') {
    db()
      .insert(policyAllowlist)
      .values({ id, organizationId, policyId, wallet: address, label: cleanLabel, createdAt: Date.now() })
      .run()
  } else {
    db()
      .insert(policyDenylist)
      .values({
        id,
        organizationId,
        policyId,
        wallet: address,
        label: cleanLabel,
        reason: (reason ?? '').trim().slice(0, 200),
        createdAt: Date.now(),
      })
      .run()
  }
  return { ok: true, policyId }
}

export function removeListEntry(
  organizationId: string,
  policyId: string,
  list: ListName,
  wallet: string,
): PolicyOutcome {
  if (!ownedPolicy(organizationId, policyId)) return { ok: false, failure: 'not_found' }
  const address = wallet.trim()
  const table = list === 'allow' ? policyAllowlist : policyDenylist
  const row = db()
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.policyId, policyId), eq(table.wallet, address)))
    .get()
  if (!row) return { ok: false, failure: 'wallet_missing' }

  db()
    .delete(table)
    .where(and(eq(table.policyId, policyId), eq(table.wallet, address), eq(table.organizationId, organizationId)))
    .run()
  return { ok: true, policyId }
}

/**
 * Point a set of services at this policy.
 *
 * `services.policyId` is what the engine reads; `policyServiceLinks` only feeds the /policies
 * screen. Both are written here so they cannot disagree. Services already bound to another policy
 * are moved, not copied, since a service has exactly one policy.
 *
 * The asset check is a guard rather than a convenience: a policy created before this module, or
 * one whose asset row was removed, would leave every service bound to it blocked at check 4 with
 * "asset not allowed" - live, priced, and refusing.
 */
export function setPolicyServices(
  organizationId: string,
  policyId: string,
  serviceIds: string[],
): PolicyOutcome {
  if (!ownedPolicy(organizationId, policyId)) return { ok: false, failure: 'not_found' }

  const wanted = [...new Set(serviceIds.filter((id) => id.length > 0))]
  if (wanted.length === 0) {
    // Detaching everything is allowed and leaves services pointing at nothing, which the engine
    // reports as "no policy attached to this service". That is a legible state, not a silent one.
    const all = db()
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.organizationId, organizationId), eq(services.policyId, policyId)))
      .all()
    for (const s of all) {
      db()
        .update(services)
        .set({ policyId: null, updatedAt: Date.now() })
        .where(and(eq(services.id, s.id), eq(services.organizationId, organizationId)))
        .run()
    }
    db()
      .delete(policyServiceLinks)
      .where(and(eq(policyServiceLinks.policyId, policyId), eq(policyServiceLinks.organizationId, organizationId)))
      .run()
    return { ok: true, policyId }
  }

  const found = db()
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.organizationId, organizationId), inArray(services.id, wanted)))
    .all()
  if (found.length !== wanted.length) return { ok: false, failure: 'service_invalid' }

  const assetOk = db()
    .select({ id: policyAssets.id })
    .from(policyAssets)
    .where(and(eq(policyAssets.policyId, policyId), eq(policyAssets.assetContract, USDC_SAC_TESTNET)))
    .get()
  if (!assetOk) return { ok: false, failure: 'not_found' }

  db().transaction((tx) => {
    // Capture where each service is bound NOW, before it is overwritten. Without this the link
    // row for its previous policy survives, and /policies then reports a service as covered by a
    // policy the engine does not use - the exact disagreement this function exists to prevent.
    const previous = tx
      .select({ id: services.id, policyId: services.policyId })
      .from(services)
      .where(and(eq(services.organizationId, organizationId), inArray(services.id, wanted)))
      .all()

    for (const s of previous) {
      if (!s.policyId || s.policyId === policyId) continue
      tx.delete(policyServiceLinks)
        .where(
          and(
            eq(policyServiceLinks.policyId, s.policyId),
            eq(policyServiceLinks.serviceId, s.id),
            eq(policyServiceLinks.organizationId, organizationId),
          ),
        )
        .run()
    }

    // Clear this policy's links, then re-point the selected services and record the links.
    tx.delete(policyServiceLinks)
      .where(
        and(
          eq(policyServiceLinks.policyId, policyId),
          eq(policyServiceLinks.organizationId, organizationId),
        ),
      )
      .run()

    for (const id of found) {
      tx.update(services)
        .set({ policyId, updatedAt: Date.now() })
        .where(and(eq(services.id, id.id), eq(services.organizationId, organizationId)))
        .run()
      tx.insert(policyServiceLinks)
        .values({ id: newId('psl'), organizationId, policyId, serviceId: id.id })
        .run()
    }

    // Anything previously on this policy that was not selected becomes unbound. Left pointing at
    // it, it would appear on /policies as covered while the engine used a different policy.
    const orphaned = tx
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.organizationId, organizationId), eq(services.policyId, policyId)))
      .all()
    for (const s of orphaned) {
      if (found.some((f) => f.id === s.id)) continue
      tx.update(services)
        .set({ policyId: null, updatedAt: Date.now() })
        .where(and(eq(services.id, s.id), eq(services.organizationId, organizationId)))
        .run()
    }
  })

  return { ok: true, policyId }
}

/** Human-readable cap for the editor's prefilled inputs. */
export function capToHuman(base: string | null): string {
  if (base === null || base === undefined || base === '') return ''
  try {
    const whole = fromBig(toBig(base))
    const padded = whole.padStart(8, '0')
    return `${padded.slice(0, -7)}.${padded.slice(-7)}`.replace(/\.?0+$/, '')
  } catch {
    return ''
  }
}
