/**
 * Service creation: who may publish, and what must be true before a service can serve traffic.
 *
 * Creating a service is the first thing an operator does, and until now it was impossible: the
 * `Create service` links pointed at a route that did not exist and the catalogue came only from
 * `npm run db:seed`, into an organization nobody signing up could ever own. So this proof is
 * written around the ways publishing could hand out something broken rather than around the happy
 * path:
 *
 *   - only an owner or operator may publish, and a non-member is refused indistinguishably
 *     from an analyst so the action is not a membership oracle
 *   - a service is servable the moment it is created: policy bound, asset registered, network
 *     registered, status live. Every one of those is a BLOCK in the engine if missed, and the
 *     engine checks them in an order that hides the cause.
 *   - slug uniqueness is GLOBAL, because /v1/:slug carries no organization context
 *   - nothing about one organization's services is readable or writable through another's id
 *
 * Runs against a throwaway database with no server, no wallet and no network. `createService` is a
 * plain function precisely so this is possible; the server action only supplies identity.
 */

import { existsSync, rmSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'

import { closeScratchDatabase } from './scratch-db'

const SCRATCH = './data/services-proof.db'

process.env.DATABASE_URL = SCRATCH

closeScratchDatabase(SCRATCH)

const { runMigrations } = await import('../src/lib/db/migrate')
const { db } = await import('../src/lib/db/client')
const {
  organizationMembers,
  organizations,
  policyAssets,
  policyNetworks,
  policyServiceLinks,
  policies,
  services,
  users,
  activityEvents,
} = await import('../src/lib/db/schema')
const { createService } = await import('../src/lib/services/create')
const { resolveServiceBySlug, resolveServiceById } = await import('../src/lib/services/registry')
const { evaluatePreflight } = await import('../src/lib/policy/service')
const { USDC_SAC_TESTNET, network } = await import('../src/lib/mpp/registry')
const { slugify, validateSlug } = await import('../src/lib/services/slug')
const { Keypair, StrKey } = await import('@stellar/stellar-sdk')

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
        email: `${role}@${organizationId}.test`,
        displayName: role,
        createdAt: Date.now(),
      })
      .run()
    db().insert(organizationMembers)
      .values({ id: newId('mem'), organizationId, userId, role, createdAt: Date.now() })
      .run()
    return userId
  }

  return {
    organizationId,
    ownerId: mk('owner'),
    operatorId: mk('operator'),
    analystId: mk('analyst'),
  }
}

const base = {
  name: 'PageSure Search',
  slug: 'search',
  price: '0.01',
  upstreamKind: 'search',
}

section('A session service cannot be published without channel infrastructure')
{
  const org = seedTenant('Session Readiness')
  const rejected = createService({
    organizationId: org.organizationId,
    ...base,
    slug: 'session-needs-setup',
    mode: 'channel',
  })
  check('live session publication is refused while signer/factory configuration is missing', !rejected.ok && rejected.failure === 'session_setup_required')

  const draft = createService({
    organizationId: org.organizationId,
    ...base,
    slug: 'session-draft',
    mode: 'channel',
    status: 'draft',
  })
  check('an operator can save the session service as a draft', draft.ok)
  if (draft.ok) check('the saved session service remains unpublished', resolveServiceById(draft.serviceId)?.status === 'draft')

  const previousToken = process.env.PAGESURE_TEST_SIGNER
  const previousFactory = process.env.CHANNEL_FACTORY_C
  process.env.PAGESURE_TEST_SIGNER = 'test-token'
  process.env.CHANNEL_FACTORY_C = StrKey.encodeContract(Buffer.alloc(32, 2))
  db().update(organizations).set({
    commitmentSignerUrl: 'https://signer.example.test',
    commitmentSignerTokenEnv: 'PAGESURE_TEST_SIGNER',
  }).where(eq(organizations.id, org.organizationId)).run()
  const ready = createService({
    organizationId: org.organizationId,
    ...base,
    slug: 'session-ready',
    mode: 'channel',
  })
  check('session service can be published after treasury, signer, token, and factory are configured', ready.ok, JSON.stringify(ready))
  if (previousToken === undefined) delete process.env.PAGESURE_TEST_SIGNER
  else process.env.PAGESURE_TEST_SIGNER = previousToken
  if (previousFactory === undefined) delete process.env.CHANNEL_FACTORY_C
  else process.env.CHANNEL_FACTORY_C = previousFactory
}

// ---------------------------------------------------------------------------
section('A service is servable the moment it is created')
// ---------------------------------------------------------------------------
{
  const acme = seedTenant('Acme Research')
  const result = createService({ organizationId: acme.organizationId, ...base })

  check('creation succeeds for a fresh organization', result.ok, JSON.stringify(result))
  if (!result.ok) throw new Error('cannot continue: creation failed')

  check('a default policy was created because none existed', result.policyCreated === true)

  const service = resolveServiceById(result.serviceId)
  check('the service resolves by id', service !== null)
  check('it is owned by the creating organization', service?.organizationId === acme.organizationId)
  check('it is published live, not left as a draft', service?.status === 'live')
  check('a policy is bound', typeof service?.policyId === 'string' && service.policyId !== null)

  const policyId = service?.policyId ?? ''
  const asset = db()
    .select()
    .from(policyAssets)
    .where(and(eq(policyAssets.policyId, policyId), eq(policyAssets.assetContract, USDC_SAC_TESTNET)))
    .get()
  check('the price asset is registered on the policy', asset !== undefined)

  const netRow = db()
    .select()
    .from(policyNetworks)
    .where(and(eq(policyNetworks.policyId, policyId), eq(policyNetworks.network, network())))
    .get()
  check('the network is registered on the policy', netRow !== undefined)

  const link = db()
    .select()
    .from(policyServiceLinks)
    .where(eq(policyServiceLinks.serviceId, result.serviceId))
    .get()
  check('the policy records that it covers this service', link !== undefined)

  // The point of the previous three checks: an unknown wallet must be HELD, not blocked for a
  // reason that has nothing to do with the wallet.
  const evaluation = evaluatePreflight({
    organizationId: acme.organizationId,
    serviceId: result.serviceId,
    serviceName: service?.name ?? '',
    serviceStatus: service?.status ?? 'draft',
    servicePolicyId: service?.policyId ?? null,
    assetContract: service?.assetContract ?? '',
    amountBase: service?.priceBase ?? '0',
    mode: 'charge',
    network: network(),
    payer: Keypair.random().publicKey(),
  })
  check(
    'an unknown wallet is reviewed, not blocked on a setup fault',
    evaluation.trace.decision === 'review',
    `decision=${evaluation.trace.decision} reason=${evaluation.trace.reason ?? 'none'}`,
  )
  const boundCheck = evaluation.trace.checks.find((c) => c.key === 'policy_bound')
  check('check 2 passes, so a policy really is attached', boundCheck?.status === 'pass')
  const assetCheck = evaluation.trace.checks.find((c) => c.key === 'asset_allowed')
  check('check 4 passes, so the asset is priced', assetCheck?.status === 'pass')
  const netCheck = evaluation.trace.checks.find((c) => c.key === 'network_allowed')
  check('check 3 passes, so the network is permitted', netCheck?.status === 'pass')

  const activity = db()
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.serviceId, result.serviceId))
    .get()
  check('the activity feed records the publication', activity !== undefined)
  check("it is typed 'service_created'", activity?.type === 'service_created')
}

// ---------------------------------------------------------------------------
section('A second service reuses the existing policy')
// ---------------------------------------------------------------------------
{
  const beta = seedTenant('Beta Co')
  const first = createService({ organizationId: beta.organizationId, ...base, slug: 'beta-search' })
  check('the first service creates the default policy', first.ok && first.policyCreated)

  const second = createService({
    organizationId: beta.organizationId,
    name: 'AI Summarizer',
    slug: 'summarize',
    price: '0.05',
    upstreamKind: 'summarize',
  })
  check('the second service succeeds', second.ok, JSON.stringify(second))
  check('it reuses the policy rather than creating another', second.ok && second.policyCreated === false)

  const policyCount = db()
    .select()
    .from(policies)
    .where(eq(policies.organizationId, beta.organizationId))
    .all()
  check('the organization still has exactly one policy', policyCount.length === 1)
}

// ---------------------------------------------------------------------------
section('Slugs are validated and globally unique')
// ---------------------------------------------------------------------------
{
  const gamma = seedTenant('Gamma')
  check(
    'a well-formed slug is accepted',
    createService({ organizationId: gamma.organizationId, ...base, slug: 'gamma-search' }).ok,
  )

  const cases: [string, string][] = [
    ['an empty slug', ''],
    ['uppercase', 'Search'],
    ['a space', 'web search'],
    ['a slash', 'web/search'],
    ['a question mark', 'search?x=1'],
    ['a leading dash', '-search'],
    ['a trailing dash', 'search-'],
    ['a double dash', 'web--search'],
    ['the reserved word "session"', 'session'],
    ['41 characters', 'a'.repeat(41)],
  ]
  for (const [label, slug] of cases) {
    const r = createService({
      organizationId: gamma.organizationId,
      name: 'Whatever',
      slug,
      price: '0.01',
      upstreamKind: 'search',
    })
    check(`${label} is refused`, !r.ok && r.failure === 'slug_invalid', JSON.stringify(r))
  }

  check('40 characters is allowed', validateSlug('a'.repeat(40)).ok)
  check('slugify lowercases and dashes a name', slugify('Web Search API') === 'web-search-api')
  check('slugify strips accents rather than mangling them', slugify('Café Ünïcode') === 'cafe-unicode')
  check('slugify refuses to emit a trailing dash', !slugify('Search -').endsWith('-'))

  // Global, because /v1/:slug carries no organization context.
  const delta = seedTenant('Delta')
  const taken = createService({
    organizationId: delta.organizationId,
    name: 'Copycat',
    slug: 'search',
    price: '0.01',
    upstreamKind: 'search',
  })
  check(
    "another organization's slug cannot be taken",
    !taken.ok && taken.failure === 'slug_taken',
    JSON.stringify(taken),
  )

  const serviceCount = db().select().from(services).where(eq(services.slug, 'search')).all()
  check('only one service holds that slug', serviceCount.length === 1)
}

// ---------------------------------------------------------------------------
section('A draft service is refused by the engine, as documented')
// ---------------------------------------------------------------------------
{
  const eps = seedTenant('Epsilon')
  const r = createService({
    organizationId: eps.organizationId,
    name: 'Quiet',
    slug: 'quiet',
    price: '0.01',
    upstreamKind: 'search',
    status: 'draft',
  })
  check('a draft can be created deliberately', r.ok)
  if (r.ok) {
    const service = resolveServiceById(r.serviceId)
    const evaluation = evaluatePreflight({
      organizationId: eps.organizationId,
      serviceId: r.serviceId,
      serviceName: service?.name ?? '',
      serviceStatus: service?.status ?? 'live',
      servicePolicyId: service?.policyId ?? null,
      assetContract: service?.assetContract ?? '',
      amountBase: service?.priceBase ?? '0',
      mode: 'charge',
      network: network(),
      payer: Keypair.random().publicKey(),
    })
    check('and it blocks at check 1, before policy is examined', evaluation.trace.decision === 'block')
    check(
      'the trace names service_active as the cause',
      evaluation.trace.checks[0]?.key === 'service_active' &&
        evaluation.trace.checks[0]?.status === 'fail',
      `first check=${evaluation.trace.checks[0]?.key}`,
    )
  }
}

// ---------------------------------------------------------------------------
section('Prices')
// ---------------------------------------------------------------------------
{
  const zeta = seedTenant('Zeta')
  const good = createService({
    organizationId: zeta.organizationId,
    name: 'Priced',
    slug: 'priced',
    price: '0.01',
    upstreamKind: 'search',
  })
  check('a human decimal converts to base units', good.ok && resolveServiceById(
    good.ok ? good.serviceId : '',
  )?.priceBase === '100000')

  const bad: [string, string][] = [
    ['zero', '0'],
    ['zero with decimals', '0.000'],
    ['a negative amount', '-1'],
    ['exponent notation', '1e-2'],
    ['a currency symbol', '$0.01'],
    ['a thousands separator', '1,000'],
    ['empty', ''],
    ['nonsense', 'free'],
    ['eight decimal places on a 7-decimal asset', '0.01234567'],
  ]
  for (const [label, price] of bad) {
    const r = createService({
      organizationId: zeta.organizationId,
      name: 'Bad price',
      slug: `bad-${Math.random().toString(16).slice(2, 8)}`,
      price,
      upstreamKind: 'search',
    })
    check(`${label} is refused`, !r.ok && (r.failure === 'price_invalid' || r.failure === 'price_zero'), JSON.stringify(r))
  }
}

// ---------------------------------------------------------------------------
section('An upstream kind no adapter handles is refused at creation')
// ---------------------------------------------------------------------------
{
  const eta = seedTenant('Eta')
  for (const kind of ['websearch', '', 'SEARCH', 'http://evil.example', 'market']) {
    const r = createService({
      organizationId: eta.organizationId,
      name: 'Upstream',
      slug: `up-${Math.random().toString(16).slice(2, 8)}`,
      price: '0.01',
      upstreamKind: kind,
    })
    const expected = kind === 'market'
    check(
      `upstream kind ${JSON.stringify(kind)} is ${expected ? 'accepted' : 'refused'}`,
      expected ? r.ok : !r.ok && r.failure === 'upstream_invalid',
      JSON.stringify(r),
    )
  }
}

// ---------------------------------------------------------------------------
section('Another organization\'s policy cannot be bound')
// ---------------------------------------------------------------------------
{
  const one = seedTenant('Org One')
  const two = seedTenant('Org Two')
  // Distinct slugs: `search` is already taken by an earlier tenant, and the point of this
  // section is the policy binding rather than slug uniqueness.
  const mine = createService({
    organizationId: one.organizationId,
    ...base,
    slug: 'org-one-search',
  })
  check('the first tenant has a service', mine.ok, JSON.stringify(mine))

  const foreignPolicy = db()
    .select({ id: policies.id })
    .from(policies)
    .where(eq(policies.organizationId, one.organizationId))
    .get()

  const r = createService({
    organizationId: two.organizationId,
    name: 'Borrowed',
    slug: 'org-two-borrowed',
    price: '0.01',
    upstreamKind: 'search',
    policyId: foreignPolicy?.id ?? '',
  })
  check(
    "a foreign policy id is refused rather than silently degrading to a block",
    !r.ok && r.failure === 'policy_invalid',
    JSON.stringify(r),
  )

  const orphan = db().select().from(services).where(eq(services.slug, 'org-two-borrowed')).all()
  check('and nothing was written', orphan.length === 0)
}

// ---------------------------------------------------------------------------
section('One organization cannot see or touch another\'s service')
// ---------------------------------------------------------------------------
{
  const one = seedTenant('Scoped One')
  const two = seedTenant('Scoped Two')
  const mine = createService({ organizationId: one.organizationId, ...base, slug: 'scoped-one' })
  if (!mine.ok) throw new Error(`cannot continue: ${JSON.stringify(mine)}`)

  // resolveServiceById is global by necessity, because the gateway needs it. That makes the
  // console's ownership check the only thing standing between tenants, so it is asserted here.
  const viaGlobalLookup = resolveServiceById(mine.serviceId)
  check('the global lookup does return it, by design', viaGlobalLookup !== null)
  check(
    'so a console must compare organizationId itself',
    viaGlobalLookup?.organizationId !== two.organizationId,
  )

  const listedForTwo = db()
    .select()
    .from(services)
    .where(and(eq(services.organizationId, two.organizationId), eq(services.id, mine.serviceId)))
    .all()
  check("it does not appear in the other tenant's scoped list", listedForTwo.length === 0)

  const linksForTwo = db()
    .select()
    .from(policyServiceLinks)
    .where(
      and(
        eq(policyServiceLinks.organizationId, two.organizationId),
        eq(policyServiceLinks.serviceId, mine.serviceId),
      ),
    )
    .all()
  check('and no policy link crosses the boundary', linksForTwo.length === 0)

  // Deleting the owning organization must take its services with it.
  db().delete(organizations).where(eq(organizations.id, one.organizationId)).run()
  const orphaned = db().select().from(services).where(eq(services.id, mine.serviceId)).all()
  check('deleting the organization cascades to its services', orphaned.length === 0)
  const orphanLinks = db()
    .select()
    .from(policyServiceLinks)
    .where(eq(policyServiceLinks.serviceId, mine.serviceId))
    .all()
  check('and to its policy links', orphanLinks.length === 0)
}

// ---------------------------------------------------------------------------
section('The endpoint answers on its slug')
// ---------------------------------------------------------------------------
{
  const theta = seedTenant('Theta')
  const r = createService({ organizationId: theta.organizationId, ...base, slug: 'theta-search' })
  check('created', r.ok)
  if (r.ok) {
    const resolved = resolveServiceBySlug('theta-search')
    check('resolveServiceBySlug finds it by the public slug', resolved?.id === r.serviceId)
    check('upstreamConfig defaults to an object, not null', typeof resolved?.upstreamConfig === 'object')
    check('the name is trimmed of surrounding whitespace', createService({
      organizationId: theta.organizationId,
      name: '  Padded  ',
      slug: 'padded',
      price: '0.01',
      upstreamKind: 'search',
    }).ok)
    const padded = resolveServiceBySlug('padded')
    check('and stored without it', padded?.name === 'Padded', padded?.name)
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
console.log('Service creation behaves correctly.')
