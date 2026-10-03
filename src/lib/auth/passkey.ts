import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type {
  AuthenticatorTransport,
  VerifyAuthenticationResponseOpts,
  VerifyRegistrationResponseOpts,
} from '@simplewebauthn/server'

/**
 * WebAuthn passkeys.
 *
 * A passkey is the everyday way into this console: biometric or device PIN, nothing to
 * copy, nothing to paste, and no secret for the operator to store.
 *
 * The security model is the important part:
 *
 *   - A passkey can only be REGISTERED from an already-authenticated session, and only
 *     for the user already signed in. There is no "register a passkey" endpoint that
 *     trusts a request on its own, so a passkey can never be the thing that bootstraps
 *     an account. Wallet sign-in is the only root.
 *   - The signature counter is checked. If it moves backwards the authenticator has been
 *     cloned, and the credential is refused rather than silently trusted.
 *   - User verification is REQUIRED at every ceremony, so a stolen authenticator that
 *     cannot perform UV is not enough on its own.
 *
 * `rpID` comes from APP_URL rather than being hardcoded, because the WebAuthn ceremony
 * fails outright when the RP ID does not match the origin the browser is on. Deriving it
 * from configuration is what keeps this working on localhost and on a real domain without
 * a code change.
 */

function rpConfig(): { rpID: string; rpName: string; origin: string } {
  const origin = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    throw new Error('APP_URL is not a valid URL')
  }
  return { rpID: host, rpName: process.env.PROVIDER_LABEL ?? 'PageSure', origin }
}

/**
 * The transports column holds a JSON array as text, but WebAuthn wants a real sequence of
 * strings. Handing it the raw JSON string fails the whole ceremony with "The provided value
 * cannot be converted to a sequence", which breaks `excludeCredentials` and therefore
 * blocks registering any SECOND passkey for a user who already has one.
 *
 * Decoding is deliberately total: an absent, malformed or unexpected shape degrades to an
 * empty list, because transports are a hint the authenticator may ignore, whereas throwing
 * here would lock the operator out of adding another device.
 */
function decodeTransports(raw: string | null | undefined): AuthenticatorTransport[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is AuthenticatorTransport => typeof t === 'string')
  } catch {
    return []
  }
}

export async function passkeyRegistrationOptions(
  user: { id: string; name: string },
  existing: { credentialId: string; transports: string }[] = [],
) {
  const { rpID, rpName } = rpConfig()
  return await generateRegistrationOptions({
    rpID,
    rpName,
    // WebAuthn wants the user handle as raw bytes, max 64. A stable id from our own
    // namespace, not the email, so the handle survives an email change.
    userID: new TextEncoder().encode(user.id),
    userName: user.name,
    userDisplayName: user.name,
    attestationType: 'none',
    // Tell the authenticator which credentials it already holds, so registering the same
    // physical key twice is refused at the ceremony rather than silently creating a second
    // row for one device.
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: decodeTransports(c.transports),
    })),
    authenticatorSelection: {
      residentKey: 'required',
      // UV required: a passkey that cannot verify the human is not an acceptable
      // second factor for a settlement console.
      userVerification: 'required',
    },
  })
}

export async function verifyPasskeyRegistration(params: {
  response: VerifyRegistrationResponseOpts['response']
  expectedChallenge: string
}) {
  const { rpID, origin } = rpConfig()
  const result = await verifyRegistrationResponse({
    response: params.response,
    expectedChallenge: params.expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  })

  if (!result.verified || !result.registrationInfo) {
    throw new Error('passkey registration could not be verified')
  }

  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo
  return {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    // Already a decoded AuthenticatorTransport[] from the library, not the JSON column,
    // so this one passes straight through.
    transports: credential.transports ?? [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  }
}

export async function passkeyAuthenticationOptions(credentials: { credentialId: string; transports: string }[]) {
  const { rpID } = rpConfig()
  return await generateAuthenticationOptions({
    rpID,
    // No allowCredentials list: this is a discoverable-credential ("usernameless")
    // login. The browser offers whichever passkey it holds for this RP ID, and the
    // server resolves the user from the credential id that comes back.
    allowCredentials: credentials.length
      ? credentials.map((c) => ({ id: c.credentialId, transports: decodeTransports(c.transports) }))
      : undefined,
    userVerification: 'required',
  })
}

export async function verifyPasskeyAuthentication(params: {
  response: VerifyAuthenticationResponseOpts['response']
  expectedChallenge: string
  credential: { id: string; publicKey: string; counter: number; transports: string | null }
}) {
  const { rpID, origin } = rpConfig()
  const result = await verifyAuthenticationResponse({
    response: params.response,
    expectedChallenge: params.expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: params.credential.id,
      publicKey: Buffer.from(params.credential.publicKey, 'base64url'),
      counter: params.credential.counter,
      transports: decodeTransports(params.credential.transports),
    },
  })

  if (!result.verified) throw new Error('passkey authentication failed')

  return {
    newCounter: result.authenticationInfo.newCounter,
    // False when the authenticator reports no backup; we record it rather than
    // refusing, because refusing would lock out legitimate users on some platforms.
    backedUp: result.authenticationInfo.credentialBackedUp,
  }
}