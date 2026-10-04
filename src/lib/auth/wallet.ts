import { StrKey, verify as ed25519Verify } from '@stellar/stellar-sdk'
import { randomBytes } from 'node:crypto'

/**
 * Wallet sign-in (SEP-0007 shape, self-certifying).
 *
 * Why a wallet and not a password: an operator already holds the key they would otherwise
 * have to protect in a second secret. Making them prove control of a key they keep is
 * strictly better than storing another credential server-side.
 *
 * The protocol:
 *
 *   server -> client   random 32 bytes, domain-separated, stored with an expiry
 *   client -> server   base64 signature over those bytes
 *   server             verifies against the key the client NAMED, consumes the row
 *
 * Three properties do the real work:
 *
 *  1. The challenge is single-use and persisted, so a captured signature is worthless once
 *     the row is consumed.
 *
 *  2. The challenge is bound to the claimed key and domain-separated, so it can never be
 *     replayed as a payment authorization or as another purpose's challenge.
 *
 *  3. SELF-CERTIFYING. This is the important change from the previous allowlist design:
 *     the verified key is the one the client named, not one read from configuration. That
 *     is what lets an unknown wallet sign up without anyone provisioning it first.
 *
 * What that third property does NOT mean: a valid signature is AUTHENTICATION ONLY. It
 * proves "the caller controls this key" and nothing more. It grants no access to any
 * organization's data. Authorization is `user -> organization -> role`, enforced by
 * requireUser(). Do not add an allowlist back here to compensate — the access decision
 * belongs in one place, and that place is not this file.
 */

/** Seconds a challenge stays valid. Short, because it is single-use anyway. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000

/**
 * Challenge domain separator.
 *
 * Signed bytes are prefixed so a signature captured here can never be replayed as some
 * other message that happens to use the same key — a payment authorization, for instance.
 * The version string means the scheme can be rotated later without silently accepting
 * challenges issued under the old one.
 */
const DOMAIN = 'pagesure:console-auth:v2'

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
  | { ok: false; reason: 'malformed' | 'wrong_signer' | 'bound_mismatch' | 'bad_claim' }

/**
 * Verify a signature over a challenge against the key the client claims.
 *
 * `claimedPublicKey` arrives from the request, which is the point: this is
 * proof-of-possession, not an allowlist check. A caller who generates a fresh keypair and
 * names it here gets a truthful "yes, you control that key" — and nothing else. Whether
 * that key may reach any data is decided by organization membership, not here.
 *
 * `boundPublicKey` is the address the challenge was issued to, when one was recorded.
 * Enforcing it means a challenge minted for one wallet cannot be answered by another,
 * which keeps a challenge captured in transit from being completed by whoever holds it.
 *
 * Note the StrKey.decodeEd25519PublicKey() call: the SDK's verify() wants 32 raw bytes
 * and throws on the 56-character `G...` form. Passing the string straight through is the
 * easiest mistake to make here.
 */
export function verifyChallengeSignature(
  challenge: string,
  signatureBase64url: string,
  claimedPublicKey: string,
  boundPublicKey?: string | null,
): SignatureCheck {
  if (!claimedPublicKey || !StrKey.isValidEd25519PublicKey(claimedPublicKey)) {
    return { ok: false, reason: 'bad_claim' }
  }
  if (boundPublicKey && boundPublicKey !== claimedPublicKey) {
    return { ok: false, reason: 'bound_mismatch' }
  }

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
    rawKey = StrKey.decodeEd25519PublicKey(claimedPublicKey)
  } catch {
    return { ok: false, reason: 'bad_claim' }
  }

  let verified = false
  try {
    verified = ed25519Verify(challengeBytes(challenge), signature, rawKey)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  // Well-formed signature that simply does not belong to the claimed key. Distinct from
  // `malformed` because the bytes were fine — the identity was not.
  return verified
    ? { ok: true, publicKey: claimedPublicKey }
    : { ok: false, reason: 'wrong_signer' }
}
