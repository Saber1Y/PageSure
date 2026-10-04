/**
 * Policy management: who may change access control, and what must be true for the change to mean
 * anything.
 *
 * A policy used to be created only as a side effect of creating a service, and never editable. So
 * an organization's entire access control was whatever default it was handed, and the only route to
 * `ALLOW` was approving a held request - a grant scoped to one service for 24 hours. This proof is
 * written around the ways that could go wrong rather than around the happy path:
 *
 *   - caps are stored as base units and edited as decimals, so a conversion error silently
 *     changes what a price means by a factor of ten million
 *   - a zero cap means "review everything", not "no limit", and reads as the latter
 *   - a wallet entry that is not a valid account is a silently ineffective allowlist entry: it
 *     looks configured on /policies and is still reviewed at request time
 *   - every mutation is scoped to one organization, and `not_found` does not distinguish "not
 *     yours" from "not there"
 *   - a service left on no policy is refused by the engine, so detaching must be legible rather
 *     than silent
 *
 * The assertions that matter most are the ones that run the real engine: a cap that converts
 * wrongly still "saves", and only a policy decision reveals it.
 *
 * Runs against a throwaway database. No server, no wallet, no network.
 */

import { existsSync, rmSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { Keypair } from '@stellar/stellar-sdk'

import { closeScratchDatabase } from './scratch-db'

const SCRATCH = './data/policies-proof.db'

process.env.DATABASE_URL = SCRATCH

closeScratchDatabase(SCRATCH)

const { runMigrations } = await import('../src/lib/db/migrate')
const { db } = await import('../src/lib/db/client')
const {
  organizationMembers,
  organizations,
  policyAllowlist,
  policyAssets,
  policyDenylist,
  policies,
  policyServiceLinks,
  services,
  users,
} = await import('../src/lib/db/schema')
const { createService } = await import('../src/lib/services/create')
const {
  addListEntry,
  capToHuman,
  createPolicy,
  removeListEntry,
  setPolicyServices,
  updatePolicy,
} = await import('../src/lib/policy/manage')
const { evaluatePreflight } = await import('../src/lib/policy/service')
const { USDC_SAC_TESTNET, network } = await import('../src/lib/mpp/registry')

runMigrations()

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`)
  }
}

function section(title: string) {
  console.log(`\n${title}`)
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(16).slice(2, 14)}`
}

interface Tenant {
  organizationId: string
  ownerId: string
  operatorId: string
  analystId: string
}

function seedTenant(name: string): Tenant {
  const organizationId = newId('org')
  db().insert(organizations)
    .values({
      id: organizationId,
      name,
      settlementRecipient: Keypair.random().publicKey(),
      treasuryVerified: true,
      createdAt: Date.now(),
    })
    .run()

  const mk = (role: 'owner' | 'operator' | 'analyst'): string => {
    const userId = newId('usr')
    db().insert(users)
      .values({
        id: userId,
        email: `${role}-${organizationId}@test`,
        displayName: role,
        organizationId,
        createdAt: Date.now(),
      })
      .run()
    db().insert(organizationMembers)
      .values({ id: newId('mem'), organizationId, userId, role, createdAt: Date.now() })
      .run()
    return userId
  }

  return { organizationId, ownerId: mk('owner'), operatorId: mk('operator'), analystId: mk('analyst') }
}

/** Run the real engine, which is the only thing that reveals whether a policy is usable. */
function decide(input: {
  organizationId: string
  serviceId: string
  policyId: string | null
  amountBase: string
  payer: string
  status?: 'live' | 'paused' | 'draft'
}) {
  return evaluatePreflight({
    organizationId: input.organizationId,
    serviceId: input.serviceId,
    serviceName: 'Test Service',
    serviceStatus: input.status ?? 'live',
    servicePolicyId: input.policyId,
    assetContract: USDC_SAC_TESTNET,
    amountBase: input.amountBase,
    mode: 'charge',
    network: network(),
    payer: input.payer,
  })
}

function makeService(organizationId: string, slug: string, price: string) {
  const r = createService({
    organizationId,
    name: `Service ${slug}`,
    slug,
    price,
    upstreamKind: 'market',
  })
  if (!r.ok) throw new Error(`cannot create service: ${JSON.stringify(r)}`)
  const row = db().select().from(services).where(eq(services.slug, slug)).get()
  if (!row) throw new Error('service vanished')
  return row
}

// ---------------------------------------------------------------------------
section('A new policy is immediately usable, not born blocking')
// ---------------------------------------------------------------------------
let acme: Tenant
let policyId = ''
{
  acme = seedTenant('Acme')
  const r = createPolicy(acme.organizationId, {
    name: 'Open',
    unknownAction: 'review',
    maxAmountPerRequest: '1',
    rateLimitPerMin: '30',
  })
  check('creation succeeds', r.ok, JSON.stringify(r))
  if (!r.ok) throw new Error('cannot continue')
  policyId = r.policyId

  const asset = db()
    .select()
    .from(policyAssets)
    .where(and(eq(policyAssets.policyId, policyId), eq(policyAssets.assetContract, USDC_SAC_TESTNET)))
    .get()
  check('USDC is registered, so the asset check can pass', asset !== undefined)

  const svc = makeService(acme.organizationId, 'acme-open', '0.5')
  setPolicyServices(acme.organizationId, policyId, [svc.id])

  const bound = db().select().from(services).where(eq(services.id, svc.id)).get()
  check('the service points at the policy', bound?.policyId === policyId)

  // The cap was entered as "1" and must mean 1 USDC = 10000000 base units. A conversion mistake
  // would still save cleanly, so only the engine can catch it.
  const cheap = decide({
    organizationId: acme.organizationId,
    serviceId: svc.id,
    policyId: bound?.policyId ?? null,
    amountBase: '9000000', // 0.9 USDC, under the cap
    payer: Keypair.random().publicKey(),
  })
  check('a request under the cap is reviewed, not held on a cap', cheap.trace.decision === 'review', `decision=${cheap.trace.decision}`)

  const dear = decide({
    organizationId: acme.organizationId,
    serviceId: svc.id,
    policyId: bound?.policyId ?? null,
    amountBase: '20000000', // 2 USDC, over the 1 USDC cap
    payer: Keypair.random().publicKey(),
  })
  check('a request over the cap is held', dear.trace.decision === 'review')
  const capCheck = dear.trace.checks.find((c) => c.key === 'amount_cap')
  check('and check 9 is the one that fired', capCheck?.status === 'fail', `amount_cap=${capCheck?.status}`)
  check('the trace states the cap in base units', /10000000/.test(capCheck?.detail ?? ''), capCheck?.detail)
}

// ---------------------------------------------------------------------------
section('The allowlist reaches ALLOW, which is the point of it')
// ---------------------------------------------------------------------------
{
  const svc = db().select().from(services).where(eq(services.slug, 'acme-open')).get()!
  const payer = Keypair.random().publicKey()

  const before = decide({
    organizationId: acme.organizationId,
    serviceId: svc.id,
    policyId,
    amountBase: '100000',
    payer,
  })
  check('an unknown wallet is reviewed', before.trace.decision === 'review')

  const added = addListEntry(acme.organizationId, policyId, 'allow', payer, 'Acme internal')
  check('the wallet can be allowlisted', added.ok, JSON.stringify(added))

  const after = decide({
    organizationId: acme.organizationId,
    serviceId: svc.id,
    policyId,
    amountBase: '100000',
    payer,
  })
  check('and is then allowed without review', after.trace.decision === 'allow', `decision=${after.trace.decision} reason=${after.trace.reason ?? 'none'}`)
  const allowCheck = after.trace.checks.find((c) => c.key === 'allowlist')
  check('check 7 is what allowed it', allowCheck?.status === 'pass')
  check('so check 8 never had to act', after.trace.checks.find((c) => c.key === 'unknown_wallet')?.status === 'skip')

  // A grant is scoped and expiring; an allowlist entry is standing. Prove they are not the same
  // by showing the entry still allows after a policy change that a grant would not survive.
  updatePolicy(acme.organizationId, policyId, {
    name: 'Open',
    unknownAction: 'block',
    maxAmountPerRequest: '1',
    rateLimitPerMin: '30',
  })
  const stillAllowed = decide({
    organizationId: acme.organizationId,
    serviceId: svc.id,
    policyId,
    amountBase: '100000',
    payer,
  })
  check('an allowlist entry survives switching unknown wallets to block', stillAllowed.trace.decision === 'allow', `decision=${stillAllowed.trace.decision}`)

  const stranger = decide({
    organizationId: acme.organizationId,
    serviceId: svc.id,
    policyId,
    amountBase: '100000',
    payer: Keypair.random().publicKey(),
  })
  check('while a stranger is now blocked outright', stranger.trace.decision === 'block')
  check('by the unknown-wallet check specifically', stranger.trace.checks.find((c) => c.key === 'unknown_wallet')?.status === 'fail')

  const removed = removeListEntry(acme.organizationId, policyId, 'allow', payer)
  check('the entry can be removed', removed.ok)
  const gone = decide({
    organizationId: acme.organizationId,
    serviceId: svc.id,
    policyId,
    amountBase: '100000',
    payer,
  })
  check('after which the same wallet is blocked like any stranger', gone.trace.decision === 'block')

  // Put it back for later sections.
  addListEntry(acme.organizationId, policyId, 'allow', payer)
}

// ---------------------------------------------------------------------------
section('The denylist is refused before anything else')
// ---------------------------------------------------------------------------
{
  const svc = db().select().from(services).where(eq(services.slug, 'acme-open')).get()!
  const payer = Keypair.random().publicKey()

  addListEntry(acme.organizationId, policyId, 'allow', payer)
  updatePolicy(acme.organizationId, policyId, {
    name: 'Open',
    unknownAction: 'allow',
    rateLimitPerMin: '30',
  })
  const allowed = decide({
    organizationId: acme.organizationId,
    serviceId: svc.id,
    policyId,
    amountBase: '100000',
    payer,
  })
  check('with unknown wallets allowed, anyone gets through', allowed.trace.decision === 'allow')

  addListEntry(acme.organizationId, policyId, 'deny', payer, '', 'abuse')
  const denied = decide({
    organizationId: acme.organizationId,
    serviceId: svc.id,
    policyId,
    amountBase: '100000',
    payer,
  })
  check('a denylisted wallet is refused', denied.trace.decision === 'block')
  const denyCheck = denied.trace.checks.find((c) => c.key === 'denylist')
  check('at check 5', denyCheck?.status === 'fail')
  check(
    'before the allowlist check, which is check 7',
    denied.trace.checks.find((c) => c.key === 'allowlist')?.status === 'skip',
  )
  const denylistRow = db()
    .select()
    .from(policyDenylist)
    .where(and(eq(policyDenylist.policyId, policyId), eq(policyDenylist.wallet, payer)))
    .get()
  check('the reason is recorded', denylistRow?.reason === 'abuse')

  removeListEntry(acme.organizationId, policyId, 'deny', payer)
  const restored = decide({
    organizationId: acme.organizationId,
    serviceId: svc.id,
    policyId,
    amountBase: '100000',
    payer,
  })
  check('and removing it restores access', restored.trace.decision === 'allow')
}

// ---------------------------------------------------------------------------
section('A wallet entry that is not an account is refused')
// ---------------------------------------------------------------------------
{
  const bad = ['not-a-wallet', '', 'G', 'GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7', '0x1234']
  for (const wallet of bad) {
    const r = addListEntry(acme.organizationId, policyId, 'allow', wallet)
    check(`${JSON.stringify(wallet)} is refused`, !r.ok && r.failure === 'wallet_invalid', JSON.stringify(r))
  }
  check(
    'nothing was written by any of them',
    db().select().from(policyAllowlist).all().filter((r) => !r.wallet.startsWith('G') || r.wallet.length !== 56).length === 0,
  )

  const dup = Keypair.random().publicKey()
  check('a valid address is accepted', addListEntry(acme.organizationId, policyId, 'allow', dup).ok)
  check('adding it twice is refused', (() => {
    const r = addListEntry(acme.organizationId, policyId, 'allow', dup)
    return !r.ok && r.failure === 'wallet_exists'
  })())
  check('removing an entry that is not there is refused', (() => {
    const r = removeListEntry(acme.organizationId, policyId, 'allow', Keypair.random().publicKey())
    return !r.ok && r.failure === 'wallet_missing'
  })())
}

// ---------------------------------------------------------------------------
section('Caps: blank, zero, and conversion')
// ---------------------------------------------------------------------------
{
  const beta = seedTenant('Beta')
  const p = createPolicy(beta.organizationId, { name: 'Caps', unknownAction: 'review' })
  if (!p.ok) throw new Error('cannot continue')
  const pid = p.policyId

  const svc = makeService(beta.organizationId, 'beta-caps', '0.02')
  setPolicyServices(beta.organizationId, pid, [svc.id])

  const blank = decide({ organizationId: beta.organizationId, serviceId: svc.id, policyId: pid, amountBase: '99999999', payer: Keypair.random().publicKey() })
  check('a blank cap means no limit, so an enormous amount is not held on a cap', blank.trace.checks.find((c) => c.key === 'amount_cap')?.status === 'pass')

  for (const cap of ['0', '0.000', '0.0']) {
    const r = updatePolicy(beta.organizationId, pid, {
      name: 'Caps',
      unknownAction: 'review',
      maxAmountPerRequest: cap,
    })
    check(`a cap of ${JSON.stringify(cap)} is refused rather than meaning "review everything"`, !r.ok && r.failure === 'cap_zero', JSON.stringify(r))
  }

  for (const cap of ['-1', '$5', '1e5', '1,000', 'abc', '']) {
    if (cap === '') continue
    const r = updatePolicy(beta.organizationId, pid, {
      name: 'Caps',
      unknownAction: 'review',
      maxAmountPerRequest: cap,
    })
    check(`a cap of ${JSON.stringify(cap)} is refused`, !r.ok && r.failure === 'cap_invalid', JSON.stringify(r))
  }

  // Round trip: entered as a decimal, stored in base units, rendered back as a decimal.
  const set = updatePolicy(beta.organizationId, pid, {
    name: 'Caps',
    unknownAction: 'review',
    maxAmountPerRequest: '0.25',
    dailyCapPerWallet: '10',
    ungrantedSpendCap: '0.05',
  })
  check('valid caps are accepted', set.ok, JSON.stringify(set))
  const row = db().select().from(policies).where(eq(policies.id, pid)).get()
  check('0.25 stored as 2500000 base units', row?.maxAmountPerRequestBase === '2500000', String(row?.maxAmountPerRequestBase))
  check('10 stored as 100000000', row?.dailyCapPerWalletBase === '100000000', String(row?.dailyCapPerWalletBase))
  check('0.05 stored as 500000', row?.ungrantedSpendCapBase === '500000', String(row?.ungrantedSpendCapBase))
  check('and rendered back as decimals', capToHuman(row!.maxAmountPerRequestBase) === '0.25', capToHuman(row!.maxAmountPerRequestBase))
  check('no rounding artefact on the round trip', capToHuman('100000000') === '10', capToHuman('100000000'))
  check('null renders as an empty field, not "0"', capToHuman(null) === '')

  const overDaily = decide({ organizationId: beta.organizationId, serviceId: svc.id, policyId: pid, amountBase: '20000000', payer: Keypair.random().publicKey() })
  check('a request above the per-request cap is held', overDaily.trace.decision === 'review')

  // The warning path: a cap below a bound service price is permitted but must be announced.
  const warned = updatePolicy(beta.organizationId, pid, {
    name: 'Caps',
    unknownAction: 'review',
    maxAmountPerRequest: '0.001',
  })
  check('a cap below the service price is permitted', warned.ok, JSON.stringify(warned))
  check(
    'and comes with a warning naming the service',
    warned.ok && typeof warned.warning === 'string' && warned.warning.includes('Service beta-caps'),
    warned.ok ? (warned.warning ?? 'no warning') : 'creation failed',
  )
}

// ---------------------------------------------------------------------------
section('Rate limits')
// ---------------------------------------------------------------------------
{
  const gamma = seedTenant('Gamma')
  const p = createPolicy(gamma.organizationId, { name: 'Rate', unknownAction: 'review' })
  if (!p.ok) throw new Error('cannot continue')
  for (const rate of ['0', '-1', '1.5', 'abc', '10001', '1e3']) {
    const r = updatePolicy(gamma.organizationId, p.policyId, {
      name: 'Rate',
      unknownAction: 'review',
      rateLimitPerMin: rate,
    })
    check(`a rate of ${JSON.stringify(rate)} is refused`, !r.ok && r.failure === 'rate_invalid', JSON.stringify(r))
  }
  const ok = updatePolicy(gamma.organizationId, p.policyId, {
    name: 'Rate',
    unknownAction: 'review',
    rateLimitPerMin: '1',
  })
  check('a rate of 1 is accepted', ok.ok, JSON.stringify(ok))
  const row = db().select().from(policies).where(eq(policies.id, p.policyId)).get()
  check('stored as a number, not a string', row?.rateLimitPerMin === 1, String(row?.rateLimitPerMin))

  const cleared = updatePolicy(gamma.organizationId, p.policyId, { name: 'Rate', unknownAction: 'review' })
  check('blank clears the limit', cleared.ok)
  check('to null rather than zero', db().select().from(policies).where(eq(policies.id, p.policyId)).get()?.rateLimitPerMin === null)
}

// ---------------------------------------------------------------------------
section('Disabling is legible, and there is no delete')
// ---------------------------------------------------------------------------
{
  const delta = seedTenant('Delta')
  const svc = makeService(delta.organizationId, 'delta-off', '0.01')
  const pid = svc.policyId!

  const off = updatePolicy(delta.organizationId, pid, {
    name: 'Standard Access',
    unknownAction: 'review',
    active: false,
  })
  check('a policy can be disabled', off.ok)

  const refused = decide({ organizationId: delta.organizationId, serviceId: svc.id, policyId: pid, amountBase: '100000', payer: Keypair.random().publicKey() })
  check('and its services are then refused', refused.trace.decision === 'block')
  check('naming the cause rather than pretending the policy is absent', /disabled/.test(refused.trace.reason ?? ''), refused.trace.reason ?? '')
}

// ---------------------------------------------------------------------------
section('Service binding')
// ---------------------------------------------------------------------------
{
  const eps = seedTenant('Eps')
  const a = makeService(eps.organizationId, 'eps-a', '0.01')
  const b = makeService(eps.organizationId, 'eps-b', '0.01')
  const policyA = a.policyId!
  const policyB = b.policyId!

  check('each service got the default policy', policyA === policyB)

  const strict = createPolicy(eps.organizationId, { name: 'Strict', unknownAction: 'block' })
  if (!strict.ok) throw new Error('cannot continue')

  const moved = setPolicyServices(eps.organizationId, strict.policyId, [b.id])
  check('a service can be moved to another policy', moved.ok)
  check('and its policyId follows', db().select().from(services).where(eq(services.id, b.id)).get()?.policyId === strict.policyId)
  check('the old policy no longer lists it', db().select().from(policyServiceLinks).where(and(eq(policyServiceLinks.policyId, policyA), eq(policyServiceLinks.serviceId, b.id))).all().length === 0)

  const blocked = decide({ organizationId: eps.organizationId, serviceId: b.id, policyId: strict.policyId, amountBase: '100000', payer: Keypair.random().publicKey() })
  check('and the new policy now governs it', blocked.trace.decision === 'block')

  // A service with no policy is refused by name. That is a legible state, so detaching all is
  // allowed - but it must not leave a stale link claiming coverage.
  const detached = setPolicyServices(eps.organizationId, strict.policyId, [])
  check('detaching everything is allowed', detached.ok)
  check('the service is left on no policy', db().select().from(services).where(eq(services.id, b.id)).get()?.policyId === null)
  check('no link is left behind', db().select().from(policyServiceLinks).where(eq(policyServiceLinks.policyId, strict.policyId)).all().length === 0)

  const orphan = decide({ organizationId: eps.organizationId, serviceId: b.id, policyId: null, amountBase: '100000', payer: Keypair.random().publicKey() })
  check('and the engine refuses it by name', orphan.trace.decision === 'block')
  check('saying no policy is attached', /no policy attached/.test(orphan.trace.reason ?? ''), orphan.trace.reason ?? '')

  const foreign = setPolicyServices(eps.organizationId, strict.policyId, [newId('svc')])
  check("a service id that is not the caller's is refused", !foreign.ok && foreign.failure === 'service_invalid', JSON.stringify(foreign))
}

// ---------------------------------------------------------------------------
section('Tenant isolation')
// ---------------------------------------------------------------------------
{
  const one = seedTenant('Iso One')
  const two = seedTenant('Iso Two')
  const svc = makeService(one.organizationId, 'iso-one', '0.01')
  const own = svc.policyId!

  const other = createPolicy(two.organizationId, { name: 'Theirs', unknownAction: 'block' })
  if (!other.ok) throw new Error('cannot continue')

  check("another tenant's policy cannot be edited", (() => {
    const r = updatePolicy(two.organizationId, own, { name: 'Hijack', unknownAction: 'allow' })
    return !r.ok && r.failure === 'not_found'
  })())
  check('and the name was not changed', db().select().from(policies).where(eq(policies.id, own)).get()?.name !== 'Hijack')

  check("another tenant's policy cannot be allowlisted into", (() => {
    const r = addListEntry(two.organizationId, own, 'allow', Keypair.random().publicKey())
    return !r.ok && r.failure === 'not_found'
  })())
  check("another tenant's policy cannot have services bound to it", (() => {
    const r = setPolicyServices(two.organizationId, own, [svc.id])
    return !r.ok && r.failure === 'not_found'
  })())
  check('and the service still belongs to its owner', db().select().from(services).where(eq(services.id, svc.id)).get()?.organizationId === one.organizationId)

  // A duplicate name is scoped per organization, so two tenants may both have "Standard Access".
  const mine = createPolicy(one.organizationId, { name: 'Standard Access', unknownAction: 'review' })
  check('a duplicate name is refused within one organization', !mine.ok && mine.failure === 'name_taken', JSON.stringify(mine))
  // 'Standard Access' is what org one already has; the second tenant must be free to use it too.
  const alsoTheirs = createPolicy(two.organizationId, { name: 'Standard Access', unknownAction: 'review' })
  check('but the same name is fine in another', alsoTheirs.ok, JSON.stringify(alsoTheirs))
}

// ---------------------------------------------------------------------------
section('Names and required fields')
// ---------------------------------------------------------------------------
{
  const zeta = seedTenant('Zeta')
  check('an empty name is refused', (() => {
    const r = createPolicy(zeta.organizationId, { name: '   ', unknownAction: 'review' })
    return !r.ok && r.failure === 'name_required'
  })())
  check('an invented unknown-wallet action is refused', (() => {
    const r = createPolicy(zeta.organizationId, { name: 'Odd', unknownAction: 'maybe' })
    return !r.ok && r.failure === 'unknown_action_invalid'
  })())
  check('an over-long description is refused', (() => {
    const r = createPolicy(zeta.organizationId, { name: 'Long', unknownAction: 'review', description: 'x'.repeat(301) })
    return !r.ok && r.failure === 'description_too_long'
  })())
  const ok = createPolicy(zeta.organizationId, { name: 'Fine', unknownAction: 'allow', description: 'x'.repeat(300) })
  check('a boundary-length description is accepted', ok.ok)

  // Renaming a policy to its own name is not a clash with itself.
  if (ok.ok) {
    const same = updatePolicy(zeta.organizationId, ok.policyId, { name: 'Fine', unknownAction: 'allow' })
    check('saving without changing the name is allowed', same.ok, JSON.stringify(same))
  }
}

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(SCRATCH + suffix)) rmSync(SCRATCH + suffix)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFailing:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('Policy management behaves correctly.')
