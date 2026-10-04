/**
 * The charge pipeline: what happens AFTER the money moves.
 *
 * `prove:settlement` reached 49 checks and never called this route once. It proved that payments
 * are correctly REFUSED - registration policy, settlement intents, and that a close credential is
 * never billed as a service request - while a successful payment was unreachable. The route
 * answered 400 after mppx had already settled, served nothing, and left the request row reading
 * `challenged`, so not even the `charged_not_delivered` incident path could record that money had
 * been taken. Every one of those 49 checks passed while that was true.
 *
 * So this suite is written around the only question that matters here: once the payer has paid,
 * does the caller get the resource, and is the payment recorded? Specifically:
 *
 *   - an unpaid request is challenged, not served, and nothing is recorded as delivered
 *   - a paid request is DELIVERED, with the receipt and tx hash on the response
 *   - a non-402 response with no settlement is a protocol error, NOT a free service
 *   - a post-settlement policy block is recorded as an incident rather than hidden
 *   - a payer who declares one wallet and pays with another is refused AND recorded
 *   - one organization's gateway does not serve another's prices or settlement
 *
 * mppx and the upstream are substituted (see lib/testing/overrides) because a real settlement
 * needs a funded account and a real provider. The billing, recording and policy code under test is
 * the gateway's own and is not substituted.
 */

import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { Keypair } from '@stellar/stellar-sdk'

import { closeScratchDatabase } from './scratch-db'

const SCRATCH = './data/charge-proof.db'

process.env.DATABASE_URL = SCRATCH
process.env.STELLAR_NETWORK = 'stellar:testnet'

closeScratchDatabase(SCRATCH)

const { runMigrations } = await import('../src/lib/db/migrate')
const { db } = await import('../src/lib/db/client')
const {
  incidents,
  organizations,
  policyGrants,
  requests,
  reviewDecisions,
  settlements,
  services,
  activityEvents,
} = await import('../src/lib/db/schema')
const { createService } = await import('../src/lib/services/create')
const { addListEntry } = await import('../src/lib/policy/manage')
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

/** tx hash the fake settlement "broadcasts". */
const TX = 'a'.repeat(64)

let upstreamCalls = 0
/** Set by a test to make the fake upstream throw, exercising the upstream_failed path. */
let upstreamShouldFail = false

/**
 * A fake mppx whose `charge()` behaves the way the real one does, including the part that caused
 * the bug: `payment.success` is emitted on a LATER microtask than the call returns.
 */
function installCharge() {
  setChargeFactory(({ recipient }) => {
    // Declared before `instance` because the handler list must exist when a charge resolves.
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
            return {
              status: 402,
              challenge: {
                headers: new Headers({
                  'WWW-Authenticate':
                    `Payment id="chal", realm="localhost", method="stellar", intent="charge", ` +
                    `request="${Buffer.from(
                      JSON.stringify({ amount: parameters.amount, currency: CURRENCY, recipient }),
                    ).toString('base64url')}"`,
                }),
                async text() {
                  return JSON.stringify({ title: 'payment_required', status: 402 })
                },
              },
            }
          }
          // A settled payment arrives with a NON-402 status, and - the part that caused the bug -
          // `payment.success` is emitted on a LATER microtask than the call that returns it.
          // `source` lives on the CREDENTIAL, not the receipt: readCredentialSource reads
          // credential.source, and the gateway turns that into the verified payer.
          const payload = {
            receipt: { reference: TX, externalId: parameters.externalId },
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

/** Which address the fake settlement reports as the payer. Flipped for the mismatch check. */
let verifierAddress = PAYER
/** When false, charge() returns a non-402 WITHOUT firing payment.success - the 400 path. */
let settleShouldFire = true
const CURRENCY = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

installCharge()

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

const acme = seedOrg('Acme', 'acme-charge')
// The payer is allowlisted so the default path is ALLOW -> paid -> delivered.
addListEntry(acme.organizationId, acme.policyId, 'allow', PAYER, 'payer')

async function call(slug: string, payer: string, withCredential: boolean) {
  const headers: Record<string, string> = { 'X-Pagesure-Payer': payer }
  if (withCredential) headers.Authorization = 'Payment signedHash:sig'
  const request = new Request(`http://localhost/v1/${slug}?q=hello`, { headers })
  const response = await route.GET(request, { params: Promise.resolve({ slug }) })
  return response
}

// ---------------------------------------------------------------------------
section('An unpaid request is challenged, not served')
// ---------------------------------------------------------------------------
{
  upstreamCalls = 0
  const response = await call('acme-charge', PAYER, false)
  check('status is 402', response.status === 402, `got ${response.status}`)
  check('a WWW-Authenticate challenge is present', response.headers.get('www-authenticate') !== null)
  check('the decision is allow', response.headers.get('x-pagesure-decision') === 'allow')
  check('a request id is returned for correlation', /^req_/.test(response.headers.get('x-pagesure-request-id') ?? ''))
  check('the upstream was NOT called', upstreamCalls === 0, `called ${upstreamCalls} times`)

  const rows = db().select().from(requests).all()
  check('the attempt is recorded as challenged', rows.some((r) => r.status === 'challenged'))
  check('no settlement exists yet', db().select().from(settlements).all().length === 0)
}

// ---------------------------------------------------------------------------
section('A paid request is delivered')
// ---------------------------------------------------------------------------
{
  upstreamCalls = 0
  const response = await call('acme-charge', PAYER, true)
  check('status is 200', response.status === 200, `got ${response.status}: ${await response.clone().text().then(t=>t.slice(0,300))}`)
  check('the upstream WAS called exactly once', upstreamCalls === 1, `called ${upstreamCalls} times`)

  const body = (await response.json()) as { results: string[] }
  check("the upstream's body is returned verbatim", Array.isArray(body.results) && body.results[0] === 'hello')

  check('a payment receipt is returned', response.headers.get('payment-receipt') === TX)
  check('the payment tx is returned', response.headers.get('x-pagesure-payment-tx') === TX)
  check('the settlement id is returned', /^stl_/.test(response.headers.get('x-pagesure-settlement-id') ?? ''), response.headers.get('x-pagesure-settlement-id') ?? 'absent')
  check('the provider is named', response.headers.get('x-pagesure-provider') === 'fake-provider')

  const settled = db().select().from(settlements).all()
  check('a settlement row is written', settled.length === 1, `${settled.length} rows`)
  check('it is a charge', settled[0]?.kind === 'charge')
  check('it records the tx hash', settled[0]?.txHash === TX)
  check('it records the amount in base units', settled[0]?.amountBase === '100000', settled[0]?.amountBase)
  check('it records the payer', settled[0]?.payer === PAYER)
  check('it records the organization settlement recipient', settled[0]?.recipient === RECIPIENT)
  check('it is confirmed', settled[0]?.status === 'confirmed')

  const paid = db().select().from(requests).all().filter((r) => r.status === 'paid')
  check('the request row is paid', paid.length === 1)
  check('it records the VERIFIED payer, not just the declared one', paid[0]?.verifiedPayer === PAYER)
  check('and keeps the payment tx', paid[0]?.paymentTxHash === TX)
  check('and the upstream provider', paid[0]?.upstreamProvider === 'fake-provider')

  const activity = db().select().from(activityEvents).all()
  check(
    'the activity feed records the delivery',
    activity.some((a) => a.type === 'request_paid' && /paid and delivered/.test(a.message)),
  )
  check('no incident was raised', db().select().from(incidents).all().length === 0)
}

// ---------------------------------------------------------------------------
section('A non-402 with no settlement is a protocol error, not a free service')
// ---------------------------------------------------------------------------
{
  // The exact regression: charge() returns a success-looking status but settles nothing.
  settleShouldFire = false
  upstreamCalls = 0
  const before = db().select().from(settlements).all().length
  const response = await call('acme-charge', PAYER, true)
  check('status is 400', response.status === 400, `got ${response.status}`)
  check('the upstream was NOT called', upstreamCalls === 0, `called ${upstreamCalls} times`)
  check('no settlement was invented', db().select().from(settlements).all().length === before)

  const body = (await response.json()) as { title?: string }
  check('it names the failure', body.title === 'unexpected_state', body.title)
  settleShouldFire = true
}

// ---------------------------------------------------------------------------
section('A disabled policy stops the request before any payment')
// ---------------------------------------------------------------------------
{
  // Worth being precise about, because it is the difference between a safe stop and the scary
  // scenario. Disabling a policy blocks at check 2 in PREFLIGHT, which is before any challenge
  // exists - so nothing is charged and nothing needs refunding.
  //
  // It also means `charged_not_delivered` cannot be reached this way. That status needs a decision
  // that is ALLOW in preflight and BLOCK after verification, which requires the spend caps to move
  // across the boundary in the moment between the two, i.e. a real settlement. It is asserted
  // further down through the payer-mismatch path instead, which reaches the same incident record.
  const { updatePolicy } = await import('../src/lib/policy/manage')
  updatePolicy(acme.organizationId, acme.policyId, {
    name: 'Standard Access',
    description: 'disabled for the preflight check',
    unknownAction: 'review',
    active: false,
  })

  upstreamCalls = 0
  const settlementsBefore = db().select().from(settlements).all().length
  const incidentsBefore = db().select().from(incidents).all().length
  const response = await call('acme-charge', PAYER, true)

  check('status is 403', response.status === 403, `got ${response.status}`)
  check('the upstream was NOT called', upstreamCalls === 0, `called ${upstreamCalls} times`)
  check('NO payment was taken', db().select().from(settlements).all().length === settlementsBefore)
  check('and no incident was needed, because nothing was charged',
    db().select().from(incidents).all().length === incidentsBefore)

  const blocked = db().select().from(requests).all().filter((r) => r.status === 'blocked')
  check('the request is recorded as blocked', blocked.length >= 1)
  check('with no verified payer, since it never paid', blocked[blocked.length - 1]?.verifiedPayer === null)

  const body = (await response.json()) as { payment?: string; service?: string; reason?: string }
  check('the response admits no payment was taken', body.payment === 'not_started', body.payment)
  check('and nothing was served', body.service === 'not_executed', body.service)
  check('naming the disabled policy as the cause', /disabled/.test(body.reason ?? ''), body.reason)

  const trace = (body as { policyTrace?: { checks?: { key: string; status: string }[] } }).policyTrace
  const bound = trace?.checks?.find((c) => c.key === 'policy_bound')
  check('the trace blames policy_bound, not the wallet', bound?.status === 'fail', JSON.stringify(bound))

  // Re-enable for the remaining sections.
  updatePolicy(acme.organizationId, acme.policyId, {
    name: 'Standard Access',
    description: 're-enabled',
    unknownAction: 'review',
    active: true,
  })
}

section('Declaring one wallet and paying with another is refused AND recorded')
// ---------------------------------------------------------------------------
{
  verifierAddress = OTHER
  upstreamCalls = 0
  const response = await call('acme-charge', PAYER, true)
  check('status is 403', response.status === 403, `got ${response.status}`)
  check('the upstream was NOT called', upstreamCalls === 0, `called ${upstreamCalls} times`)

  const row = db()
    .select()
    .from(requests)
    .all()
    .filter((r) => r.status === 'rejected_mismatch')
  check('the request is recorded as rejected_mismatch', row.length >= 1)
  check('the VERIFIED payer is stored, being the one that actually paid', row[0]?.verifiedPayer === OTHER)
  check('the declared payer is kept too', row[0]?.claimedPayer === PAYER)

  const body = (await response.json()) as { payment?: string; service?: string }
  check('the response admits the payment settled', body.payment === 'settled')
  check('and that nothing was served', body.service === 'not_executed')

  const mismatch = db()
    .select()
    .from(incidents)
    .all()
    .filter((i) => /did not match.*verified payer/.test(i.reason ?? ''))
  check('and it is raised as an incident rather than quietly dropped', mismatch.length >= 1)
  verifierAddress = PAYER
}

// ---------------------------------------------------------------------------
section('An upstream failure after payment is recorded')
// ---------------------------------------------------------------------------
{
  upstreamShouldFail = true
  upstreamCalls = 0
  const response = await call('acme-charge', PAYER, true)
  upstreamShouldFail = false

  check('the upstream was attempted', upstreamCalls === 1, `called ${upstreamCalls} times`)
  check('status is 502', response.status === 502, `got ${response.status}`)

  const failed = db().select().from(incidents).all().filter((i) => i.kind === 'upstream_failed')
  check('an upstream_failed incident is recorded', failed.length >= 1)
  check('it records the payment tx', failed[failed.length - 1]?.paymentTxHash === TX)
}

// ---------------------------------------------------------------------------
section('One organization cannot reach another')
// ---------------------------------------------------------------------------
{
  const other = seedOrg('Other', 'other-charge')
  upstreamCalls = 0
  // No allowlist entry for PAYER on the other org's policy, so it is held rather than served.
  const response = await call('other-charge', PAYER, true)
  check('an unknown payer cannot pay a service it was never allowed', response.status !== 200, `got ${response.status}`)
  check('the upstream was NOT called', upstreamCalls === 0, `called ${upstreamCalls} times`)

  // Settlements carry requestId, not serviceId, so attribute via the request row instead.
  const otherRequestIds = new Set(
    db().select().from(requests).all().filter((r) => r.organizationId === other.organizationId).map((r) => r.id),
  )
  const leaked = db()
    .select()
    .from(settlements)
    .all()
    .filter((s) => s.requestId !== null && otherRequestIds.has(s.requestId))
  check('no settlement was attributed to the other organization', leaked.length === 0, `${leaked.length} leaked`)

  // And a review was raised on the other org's own policy, not Acme's.
  const reviews = db().select().from(reviewDecisions).all()
  check('the other organization recorded its own review', reviews.length >= 1)
  check('and no grant was issued for it', db().select().from(policyGrants).all().every((g) => g.policyId === acme.policyId))
}

// ---------------------------------------------------------------------------
section('A review-held payer is never charged')
// ---------------------------------------------------------------------------
{
  const stranger = Keypair.random().publicKey()
  const reviewBefore = db().select().from(reviewDecisions).all().length
  const settleBefore = db().select().from(settlements).all().length
  upstreamCalls = 0

  const response = await call('other-charge', stranger, true)
  check('status is 202, held', response.status === 202, `got ${response.status}`)
  check('the upstream was NOT called', upstreamCalls === 0)
  check('no settlement was recorded', db().select().from(settlements).all().length === settleBefore)

  const body = (await response.json()) as { payment?: string; service?: string; reviewId?: string }
  check('the body says no payment was taken', body.payment === 'not_started', body.payment)
  check('and the service was not executed', body.service === 'not_executed', body.service)
  check('and a review was raised', typeof body.reviewId === 'string' && body.reviewId.startsWith('rev_'))
  check('the review is persisted', db().select().from(reviewDecisions).all().length === reviewBefore + 1)
  const trace = (body as { policyTrace?: { checks?: unknown[]; decision?: string } }).policyTrace
  check('and the policy trace is returned so the hold is explainable', typeof trace === 'object' && trace !== null)
  check('carrying the ordered checks', Array.isArray(trace?.checks) && (trace?.checks.length ?? 0) > 0)
  check('and the decision that held it', trace?.decision === 'review', trace?.decision)
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
console.log('The charge pipeline delivers and records.')
