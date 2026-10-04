/**
 * Client for an organization's channel signer service.
 *
 * PageSure never holds a channel private key. Settlement needs an ed25519 signature from the
 * organization's commitment key, and that signature comes from a service the organization
 * runs and controls. This module is the entire trust surface between the two.
 *
 * The protocol is deliberately dull, because everything interesting is in what it refuses:
 *
 *   - PageSure sends the exact commitment bytes it verified, and the signer signs those bytes
 *     verbatim. The signer cannot substitute a different channel or amount, because it never
 *     constructs the payload; it only signs what it was handed. It does not even need Stellar
 *     RPC access.
 *   - PageSure re-checks the binding and the signature locally afterwards. A signer that
 *     returns something unexpected is caught here rather than on-chain, where it would cost a
 *     transaction.
 *
 * The signer is not asked to sign anything until PageSure has confirmed the bytes bind to the
 * intended channel, amount and network.
 */

import { assertCommitmentBinds, verifyCommitmentSignature, CommitmentBindingError } from './commitment'

/** Body PageSure posts to the signer. */
export interface SignCommitmentRequest {
  /** Commitment bytes, hex encoded, exactly as PageSure received them. */
  commitment: string
  /** Echoed back for the signer's own logging and for operator sanity. */
  context: {
    channel: string
    amountBase: string
    network: string
  }
}

/** What a conforming signer returns. */
export interface SignCommitmentResponse {
  /** 64-byte ed25519 signature over `commitment`, hex encoded. */
  signature: string
}

export class SignerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignerError'
  }
}

/**
 * How the request is actually sent. Defaults to global fetch.
 *
 * This exists so the protocol can be tested against a local server without disabling TLS
 * verification anywhere. It does not relax anything: `assertUsableUrl` runs first and
 * unconditionally, so an http signer url is refused before this is ever called.
 */
export type SignerTransport = (
  url: string,
  init: { method: string; signal: AbortSignal; headers: Record<string, string>; body: string },
) => Promise<Response>

/** Registered signer for an organization. */
export interface OrganizationSigner {
  /** Absolute https URL of the signer's sign endpoint. */
  url: string
  /** Bearer token PageSure presents to the signer. */
  token: string
}

const TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 8 * 1024

function hexToBytes(hex: string, expectedBytes: number, label: string): Uint8Array {
  const clean = hex.trim().toLowerCase()
  if (!/^[0-9a-f]*$/.test(clean) || clean.length !== expectedBytes * 2) {
    throw new SignerError(
      `${label} is not ${expectedBytes} bytes of hex (got ${clean.length / 2} bytes)`,
    )
  }
  return Buffer.from(clean, 'hex')
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** A signer URL must be https and absolute. Plain http would put a bearer token on the wire. */
function assertUsableUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SignerError(`signer url is not a valid URL: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new SignerError(`signer url must be https, refusing ${parsed.protocol}`)
  }
  return parsed
}

/**
 * Ask the organization's signer to sign a commitment, and verify the result end to end.
 *
 * Returns the verified signature. Every failure throws, and nothing unverified is ever
 * returned to a caller that might submit it on-chain.
 */
export async function signCommitmentForOrganization(
  args: {
    signer: OrganizationSigner
    commitmentBytes: Uint8Array
    commitmentPublicKey: string
    channel: string
    amountBase: string
    network: string
  },
  transport: SignerTransport = fetch,
): Promise<Uint8Array> {
  const { signer, commitmentBytes, commitmentPublicKey, channel, amountBase, network } = args

  assertUsableUrl(signer.url)

  // Verify before the request, not after. There is no reason to ask an organization to sign
  // bytes that do not authorize what we are about to claim.
  try {
    await assertCommitmentBinds(commitmentBytes, { channel, amountBase, network })
  } catch (error) {
    throw new SignerError(
      `refusing to ask the signer to sign unbound commitment bytes: ${
        error instanceof CommitmentBindingError ? error.message : String(error)
      }`,
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response: Response
  try {
    response = await transport(signer.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${signer.token}`,
      },
      body: JSON.stringify({
        commitment: bytesToHex(commitmentBytes),
        context: { channel, amountBase, network },
      } satisfies SignCommitmentRequest),
    })
  } catch (error) {
    throw new SignerError(
      `signer at ${signer.url} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    // Deliberately does not echo the body. A signer error page can contain internal detail,
    // and none of it changes what PageSure should do.
    throw new SignerError(`signer at ${signer.url} returned HTTP ${response.status}`)
  }

  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new SignerError(`signer response is ${text.length} bytes, refusing to parse`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SignerError(`signer at ${signer.url} returned a body that is not JSON`)
  }

  const signatureHex = (parsed as Partial<SignCommitmentResponse> | null)?.signature
  if (typeof signatureHex !== 'string') {
    throw new SignerError(`signer at ${signer.url} returned no "signature" string`)
  }

  const signature = hexToBytes(signatureHex, 64, 'signer signature')

  // The check that makes the whole arrangement safe. A signer can return anything at all; only
  // a signature that verifies against the organization's key over commitment bytes bound to
  // this channel and amount is allowed out of this function.
  if (!verifyCommitmentSignature(commitmentBytes, signature, commitmentPublicKey)) {
    throw new SignerError(
      `signer at ${signer.url} returned a signature that is not by organization key ` +
        `${commitmentPublicKey}; refusing to use it`,
    )
  }

  return signature
}