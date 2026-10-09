/** Live, low-value Testnet proof for the charge gateway.
 *
 * Requires the seeded `search` service, APP_URL, a funded DEMO_PAYER_SECRET, the
 * fee-payer configuration, and a working upstream provider credential. This script
 * charges only the configured service price and removes its temporary allowlist entry.
 */
import { eq } from 'drizzle-orm'
import { Keypair, StrKey, rpc } from '@stellar/stellar-sdk'
import { Mppx, stellar as chargeClient } from '@stellar/mpp/charge/client'
import { db, closeDatabase } from '../src/lib/db/client'
import * as schema from '../src/lib/db/schema'
import { addListEntry, removeListEntry } from '../src/lib/policy/manage'

const slug = process.env.E2E_CHARGE_SLUG ?? 'search'
const origin = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const secret = process.env.DEMO_PAYER_SECRET ?? ''
const network = process.env.STELLAR_NETWORK ?? ''
const rpcUrl = process.env.STELLAR_RPC_URL ?? ''

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`e2e-charge: ${message}`)
}

async function main() {
  assert(network === 'stellar:testnet', 'refusing to run unless STELLAR_NETWORK=stellar:testnet')
  assert(rpcUrl, 'STELLAR_RPC_URL is required')
  assert(StrKey.isValidEd25519SecretSeed(secret), 'DEMO_PAYER_SECRET is missing or invalid')
  const payer = Keypair.fromSecret(secret)
  const service = db().select().from(schema.services).where(eq(schema.services.slug, slug)).get()
  assert(service?.mode === 'charge' && service.status === 'live', `live charge service ${slug} not found`)
  assert(service.policyId, 'service has no policy')
  const org = db().select().from(schema.organizations).where(eq(schema.organizations.id, service.organizationId)).get()
  assert(org?.treasuryVerified && org.settlementRecipient, 'organization treasury is not verified')

  const grant = addListEntry(service.organizationId, service.policyId, 'allow', payer.publicKey(), 'e2e-charge')
  assert(grant.ok, `could not temporarily allowlist demo payer: ${JSON.stringify(grant)}`)
  try {
    const target = new URL(`/v1/${slug}`, origin)
    target.searchParams.set('q', process.env.E2E_CHARGE_QUERY ?? 'Stellar USDC price')
    const requestHeaders = { 'X-Pagesure-Payer': payer.publicKey(), Accept: 'application/json' }

    const unpaid = await fetch(target, { headers: requestHeaders })
    assert(unpaid.status === 402, `unpaid request expected 402, got ${unpaid.status}`)
    const challenge = unpaid.headers.get('www-authenticate') ?? ''
    const encoded = challenge.match(/request="([A-Za-z0-9_-]+)"/)?.[1]
    assert(encoded, '402 response has no encoded MPP request')
    const terms = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      amount?: string; currency?: string; recipient?: string; externalId?: string
    }
    const challengeRequestId = unpaid.headers.get('x-pagesure-request-id')
    assert(terms.amount === service.priceBase, 'challenge amount differs from service price')
    assert(terms.currency === service.assetContract, 'challenge asset differs from service asset')
    assert(terms.recipient === org.settlementRecipient, 'challenge destination differs from verified treasury')
    assert(terms.externalId && terms.externalId === challengeRequestId, 'challenge externalId does not match request id')
    console.log(`402 verified: request=${challengeRequestId} amount=${terms.amount} asset=${terms.currency} destination=${terms.recipient}`)

    const mppx = Mppx.create({
      polyfill: false,
      methods: [chargeClient.charge({ keypair: payer, mode: 'pull', rpcUrl })],
    })
    const response = await mppx.fetch(target, { headers: requestHeaders })
    const bodyText = await response.text()
    assert(response.status === 200, `paid request returned ${response.status}: ${bodyText.slice(0, 240)}`)
    const requestId = response.headers.get('x-pagesure-request-id')
    const settlementId = response.headers.get('x-pagesure-settlement-id')
    const txHash = response.headers.get('x-pagesure-payment-tx')
    const receipt = response.headers.get('payment-receipt')
    assert(requestId && settlementId && txHash && receipt, 'successful response is missing request, settlement, tx, or receipt headers')
    assert(txHash === receipt, 'payment receipt does not match the transaction hash')

    const requestRow = db().select().from(schema.requests).where(eq(schema.requests.id, requestId)).get()
    const settlement = db().select().from(schema.settlements).where(eq(schema.settlements.id, settlementId)).get()
    const activity = db().select().from(schema.activityEvents).all().find((event) => event.requestId === requestId && event.type === 'request_paid')
    assert(requestRow?.status === 'paid' && requestRow.verifiedPayer === payer.publicKey(), 'request row is not paid for the verified payer')
    assert(requestRow.paymentTxHash === txHash && requestRow.receiptReference === receipt && requestRow.settlementId === settlementId, 'request record differs from response')
    assert(settlement?.kind === 'charge' && settlement.status === 'confirmed', 'confirmed charge settlement row not found')
    assert(settlement.requestId === requestId && settlement.payer === payer.publicKey(), 'settlement request or payer mismatch')
    assert(settlement.recipient === org.settlementRecipient && settlement.amountBase === service.priceBase, 'settlement destination or amount mismatch')
    assert(settlement.txHash === txHash && settlement.assetContract === service.assetContract, 'settlement tx or asset mismatch')
    assert(activity, 'provider request_paid activity event is missing')

    const chain = await new rpc.Server(rpcUrl).getTransaction(txHash)
    assert(chain.status === 'SUCCESS', `chain transaction status is ${chain.status}`)
    console.log(`Paid delivery verified: request=${requestId} settlement=${settlementId} tx=${txHash} chain=${chain.status}`)
    console.log(`Response body bytes: ${Buffer.byteLength(bodyText)}; provider activity and matching DB rows verified.`)
  } finally {
    const cleanup = removeListEntry(service.organizationId, service.policyId!, 'allow', payer.publicKey())
    assert(cleanup.ok, `failed to remove temporary payer allowlist entry: ${JSON.stringify(cleanup)}`)
  }
}

try {
  await main()
} finally {
  closeDatabase()
}
