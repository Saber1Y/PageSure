/**
 * Commitment binding and signature proof.
 *
 * A channel withdrawal is authorized by a signature over bytes the contract derives. Two
 * independent things must hold: the bytes must be a commitment for this channel, this
 * amount and this network, and the signature must be by the payer's key.
 *
 * This builds commitment bytes the way the contract does, then attacks them. Every check
 * below is a way the system could be tricked into releasing funds, so a pass means the gate
 * refuses that specific trick.
 *
 * Offline and deterministic: commitment bytes are assembled with the same stellar-sdk XDR
 * types the contract's `to_xdr` produces, and verified by the same SDK function the
 * settlement path uses. This boundary prevents the provider treasury signer from increasing
 * the cumulative: it has no payer secret, and changing the amount invalidates the signature.
 */

import { Address, Keypair, StrKey, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'

const {
  assertCommitmentBinds,
  verifyCommitmentSignature,
  assertWithdrawableByFunder,
  CommitmentBindingError,
} = await import('../src/lib/mpp/commitment')

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

// Keys are the SDK's own, `stellar:`-prefixed, which is also what `network()` returns.
const NETWORK = 'stellar:testnet'
/*
 * Real contract addresses, derived rather than pasted.
 *
 * A hand-written contract address has to pass its own StrKey checksum, and a made-up one does
 * not, which fails at construction and reads like an unrelated bug. Deriving them keeps the
 * test honest and makes "the other channel" genuinely different rather than nearly identical.
 */
const CHANNEL = StrKey.encodeContract(Buffer.alloc(32, 0xa1))
const OTHER_CHANNEL = StrKey.encodeContract(Buffer.alloc(32, 0xb2))
const AMOUNT_BASE = '1000000'

const networkId = hash(Buffer.from(NETWORK_PASSPHRASE[NETWORK]))

/**
 * Commitment bytes in the shape the contract returns.
 *
 * The contract does `self.to_xdr(env)` on a `#[contracttype]` struct, which soroban encodes
 * as a `ScVal::Map` keyed by field name. Building the same structure here gives the decoder
 * something faithful to work on.
 */
function commitmentBytes(options: {
  channel?: string
  amount?: bigint
  networkId?: Buffer
  domain?: string
} = {}): Uint8Array {
  const args = options
  const map = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('domain'),
      val: xdr.ScVal.scvSymbol(args.domain ?? 'chancmmt'),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('network'),
      val: nativeToScVal(args.networkId ?? networkId),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('channel'),
      val: new Address(args.channel ?? CHANNEL).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('amount'),
      val: nativeToScVal(args.amount ?? BigInt(AMOUNT_BASE), { type: 'i128' }),
    }),
  ])
  return map.toXDR()
}

const binding = { channel: CHANNEL, amountBase: AMOUNT_BASE, network: NETWORK }

// ---------------------------------------------------------------------------

section('An honest commitment is accepted')
{
  const bytes = commitmentBytes()
  let threw = ''
  try {
    await assertCommitmentBinds(bytes, binding)
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('the correctly built commitment binds', threw === '', threw)
}

section('A commitment for a different channel is refused')
{
  // The attack: a valid signature over a commitment for ANOTHER channel, replayed here. If
  // binding were not checked first, the funds would come from this channel while being
  // authorized by the other one.
  const other = OTHER_CHANNEL
  let threw = ''
  try {
    await assertCommitmentBinds(commitmentBytes({ channel: other }), binding)
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('a commitment bound to another channel is refused', threw.includes('channel mismatch'), threw)
}

section('A commitment for a different amount is refused')
{
  // The attack: authorize one unit, claim a million. Without binding this is unlimited
  // withdrawal from a single signature.
  let threw = ''
  try {
    await assertCommitmentBinds(commitmentBytes({ amount: 1n }), binding)
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('a commitment for one base unit is refused when a million is claimed', threw.includes('amount mismatch'), threw)
}

section('A commitment from another network is refused')
{
  // The attack: replay a mainnet-signed commitment on testnet, where it is worth nothing but
  // still verifies as a signature.
  const otherNetworkId = hash(Buffer.from(NETWORK_PASSPHRASE['stellar:pubnet']))
  let threw = ''
  try {
    await assertCommitmentBinds(commitmentBytes({ networkId: otherNetworkId }), binding)
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('a pubnet commitment is refused on testnet', threw.includes('network mismatch'), threw)
}

section('A commitment with another domain is refused')
{
  // The domain separator is what stops this signature being reused as some other signed
  // payload that happens to be 104 bytes.
  let threw = ''
  try {
    await assertCommitmentBinds(commitmentBytes({ domain: 'othercmt' }), binding)
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('a commitment under another domain is refused', threw.includes('domain mismatch'), threw)
}

section('Garbage is refused')
{
  for (const [label, bytes] of [
    ['empty bytes', new Uint8Array(0)],
    ['random bytes', new Uint8Array([1, 2, 3, 4, 5])],
    ['truncated commitment', commitmentBytes().slice(0, 20)],
  ] as const) {
    let threw = ''
    try {
      await assertCommitmentBinds(bytes, binding)
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check(`${label} is refused`, threw !== '', threw)
  }
}

section('A malformed amount never reaches the comparison')
{
  let threw = false
  try {
    await assertCommitmentBinds(commitmentBytes(), {
      channel: CHANNEL,
      amountBase: '1e6',
      network: NETWORK,
    })
  } catch (error) {
    threw = error instanceof CommitmentBindingError
  }
  check('scientific notation is rejected as base units', threw)
}

section('Signature verification only accepts the payer key')
{
  const bytes = commitmentBytes()
  const org = Keypair.random()
  const other = Keypair.random()
  const payerKey = org.publicKey()
  const signature = org.sign(Buffer.from(bytes))

  check('the payer signature verifies', verifyCommitmentSignature(bytes, signature, payerKey) === true)
  check(
    "another key's signature is refused",
    verifyCommitmentSignature(bytes, other.sign(Buffer.from(bytes)), payerKey) === false,
  )

  const flipped = Buffer.from(signature)
  flipped.writeUInt8(flipped.readUInt8(0) ^ 0xff, 0)
  check('a single flipped signature bit is refused', verifyCommitmentSignature(bytes, flipped, payerKey) === false)

  // Signature over different bytes than the ones being presented.
  check(
    'a signature over other bytes is refused',
    verifyCommitmentSignature(bytes, org.sign(Buffer.from(commitmentBytes({ amount: 1n }))), payerKey) === false,
  )

  for (const [label, sig] of [
    ['an empty signature', new Uint8Array(0)],
    ['a short signature', new Uint8Array(63)],
    ['a long signature', new Uint8Array(65)],
  ] as const) {
    let threw = false
    try {
      verifyCommitmentSignature(bytes, sig, payerKey)
    } catch (error) {
      threw = error instanceof CommitmentBindingError
    }
    check(`${label} is rejected`, threw)
  }

  check(
    'a different valid ed25519 public key cannot validate the payer signature',
    verifyCommitmentSignature(bytes, signature, Keypair.random().publicKey()) === false,
  )
}

section('The full gate requires binding AND signature')
{
  const org = Keypair.random()
  const other = Keypair.random()
  const payerKey = org.publicKey()
  const bytes = commitmentBytes()

  let threw = ''
  try {
    await assertWithdrawableByFunder({
      commitmentBytes: bytes,
      signature: org.sign(Buffer.from(bytes)),
      commitmentPublicKey: payerKey,
      ...binding,
    })
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('an honest withdrawal passes the gate', threw === '', threw)

  // Bound to another channel AND signed by this payer. Signature valid, meaning false.
  let crossChannel = ''
  try {
    await assertWithdrawableByFunder({
      commitmentBytes: commitmentBytes({ channel: OTHER_CHANNEL }),
      signature: org.sign(Buffer.from(commitmentBytes({ channel: OTHER_CHANNEL }))),
      commitmentPublicKey: payerKey,
      ...binding,
    })
  } catch (error) {
    crossChannel = error instanceof Error ? error.message : String(error)
  }
  check(
    "even the payer's own signature cannot authorize another channel",
    crossChannel.includes('channel mismatch'),
    crossChannel,
  )

  // Right channel and amount, wrong signer.
  let wrongSigner = ''
  try {
    await assertWithdrawableByFunder({
      commitmentBytes: bytes,
      signature: other.sign(Buffer.from(bytes)),
      commitmentPublicKey: payerKey,
      ...binding,
    })
  } catch (error) {
    wrongSigner = error instanceof Error ? error.message : String(error)
  }
  check(
    'a valid signature from a different key does not pass',
    wrongSigner.includes('is not by funder key'),
    wrongSigner,
  )
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFailing:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('Commitment binding holds.')
