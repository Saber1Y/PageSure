import { db } from '@/lib/db/client'
import {
  policies,
  policyAssets,
  policyNetworks,
  policyServiceLinks,
  services,
  users,
} from '@/lib/db/schema'
import { USDC_SAC_TESTNET, STELLAR_TESTNET } from '@stellar/mpp'
import { eq } from 'drizzle-orm'
import { hashPassword } from '@/lib/auth/password'
import { randomUUID } from 'node:crypto'

/**
 * Seed the demo provider, policies and services.
 *
 * Idempotent: re-running updates the demo rows rather than duplicating them.
 * Prices are in USDC base units at 7 decimals, so 0.01 USDC = '100000'.
 */

const DEMO_EMAIL = 'provider@pagesure.dev'

function uid(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export async function seed(): Promise<{ created: boolean; services: number }> {
  const target = db()

  // ---- provider account ---------------------------------------------------
  const existingUser = target.select().from(users).where(eq(users.email, DEMO_EMAIL)).get()
  if (existingUser) {
    console.log('provider account already exists')
  } else {
    const password = process.env.PROVIDER_ADMIN_PASSWORD
    if (!password) throw new Error('PROVIDER_ADMIN_PASSWORD is not set')
    target
      .insert(users)
      .values({
        id: uid('usr'),
        email: DEMO_EMAIL,
        passwordHash: hashPassword(password),
        displayName: process.env.PROVIDER_LABEL ?? 'PageSure Demo Provider',
        role: 'owner',
        createdAt: Date.now(),
      })
      .run()
    console.log(`created provider account ${DEMO_EMAIL}`)
  }

  // ---- policy -------------------------------------------------------------
  let policy = target.select().from(policies).where(eq(policies.name, 'Standard Access')).get()
  if (!policy) {
    policy = {
      id: uid('pol'),
      name: 'Standard Access',
      description:
        'Default provider policy. Unknown wallets are reviewed rather than trusted; denylisted wallets are refused outright.',
      // Review, not allow: an unknown wallet should be held, not waved through.
      unknownAction: 'review',
      maxAmountPerRequestBase: '5000000', // 0.5 USDC
      dailyCapPerWalletBase: '100000000', // 100 USDC
      // Keeps a post-verification deny cheap. A wallet with no grant cannot authorise
      // an amount large enough to matter before PageSure holds an authoritative payer.
      ungrantedSpendCapBase: '1000000', // 0.1 USDC
      rateLimitPerMin: 60,
      active: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    target.insert(policies).values(policy).run()

    target.insert(policyAssets).values({ id: uid('pas'), policyId: policy.id, assetContract: USDC_SAC_TESTNET }).run()
    target.insert(policyNetworks).values({ id: uid('pnt'), policyId: policy.id, network: STELLAR_TESTNET }).run()
    console.log('created policy "Standard Access"')
  }

  // A second policy showing a stricter posture, and a wallet on its denylist so the
  // BLOCK path is demonstrable without editing anything.
  let strict = target.select().from(policies).where(eq(policies.name, 'Restricted')).get()
  if (!strict) {
    strict = {
      id: uid('pol'),
      name: 'Restricted',
      description: 'Deny by default. Unknown wallets are blocked outright.',
      unknownAction: 'block',
      maxAmountPerRequestBase: '1000000',
      dailyCapPerWalletBase: '10000000',
      ungrantedSpendCapBase: '100000',
      rateLimitPerMin: 20,
      active: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    target.insert(policies).values(strict).run()
    target.insert(policyAssets).values({ id: uid('pas'), policyId: strict.id, assetContract: USDC_SAC_TESTNET }).run()
    target.insert(policyNetworks).values({ id: uid('pnt'), policyId: strict.id, network: STELLAR_TESTNET }).run()
    console.log('created policy "Restricted"')
  }

  // ---- services -----------------------------------------------------------
  const definitions = [
    {
      slug: 'search',
      name: 'PageSure Search',
      description: 'Web search across Brave, Tavily and Exa. Real provider APIs, no local fallback.',
      priceBase: '100000', // 0.01 USDC
      mode: 'charge' as const,
      upstreamKind: 'search',
      policyId: policy.id,
      upstreamConfig: {},
    },
    {
      slug: 'market-data',
      name: 'Market Data',
      description: 'Live Stellar DEX order book via Horizon, with CoinGecko as a second source.',
      priceBase: '20000', // 0.002 USDC
      mode: 'channel' as const,
      upstreamKind: 'market',
      policyId: policy.id,
      upstreamConfig: {},
    },
    {
      slug: 'summarize',
      name: 'AI Summarizer',
      description: 'Summarisation through any OpenAI-compatible chat completions endpoint.',
      priceBase: '500000', // 0.05 USDC
      mode: 'charge' as const,
      upstreamKind: 'summarize',
      policyId: strict.id,
      upstreamConfig: {},
    },
  ]

  let created = 0
  for (const def of definitions) {
    const existing = target.select().from(services).where(eq(services.slug, def.slug)).get()
    if (existing) continue
    const now = Date.now()
    target
      .insert(services)
      .values({
        id: uid('svc'),
        slug: def.slug,
        name: def.name,
        description: def.description,
        assetCode: 'USDC',
        assetContract: USDC_SAC_TESTNET,
        decimals: 7,
        priceBase: def.priceBase,
        mode: def.mode,
        upstreamKind: def.upstreamKind,
        upstreamConfig: def.upstreamConfig,
        policyId: def.policyId,
        status: 'live',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    created++
  }

  // Link both services to both policies so the Policies screens show real usage.
  for (const policyId of [policy.id, strict.id]) {
    for (const def of definitions) {
      const svc = target.select().from(services).where(eq(services.slug, def.slug)).get()
      if (!svc) continue
      const linked = target
        .select()
        .from(policyServiceLinks)
        .where(eq(policyServiceLinks.policyId, policyId))
        .all()
        .some((l) => l.serviceId === svc.id)
      if (!linked) {
        target
          .insert(policyServiceLinks)
          .values({ id: uid('psl'), policyId, serviceId: svc.id })
          .run()
      }
    }
  }

  console.log(`services created: ${created}, total services: ${target.select().from(services).all().length}`)
  return { created: created > 0, services: created }
}

const isDirectRun = process.argv[1]?.includes('seed')
if (isDirectRun) {
  seed()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}