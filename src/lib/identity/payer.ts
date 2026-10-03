import { StrKey } from '@stellar/stellar-sdk'

/**
 * Payer identity resolution.
 *
 * Two distinct concepts, deliberately never conflated:
 *
 *   claimed  - who the caller SAYS it is. From an unverified credential payload or
 *              from the `X-Pagesure-Payer` header / `?payer=` query. Untrusted.
 *              Usable only to pick a policy and to reject early.
 *
 *   verified - who actually controls the funds. Read from the MPP credential AFTER
 *              mppx has cryptographically verified it. The only identity allowed to
 *              authorise an upstream call.
 *
 * Decoding the credential ourselves is advisory and never replaces mppx
 * verification, which stays the sole authority on whether money moved.
 */

export type PayerSource = 'credential' | 'header' | 'query' | 'session' | 'none'

export interface ClaimedPayer {
  address: string | null
  source: PayerSource
}

const DID_PREFIX = 'did:pkh:'

/** True when `value` is a valid Stellar ed25519 public key. */
export function isValidStellarAccount(value: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(value)
  } catch {
    return false
  }
}

/** Extract a Stellar address from a DID or return the value if it is already an address. */
export function addressFromDid(did: string | undefined | null): string | null {
  if (!did) return null
  const value = did.startsWith(DID_PREFIX) ? did.slice(DID_PREFIX.length) : did
  // did:pkh:stellar:testnet:GABC... -> strip the method-specific part too.
  const parts = value.split(':')
  const candidate = parts[parts.length - 1] ?? ''
  return isValidStellarAccount(candidate) ? candidate : null
}

interface DecodedCredential {
  challenge?: { id?: string; method?: string; intent?: string; expires?: string }
  payload?: { type?: string } & Record<string, unknown>
  source?: string
}

/**
 * Decode `Authorization: Payment <base64url>` without verifying anything.
 *
 * Returns null when the header is absent or unparseable. A malformed credential is
 * NOT an error here: mppx will produce the authoritative rejection. This function
 * only answers "who is this claiming to be, and which challenge is it answering".
 */
export function decodeCredential(headers: Headers): DecodedCredential | null {
  const raw =
    headers.get('authorization') ?? headers.get('Payment-Authorization') ?? headers.get('payment-authorization')
  if (!raw) return null

  const match = /^Payment\s+(.+)$/i.exec(raw.trim())
  if (!match?.[1]) return null

  try {
    const base64 = match[1].trim().replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as DecodedCredential
  } catch {
    return null
  }
}

/**
 * Resolve the claimed (untrusted) payer.
 *
 * Order matters: a real credential beats a declared header, because the credential
 * at least carries a signature we can cross-check later even though we do not verify
 * it here. The declared header is a pure convenience for the very first request,
 * where no credential exists yet.
 */
export function resolveClaimedPayer(request: Request): ClaimedPayer {
  const credential = decodeCredential(request.headers)
  if (credential) {
    const fromCredential = addressFromDid(credential.source)
    if (fromCredential) return { address: fromCredential, source: 'credential' }
  }

  const header = request.headers.get('x-pagesure-payer')
  if (header && isValidStellarAccount(header.trim())) {
    return { address: header.trim(), source: 'header' }
  }

  const query = new URL(request.url).searchParams.get('payer')
  if (query && isValidStellarAccount(query.trim())) {
    return { address: query.trim(), source: 'query' }
  }

  return { address: null, source: 'none' }
}

/** The challenge id a credential is answering, for correlating gateway rows. */
export function credentialChallengeId(request: Request): string | null {
  return decodeCredential(request.headers)?.challenge?.id ?? null
}

/** The credential payload type: 'transaction' (pull) | 'signedHash' | 'hash' (push). */
export function credentialPayloadType(request: Request): string | null {
  const payload = decodeCredential(request.headers)?.payload
  return typeof payload?.type === 'string' ? payload.type : null
}