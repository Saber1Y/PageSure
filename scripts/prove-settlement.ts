/**
 * External signer settlement proof.
 *
 * PageSure holds no channel private key. The channel contract requires `to.require_auth()`
 * against the organization's treasury account, and the MPP SDK broadcasts a close using a
 * `feePayer.envelopeSigner` holding that secret, so PageSure is structurally unable to submit a
 * withdrawal on an organization's behalf. Settlement is therefore driven by the organization's
 * signer service, which makes three boundaries load-bearing:
 *
 *   1. Registration policy. An organization supplies a signer URL and the NAME of an env var
 *      holding its token. PageSure reads the token from its own process and sends it as a
 *      bearer credential, so unrestricted registration would be a credential-exfiltration
 *      primitive: point the URL at an attacker's host, name any variable, and the next
 *      settlement request hands over that process secret. These checks attack exactly that.
 *
 *   2. Settlement intent authorization. The signer needs to know what to sign. The endpoint
 *      that tells it must not leak another tenant's financials to a valid token, and the amount
 *      must be PageSure's own record rather than anything the caller supplies.
 *
 *   3. Credential action. The MPP credential carries `action: 'voucher' | 'close'`. A close is a
 *      withdrawal, not a billable service request. Ignoring `action` means a settlement request
 *      runs down the voucher path, prices as a service request, and advances the cumulative for
 *      a withdrawal instead of delivered work. This was a live bug; the last checks pin it.
 *
 * Runs against a throwaway database, deletes it on exit, and needs no server, wallet or network.
 */

import { eq } from 'drizzle-orm'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { Keypair, StrKey } from '@stellar/stellar-sdk'

const SCRATCH = './data/settlement-proof.db'

process.env.DATABASE_URL = SCRATCH

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(resolve(process.cwd(), SCRATCH + suffix))) rmSync(resolve(process.cwd(), SCRATCH + suffix))
}

// Imported after the environment is set, deliberately: `db()` caches its handle on first use.
const { db } = await import('../src/lib/db/client')
const { runMigrations } = await import('../src/lib/db/migrate')
const schema = await import('../src/lib/db/schema')
const { createOrganizationWithOwner } = await import('../src/lib/auth/session')
const { resolveServiceBySlug } = await import('../src/lib/services/registry')
const { validateSignerRegistration, signerRegistrationAvailable } = await import(
  '../src/lib/mpp/signer-registration'
)
const { authenticateSignerToken, settlementIntent } = await import('../src/lib/mpp/settlement-intent')
const { handleChannelRequest } = await import('../src/lib/sessions/gateway')
const { createSessionRow } = await import('../src/lib/sessions/manager')
const { providerSignerEnvironment } = await import('../src/lib/mpp/signer-env')

process.env.CHANNEL_FACTORY_C ??= 'CDENABPOYPNPJFP2TEFO5UJFYCA7OGG6Y7TBU5XFXZ3WJJN5FKOLXN4B'

runMigrations()

const filteredSignerEnv = providerSignerEnvironment({
  AGENT_COMMITMENT_SEED: 'payer-secret-must-not-cross-this-boundary',
  SIGNER_TREASURY_SECRET: 'provider-treasury-secret',
})

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

/** For functions that throw (signup, intent auth). */
function throws(name: string, fn: () => unknown, expectFragment?: string) {
  try {
    fn()
    check(name, false, 'expected a rejection, got success')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expectFragment ? message.includes(expectFragment) : true, `message was: ${message}`)
  }
}

/** For functions that report failure by returning { ok: false } (registration policy). */
function denies(name: string, fn: () => { ok: boolean; reason?: string }, expectFragment?: string) {
  const result = fn()
  if (result.ok) {
    check(name, false, 'accepted, but should have been refused')
    return
  }
  const reason = result.reason ?? ''
  check(name, expectFragment ? reason.includes(expectFragment) : true, `reason was: ${reason}`)
}

function accepts(name: string, fn: () => unknown) {
  try {
    fn()
    check(name, true)
  } catch (error) {
    check(name, false, `expected success, got: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// Two tenants with registered signers
// ---------------------------------------------------------------------------

const A_WALLET = 'GAHNAKJYF2JLU4L6YHEYLDJGY3EWR6JCFYH6PGLHU7HWCQOJ24NJ5OGI'
const B_WALLET = 'GDYKHMQUQPLDIHADE5SLBW3ZC44S3ISIPQKKWKC6XQ3G2ZZFSGDTILGG'
const A_TREASURY = 'GCKLMICNBX6MAARZ5D566HDI4EBBGYE4CHJMU75ILTW77EG5X4HSQBGZ'
const B_TREASURY = 'GBWDEM3JNHGGNRNT5N6QJ5UUULT6C7J6MEPO3C2FFRSTFLVUPLCGV5C4'
const PAYER = 'GPAYERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const CHANNEL_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const CHANNEL_B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const COMMITMENT_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 31)).publicKey()
const COMMITMENT_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 32)).publicKey()

// Operator policy for the whole proof.
process.env.MPP_SIGNER_HOSTS = 'signer.a.example, signer.b.example'
process.env.MPP_SIGNER_TOKEN_PREFIX = 'PAGESURE_SIGNER_'
process.env.PAGESURE_SIGNER_TOKEN_A = 'token-for-org-a-do-not-leak'
process.env.PAGESURE_SIGNER_TOKEN_B = 'token-for-org-b-do-not-leak'

section('Operator policy gates signer registration')

check('registration is available when a host allowlist and prefix are configured', signerRegistrationAvailable())

delete process.env.MPP_SIGNER_HOSTS
check('registration is unavailable with no host allowlist', !signerRegistrationAvailable())
process.env.MPP_SIGNER_HOSTS = 'signer.a.example, signer.b.example'

accepts('accepts a permitted host with a conforming token name', () => {
  const result = validateSignerRegistration({
    signerUrl: 'https://signer.a.example',
    signerTokenEnv: 'PAGESURE_SIGNER_TOKEN_A',
  })
  if (!result.ok) throw new Error(result.reason)
})

denies(
    'rejects a host outside the allowlist',
    () => validateSignerRegistration({
    signerUrl: 'https://signer.attacker.example',
    signerTokenEnv: 'PAGESURE_SIGNER_TOKEN_A',
  }),
    'not permitted',
  )

denies(
    'rejects a suffix-match on an allowed host',
    () => validateSignerRegistration({
      signerUrl: 'https://evil-signer.a.example',
      signerTokenEnv: 'PAGESURE_SIGNER_TOKEN_A',
    }),
    'not permitted',
  )

denies(
    'rejects a plaintext http signer URL',
    () => validateSignerRegistration({
    signerUrl: 'http://signer.a.example',
    signerTokenEnv: 'PAGESURE_SIGNER_TOKEN_A',
  }),
    'https',
  )

denies(
    'rejects credentials embedded in the signer URL',
    () => validateSignerRegistration({
    signerUrl: 'https://user:pass@signer.a.example',
    signerTokenEnv: 'PAGESURE_SIGNER_TOKEN_A',
  }),
    'must not embed credentials',
  )

denies(
    'rejects a token variable name outside the prefix',
    () => validateSignerRegistration({
    signerUrl: 'https://signer.a.example',
    signerTokenEnv: 'SESSION_SECRET',
  }),
    'must start with',
  )

denies(
    'rejects a token variable that is not set in this process',
    () => validateSignerRegistration({
    signerUrl: 'https://signer.a.example',
    signerTokenEnv: 'PAGESURE_SIGNER_TOKEN_NEVER_PROVISIONED',
  }),
    'not set in this process',
  )

denies(
    'rejects a URL with no token variable name',
    () => validateSignerRegistration({ signerUrl: 'https://signer.a.example' }),
    'together',
  )

denies(
    'rejects a token variable name with no URL',
    () => validateSignerRegistration({ signerTokenEnv: 'PAGESURE_SIGNER_TOKEN_A' }),
    'together',
  )

// ---------------------------------------------------------------------------
// Signup integration
// ---------------------------------------------------------------------------

section('Signup stores only what the operator permits')

const a = createOrganizationWithOwner({
  walletPublicKey: A_WALLET,
  displayName: 'Org A Owner',
  organizationName: 'Org A',
  settlementRecipient: A_TREASURY,
  signerUrl: 'https://signer.a.example',
  signerTokenEnv: 'PAGESURE_SIGNER_TOKEN_A',
})
const b = createOrganizationWithOwner({
  walletPublicKey: B_WALLET,
  displayName: 'Org B Owner',
  organizationName: 'Org B',
  settlementRecipient: B_TREASURY,
  signerUrl: 'https://signer.b.example',
  signerTokenEnv: 'PAGESURE_SIGNER_TOKEN_B',
})

const orgA = db()
  .select()
  .from(schema.organizations)
  .where(eqOrg(a.organizationId))
  .get()

check('org A signer URL persisted', orgA?.commitmentSignerUrl === 'https://signer.a.example/')
check('org A stores only the token variable name', orgA?.commitmentSignerTokenEnv === 'PAGESURE_SIGNER_TOKEN_A')

const serialized = JSON.stringify(orgA)
check(
  'no signer token value is stored anywhere in the organization row',
  !serialized.includes('token-for-org-a-do-not-leak'),
)

const signupRejections = [
  {
    name: 'signup rejects a signer host outside the allowlist',
    wallet: 'GDUMMYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    url: 'https://signer.attacker.example',
    env: 'PAGESURE_SIGNER_TOKEN_A',
  },
  {
    name: 'signup rejects an attempt to register SESSION_SECRET as the token',
    wallet: 'GDUMMY2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    url: 'https://signer.a.example',
    env: 'SESSION_SECRET',
  },
  {
    name: 'signup rejects a plaintext signer URL',
    wallet: 'GDUMMY3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    url: 'http://signer.a.example',
    env: 'PAGESURE_SIGNER_TOKEN_A',
  },
]

for (const attempt of signupRejections) {
  const before = db().select().from(schema.organizations).all().length
  throws(attempt.name, () => {
    createOrganizationWithOwner({
      walletPublicKey: attempt.wallet,
      displayName: 'Rejected',
      organizationName: 'Rejected Org',
      settlementRecipient: A_TREASURY,
      signerUrl: attempt.url,
      signerTokenEnv: attempt.env,
    })
  })
  const after = db().select().from(schema.organizations).all().length
  check(`  ...and creates no organization (${attempt.name})`, after === before)
}

function eqOrg(id: string) {
  return eq(schema.organizations.id, id)
}

// ---------------------------------------------------------------------------
// Services and sessions
// ---------------------------------------------------------------------------

section('Channel services and sessions')

const now = Date.now()
function insertChannelService(id: string, orgId: string, slug: string) {
  db()
    .insert(schema.services)
    .values({
      id,
      organizationId: orgId,
      slug,
      name: slug,
      description: 'channel service',
      assetCode: 'USDC',
      assetContract: 'CA_USDC',
      decimals: 7,
      priceBase: '250000',
      mode: 'channel',
      upstreamKind: 'search',
      upstreamConfig: {},
      policyId: null,
      status: 'live',
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

insertChannelService('svc_a', a.organizationId, 'chan-a')
insertChannelService('svc_b', b.organizationId, 'chan-b')

function insertSession(
  id: string,
  orgId: string,
  serviceId: string,
  channel: string,
  commitmentKey: string,
  cumulative: string,
  requests: number,
) {
  db()
    .insert(schema.paymentSessions)
    .values({
      id,
      organizationId: orgId,
      ref: id,
      serviceId,
      channelContract: channel,
      funder: PAYER,
      recipient: orgId === a.organizationId ? A_TREASURY : B_TREASURY,
      assetContract: 'CA_USDC',
      decimals: 7,
      commitmentPublicKey: commitmentKey,
      latestVoucherSignature: 'ab'.repeat(64),
      cumulativeBase: cumulative,
      requestCount: requests,
      fundedBase: '50000000',
      status: 'active',
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

insertSession('ses_a1', a.organizationId, 'svc_a', CHANNEL_A, COMMITMENT_A, '1750000', 7)
insertSession('ses_b1', b.organizationId, 'svc_b', CHANNEL_B, COMMITMENT_B, '250000', 1)

const serviceA = resolveServiceBySlug('chan-a')
check('org A channel service resolves', serviceA !== null)
check('org B channel service resolves', resolveServiceBySlug('chan-b') !== null)

// ---------------------------------------------------------------------------
// Session rows store the SDK-verifiable form of the commitment key
// ---------------------------------------------------------------------------

/*
 * MPP verifies voucher signatures with `Keypair.fromPublicKey(string)`, which accepts the
 * payer's ed25519 (G...) public key. The provider's organization key is not involved.
 */
section('Session rows store the commitment key the SDK can verify')

const C_WALLET = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey()
const C_TREASURY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey()
const C_SIGNER_HOST = 'signer.c.example'
process.env.MPP_SIGNER_HOSTS = `${process.env.MPP_SIGNER_HOSTS}, ${C_SIGNER_HOST}`
process.env.PAGESURE_SIGNER_TOKEN_C = 'token-for-org-c-do-not-leak'

const C_KEY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7))
const c = createOrganizationWithOwner({
  walletPublicKey: C_WALLET,
  displayName: 'Org C Owner',
  organizationName: 'Org C',
  settlementRecipient: C_TREASURY,
  signerUrl: `https://${C_SIGNER_HOST}`,
  signerTokenEnv: 'PAGESURE_SIGNER_TOKEN_C',
})
insertChannelService('svc_c', c.organizationId, 'chan-c')
const sessionCId = createSessionRow({
  organizationId: c.organizationId,
  serviceId: 'svc_c',
  funder: PAYER,
  commitmentPublicKey: C_KEY.publicKey(),
  assetContract: 'CA_USDC',
  decimals: 7,
  fundedBase: '50000000',
  refundWaitingPeriodSeconds: 100,
})
const stored = db()
  .select({ commitmentPublicKey: schema.paymentSessions.commitmentPublicKey })
  .from(schema.paymentSessions)
  .where(eq(schema.paymentSessions.id, sessionCId))
  .get()?.commitmentPublicKey ?? ''

check('the stored payer key is a valid ed25519 StrKey', StrKey.isValidEd25519PublicKey(stored))
accepts('Keypair.fromPublicKey accepts the stored key', () => {
  const pub = Keypair.fromPublicKey(stored).rawPublicKey()
  const expected = Buffer.from(StrKey.decodeEd25519PublicKey(C_KEY.publicKey()))
  if (!Buffer.from(pub).equals(expected)) {
    throw new Error('stored G-form does not encode the same raw bytes as the M-key')
  }
})

// ---------------------------------------------------------------------------
// Settlement intent authorization
// ---------------------------------------------------------------------------

section('Settlement intents require the organization signer token')
check('provider signer environment strips the payer seed', filteredSignerEnv.AGENT_COMMITMENT_SEED === undefined)
check('provider signer environment retains treasury authorization', filteredSignerEnv.SIGNER_TREASURY_SECRET === 'provider-treasury-secret')

throws('a settlement intent with no token is refused', () => {
  authenticateSignerToken(a.organizationId, null)
}, 'require the organization signer token')

throws('a settlement intent with an empty token is refused', () => {
  authenticateSignerToken(a.organizationId, '')
}, 'require the organization signer token')

throws('a settlement intent with the wrong token is refused', () => {
  authenticateSignerToken(a.organizationId, 'token-for-org-b-do-not-leak')
}, 'not available')

throws(
  "org B's token is refused for org A",
  () => {
    authenticateSignerToken(a.organizationId, 'token-for-org-b-do-not-leak')
  },
  'not available',
)

throws(
  'a token that merely contains the real one is refused',
  () => {
    authenticateSignerToken(a.organizationId, 'xtoken-for-org-a-do-not-leak')
  },
  'not available',
)

accepts("org A's own token is accepted", () => {
  authenticateSignerToken(a.organizationId, 'token-for-org-a-do-not-leak')
})

check('an unknown organization is refused without disclosing its id', (() => {
  try {
    authenticateSignerToken('org_does_not_exist', 'anything')
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return !message.includes('org_does_not_exist') && message.includes('not available')
  }
})())

section('Settlement intents expose only the caller own organization')

const intentA = settlementIntent({
  organizationId: a.organizationId,
  sessionId: 'ses_a1',
  network: 'stellar:testnet',
})

check('intent returns the recorded cumulative', intentA.cumulativeBase === '1750000')
check('intent formats the cumulative for the asset', intentA.cumulativeFormatted === '0.1750000')
check('intent carries the request count', intentA.requestCount === 7)
check('intent directs the withdrawal at the org treasury', intentA.recipient === A_TREASURY)
check('intent names the payer commitment key', intentA.commitmentPublicKey === COMMITMENT_A)
check('intent returns the exact recorded payer voucher signature', intentA.commitmentSignature === 'ab'.repeat(64))
check('intent names the signer URL', intentA.signerUrl.startsWith('https://signer.a.example'))
check('intent carries the asset code from the service', intentA.assetCode === 'USDC')

const claimedStatus = db()
  .select({ status: schema.paymentSessions.status })
  .from(schema.paymentSessions)
  .where(eq(schema.paymentSessions.id, 'ses_a1'))
  .get()?.status
check('issuing an intent claims the session (active -> settling)', claimedStatus === 'settling', String(claimedStatus))

const retryIntent = settlementIntent({
  organizationId: a.organizationId,
  sessionId: 'ses_a1',
  network: 'stellar:testnet',
})
check('a settling session can pull the intent again (retry of the same claim)', retryIntent.cumulativeBase === '1750000')

const claimEvents = db()
  .select()
  .from(schema.sessionEvents)
  .where(eq(schema.sessionEvents.sessionId, 'ses_a1'))
  .all()
check('the claim is recorded on the session timeline', claimEvents.some((e) => e.type === 'close_requested'))

throws(
  "org A's valid token cannot pull org B's settlement intent",
  () => {
    authenticateSignerToken(a.organizationId, 'token-for-org-a-do-not-leak')
    settlementIntent({ organizationId: a.organizationId, sessionId: 'ses_b1', network: 'stellar:testnet' })
  },
  'no session exists with that id',
)

throws('a nonexistent session is refused', () => {
  settlementIntent({ organizationId: a.organizationId, sessionId: 'ses_does_not_exist', network: 'stellar:testnet' })
}, 'no session exists with that id')

db()
  .update(schema.paymentSessions)
  .set({ status: 'closed' })
  .where(eq(schema.paymentSessions.id, 'ses_a1'))
  .run()

throws('a closed session cannot be settled', () => {
  settlementIntent({ organizationId: a.organizationId, sessionId: 'ses_a1', network: 'stellar:testnet' })
}, 'only an active or settling session')

db()
  .update(schema.paymentSessions)
  .set({ status: 'active' })
  .where(eq(schema.paymentSessions.id, 'ses_a1'))
  .run()

db()
  .update(schema.organizations)
  .set({ commitmentSignerUrl: null, commitmentSignerTokenEnv: null })
  .where(eq(schema.organizations.id, a.organizationId))
  .run()

throws('an organization with no signer registration cannot pull an intent', () => {
  settlementIntent({ organizationId: a.organizationId, sessionId: 'ses_a1', network: 'stellar:testnet' })
}, 'no channel signer service registered')

db()
  .update(schema.organizations)
  .set({ commitmentSignerUrl: 'https://signer.a.example', commitmentSignerTokenEnv: 'PAGESURE_SIGNER_TOKEN_A' })
  .where(eq(schema.organizations.id, a.organizationId))
  .run()

// ---------------------------------------------------------------------------
// Credential action: a close is not a billable voucher
// ---------------------------------------------------------------------------

section('A close credential is never billed as a service request')

function credentialFor(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify({ payload }), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `Payment ${b64}`
}

function gatewayCall(payload: Record<string, unknown>) {
  return handleChannelRequest({
    request: new Request('https://pagesure.test/v1/chan-a', {
      method: 'GET',
      headers: { authorization: credentialFor(payload) },
    }),
    service: serviceA!,
    url: new URL('https://pagesure.test/v1/chan-a'),
    startedAt: Date.now(),
  })
}

const closeResponse = await gatewayCall({
  action: 'close',
  channel: CHANNEL_A,
  amount: '1750000',
  signature: 'ab'.repeat(64),
})

check('a close credential is not processed as a voucher', closeResponse.status === 501, `status ${closeResponse.status}`)
const closeBody = (await closeResponse.json()) as { title?: string; detail?: string; settlementEndpoint?: string }
check(
  'the refusal names settlement, not payment',
  closeBody.title === 'settlement_not_submitted_by_pagesure',
  closeBody.title,
)
check(
  'the refusal explains that the signer submits the withdrawal',
  (closeBody.detail ?? '').includes('organization signer service'),
  closeBody.detail,
)
check('the refusal points at the settlement endpoint', closeBody.settlementEndpoint === '/v1/chan-a/session/settlement')

const cumulativeAfterClose = db()
  .select()
  .from(schema.paymentSessions)
  .where(eq(schema.paymentSessions.id, 'ses_a1'))
  .get()
check('a close does not advance the cumulative', cumulativeAfterClose?.cumulativeBase === '1750000')
check('a close does not increment the request count', cumulativeAfterClose?.requestCount === 7)

const events = db()
  .select()
  .from(schema.sessionEvents)
  .where(eq(schema.sessionEvents.sessionId, 'ses_a1'))
  .all()
check('the close attempt is recorded as an event', events.some((e) => e.type === 'close_requested'))

const requestsAfterClose = db()
  .select()
  .from(schema.requests)
  .all()
check('a close produces no billable request row', requestsAfterClose.length === 0, `saw ${requestsAfterClose.length}`)

// A voucher for the same channel is still recognised as a channel request, so the action fix
// has not broken the ordinary path's session lookup.
const voucherResponse = await gatewayCall({
  action: 'voucher',
  channel: CHANNEL_A,
  amount: '250000',
  signature: 'ab'.repeat(64),
})
check(
  'a voucher still resolves its session (not rejected as channel_required)',
  voucherResponse.status !== 400,
  `status ${voucherResponse.status}`,
)

// Once the settlement intent has claimed the session the close is imminent: a voucher served
// after that would raise the cumulative the organization signer is about to sign against.
db()
  .update(schema.paymentSessions)
  .set({ status: 'settling' })
  .where(eq(schema.paymentSessions.id, 'ses_a1'))
  .run()

const settlingResponse = await gatewayCall({
  action: 'voucher',
  channel: CHANNEL_A,
  amount: '250000',
  signature: 'ab'.repeat(64),
})
check('a settling session refuses new vouchers', settlingResponse.status === 409, `status ${settlingResponse.status}`)
const settlingBody = (await settlingResponse.json()) as { title?: string }
check('the refusal is session_not_active', settlingBody.title === 'session_not_active', settlingBody.title)

// ---------------------------------------------------------------------------

for (const suffix of ['', '-wal', '-shm']) {
  const path = resolve(process.cwd(), SCRATCH + suffix)
  if (existsSync(path)) rmSync(path)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailed checks:')
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
