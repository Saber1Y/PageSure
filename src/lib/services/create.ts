import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  organizations,
  policyAssets,
  policyNetworks,
  policies,
  policyServiceLinks,
  services,
} from '@/lib/db/schema'
import { newId } from '@/lib/auth/identity'
import { parseAmount } from '@/lib/money'
import { network, USDC_SAC_TESTNET } from '@/lib/mpp/registry'
import { recordActivity } from '@/lib/metering/record'
import { validateSlug, type SlugRejection } from './slug'
import { UPSTREAM_KINDS, type UpstreamKind } from '@/lib/upstream/kinds'
import { StrKey } from '@stellar/stellar-sdk'

/**
 * Creating a service: the first thing an operator does, and previously impossible.
 *
 * The catalogue used to be reachable only through `npm run db:seed`. The `Create service` links
 * on /services pointed at a route that did not exist, and a seeded service belonged to the seeded
 * organization, so an organization created by signing up owned nothing and could not add
 * anything. The gateway resolves `/v1/:slug` globally while every console screen is
 * organization-scoped, so the two halves never met.
 *
 * This lives in lib rather than inside the server action for one reason: it must be provable.
 * Authorization and tenant scoping that can only be exercised through a cookie-reading action is
 * authorization nobody has tested. The action supplies identity and throttling; everything that
 * decides what gets written is here.
 *
 * Three decisions, each a way this could have been wrong:
 *
 * 1. A DEFAULT POLICY IS CREATED WHEN THE ORGANIZATION HAS NONE. Policies are still not creatable
 *    through the interface, so without this a brand-new organization reaches a form whose only
 *    submit path is "no policy to bind". A service with no policy is not merely unpriced:
 *    `evaluate` blocks it at check 2 with "no policy attached to this service", so it would be
 *    published and dead. The default is the conservative one - unknown wallets reviewed, not
 *    allowed - and it registers the asset and network the engine requires, because an
 *    unregistered asset blocks at check 4 just as firmly.
 *
 * 2. STATUS DEFAULTS TO LIVE. The schema default is `draft`, and `evaluate` checks
 *    `service_active` FIRST, so a draft service is blocked before policy is examined. Defaulting
 *    to draft would mean every service created through the form appeared to work and answered
 *    403. A draft can still be chosen deliberately.
 *
 * 3. ZERO IS REFUSED. A free endpoint is an open relay that still consumes somebody's upstream
 *    quota on every call, and it would be a quiet way to drain an API key.
 *
 * `services.policyId` carries no foreign key, so nothing at the database level stops another
 * tenant's policy id being written here. `loadPolicySnapshot` filters by organization and returns
 * null, which degrades to a BLOCK rather than a cross-tenant read - safe, but silent, so
 * ownership is checked explicitly instead.
 */

export type CreateServiceFailure =
  | 'name_required'
  | 'description_too_long'
  | 'slug_invalid'
  | 'slug_taken'
  | 'price_invalid'
  | 'price_zero'
  | 'upstream_invalid'
  | 'mode_invalid'
  | 'policy_invalid'
  | 'session_setup_required'

export interface CreateServiceInput {
  organizationId: string
  name: string
  slug: string
  description?: string
  /** Human decimal, e.g. '0.01'. Converted to base units here. */
  price: string
  upstreamKind: string
  mode?: string
  policyId?: string
  status?: string
}

export type CreateServiceOutcome =
  | { ok: true; serviceId: string; policyCreated: boolean }
  | { ok: false; failure: CreateServiceFailure; detail?: string }

const NAME_MAX = 80
const DESCRIPTION_MAX = 300

/** Conservative by design: this becomes the organization's access policy without being asked. */
const DEFAULT_POLICY = {
  name: 'Standard Access',
  description:
    'Created with your first service. Unknown wallets are reviewed rather than trusted, and spending is capped.',
  unknownAction: 'review' as const,
  maxAmountPerRequestBase: '5000000', // 0.5 USDC
  dailyCapPerWalletBase: '100000000', // 100 USDC
  ungrantedSpendCapBase: '1000000', // 0.1 USDC
  rateLimitPerMin: 60,
}

export const SLUG_MESSAGES: Record<SlugRejection, string> = {
  empty: 'Give the service an address in its URL.',
  characters: 'Use lowercase letters, numbers and single dashes only.',
  length: 'That address is too long. Keep it under 40 characters.',
  reserved: 'That address is reserved by PageSure. Pick another.',
  leading_dash: 'A URL cannot start with a dash.',
  trailing_dash: 'A URL cannot end with a dash.',
}

export function createService(input: CreateServiceInput): CreateServiceOutcome {
  const name = input.name.trim()
  if (name.length === 0 || name.length > NAME_MAX) {
    return { ok: false, failure: 'name_required' }
  }

  const description = (input.description ?? '').trim()
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, failure: 'description_too_long' }
  }

  const slugResult = validateSlug(input.slug)
  if (!slugResult.ok) {
    return { ok: false, failure: 'slug_invalid', detail: SLUG_MESSAGES[slugResult.reason] }
  }
  const slug = slugResult.slug

  if (!UPSTREAM_KINDS.includes(input.upstreamKind as UpstreamKind)) {
    return { ok: false, failure: 'upstream_invalid' }
  }
  const upstreamKind = input.upstreamKind as UpstreamKind

  const mode = input.mode === 'channel' ? 'channel' : 'charge'
  if (input.mode !== undefined && input.mode !== 'charge' && input.mode !== 'channel') {
    return { ok: false, failure: 'mode_invalid' }
  }

  const status = input.status === 'draft' || input.status === 'paused' ? input.status : 'live'
  if (input.status !== undefined && !['live', 'draft', 'paused'].includes(input.status)) {
    return { ok: false, failure: 'mode_invalid' }
  }

  // A published channel endpoint is not usable until the organization can receive and settle.
  // Drafts remain available so an operator can configure the organization in parallel.
  if (mode === 'channel' && status === 'live') {
    const org = db().select().from(organizations).where(eq(organizations.id, input.organizationId)).get()
    const tokenEnv = org?.commitmentSignerTokenEnv ?? ''
    const ready = Boolean(
      org?.treasuryVerified && org.settlementRecipient &&
      org.commitmentSignerUrl?.startsWith('https://') &&
      /^[A-Z0-9_]+$/.test(tokenEnv) && process.env[tokenEnv] &&
      StrKey.isValidContract(process.env.CHANNEL_FACTORY_C ?? ''),
    )
    if (!ready) {
      return {
        ok: false,
        failure: 'session_setup_required',
        detail: 'Verify the organization treasury, configure its HTTPS settlement signer and token, and deploy the channel factory in Settings/setup before publishing a session service. You can save this service as a draft.',
      }
    }
  }

  let priceBase: string
  try {
    priceBase = parseAmount(input.price, 7)
  } catch {
    return { ok: false, failure: 'price_invalid' }
  }
  if (priceBase === '0') return { ok: false, failure: 'price_zero' }

  const assetContract = USDC_SAC_TESTNET
  const net = network()
  const organizationId = input.organizationId

  let outcome: CreateServiceOutcome
  try {
    outcome = db().transaction((tx) => {
      // Global uniqueness. Checked inside the transaction so a concurrent create cannot slip
      // between check and insert; the unique index remains the authority, and its error is
      // translated below rather than surfacing as a 500.
      const clash = tx.select({ id: services.id }).from(services).where(eq(services.slug, slug)).get()
      if (clash) return { ok: false as const, failure: 'slug_taken' as const }

      let policyId = input.policyId?.trim() ?? ''
      let policyCreated = false

      if (policyId) {
        // services.policyId has no foreign key, so ownership is proven here.
        const owned = tx
          .select({ id: policies.id })
          .from(policies)
          .where(and(eq(policies.id, policyId), eq(policies.organizationId, organizationId)))
          .get()
        if (!owned) return { ok: false as const, failure: 'policy_invalid' as const }

        const assetOk = tx
          .select({ id: policyAssets.id })
          .from(policyAssets)
          .where(
            and(eq(policyAssets.policyId, policyId), eq(policyAssets.assetContract, assetContract)),
          )
          .get()
        if (!assetOk) return { ok: false as const, failure: 'policy_invalid' as const }
      } else {
        const existing = tx
          .select({ id: policies.id })
          .from(policies)
          .where(eq(policies.organizationId, organizationId))
          .get()
        if (existing) {
          policyId = existing.id
        } else {
          policyId = newId('pol')
          const now = Date.now()
          tx.insert(policies)
            .values({
              id: policyId,
              organizationId,
              name: DEFAULT_POLICY.name,
              description: DEFAULT_POLICY.description,
              unknownAction: DEFAULT_POLICY.unknownAction,
              maxAmountPerRequestBase: DEFAULT_POLICY.maxAmountPerRequestBase,
              dailyCapPerWalletBase: DEFAULT_POLICY.dailyCapPerWalletBase,
              ungrantedSpendCapBase: DEFAULT_POLICY.ungrantedSpendCapBase,
              rateLimitPerMin: DEFAULT_POLICY.rateLimitPerMin,
              active: true,
              createdAt: now,
              updatedAt: now,
            })
            .run()
          // The engine blocks at check 4 without an asset row and at check 3 without a network
          // row, so a policy without them cannot price anything.
          tx.insert(policyAssets)
            .values({ id: newId('pa'), organizationId, policyId, assetContract })
            .run()
          tx.insert(policyNetworks)
            .values({ id: newId('pn'), organizationId, policyId, network: net })
            .run()
          policyCreated = true
        }
      }

      const serviceId = newId('svc')
      const now = Date.now()
      tx.insert(services)
        .values({
          id: serviceId,
          organizationId,
          slug,
          name,
          description,
          assetCode: 'USDC',
          assetContract,
          decimals: 7,
          priceBase,
          mode,
          upstreamKind,
          upstreamConfig: {},
          policyId,
          status,
          createdAt: now,
          updatedAt: now,
        })
        .run()

      // Display-only: the engine reads services.policyId, and /policies reads these to show what
      // a policy covers. Written alongside the service, in the same transaction.
      tx.insert(policyServiceLinks)
        .values({ id: newId('psl'), organizationId, policyId, serviceId })
        .run()

      return { ok: true as const, serviceId, policyCreated }
    })
  } catch (error) {
    // The unique index is the real authority on slug uniqueness. Reaching here means the check
    // above was bypassed by a concurrent insert, so translate it rather than reporting a 500 for
    // something the caller can fix by choosing another address.
    if (isUniqueSlugViolation(error)) return { ok: false, failure: 'slug_taken' }
    throw error
  }

  if (!outcome.ok) return outcome

  // 'service_created' existed in the activity union from the start with no writer; this is it.
  recordActivity({
    organizationId,
    type: 'service_created',
    message: `${name} published at /v1/${slug}`,
    serviceId: outcome.serviceId,
    amountBase: priceBase,
    assetCode: 'USDC',
    decimals: 7,
  })

  return outcome
}

function isUniqueSlugViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const message = 'message' in error ? String((error as { message?: unknown }).message) : ''
  return message.includes('services.slug') || message.includes('services_slug_idx')
}
