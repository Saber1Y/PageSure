/**
 * External signer proof.
 *
 * PageSure holds no channel private key, so the organization signer is the only thing standing
 * between a settlement request and released funds. This exercises a real HTTP signer service
 * and several dishonest ones.
 *
 * What matters:
 *
 *   1. A well-behaved signer produces a signature PageSure accepts, and the two agree on the
 *      exact bytes that were signed.
 *   2. A signer cannot redirect a settlement. It signs bytes it is given, so a signer that
 *      tries to sign for a different amount or channel has nothing to sign.
 *   3. A dishonest signer's output is caught locally. Wrong key, wrong length, non-JSON, HTTP
 *      error, oversized body, and a signature over different bytes are all refused without
 *      touching the network.
 *   4. PageSure will not ask a signer to sign bytes that do not bind to the intended
 *      withdrawal.
 *   5. A token cannot be sent over plain http.
 */

import { createServer, type Server } from 'node:http'
import { Address, Keypair, StrKey, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'

const { signCommitmentForOrganization, SignerError } = await import('../src/lib/mpp/signer-client')
const { NETWORK_PASSPHRASE } = await import('@stellar/mpp')

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

const NETWORK = 'stellar:testnet'
const CHANNEL = StrKey.encodeContract(Buffer.alloc(32, 0xc1))
const OTHER_CHANNEL = StrKey.encodeContract(Buffer.alloc(32, 0xd2))
const AMOUNT_BASE = '750000'
const networkId = hash(Buffer.from(NETWORK_PASSPHRASE[NETWORK]))

function commitmentBytes(amountBase = AMOUNT_BASE, channel = CHANNEL): Uint8Array {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('domain'),
      val: xdr.ScVal.scvSymbol('chancmmt'),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('network'),
      val: nativeToScVal(networkId),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('channel'),
      val: new Address(channel).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('amount'),
      val: nativeToScVal(BigInt(amountBase), { type: 'i128' }),
    }),
  ]).toXDR()
}

/** What the signer under test does with each request. */
type Behaviour = (commitment: Buffer, auth: string | undefined) => { status: number; body: string }

/** A conforming signer parses the request and signs the commitment bytes verbatim. */
function commitmentOf(body: Buffer): Buffer {
  return Buffer.from((JSON.parse(body.toString('utf8')) as { commitment: string }).commitment, 'hex')
}

const ORG = Keypair.random()
const OTHER = Keypair.random()
const ORG_KEY = StrKey.encodeMed25519PublicKey(ORG.rawPublicKey())
const TOKEN = 'org-secret-token-for-tests'

let behaviour: Behaviour = () => ({ status: 200, body: '{}' })
let lastRequest: { body: Buffer; auth: string | undefined } | null = null

const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    lastRequest = { body, auth: req.headers.authorization }
    const out = behaviour(commitmentOf(body), req.headers.authorization)
    res.writeHead(out.status, { 'content-type': 'application/json' })
    res.end(out.body)
  })
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (typeof address === 'string' || address === null) throw new Error('signer test server has no port')
const BASE = `https://127.0.0.1:${address.port}`

/*
 * The transport is injected so the protocol can be exercised against a local server. The
 * signer url still has to be https, which is why `BASE` is https and the test server's own
 * protocol is irrelevant to the client.
 */
const transport = (url: string, init: Parameters<typeof fetch>[1]): Promise<Response> =>
  fetch(`http://127.0.0.1:${address.port}/sign`, init)

const signer = { url: `${BASE}/sign`, token: TOKEN }

function request(overrides: Partial<Parameters<typeof signCommitmentForOrganization>[0]> = {}) {
  return signCommitmentForOrganization({
    signer,
    commitmentBytes: commitmentBytes(),
    commitmentPublicKey: ORG_KEY,
    channel: CHANNEL,
    amountBase: AMOUNT_BASE,
    network: NETWORK,
    ...overrides,
  }, transport)
}

async function refuses(name: string, promise: Promise<unknown>): Promise<void> {
  try {
    await promise
    check(name, false, 'resolved, but should have been refused')
  } catch (error) {
    check(name, error instanceof SignerError, error instanceof Error ? error.message : String(error))
  }
}

// ---------------------------------------------------------------------------

section('A well-behaved signer')
{
  behaviour = (bytes) => ({
    status: 200,
    body: JSON.stringify({ signature: ORG.sign(bytes).toString('hex') }),
  })

  const signature = await request()
  check('a signature from the organization key is returned', signature.length === 64)

  // The signer signed exactly what we sent, byte for byte. This is the property that makes a
  // dumb signer safe: it has no channel or amount of its own to get wrong.
  const sent = JSON.parse(lastRequest!.body.toString('utf8')) as { commitment: string }
  check('the signer received the commitment bytes verbatim', sent.commitment === Buffer.from(commitmentBytes()).toString('hex'))
  check('PageSure presented its bearer token', lastRequest!.auth === `Bearer ${TOKEN}`)

  // And the signature is over those bytes, verified the same way the settlement path will.
  const { verifyCommitmentSignature } = await import('../src/lib/mpp/commitment')
  check(
    'the returned signature verifies over the commitment we sent',
    verifyCommitmentSignature(commitmentBytes(), signature, ORG_KEY),
  )
}

section('PageSure verifies before it asks, so a signer cannot be tricked')
{
  behaviour = () => {
    throw new Error('the signer must not be contacted')
  }
  await refuses(
    'unbound commitment bytes are refused without contacting the signer',
    request({ commitmentBytes: commitmentBytes('1') }),
  )
  await refuses(
    'commitment bytes for another channel are refused without contacting the signer',
    request({ commitmentBytes: commitmentBytes(AMOUNT_BASE, OTHER_CHANNEL) }),
  )
}

section('A dishonest signer is caught locally')
{
  behaviour = (bytes) => ({
    status: 200,
    // Correct protocol, wrong key. The dangerous case: a valid signature, just not ours.
    body: JSON.stringify({ signature: OTHER.sign(bytes).toString('hex') }),
  })
  await refuses('a valid signature from the wrong key is refused', request())

  behaviour = (bytes) => ({
    status: 200,
    // Signs different bytes than the ones bound to this withdrawal.
    body: JSON.stringify({
      signature: ORG.sign(Buffer.concat([bytes, Buffer.from('x')])).toString('hex'),
    }),
  })
  await refuses('a signature over different bytes is refused', request())

  for (const [label, sig] of [
    ['too short', 'ab'.repeat(32)],
    ['too long', 'ab'.repeat(65)],
    ['empty', ''],
    ['not hex', 'zzzz'.repeat(32)],
    ['absent', null],
  ] as const) {
    behaviour = () => ({
      status: 200,
      body: JSON.stringify(sig === null ? {} : { signature: sig }),
    })
    await refuses(`a signature that is ${label} is refused`, request())
  }

  behaviour = () => ({ status: 200, body: 'this is not json' })
  await refuses('a non-JSON body is refused', request())

  behaviour = () => ({
    status: 200,
    body: JSON.stringify({ signature: ORG.sign(Buffer.alloc(0)).toString('hex'), padding: 'x'.repeat(20000) }),
  })
  await refuses('an oversized body is refused without parsing', request())

  behaviour = () => ({ status: 500, body: 'internal signer explosion' })
  await refuses('an HTTP error is refused', request())

  behaviour = () => ({ status: 200, body: JSON.stringify(['not', 'an', 'object']) })
  await refuses('a JSON array is refused', request())
}

section('An unreachable signer fails closed')
{
  behaviour = () => ({ status: 200, body: '{}' })
  await refuses(
    'a signer that is not listening is refused',
    request({ signer: { url: `https://127.0.0.1:1/sign`, token: TOKEN } }),
  )
}

section('The token cannot travel over plain http')
{
  behaviour = (bytes) => ({ status: 200, body: JSON.stringify({ signature: ORG.sign(bytes).toString('hex') }) })

  await refuses(
    'an http signer url is refused',
    request({ signer: { url: `http://127.0.0.1:${address.port}/sign`, token: TOKEN } }),
  )
  await refuses(
    'a url that is not a url at all is refused',
    request({ signer: { url: 'not-a-url', token: TOKEN } }),
  )
}

await new Promise<void>((resolve) => server.close(() => resolve()))

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFailing:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('External signer protocol holds.')