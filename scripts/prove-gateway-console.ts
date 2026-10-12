/**
 * L102: the HTTP gateway and the browser-facing console.
 *
 * prove:charge proved the paid path end to end, but its fake made one simplification that
 * mattered: the mock mppx echoed the CURRENT call's `parameters.externalId` back in the
 * settlement receipt. The real mppx does not do that. A paid request spans TWO HTTP
 * requests:
 *
 *   1. the first is answered 402 and mints a challenge carrying `externalId` = request A
 *   2. the second presents the credential for that challenge and settles; mppx decodes the
 *      ORIGINAL challenge from the credential (`challengeRequest` in charge/server/Charge.js),
 *      so the settlement receipt carries `externalId` = request A, while the gateway minted a
 *      BRAND NEW request id B on this HTTP request
 *
 * So the id the gateway is holding when the payment lands is NOT the id the settlement reports.
 * That is the exact trap documented in src/lib/mpp/registry.ts, and the reason the gateway
 * correlates through the instance (`settledPayment`) rather than through the externalId.
 * prove-charge never exercised that: its fake reported the current request's externalId, which
 * is the case that always worked. This suite uses a retry-aware fake that reports the ORIGINAL
 * challenge's externalId, the case that used to 400 after the money had moved.
 *
 * It also covers the console surfaces that prove:charge only implied:
 *
 *   - payment retry: the two-request correlation settles exactly once and delivers
 *   - review approval: a held wallet appears in the review queue, an operator's approval writes
 *     a scoped, time-boxed grant (never touching the allowlist), and the retry with that review
 *     id is ALLOW and delivered; reject writes nothing and the wallet is held again
 *   - incident recording: the incidents console lists exactly what the gateway recorded, for the
 *     incident's own organization only
 *
 * The auth wrapper on POST /api/reviews/[id] cannot be driven from a script: `currentUser()`
 * reads the session cookie through next/headers, which only exists inside a request context.
 * This suite therefore exercises `resolveReview` with the same arguments the route passes
 * (organizationId from the session, never the body), which is the boundary the console's
 * tenant isolation actually depends on.
 *
 * mppx and the upstream are substituted (see lib/testing/overrides); the billing, recording and
 * policy code under test is the gateway's own and is not substituted.
 */

import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { Keypair } from '@stellar/stellar-sdk'

import { closeScratchDatabase } from './scratch-db'

const SCRATCH = './data/console-proof.db'

process.env.DATABASE_URL = SCRATCH
process.env.STELLAR_NETWORK = 'stellar:testnet'

closeScratchDatabase(SCRATCH)

const { runMigrations } = await import('../src/lib/db/migrate')
const { db } = await import('../src/lib/db/client')
const {
  incidents,
  organizations,
  policyAllowlist,
  policyGrants,
  requests,
  reviewDecisions,
  settlements,
  services,
  activityEvents,
  users,
} = await import('../src/lib/db/schema')
const { createService } = await import('../src/lib/services/create')
const { addListEntry } = await import('../src/lib/policy/manage')
const { openReviews, countPendingReviews, resolveReview } = await import('../src/lib/policy/review')
const { overviewStats, incidentRows } = await import('../src/lib/metering/aggregates')
const { recordActivity } = await import('../src/lib/metering/record')
const { setChargeFactory, setUpstreamRunner, resetOverrides } = await import(
  '../src/lib/testing/overrides'
)
const route = await import('../src/app/v1/[slug]/route')

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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const PAYER = Keypair.random().publicKey()
const OTHER = Keypair.random().publicKey()
const RECIPIENT = Keypair.random().publicKey()

/**
 * tx hash the fake settlement "broadcasts". Unique per settlement: the gateway records
 * settlements.tx_hash in a UNIQUE index, so a constant value would collide on a second paid
 * request (exactly what the mismatch and upstream-failure sections also fire).
 */
let txCounter = 0
function nextTxHash() {
  txCounter++
  return txCounter.toString(16).padStart(64, '0')
}

const CURRENCY = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

let upstreamCalls = 0
/** Set by a test to make the fake upstream throw, exercising the upstream_failed path. */
let upstreamShouldFail = false

let verifierAddress = PAYER
/** When false, charge() returns a non-402 WITHOUT firing payment.success - the 400 path. */
const settleShouldFire = true

/**
 * The externalId carried by the challenge this fake issued most recently. The real mppx embeds
 * the challenge in the credential, and the receipt is minted from that ORIGINAL challenge - not
 * from the parameters of the current HTTP request.
 */
let lastChallengedExternalId: string | null = null
/** The externalId this fake reported in the last settlement receipt that fired. */
let lastSettledExternalId: string | null = null
/** The tx hash this fake reported in the last settlement receipt that fired. */
let lastSettledTx: string | null = null

/**
 * A fake mppx whose `charge()` behaves like the real one across a paid RETRY:
 *
 *   - without a credential: 402, remembering the externalId it minted into the challenge
 *   - with a credential: settle instantly (payment.success on a LATER microtask), reporting the
 *     ORIGINAL challenge's externalId rather than this HTTP request's externalId
 *
 * The gateway mints a new request id per HTTP request, so on the paid retry the receipt's
 * externalId (request A) differs from the request the gateway is holding (request B). This is
 * the case that used to 400 after the money had moved.
 */
function installRetryAwareCharge() {
  setChargeFactory(({ recipient }) => {
    const handlers: ((e: unknown) => void)[] = []
    const instance = {
      on(_event: string, handler: (e: unknown) => void) {
        handlers.push(handler)
        return instance
      },
      charge(parameters: { amount: string; description: string; externalId: string }) {
        return async (request: Request) => {
          const hasCredential = request.headers.get('authorization')?.startsWith('Payment ') ?? false
          if (!hasCredential) {
            lastChallengedExternalId = parameters.externalId
            return {
              status: 402,
              challenge: {
                headers: new Headers({
                  'WWW-Authenticate':
                    `Payment id="chal", realm="localhost", method="stellar", intent="charge", ` +
                    `request="${Buffer.from(
                      JSON.stringify({
                        amount: parameters.amount,
                        currency: CURRENCY,
                        recipient,
                        // The challenge carries the externalId; the credential re-presents it.
                        externalId: parameters.externalId,
                      }),
                    ).toString('base64url')}"`,
                }),
                async text() {
                  return JSON.stringify({ title: 'payment_required', status: 402 })
                },
              },
            }
          }
          // A settled payment on a retry reports the ORIGINAL challenge's externalId, which is
          // the id from the 402 attempt - NOT the id the gateway minted for this retry request.
          const settledExternalId = lastChallengedExternalId ?? parameters.externalId
          lastSettledExternalId = settledExternalId
          const tx = nextTxHash()
          lastSettledTx = tx
          const payload = {
            receipt: { reference: tx, externalId: settledExternalId },
            credential: { signedHash: 'sig', source: `did:pkh:stellar:testnet:${verifierAddress}` },
          }
          if (settleShouldFire) {
            queueMicrotask(() => {
              for (const h of handlers) h(payload)
            })
          }
          return { status: 200, body: { ok: true } }
        }
      },
    }
    return instance
  })
}

installRetryAwareCharge()

setUpstreamRunner(async () => {
  upstreamCalls++
  if (upstreamShouldFail) throw new Error('upstream exploded')
  return { provider: 'fake-provider', status: 200, body: { results: ['hello'] } }
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2, 14)}`
}

function seedOrg(name: string, slug: string, price = '0.01') {
  const organizationId = newId('org')
  db().insert(organizations)
    .values({
      id: organizationId,
      name,
      settlementRecipient: RECIPIENT,
      // The gateway requires a settlement recipient; the proof asserts what it settles TO.
      treasuryVerified: true,
      commitmentPublicKey: null,
      commitmentSignerUrl: null,
      commitmentSignerTokenEnv: null,
      createdAt: Date.now(),
    })
    .run()
  const created = createService({
    organizationId,
    name: `${name} Search`,
    slug,
    price,
    upstreamKind: 'market',
  })
  if (!created.ok) throw new Error(`fixture failed: ${JSON.stringify(created)}`)
  const row = db().select().from(services).where(eq(services.slug, slug)).get()!
  return { organizationId, serviceId: row.id, policyId: row.policyId! }
}

const acme = seedOrg('Acme', 'acme-console')
// The payer is allowlisted so the default path is ALLOW -> paid -> delivered.
addListEntry(acme.organizationId, acme.policyId, 'allow', PAYER, 'payer')
// A second organization with no allowlist: unknown wallets are held for review.
const globe = seedOrg('Globe', 'globe-console')

// Console operators are real user rows: the review endpoint resolves as the signed-in user
// (resolvedBy: user.id) and users.id is a foreign key on review_decisions, so passing a stub
// wallet identity would violate the constraint. Same shape the route sends.
function seedOperator(organizationId: string, displayName: string) {
  const id = `usr_console_${Math.random().toString(16).slice(2, 10)}`
  db()
    .insert(users)
    .values({
      id,
      organizationId,
      walletPublicKey: Keypair.random().publicKey(),
      displayName,
      role: 'operator',
      createdAt: Date.now(),
    })
    .run()
  return id
}
const globeOperator = seedOperator(globe.organizationId, 'Globe Operator')
const acmeOperator = seedOperator(acme.organizationId, 'Acme Operator')

async function call(
  slug: string,
  payer: string,
  withCredential: boolean,
  query: Record<string, string> = {},
) {
  const headers: Record<string, string> = { 'X-Pagesure-Payer': payer }
  if (withCredential) headers.Authorization = 'Payment signedHash:sig'
  const url = new URL(`http://localhost/v1/${slug}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const request = new Request(url, { headers })
  const response = await route.GET(request, { params: Promise.resolve({ slug }) })
  return response
}

/** Decode the externalId the fake embedded in a 402 challenge, the way the real client would. */
function challengeExternalId(response: Response): string | null {
  const header = response.headers.get('www-authenticate') ?? ''
  const encoded = header.match(/request="([A-Za-z0-9_-]+)"/)?.[1]
  if (!encoded) return null
  try {
    const terms = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      externalId?: string
    }
    return terms.externalId ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 1. Payment retry
// ---------------------------------------------------------------------------
section('A paid retry settles once and delivers, even though the receipt carries the ORIGINAL challenge id')
{
  lastChallengedExternalId = null
  lastSettledExternalId = null
  upstreamCalls = 0
  const settleBefore = db().select().from(settlements).all().length

  // First HTTP request: no credential -> challenged.
  const unpaid = await call('acme-console', PAYER, false)
  const requestA = unpaid.headers.get('x-pagesure-request-id') ?? ''
  check('the unpaid attempt is challenged', unpaid.status === 402, `got ${unpaid.status}`)
  check('with the decision allow', unpaid.headers.get('x-pagesure-decision') === 'allow')
  check('a request id is minted for the challenge', /^req_/.test(requestA))
  check('the challenge embeds the SAME externalId the gateway minted', challengeExternalId(unpaid) === requestA)
  check('the upstream was NOT called', upstreamCalls === 0, `called ${upstreamCalls} times`)

  const rowA = db().select().from(requests).where(eq(requests.id, requestA)).get()
  check('the attempt is recorded as challenged', rowA?.status === 'challenged', rowA?.status)
  check('no settlement exists yet', db().select().from(settlements).all().length === settleBefore)

  // The client pays the challenge and retries the SAME url. A NEW http request.
  const paid = await call('acme-console', PAYER, true)
  const requestB = paid.headers.get('x-pagesure-request-id') ?? ''
  check('the retry returns the resource', paid.status === 200, `got ${paid.status}`)
  check('the gateway minted a NEW request id for the retry', /^req_/.test(requestB) && requestB !== requestA)
  check('the upstream WAS called exactly once', upstreamCalls === 1, `called ${upstreamCalls} times`)

  // The part that used to 400: the settlement receipt reports request A (from the original
  // challenge), not request B (the retry the gateway is holding). The correlation works because
  // it is instance-scoped, not externalId-scoped.
  check('the receipt reported the ORIGINAL challenge externalId, not the retry id', lastSettledExternalId === requestA)
  check('which is NOT the id this retry minted', lastSettledExternalId !== requestB)

  const settled = db().select().from(settlements).all()
  check('exactly one settlement was recorded for the two requests', settled.length === settleBefore + 1, `${settled.length - settleBefore}`)
  check('it is confirmed', settled[0]?.status === 'confirmed')
  check('it records the tx hash', settled[0]?.txHash === lastSettledTx)
  check('it records the VERIFIED payer', settled[0]?.payer === PAYER)

  const rowB = db().select().from(requests).where(eq(requests.id, requestB)).get()
  check('the retry row is paid', rowB?.status === 'paid', rowB?.status)
  check('it records the verified payer', rowB?.verifiedPayer === PAYER)
  check('and the payment tx', rowB?.paymentTxHash === lastSettledTx)

  // The 402 attempt leaves its own row behind: that is the two-request reality. It is never
  // billed (no settlement keyed to it) and it is not duplicated into a second payment.
  check('the 402 attempt stays challenged, not paid', rowA?.status === 'challenged', rowA?.status)
  const billed = db().select().from(settlements).all().filter((s) => s.requestId === requestA)
  check('and nothing was settled against the 402 attempt', billed.length === 0, `${billed.length}`)

  const paidRows = db().select().from(requests).all().filter((r) => r.status === 'paid')
  check('exactly one paid row exists for the whole retry', paidRows.length === 1, `${paidRows.length}`)

  const activity = db().select().from(activityEvents).all()
  check(
    'the activity feed records one delivery',
    activity.filter((a) => a.type === 'request_paid').length === 1,
  )
  check('no incident was raised', db().select().from(incidents).all().length === 0)
}

// ---------------------------------------------------------------------------
// 2. Review approval
// ---------------------------------------------------------------------------
section('A held wallet appears in the console review queue, and approving it lets the retry through')
{
  const stranger = Keypair.random().publicKey()
  const reviewsBefore = db().select().from(reviewDecisions).all().length
  const settlesBefore = db().select().from(settlements).all().length
  upstreamCalls = 0

  // Unknown wallet on Globe, which allowlists nobody -> held.
  const held = await call('globe-console', stranger, false)
  check('an unknown wallet is held', held.status === 202, `got ${held.status}`)
  check('the upstream was NOT called', upstreamCalls === 0)
  const heldBody = (await held.json()) as { reviewId?: string; payment?: string; service?: string }
  check('a review id is returned', typeof heldBody.reviewId === 'string' && heldBody.reviewId.startsWith('rev_'))
  check('the body admits nothing was charged', heldBody.payment === 'not_started')
  check('and nothing was executed', heldBody.service === 'not_executed')
  check('the review decision is persisted', db().select().from(reviewDecisions).all().length === reviewsBefore + 1)
  const heldReviewId = heldBody.reviewId!

  // What the /review console page reads.
  const queue = openReviews(globe.organizationId, 100)
  check('the review console lists the held request', queue.some((r) => r.id === heldReviewId))
  check('with the waiting count at one', countPendingReviews(globe.organizationId) === 1)
  check('showing the wallet it belongs to', queue.find((r) => r.id === heldReviewId)?.wallet === stranger)
  check('in the review page amount', queue.find((r) => r.id === heldReviewId)?.amountBase === '100000')

  // The operator approves through the console. This is exactly what POST /api/reviews/[id]
  // calls after currentUser(): organizationId from the session, resolvedBy the operator.
  const approved = resolveReview({
    organizationId: globe.organizationId,
    reviewId: heldReviewId,
    resolvedBy: globeOperator,
    action: 'approve',
    note: 'customer verified by phone',
  })
  check('the approval succeeds', approved.ok, JSON.stringify(approved))
  check('and issues a grant id', approved.ok && approved.grantId !== null)
  recordActivity({
    organizationId: globe.organizationId,
    type: 'review_resolved',
    ok: true,
    message: `Review ${heldReviewId.slice(0, 12)} approved, grant created`,
  })

  const review = db().select().from(reviewDecisions).where(eq(reviewDecisions.id, heldReviewId)).get()
  check('the review is marked approved', review?.status === 'approved', review?.status)
  check('resolved by the operator', review?.resolvedBy === globeOperator)
  check('with the audit note', review?.note === 'customer verified by phone')

  const grants = db().select().from(policyGrants).all()
  check('a policy grant was written', grants.length >= 1)
  check('scoped to the service, not the org', grants[grants.length - 1]?.serviceId === globe.serviceId)
  check('for the wallet that was held', grants[grants.length - 1]?.wallet === stranger)
  check('linked to the review', grants[grants.length - 1]?.grantedFromReviewId === heldReviewId)
  check('expiring, not permanent', (grants[grants.length - 1]?.expiresAt ?? 0) > Date.now())
  check('and NOT an allowlist edit', grants[grants.length - 1]?.revokedAt === null)

  const allowlistHit = db()
    .select()
    .from(policyAllowlist)
    .where(eq(policyAllowlist.policyId, globe.policyId))
    .all()
  check('approval created NO allowlist entry', allowlistHit.length === 0, `${allowlistHit.length}`)
  check('the review leaves the pending queue', !openReviews(globe.organizationId, 100).some((r) => r.id === heldReviewId))
  check('and the waiting count is back to zero', countPendingReviews(globe.organizationId) === 0)

  // The payer retries with the review id. The preflight re-runs, the grant hits, and the retry is
  // now a charge request rather than a hold. No credential yet -> challenged, NOT held.
  lastChallengedExternalId = null
  lastSettledExternalId = null
  upstreamCalls = 0
  const retried = await call('globe-console', stranger, false, { review: heldReviewId })
  check('the retry is no longer held', retried.status === 402, `got ${retried.status}: ${await retried.clone().text()}`)
  check('the decision is now allow', retried.headers.get('x-pagesure-decision') === 'allow')
  check('the upstream was still not called', upstreamCalls === 0)

  // The paid retry: same review id, now presenting the credential.
  verifierAddress = stranger
  lastChallengedExternalId = null
  const delivered = await call('globe-console', stranger, true, { review: heldReviewId })
  check('the approved wallet gets the resource', delivered.status === 200, `got ${delivered.status}`)
  check('the upstream WAS called once', upstreamCalls === 1, `called ${upstreamCalls} times`)
  check('a settlement was recorded for it', db().select().from(settlements).all().length === settlesBefore + 1)
  const settled = db().select().from(settlements).all()
  check('to the verified payer', settled[settled.length - 1]?.payer === stranger)

  const paidRow = db()
    .select()
    .from(requests)
    .all()
    .filter((r) => r.status === 'paid' && r.organizationId === globe.organizationId)
  check('the approved request is recorded as paid', paidRow.length === 1)
  check('the grant is still live, not consumed', db().select().from(policyGrants).all().some((g) => g.grantedFromReviewId === heldReviewId && g.revokedAt === null))
  check('no extra review was created for the retry', db().select().from(reviewDecisions).all().length === reviewsBefore + 1)
}

// ---------------------------------------------------------------------------
// 3. Review rejection
// ---------------------------------------------------------------------------
section('Reject writes nothing, so the same wallet is held again on retry')
{
  const stranger = Keypair.random().publicKey()
  const reviewsBefore = db().select().from(reviewDecisions).all().length
  const grantsBefore = db().select().from(policyGrants).all().length
  const settlesBefore = db().select().from(settlements).all().length
  upstreamCalls = 0

  const held = await call('globe-console', stranger, false)
  const rejectedId = (await held.json() as { reviewId?: string }).reviewId!
  check('an unknown wallet is held again', held.status === 202)
  check('with a fresh review id', rejectedId.startsWith('rev_'))

  const rejected = resolveReview({
    organizationId: globe.organizationId,
    reviewId: rejectedId,
    resolvedBy: globeOperator,
    action: 'reject',
    note: 'cannot verify caller',
  })
  check('the rejection succeeds', rejected.ok, JSON.stringify(rejected))
  check('and issues NO grant', rejected.ok && rejected.grantId === null)
  const row = db().select().from(reviewDecisions).where(eq(reviewDecisions.id, rejectedId)).get()
  check('the review is marked rejected', row?.status === 'rejected', row?.status)
  check('no grant was written', db().select().from(policyGrants).all().length === grantsBefore)

  // Retry with the rejected review id: still held. The hold writes a NEW review (replays are
  // decisions, not approvals), but never a charge and never an upstream call.
  const retried = await call('globe-console', stranger, false, { review: rejectedId })
  const retriedBody = (await retried.json()) as { reviewId?: string; payment?: string }
  check('the rejected wallet is held again on retry', retried.status === 202, `got ${retried.status}`)
  check('no payment was taken', retriedBody.payment === 'not_started')
  check('no settlement was recorded', db().select().from(settlements).all().length === settlesBefore)
  check('the upstream was never called', upstreamCalls === 0)
  check('a fresh review id was minted for the replay', retriedBody.reviewId !== rejectedId)
  check('exactly one new review row joined the queue', db().select().from(reviewDecisions).all().length === reviewsBefore + 2)
  check('the console still counts exactly this pending one', countPendingReviews(globe.organizationId) === 1)
}

// ---------------------------------------------------------------------------
// 4. Cross-organization isolation
// ---------------------------------------------------------------------------
section('One organization cannot approve or see another')
{
  // Acme resolves a Globe review id -> refused, exactly as the console route passes
  // organizationId from the session and resolveReview refuses anything outside it.
  const globeReview = db().select().from(reviewDecisions).where(eq(reviewDecisions.organizationId, globe.organizationId)).get()
  const grantsBefore = db().select().from(policyGrants).all().length
  const escalated = resolveReview({
    organizationId: acme.organizationId,
    reviewId: globeReview?.id ?? '',
    resolvedBy: acmeOperator,
    action: 'approve',
    note: 'attempted cross-org approval',
  })
  check('the cross-org approval is refused', !escalated.ok, JSON.stringify(escalated))
  check('reported as not found, not forbidden', escalated.ok === false && escalated.reason === 'review not found', (escalated as { reason?: string }).reason)
  check('and no grant was written', db().select().from(policyGrants).all().length === grantsBefore)

  const acmeQueue = openReviews(acme.organizationId, 100)
  check('the acme console does not list globe reviews', !acmeQueue.some((r) => r.id === globeReview?.id))
  check('and acme sees zero pending', countPendingReviews(acme.organizationId) === 0)
}

// ---------------------------------------------------------------------------
// 5. Incident recording
// ---------------------------------------------------------------------------
section('The incidents console lists what the gateway recorded, for this organization only')
{
  // declared != paid -> refusal AND charged_not_delivered incident.
  verifierAddress = OTHER
  lastChallengedExternalId = null
  upstreamCalls = 0
  const mismatch = await call('acme-console', PAYER, true)
  const mismatchTx = lastSettledTx
  check('declaring one wallet and paying with another is refused', mismatch.status === 403, `got ${mismatch.status}`)
  check('the upstream was NOT called', upstreamCalls === 0)

  // upstream failure after a real payment -> upstream_failed incident.
  verifierAddress = PAYER
  upstreamShouldFail = true
  lastChallengedExternalId = null
  upstreamCalls = 0
  const failed = await call('acme-console', PAYER, true)
  const upstreamFailTx = lastSettledTx
  upstreamShouldFail = false
  check('an upstream failure after payment is surfaced', failed.status === 502, `got ${failed.status}`)

  const rows = incidentRows(acme.organizationId, 100)
  check('the incidents console lists both', rows.some((r) => r.kind === 'charged_not_delivered') && rows.some((r) => r.kind === 'upstream_failed'))

  const cnd = rows.find((r) => r.kind === 'charged_not_delivered')!
  check('the charged_not_delivered incident records the payer who actually paid', cnd.payer === OTHER, cnd.payer)
  check('the amount taken', cnd.amountBase === '100000', cnd.amountBase)
  check('the tx hash', cnd.paymentTxHash === mismatchTx)
  check('the reason explains the mismatch', /did not match verified payer/.test(cnd.reason ?? ''))
  check('it is unacknowledged (open)', cnd.acknowledgedAt === null)
  check('it links to a request trace', typeof cnd.requestId === 'string' && /^req_/.test(cnd.requestId))

  const upf = rows.find((r) => r.kind === 'upstream_failed')!
  check('the upstream_failed incident records the tx hash', upf.paymentTxHash === upstreamFailTx)
  check('and the verified payer', upf.payer === PAYER, upf.payer)

  const stats = overviewStats(acme.organizationId)
  check('the dashboard open-incidents counter matches', stats.openIncidents >= 2, `openIncidents=${stats.openIncidents}`)

  // The incidents console is scoped: Globe never sees Acme's.
  const globeRows = incidentRows(globe.organizationId, 100)
  check('the other organization sees none of acme\u2019s incidents', globeRows.every((r) => r.organizationId === globe.organizationId))
  check('and acme\u2019s own console is scoped to acme', rows.every((r) => r.organizationId === acme.organizationId))
}

// ---------------------------------------------------------------------------
// Leave the gateway armed for production, always.
resetOverrides()
closeScratchDatabase(SCRATCH)
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(resolve(process.cwd(), SCRATCH + suffix))) rmSync(SCRATCH + suffix)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFailing:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('The gateway correlates retries, holds and releases on review, and records what it does.')