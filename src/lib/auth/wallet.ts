import { StrKey, verify as ed25519Verify } from '@stellar/stellar-sdk'
import { randomBytes } from 'node:crypto'

/**
 * Wallet sign-in (SEP-0007 shape).
 *
 * Why a wallet and not a password: the operator of a payment gateway already holds the
 * keypair that receives settlements. Making them protect a second secret — stored in a
 * .env file that ships with the repo, like the one this replaces — is strictly worse
 * than making them prove control of a key they already keep.
 *
 * The protocol:
 *
 *   server -> client   random 32 bytes, base64url, stored with an expiry
 *   client -> server   base64url signature over those bytes
 *   server             verifies against the expected public key, consumes the row
 *
 * Two properties do the real work:
 *
 *  1. The challenge is single-use. A captured signature is worthless once the row is
 *     consumed, which is why the challenge is persisted rather than kept in memory.
 *
 *  2. The EXPECTED key comes from configuration (PROVIDER_RECIPIENT_G), never from the
 *     request. A client that signs a challenge with its own freshly generated keypair
 *     and claims that key as the identity proves nothing — the signature is valid and
 *     the identity is still checked against the configured settlement wallet.
 */

/** Wallet whose control grants console access. The single source of truth. */
export function configuredOperatorWallet(): string {
  const key = process.env.PROVIDER_RECIPIENT_G?.trim()
  if (!key) throw new Error('PROVIDER_RECIPIENT_G is not set')
  if (!StrKey.isValidEd25519PublicKey(key)) {
    throw new Error('PROVIDER_RECIPIENT_G is not a valid Stellar ed25519 public key')
  }
  return key
}

/** Seconds a challenge stays valid. Short, because it is single-use anyway. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000

/**
 * Challenge domain separator.
 *
 * Signed bytes are prefixed so a signature captured here can never be replayed as some
 * other message that happens to use the same key — a payment authorization, for
 * instance. The version string means the scheme can be rotated later without silently
 * accepting challenges issued under the old one.
 */
const DOMAIN = 'pagesure:console-auth:v1'

export function issueChallenge(): { challenge: string; expiresAt: number } {
  const raw = randomBytes(32)
  const challenge = `${DOMAIN}:${raw.toString('base64url')}`
  return { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS }
}

/** The exact bytes a wallet must sign for a given challenge. */
export function challengeBytes(challenge: string): Buffer {
  if (!challenge.startsWith(`${DOMAIN}:`)) {
    throw new Error('challenge was not issued by this server')
  }
  return Buffer.from(challenge, 'utf8')
}

export type SignatureCheck =
  | { ok: true; publicKey: string }
  | { ok: false; reason: 'malformed' | 'wrong_signer' | 'not_configured' }

/**
 * Verify a signature over a challenge.
 *
 * `expectedPublicKey` is passed in by the caller from configuration, never from the
 * request body. The returned key is only ever the expected one — a valid signature from
 * the WRONG wallet is a failure, not an identity.
 *
 * Note the StrKey.decodeEd25519PublicKey() call: the SDK's verify() wants 32 raw bytes
 * and throws on the 56-character `G...` form. Passing the string straight through is the
 * easiest mistake to make here.
 */
export function verifyChallengeSignature(
  challenge: string,
  signatureBase64url: string,
  expectedPublicKey: string,
): SignatureCheck {
  if (!StrKey.isValidEd25519PublicKey(expectedPublicKey)) return { ok: false, reason: 'not_configured' }

  let signature: Buffer
  try {
    signature = Buffer.from(signatureBase64url, 'base64url')
    // A 64-byte ed25519 signature is the only valid length; reject the rest before
    // handing junk to the verifier.
    if (signature.length !== 64) return { ok: false, reason: 'malformed' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  let rawKey: Buffer
  try {
    rawKey = StrKey.decodeEd25519PublicKey(expectedPublicKey)
  } catch {
    return { ok: false, reason: 'not_configured' }
  }

  let verified = false
  try {
    verified = ed25519Verify(challengeBytes(challenge), signature, rawKey)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  return verified ? { ok: true, publicKey: expectedPublicKey } : { ok: false, reason: 'wrong_signer' }
}
