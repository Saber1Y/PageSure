import { db } from '@/lib/db/client'
import {
  organizations,
  policies,
  policyAssets,
  policyNetworks,
  policyServiceLinks,
  services,
  users,
} from '@/lib/db/schema'
import { USDC_SAC_TESTNET, STELLAR_TESTNET } from '@stellar/mpp'
import { StrKey } from '@stellar/stellar-sdk'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

/**
 * Seed a DEMO organization with sample policies and services.
 *
 * There is deliberately NO account seeding here in the general case. An operator is created
 * only when somebody proves control of a wallet they own, and their organization is created
 * by that same proof. There is no credential in .env, no password hash in the database, and
 * nothing to rotate or leak.
 *
 * This script therefore does nothing at all unless DEMO_OWNER_WALLET names a wallet. That
 * guard exists because policies and services are organization-owned now: seeding them
 * without an owner would create rows no dashboard could ever reach, which is worse than
 * having no demo data. Set it to the wallet you will actually sign in with, and the demo
 * organization becomes yours to edit like any other.
 *
 * Idempotent: re-running updates nothing and creates no duplicates.
 * Prices are in USDC base units at 7 decimals, so 0.01 USDC = '100000'.
 */

function uid(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export const DEMO_ORG_ID = 'org_demo'

export async function seed(): Promise<{ created: boolean; services: number }> {
  const target = db()

  const ownerWallet = process.env.DEMO_OWNER_WALLET?.trim()
  if (!ownerWallet || !StrKey.isValidEd25519PublicKey(ownerWallet)) {
    console.log('DEMO_OWNER_WALLET not set to a valid Stellar key: nothing to seed.')
    console.log('Set it to the wallet you will sign in with, then re-run `npm run db:seed`.')
    return { created: false, services: 0 }
  }

  const treasury = process.env.DEMO_SETTLEMENT_RECIPIENT?.trim() || ownerWallet
  if (!StrKey.isValidEd25519PublicKey(treasury)) {
    throw new Error('DEMO_SETTLEMENT_RECIPIENT is not a valid Stellar account')
  }

  // The channel commitment key is optional: charge-mode services settle without one. It is
  // validated up front so a malformed value fails the seed loudly rather than leaving a
  // demo organization that cannot open channels for reasons nobody can see.
  const commitmentPublicKey = process.env.DEMO_COMMITMENT_PUBLIC_KEY?.trim() || null
  if (commitmentPublicKey) {
    let raw: Buffer
    try {
      raw = Buffer.from(StrKey.decodeMed25519PublicKey(commitmentPublicKey))
    } catch {
      throw new Error(
        'DEMO_COMMITMENT_PUBLIC_KEY is not an M... (med25519) public key: decodeMed25519PublicKey requires the M prefix',
      )
    }
    if (raw.length !== 32) throw new Error('DEMO_COMMITMENT_PUBLIC_KEY must decode to 32 bytes')
  }

  // ---- organization -------------------------------------------------------
  const existingOrg = target.select().from(organizations).where(eq(organizations.id, DEMO_ORG_ID)).get()
  if (!existingOrg) {
    target
      .insert(organizations)
      .values({
        id: DEMO_ORG_ID,
        name: 'PageSure Demo',
        settlementRecipient: treasury,
        commitmentPublicKey,
        createdAt: Date.now(),
      })
      .run()
    console.log('created demo organization')
  } else if (commitmentPublicKey && !existingOrg.commitmentPublicKey) {
    // Backfill rather than insert: re-running the seed must not fail on the existing row.
    target
      .update(organizations)
      .set({ commitmentPublicKey })
      .where(eq(organizations.id, DEMO_ORG_ID))
      .run()
    console.log('backfilled demo commitment key')
  }

  // ---- owner --------------------------------------------------------------
  const existingUser = target.select().from(users).where(eq(users.walletPublicKey, ownerWallet)).get()
  if (!existingUser) {
    target
      .insert(users)
      .values({
        id: uid('usr'),
        organizationId: DEMO_ORG_ID,
        walletPublicKey: ownerWallet,
        displayName: process.env.PROVIDER_LABEL ?? 'PageSure Demo',
        role: 'owner',
        createdAt: Date.now(),
      })
      .run()
    console.log(`created demo owner for ${ownerWallet}`)
  } else if (existingUser.organizationId !== DEMO_ORG_ID) {
    /*
     * The wallet is already registered, but under a different organization.
     *
     * Silently skipping the insert here produced a demo organization with no members: the
     * operator signs in successfully, lands on their real organization, and concludes the
     * seed is broken. Re-homing an existing account is destructive, so this stops instead
     * and says which organization already owns the wallet.
     */
    throw new Error(
      `DEMO_OWNER_WALLET ${ownerWallet} already belongs to organization ${existingUser.organizationId}. ` +
        'Point DEMO_OWNER_WALLET at a fresh wallet, or clear the demo organization and sign up through /login.',
    )
  }

  // ---- policies -----------------------------------------------------------
  const policyId = ensurePolicy(target, {
    name: 'Standard Access',
    description:
      'Default provider policy. Unknown wallets are reviewed rather than trusted; denylisted wallets are refused outright.',
    unknownAction: 'review',
    maxAmountPerRequestBase: '5000000', // 0.5 USDC
    dailyCapPerWalletBase: '100000000', // 100 USDC
    // Keeps a post-verification deny cheap. A wallet with no grant cannot authorise an
    // amount large enough to matter before PageSure holds an authoritative payer.
    ungrantedSpendCapBase: '1000000', // 0.1 USDC
    rateLimitPerMin: 60,
  })

  // A second policy showing a stricter posture, so the BLOCK path is demonstrable without
  // editing anything.
  const strictPolicyId = ensurePolicy(target, {
    name: 'Restricted',
    description: 'Deny by default. Unknown wallets are blocked outright.',
    unknownAction: 'block',
    maxAmountPerRequestBase: '1000000',
    dailyCapPerWalletBase: '10000000',
    ungrantedSpendCapBase: '100000',
    rateLimitPerMin: 20,
  })

  // ---- services -----------------------------------------------------------
  const definitions = [
    {
      slug: 'search',
      name: 'PageSure Search',
      description: 'Web search across Brave, Tavily and Exa. Real provider APIs, no local fallback.',
      priceBase: '100000', // 0.01 USDC
      mode: 'charge' as const,
      upstreamKind: 'search',
      policyId,
      upstreamConfig: {},
    },
    {
      slug: 'market-data',
      name: 'Market Data',
      description: 'Live Stellar DEX order book via Horizon, with CoinGecko as a second source.',
      priceBase: '20000', // 0.002 USDC
      mode: 'channel' as const,
      upstreamKind: 'market',
      policyId,
      upstreamConfig: {},
    },
    {
      slug: 'summarize',
      name: 'AI Summarizer',
      description: 'Summarisation through any OpenAI-compatible chat completions endpoint.',
      priceBase: '500000', // 0.05 USDC
      mode: 'charge' as const,
      upstreamKind: 'summarize',
      policyId: strictPolicyId,
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
        organizationId: DEMO_ORG_ID,
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

  // Link every service to both policies so the Policies screens show real usage.
  for (const pid of [policyId, strictPolicyId]) {
    for (const def of definitions) {
      const svc = target.select().from(services).where(eq(services.slug, def.slug)).get()
      if (!svc) continue
      const linked = target
        .select()
        .from(policyServiceLinks)
        .where(eq(policyServiceLinks.policyId, pid))
        .all()
        .some((l) => l.serviceId === svc.id)
      if (!linked) {
        target.insert(policyServiceLinks).values({ id: uid('psl'), organizationId: DEMO_ORG_ID, policyId: pid, serviceId: svc.id }).run()
      }
    }
  }

  console.log(`services created: ${created}`)
  return { created: created > 0, services: created }
}

type PolicyInput = {
  name: string
  description: string
  unknownAction: 'allow' | 'review' | 'block'
  maxAmountPerRequestBase: string
  dailyCapPerWalletBase: string
  ungrantedSpendCapBase: string
  rateLimitPerMin: number
}

function ensurePolicy(target: ReturnType<typeof db>, input: PolicyInput): string {
  const existing = target
    .select()
    .from(policies)
    .where(eq(policies.organizationId, DEMO_ORG_ID))
    .all()
    .find((p) => p.name === input.name)

  if (existing) return existing.id

  const id = uid('pol')
  const now = Date.now()
  target
    .insert(policies)
    .values({
      id,
      organizationId: DEMO_ORG_ID,
      name: input.name,
      description: input.description,
      unknownAction: input.unknownAction,
      maxAmountPerRequestBase: input.maxAmountPerRequestBase,
      dailyCapPerWalletBase: input.dailyCapPerWalletBase,
      ungrantedSpendCapBase: input.ungrantedSpendCapBase,
      rateLimitPerMin: input.rateLimitPerMin,
      active: true,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  target
    .insert(policyAssets)
    .values({ id: uid('pas'), organizationId: DEMO_ORG_ID, policyId: id, assetContract: USDC_SAC_TESTNET })
    .run()
  target
    .insert(policyNetworks)
    .values({ id: uid('pnt'), organizationId: DEMO_ORG_ID, policyId: id, network: STELLAR_TESTNET })
    .run()

  console.log(`created policy "${input.name}"`)
  return id
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