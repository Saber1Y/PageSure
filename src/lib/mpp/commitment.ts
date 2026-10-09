/**
 * Commitment binding and signature verification for one-way channels.
 *
 * A channel withdrawal is authorized by an ed25519 signature, by the funder's
 * commitment key, over bytes the contract defines. Two things must therefore be true before
 * a settlement proceeds, and they are checked separately here:
 *
 *   1. The bytes really are a commitment for THIS channel, THIS cumulative amount, THIS
 *      network, under the `chancmmt` domain. Commitment bytes come from simulating
 *      `prepare_commitment`, which is unauthenticated and callable by anyone, so the bytes are
 *      untrusted input until decoded and compared against what we intended to authorize.
 *   2. The signature over those bytes really came from the funder's key.
 *
 * The order matters. Verifying the signature first proves only that *someone* signed
 * *something*; binding is what makes it mean "this much, from this channel".
 *
 * This module never sees a private key. It verifies; it cannot sign. Producing the signature
 * is the payer's job, which is why nothing here can be coerced into
 * moving funds.
 *
 * Note on the SDK: `@stellar/mpp` has an `assertCommitmentBinds`, but it is not reachable
 * through the package's public `exports` map, only via a blocked deep path into `dist/`.
 * Rather than reach past the package boundary, the decode is done here with public
 * `stellar-sdk` exports. PageSure only ever *reads* these bytes, so it needs the decoder, not
 * the encoder, and the encoder stays the contract's single source of truth.
 */

import {
  NETWORK_PASSPHRASE,
  type NetworkId,
} from '@stellar/mpp'
import { StrKey, hash, scValToNative, verify as ed25519Verify, xdr } from '@stellar/stellar-sdk'

/**
 * Domain separator embedded in every one-way-channel commitment.
 * `symbol_short!("chancmmt")` in the contract.
 */
export const COMMITMENT_DOMAIN = 'chancmmt'

/** The values a commitment must bind to before its signature is trusted. */
export interface CommitmentBinding {
  /** Channel contract address the withdrawal applies to. */
  channel: string
  /** Cumulative base-unit amount the commitment authorizes, as decimal digits. */
  amountBase: string
  /** Network the channel lives on. */
  network: NetworkId | string
}

export class CommitmentBindingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommitmentBindingError'
  }
}

function amountOf(amountBase: string): bigint {
  if (!/^-?\d+$/.test(amountBase)) {
    throw new CommitmentBindingError(
      `commitment amount is not a base-unit integer: ${JSON.stringify(amountBase)}`,
    )
  }
  return BigInt(amountBase)
}

function networkIdOf(network: string): Buffer {
  const passphrase = (NETWORK_PASSPHRASE as Record<string, string>)[network]
  if (!passphrase) {
    throw new CommitmentBindingError(`unknown network for commitment binding: ${network}`)
  }
  return hash(Buffer.from(passphrase))
}

/**
 * Decode commitment bytes and assert every field matches what we intended to authorize.
 *
 * The contract encodes the struct with `to_xdr`, which soroban produces as a `ScVal::Map`
 * keyed by field name. Anything that is not that shape is refused rather than partially
 * trusted.
 */
export async function assertCommitmentBinds(
  commitmentBytes: Uint8Array,
  binding: CommitmentBinding,
): Promise<void> {
  const expectedAmount = amountOf(binding.amountBase)

  let decoded: unknown
  try {
    decoded = scValToNative(xdr.ScVal.fromXDR(Buffer.from(commitmentBytes)))
  } catch (error) {
    throw new CommitmentBindingError(
      `commitment bytes are not decodable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new CommitmentBindingError('commitment bytes did not decode to a commitment struct')
  }

  const { domain, network, channel, amount } = decoded as Record<string, unknown>

  if (domain !== COMMITMENT_DOMAIN) {
    throw new CommitmentBindingError(
      `commitment domain mismatch (expected "${COMMITMENT_DOMAIN}", got "${String(domain)}")`,
    )
  }
  if (channel !== binding.channel) {
    throw new CommitmentBindingError(
      `commitment channel mismatch (expected "${binding.channel}", got "${String(channel)}")`,
    )
  }

  let decodedAmount: bigint
  try {
    decodedAmount = BigInt(amount as string | number | bigint)
  } catch {
    throw new CommitmentBindingError(`commitment amount is not an integer ("${String(amount)}")`)
  }
  if (decodedAmount !== expectedAmount) {
    throw new CommitmentBindingError(
      `commitment amount mismatch (expected ${expectedAmount}, got ${decodedAmount})`,
    )
  }

  // The network ID is the ledger's hash of the passphrase, which is what stops a signature
  // made on one network from being replayed on another where it is worth a different amount.
  if (
    !(network instanceof Uint8Array) ||
    Buffer.compare(Buffer.from(network), networkIdOf(binding.network)) !== 0
  ) {
    throw new CommitmentBindingError('commitment network mismatch')
  }
}

/**
 * Verify a commitment signature against the funder's public commitment key.
 *
 * Accepts the funder's G... ed25519 key (stored on the session) or the legacy M... encoding.
 * Only the public half is used, so this is safe to call with data from any source.
 */
export function verifyCommitmentSignature(
  commitmentBytes: Uint8Array,
  signature: Uint8Array,
  commitmentPublicKey: string,
): boolean {
  let rawKey: Buffer
  try {
    rawKey = Buffer.from(
      StrKey.isValidEd25519PublicKey(commitmentPublicKey)
        ? StrKey.decodeEd25519PublicKey(commitmentPublicKey)
        : StrKey.decodeMed25519PublicKey(commitmentPublicKey),
    )
  } catch {
    throw new CommitmentBindingError(
      `commitment key is not a valid G... (ed25519) or M... (med25519) public key: ${commitmentPublicKey}`,
    )
  }
  if (rawKey.length !== 32) {
    throw new CommitmentBindingError(
      `commitment key decoded to ${rawKey.length} bytes, expected 32`,
    )
  }
  if (signature.length !== 64) {
    throw new CommitmentBindingError(
      `commitment signature is ${signature.length} bytes, expected exactly 64`,
    )
  }

  try {
    return ed25519Verify(Buffer.from(commitmentBytes), Buffer.from(signature), rawKey)
  } catch {
    return false
  }
}

/**
 * Full gate for a withdrawal: binding first, then signature.
 *
 * Resolves only when the signature is by the funder's key over a commitment for the
 * requested channel, amount and network. Every failure throws, so a caller cannot accidentally
 * read a `false` as "proceed anyway".
 */
export async function assertWithdrawableByFunder(
  args: {
    commitmentBytes: Uint8Array
    signature: Uint8Array
    commitmentPublicKey: string
  } & CommitmentBinding,
): Promise<void> {
  await assertCommitmentBinds(args.commitmentBytes, args)
  if (!verifyCommitmentSignature(args.commitmentBytes, args.signature, args.commitmentPublicKey)) {
    throw new CommitmentBindingError(
      `commitment signature is not by funder key ${args.commitmentPublicKey} ` +
        `for channel ${args.channel} at ${args.amountBase}`,
    )
  }
}
