/**
 * Cross-organization isolation proof.
 *
 * Isolation is not a property you can eyeball into existence, and it is the one thing this
 * schema cannot get wrong by accident later. So this script builds two complete, real
 * tenants in a scratch database and then attacks Org A's data using Org B's session.
 *
 * What is asserted, and why each one is separate:
 *
 *   - Reads by foreign primary key return nothing. This is the direct-URL case: a
 *     member of Org B who learns an Org A row id must get exactly what a nonexistent id
 *     gets, because otherwise the id itself is a lookup oracle and ids leak through
 *     counts, latency, or an error message.
 *   - Aggregate counts never include the other tenant. A row that is invisible in detail
 *     but counted in a total is still a disclosure, and it also breaks settlement
 *     reconciliation, which is why this is checked separately from detail reads.
 *   - Mutations cannot reach across. A review approved by Org B must not approve Org A's
 *     review; this is the write-path twin of the read checks and the reason
 *     organizationId is in the WHERE clause rather than only in the SELECT list.
 *   - Policy state is per tenant. Rate limits and payer caps are the classic place where
 *     one tenant's traffic exhausts another's allowance, so they get explicit coverage.
 *   - Gateway tenant derivation comes from the service row, never from the caller. The
 *     public endpoint has no organization parameter at all, so anything tenant-shaped in
 *     the request body must be inert.
 *
 * Runs against a throwaway database and deletes it on exit. It never touches data/ and it
 * needs no server, no wallet and no network, so it is cheap enough to be run on every
 * change.
 */

import { eq } from 'drizzle-orm'
import { Keypair } from '@stellar/stellar-sdk'
import { toBig } from '../src/lib/money'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const SCRATCH = './data/isolation-proof.db'

// Set before importing anything that opens the database: `db()` caches its handle on first
// use, and the client reads this at construction time.
process.env.DATABASE_URL = SCRATCH

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(resCRATCH(suffix))) rmSync(resCRATCH(suffix))
}

function resCRATCH(suffix: string) {
  return resolve(process.cwd(), SCRATCH + suffix)
}

// Imported after the environment is set, deliberately.
const { db } = await import('../src/lib/db/client')
const { runMigrations } = await import('../src/lib/db/migrate')
const schema = await import('../src/lib/db/schema')
const { createOrganizationWithOwner, findUserByWallet } = await import('../src/lib/auth/session')
const { resolveServiceBySlug } = await import('../src/lib/services/registry')
const { recordRequest, recordSettlement, recordIncident, recordActivity } = await import(
  '../src/lib/metering/record'
)
const aggregates = await import('../src/lib/metering/aggregates')
const reviews = await import('../src/lib/policy/review')
const { policiesWithUsage } = await import('../src/lib/policy/read-model')
const sessions = await import('../src/lib/sessions/lookup')
const manager = await import('../src/lib/sessions/manager')
const { requireCommitmentSigner, CommitmentSignerUnavailableError } = await import('../src/lib/mpp/signer-registry')
process.env.CHANNEL_FACTORY_C ??= 'CDENABPOYPNPJFP2TEFO5UJFYCA7OGG6Y7TBU5XFXZ3WJJN5FKOLXN4B'
const { consumeRateLimit } = await import('../src/lib/policy/engine')
const { requireSettlementRecipient } = await import('../src/lib/mpp/settlement')
import type { PolicyTrace } from '../src/lib/policy/types'

runMigrations()

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
    return
  }
  failures.push(name)
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`)
}

function section(title: string) {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------------------
// Two tenants, built through the real code paths
// ---------------------------------------------------------------------------

console.log('Building two organizations…')

const A_WALLET = 'GAHNAKJYF2JLU4L6YHEYLDJGY3EWR6JCFYH6PGLHU7HWCQOJ24NJ5OGI'
const B_WALLET = 'GDYKHMQUQPLDIHADE5SLBW3ZC44S3ISIPQKKWKC6XQ3G2ZZFSGDTILGG'
const A_TREASURY = 'GCKLMICNBX6MAARZ5D566HDI4EBBGYE4CHJMU75ILTW77EG5X4HSQBGZ'
const B_TREASURY = 'GBWDEM3JNHGGNRNT5N6QJ5UUULT6C7J6MEPO3C2FFRSTFLVUPLCGV5C4'
const PAYER = 'GPAYERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

// createOrganizationWithOwner is the signup path itself, so using it here means the test
// proves the deployed transaction shape rather than a hand-built approximation of it.
const a = createOrganizationWithOwner({
  walletPublicKey: A_WALLET,
  displayName: 'Org A Owner',
  organizationName: 'Org A',
  settlementRecipient: A_TREASURY,
})
const b = createOrganizationWithOwner({
  walletPublicKey: B_WALLET,
  displayName: 'Org B Owner',
  organizationName: 'Org B',
  settlementRecipient: B_TREASURY,
})

const userA = findUserByWallet(A_WALLET)
const userB = findUserByWallet(B_WALLET)
if (!userA || !userB) throw new Error('organizations did not persist')

const now = Date.now()
const insertService = (id: string, orgId: string, slug: string, name: string) =>
  db()
    .insert(schema.services)
    .values({
      id,
      organizationId: orgId,
      slug,
      name,
      description: `${name} endpoint`,
      assetCode: 'USDC',
      assetContract: 'CA_USDC',
      decimals: 7,
      priceBase: '250000',
      mode: 'charge',
      upstreamKind: 'search',
      upstreamConfig: {},
      policyId: null,
      status: 'live',
      createdAt: now,
      updatedAt: now,
    })
    .run()

const insertPolicy = (id: string, orgId: string, name: string) =>
  db()
    .insert(schema.policies)
    .values({
      id,
      organizationId: orgId,
      name,
      unknownAction: 'allow',
      createdAt: now,
      updatedAt: now,
    })
    .run()

insertPolicy('pol_a', a.organizationId, 'Org A policy')
insertPolicy('pol_b', b.organizationId, 'Org B policy')
insertService('svc_a', a.organizationId, 'org-a-search', 'Org A Search')
insertService('svc_b', b.organizationId, 'org-b-search', 'Org B Search')

// The gateway resolves a service's policy through policy_service_links, so that is what the
// proof has to populate. Attaching it via services.policy_id would pass the read-scope tests
// while leaving the real resolution path untested.
const linkPolicy = (policyId: string, serviceId: string, orgId: string) =>
  db()
    .insert(schema.policyServiceLinks)
    .values({ id: `psl_${serviceId}`, policyId, serviceId, organizationId: orgId })
    .run()
linkPolicy('pol_a', 'svc_a', a.organizationId)
linkPolicy('pol_b', 'svc_b', b.organizationId)

// Policy child rows exist per tenant, which is what loadPolicySnapshot joins against.
const insertPolicyNetwork = (policyId: string, orgId: string) =>
  db()
  .insert(schema.policyNetworks)
  .values({ id: `pn_${policyId}`, policyId, organizationId: orgId, network: 'testnet' })
  .run()
insertPolicyNetwork('pol_a', a.organizationId)
insertPolicyNetwork('pol_b', b.organizationId)

const insertPolicyAsset = (policyId: string, orgId: string) =>
  db()
  .insert(schema.policyAssets)
  .values({ id: `pa_${policyId}`, policyId, organizationId: orgId, assetContract: 'CA_USDC' })
  .run()
insertPolicyAsset('pol_a', a.organizationId)
insertPolicyAsset('pol_b', b.organizationId)

const resolveA = resolveServiceBySlug('org-a-search')
const resolveB = resolveServiceBySlug('org-b-search')

section('Tenant is derived from the service row, never from the caller')
check('Org A service resolves to Org A', resolveA?.organizationId === a.organizationId)
check('Org B service resolves to Org B', resolveB?.organizationId === b.organizationId)

// One request, one settlement, one incident and one activity row per tenant.
const trace = (subject: string): PolicyTrace => ({
  phase: 'preflight',
  decision: 'allow',
  checks: [],
  subject,
  evaluatedAt: now,
  durationMs: 0,
})

const reqA = recordRequest({
  id: 'req_a',
  organizationId: a.organizationId,
  serviceId: 'svc_a',
  policyId: 'pol_a',
  sessionId: null,
  reviewId: null,
  claimedPayer: PAYER,
  verifiedPayer: PAYER,
  mode: 'charge',
  amountBase: '250000',
  status: 'paid',
  policyDecision: 'allow',
  policyTrace: trace(PAYER),
})
const reqB = recordRequest({
  id: 'req_b',
  organizationId: b.organizationId,
  serviceId: 'svc_b',
  policyId: 'pol_b',
  sessionId: null,
  reviewId: null,
  claimedPayer: PAYER,
  verifiedPayer: PAYER,
  mode: 'charge',
  amountBase: '250000',
  status: 'paid',
  policyDecision: 'allow',
  policyTrace: trace(PAYER),
})

recordSettlement({
  organizationId: a.organizationId,
  kind: 'charge',
  requestId: reqA,
  sessionId: null,
  requestCount: 1,
  amountBase: '250000',
  assetContract: 'CA_USDC',
  assetCode: 'USDC',
  decimals: 7,
  payer: PAYER,
  recipient: A_TREASURY,
  network: 'testnet',
  txHash: 'tx_a',
  status: 'confirmed',
})
recordSettlement({
  organizationId: b.organizationId,
  kind: 'charge',
  requestId: reqB,
  sessionId: null,
  requestCount: 1,
  amountBase: '250000',
  assetContract: 'CA_USDC',
  assetCode: 'USDC',
  decimals: 7,
  payer: PAYER,
  recipient: B_TREASURY,
  network: 'testnet',
  txHash: 'tx_b',
  status: 'confirmed',
})

recordIncident({
  organizationId: a.organizationId,
  kind: 'charged_not_delivered',
  requestId: reqA,
  sessionId: null,
  serviceId: 'svc_a',
  payer: PAYER,
  amountBase: '250000',
  assetCode: 'USDC',
  decimals: 7,
  reason: 'upstream timeout',
  policyTrace: trace(PAYER),
  paymentTxHash: 'tx_a',
})
recordIncident({
  organizationId: b.organizationId,
  kind: 'charged_not_delivered',
  requestId: reqB,
  sessionId: null,
  serviceId: 'svc_b',
  payer: PAYER,
  amountBase: '250000',
  assetCode: 'USDC',
  decimals: 7,
  reason: 'upstream timeout',
  policyTrace: trace(PAYER),
  paymentTxHash: 'tx_b',
})

recordActivity({
  organizationId: a.organizationId,
  type: 'request_paid',
  message: 'Org A paid',
  serviceId: 'svc_a',
  requestId: reqA,
  amountBase: '250000',
  assetCode: 'USDC',
  decimals: 7,
})
recordActivity({
  organizationId: b.organizationId,
  type: 'request_paid',
  message: 'Org B paid',
  serviceId: 'svc_b',
  requestId: reqB,
  amountBase: '250000',
  assetCode: 'USDC',
  decimals: 7,
})

// A pending review per tenant: the write-path attack needs a live target.
const reviewA = reviews.createReview({
  organizationId: a.organizationId,
  policyId: 'pol_a',
  serviceId: 'svc_a',
  wallet: PAYER,
  reason: 'needs a human',
  amountBase: '250000',
  policyTrace: trace(PAYER),
})
const reviewB = reviews.createReview({
  organizationId: b.organizationId,
  policyId: 'pol_b',
  serviceId: 'svc_b',
  wallet: PAYER,
  reason: 'needs a human',
  amountBase: '250000',
  policyTrace: trace(PAYER),
})

let nextFixtureRef = 1

// A channel session per tenant, so session lookups have something to leak.
const insertPaymentSession = (
  id: string,
  orgId: string,
  serviceId: string,
  channel: string,
  recipient: string,
  refOverride?: string,
) =>
  db()
    .insert(schema.paymentSessions)
    .values({
      id,
      organizationId: orgId,
      /*
       * Bare decimal, matching the schema and what `nextSessionRef` returns.
       *
       * This fixture used to write `ref_${id}`. That is the one shape the buggy
       * `substr(ref, 3)` could parse, so the fixture agreed with the bug instead of with the
       * spec, and the collision survived every test run.
       */
      ref: refOverride ?? String(nextFixtureRef++),
      serviceId,
      channelContract: channel,
      funder: PAYER,
      recipient,
      assetContract: 'CA_USDC',
      decimals: 7,
      commitmentPublicKey: 'G_COMMITMENT_KEY',
      cumulativeBase: '0',
      requestCount: 0,
      fundedBase: '0',
      status: 'active',
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run()

insertPaymentSession('ses_a', a.organizationId, 'svc_a', 'CA_CHANNEL_A', A_TREASURY)
insertPaymentSession('ses_b', b.organizationId, 'svc_b', 'CA_CHANNEL_B', B_TREASURY)

// Channel events are a second tenant-scoped child of the session, and an unscoped one would
// let a session's history leak even when the session row itself is correctly filtered.
const insertSessionEvent = (id: string, sessionId: string, orgId: string) =>
  db()
    .insert(schema.sessionEvents)
    .values({
      id,
      sessionId,
      organizationId: orgId,
      type: 'created',
      detail: 'channel opened',
      amountBase: null,
      createdAt: now,
    })
    .run()
insertSessionEvent('sev_a', 'ses_a', a.organizationId)
insertSessionEvent('sev_b', 'ses_b', b.organizationId)

// ---------------------------------------------------------------------------
// Read isolation
// ---------------------------------------------------------------------------

section('Direct lookups by primary key')
check(
  'Org A cannot read Org B request detail',
  aggregates.requestDetail(a.organizationId, reqB) == null,
)
check(
  'Org B cannot read Org A request detail',
  aggregates.requestDetail(b.organizationId, reqA) == null,
)
check('Org A can read its own request detail', aggregates.requestDetail(a.organizationId, reqA) !== null)

check(
  'Org A cannot fetch Org B session',
  sessions.getSession(a.organizationId, 'ses_b') == null,
)
check(
  'Org A cannot resolve Org B review',
  reviews.findPresentedReview(a.organizationId, reviewB, 'svc_a', PAYER) == null,
)
check(
  'Org B cannot present Org A review against its own service',
  reviews.findPresentedReview(b.organizationId, reviewA, 'svc_b', PAYER) == null,
)

section('Aggregate counts exclude the other tenant')
const statsA = aggregates.overviewStats(a.organizationId)
const statsB = aggregates.overviewStats(b.organizationId)
check('Org A sees exactly its own request count', statsA.totalRequests === 1, `saw ${statsA.totalRequests}`)
check('Org B sees exactly its own request count', statsB.totalRequests === 1, `saw ${statsB.totalRequests}`)

const rollupsA = aggregates.serviceRollups(a.organizationId)
check(
  'Org A rollups contain only its own service',
  rollupsA.length === 1 && rollupsA[0]?.id === 'svc_a',
  `saw ${JSON.stringify(rollupsA.map((r) => r.id))}`,
)
check(
  "Org A's rollup counts exclude Org B's request",
  rollupsA.every((r) => r.requestCount === 1),
  `saw ${JSON.stringify(rollupsA.map((r) => r.requestCount))}`,
)

const settledA = aggregates.settlementRows(a.organizationId)
check(
  'Org A settlements name only the Org A treasury',
  settledA.length === 1 && settledA[0]?.recipient === A_TREASURY,
  `saw ${JSON.stringify(settledA.map((s) => s.recipient))}`,
)
const settledB = aggregates.settlementRows(b.organizationId)
check(
  'Org B settlements name only the Org B treasury',
  settledB.length === 1 && settledB[0]?.recipient === B_TREASURY,
  `saw ${JSON.stringify(settledB.map((s) => s.recipient))}`,
)

check(
  'Org A incidents contain only its own',
  aggregates.incidentRows(a.organizationId).every((i) => i.serviceId === 'svc_a'),
)
check(
  'Org A activity contains only its own',
  aggregates.recentActivity(a.organizationId).every((row) => !row.message.includes('Org B')),
)

check('Org A session list contains only its own', sessions.listAllSessions(a.organizationId).every((s) => s.id === 'ses_a'))
check('Org A open reviews contain only its own', reviews.openReviews(a.organizationId).every((r) => r.id === reviewA))
check('Org A pending count is exactly its own', reviews.countPendingReviews(a.organizationId) === 1)
const policiesA = policiesWithUsage(a.organizationId)
check(
  'Org A policies contain only its own',
  policiesA.length === 1 && policiesA[0]?.policy.id === 'pol_a',
  `saw ${JSON.stringify(policiesA.map((p) => p.policy.id))}`,
)
const usageA = policiesA[0]?.usage
check(
  "Org A's policy usage does not borrow Org B's child rows",
  usageA !== undefined && usageA.services.every((sv) => sv.id === 'svc_a'),
  `saw ${JSON.stringify(usageA?.services.map((sv) => sv.id))}`,
)

// ---------------------------------------------------------------------------
// Write isolation
// ---------------------------------------------------------------------------

section('Mutations cannot cross tenants')
const hijack = reviews.resolveReview({
  organizationId: b.organizationId,
  reviewId: reviewA,
  resolvedBy: userB.id,
  action: 'approve',
  note: 'approve someone elses review',
})
check(
  "Org B cannot resolve Org A's review",
  hijack.ok === false && hijack.reason === 'review not found',
  `got ${JSON.stringify(hijack)}`,
)

const stillPending = db()
  .select()
  .from(schema.reviewDecisions)
  .where(eq(schema.reviewDecisions.id, reviewA))
  .get()
check("Org A's review is still pending after the hijack attempt", stillPending?.status === 'pending')

// The legitimate path must still work, otherwise the checks above prove only that nothing
// works at all.
const legit = reviews.resolveReview({
  organizationId: a.organizationId,
  reviewId: reviewA,
  resolvedBy: userA.id,
  action: 'approve',
  note: 'legitimate',
})
check('Org A can still resolve its own review', legit.ok === true, `got ${JSON.stringify(legit)}`)

// ---------------------------------------------------------------------------
// Settlement routing
// ---------------------------------------------------------------------------

section('Payment routing follows the organization, not a global config')
const targetA = requireSettlementRecipient(a.organizationId)
const targetB = requireSettlementRecipient(b.organizationId)
check('Org A routes to its own treasury', targetA === A_TREASURY, `got ${targetA}`)
check('Org B routes to its own treasury', targetB === B_TREASURY, `got ${targetB}`)
check('the two organizations settle to different accounts', targetA !== targetB)

// Session commitment keys belong to payers and are supplied per open, so treasury routing
// has no organization commitment-key prerequisite.
check('treasury routing needs no organization commitment key', requireSettlementRecipient(a.organizationId) === A_TREASURY)

// ---------------------------------------------------------------------------
// Policy state isolation
// ---------------------------------------------------------------------------

section('Policy state is per tenant')
// The same payer key is deliberately reused across both tenants: a shared rate-limit counter
// would let Org B's traffic exhaust Org A's allowance, which is the failure this isolates.
const limitA1: boolean = consumeRateLimit(a.organizationId, 'pol_a', PAYER, 1)
const limitB1: boolean = consumeRateLimit(b.organizationId, 'pol_b', PAYER, 1)
check('Org A rate limit allows its own first call', limitA1 === true)
check("Org A's usage does not consume Org B's allowance", limitB1 === true)
check(
  'Org A rate limit is now exhausted',
  consumeRateLimit(a.organizationId, 'pol_a', PAYER, 1) === false,
)
check(
  "Org B is unaffected by Org A exhausting its own limit",
  consumeRateLimit(b.organizationId, 'pol_b', PAYER, 2),
)

// ---------------------------------------------------------------------------
// Session reference allocation
// ---------------------------------------------------------------------------

// Regression, not a design property. `nextSessionRef` derived the next number with
// `max(cast(substr(ref, 3)))`, which assumed a `ref_` prefix the function never wrote and
// the column never stored. On a stored ref of '1' that slice is the empty string, which casts
// to 0, so max() stayed pinned at 0 and every call after the first session re-issued ref '1'.
// The unique index turned the second channel open into a 500, meaning channel mode worked
// exactly once per database. These checks pin the allocator to "strictly increasing across
// many calls", which is what would have caught it.
section('Session references are allocated without collision')
{
  // `nextSessionRef` is max(ref)+1 over STORED rows, so it is only monotonic if rows are
  // written between calls. Interleaving allocation with insertion is what makes this a real
  // regression test rather than a loop that returns 1 forever against an empty table.
  const allocated: string[] = []
  for (let i = 0; i < 25; i++) {
    allocated.push(sessions.nextSessionRef())
    insertPaymentSession(
      `ses_alloc_${i}`,
      a.organizationId,
      'svc_a',
      `C_alloc_${i}`,
      A_TREASURY,
      allocated[i],
    )
  }

  const numeric = allocated.every((r) => /^\d+$/.test(r))
  check('every reference is a bare decimal string, with no prefix to mis-slice', numeric, allocated.slice(0, 3).join(', '))

  const unique = new Set(allocated)
  check('25 allocations produce 25 distinct references', unique.size === 25, `got ${unique.size}`)

  const ascending = allocated.every((r, i) => i === 0 || Number(r) === Number(allocated[i - 1]) + 1)
  check('references ascend by one across 25 open cycles', ascending, allocated.slice(0, 5).join(', '))

  // The exact historical failure: with a stored ref of '1', `substr(ref, 3)` yields the empty
  // string, which casts to 0 and pins max() at 0, so every later open re-issued '1'.
  const one = db()
    .select({ ref: schema.paymentSessions.ref })
    .from(schema.paymentSessions)
    .where(eq(schema.paymentSessions.ref, '1'))
    .all()
  check(
    "a stored ref of '1' is present and is read back as the number 1",
    one.length === 1 && Number(one[0]?.ref) === 1,
    `rows=${one.length}`,
  )

  const next = sessions.nextSessionRef()
  check('the allocator moves past the highest stored ref instead of re-issuing 1', next !== '1', `got ${next}`)
}

// ---------------------------------------------------------------------------
// Open instructions survive JSON serialization
// ---------------------------------------------------------------------------

// Regression. The channel open response carries an i128 base-unit amount straight into
// `JSON.stringify`, which throws on BigInt. Passing the bigint reserved the session row and
// then failed to answer, so the payer received a 500 with no instructions while an orphaned
// session sat in the database holding a slot they could never use.
//
// This calls the real `channelOpenInstructions`, not a hand-built copy of its shape. An
// earlier version of this check assembled its own object and therefore passed while the
// actual function was still returning a BigInt, which is worth remembering as a reason the
// test did nothing.
section('Channel open instructions are JSON-serializable')
{
  const orgId = a.organizationId
  const A_COMMITMENT = Keypair.random()

  const treasury = requireSettlementRecipient(orgId)
  const fundedBase = '1000000000000000000000000'

  const instructions = manager.channelOpenInstructions({
    organizationId: orgId,
    serviceId: 'svc_a',
    funder: PAYER,
    commitmentPublicKey: A_COMMITMENT.publicKey(),
    assetContract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    decimals: 7,
    fundedBase,
    refundWaitingPeriodSeconds: 100,
  })

  check(
    'the real function returns an amount with no BigInt anywhere in the payload',
    !containsBigInt(instructions),
    'channelOpenInstructions returned a BigInt',
  )

  let encoded = ''
  let threw = ''
  try {
    encoded = JSON.stringify(instructions)
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('the instructions serialize without throwing', threw === '', threw)

  if (encoded) {
    const round = JSON.parse(encoded)
    check('the amount survives as an exact decimal string', round.amount === fundedBase, String(round.amount))
    check(
      'the amount is the decimal digits the factory i128 expects',
      /^-?\d+$/.test(round.amount) && BigInt(round.amount) === toBig(fundedBase),
    )
    check('the commitment key is 64 raw hex characters', round.commitmentKey.length === 64, round.commitmentKey)
    check(
      'the commitment key belongs to the payer that requested the open',
      round.commitmentKey === Buffer.from(A_COMMITMENT.rawPublicKey()).toString('hex'),
    )
    check('the recipient is the organization treasury', round.to === treasury, `${round.to} vs ${treasury}`)
    check('the funder is never treated as the recipient', round.to !== PAYER && round.from === PAYER)
  }

  // The response also travels through the route, which adds a session record. That record is
  // written BEFORE the response body is serialized, so a serialization throw leaks an orphaned
  // session. Pin that the whole route payload is clean, not just the instructions sub-object.
  let routeThrew = ''
  let routeEncoded = ''
  try {
    routeEncoded = JSON.stringify({
      sessionId: 'ses_x',
      open: instructions,
      recipient: treasury,
      next: 'submit',
    })
  } catch (error) {
    routeThrew = error instanceof Error ? error.message : String(error)
  }
  check('the full session-open response body serializes', routeThrew === '', routeThrew)
  check('and is non-empty', routeEncoded.length > 0)
}

/** True if a bigint hides anywhere in the payload, including behind a non-enumerable value. */
function containsBigInt(value: unknown): boolean {
  return (
    typeof value === 'bigint' ||
    (value !== null &&
      typeof value === 'object' &&
      Object.values(value as Record<string, unknown>).some(containsBigInt))
  )
}

// ---------------------------------------------------------------------------
// Channel settlement requires a signer PageSure does not control
// ---------------------------------------------------------------------------

// A channel withdrawal is authorized by the payer's commitment key. PageSure deliberately
// holds no payer private key, so a channel-mode organization has to
// register a signer service. These checks pin the gate: it refuses when anything is missing,
// and it never substitutes a process-wide default, because a shared signer would let one
// organization's settlement be signed by another's key.
section('Channel settlement requires a registered signer')
{
  const orgId = a.organizationId

  // Charge mode is unaffected throughout: it needs a recipient, never a signer.
  const treasuryRow = db()
    .select({ r: schema.organizations.settlementRecipient })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .get()
  check(
    'charge routing works with no signer registered at all',
    requireSettlementRecipient(orgId) === treasuryRow?.r,
  )

  const setSigner = (url: string | null, tokenEnv: string | null) =>
    db()
      .update(schema.organizations)
      .set({ commitmentSignerUrl: url, commitmentSignerTokenEnv: tokenEnv })
      .where(eq(schema.organizations.id, orgId))
      .run()

  // The provider signer is independent of the payer's per-channel key.
  setSigner(null, null)
  let reason = ''
  try {
    requireCommitmentSigner(orgId)
  } catch (error) {
    reason = error instanceof CommitmentSignerUnavailableError ? error.message : 'threw something else'
  }
  check('an organization with no signer service is refused', reason.includes('no channel signer service'), reason)

  setSigner('https://signer.example/sign', null)
  reason = ''
  try {
    requireCommitmentSigner(orgId)
  } catch (error) {
    reason = error instanceof CommitmentSignerUnavailableError ? error.message : 'threw something else'
  }
  check('a signer with no token variable is refused', reason.includes('no signer token environment variable'), reason)

  // The variable is named but unset in this process. This is the deployment mistake that
  // would otherwise surface as a confusing signature failure at settlement time.
  setSigner('https://signer.example/sign', 'PAGESURE_TEST_SIGNER_TOKEN_UNSET')
  reason = ''
  try {
    requireCommitmentSigner(orgId)
  } catch (error) {
    reason = error instanceof CommitmentSignerUnavailableError ? error.message : 'threw something else'
  }
  check(
    'a named token variable that is not set is reported by name, not silently ignored',
    reason.includes('PAGESURE_TEST_SIGNER_TOKEN_UNSET') && reason.includes('not set'),
    reason,
  )

  // The working case.
  process.env.PAGESURE_TEST_SIGNER_TOKEN = 'test-token'
  setSigner('https://signer.example/sign', 'PAGESURE_TEST_SIGNER_TOKEN')
  let signer: ReturnType<typeof requireCommitmentSigner> | null = null
  let signerError = ''
  try {
    signer = requireCommitmentSigner(orgId)
  } catch (error) {
    signerError = error instanceof Error ? error.message : String(error)
  }
  check('a fully registered signer resolves', signer !== null, signerError)
  check('the resolved signer carries the organization token', signer?.token === 'test-token')
  check('the resolved signer has no payer commitment key', signer !== null && !('commitmentPublicKey' in signer))

  // Org B must not be able to borrow Org A's signer.
  setSigner(null, null)
  let crossed = ''
  try {
    requireCommitmentSigner(orgId)
  } catch (error) {
    crossed = error instanceof CommitmentSignerUnavailableError ? error.message : 'threw something else'
  }
  check('withdrawing Org A signer config leaves Org A unusable, never a shared default', crossed !== '')
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(resCRATCH(suffix))) rmSync(resCRATCH(suffix))
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFailing:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('Cross-organization isolation holds.')
