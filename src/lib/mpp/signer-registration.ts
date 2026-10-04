/**
 * Operator policy for channel signer registration.
 *
 * An organization registers a signer URL and the name of an environment variable holding its
 * token. PageSure reads the token from its own process and sends it as a bearer credential, so
 * an unrestricted registration would be a credential-exfiltration primitive rather than a
 * feature: signup could point the URL at any host and name any variable, and the next
 * settlement request would hand that process secret to the caller.
 *
 * Registration is therefore constrained by operator policy, not by the tenant:
 *
 *   - the URL must be HTTPS and its host must appear in MPP_SIGNER_HOSTS
 *   - the variable name must start with MPP_SIGNER_TOKEN_PREFIX
 *   - the variable must actually be set in this process, so a name that is never provisioned
 *     fails at signup rather than at first settlement
 *
 * With no policy configured, signer registration is simply unavailable. That is the safe default:
 * an operator who has not declared which hosts may receive their secrets gets no self-service
 * signer registration at all.
 */

export interface SignerRegistrationInput {
  signerUrl?: string | null
  signerTokenEnv?: string | null
}

export type SignerRegistrationResult =
  | { ok: true; signerUrl: string; signerTokenEnv: string }
  | { ok: false; reason: string }

/** Hosts permitted to receive an organization signer token, from MPP_SIGNER_HOSTS (comma separated). */
function allowedHosts(): Set<string> {
  const raw = process.env.MPP_SIGNER_HOSTS ?? ''
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  )
}

/** Required prefix for token variable names, from MPP_SIGNER_TOKEN_PREFIX. */
function tokenPrefix(): string {
  return process.env.MPP_SIGNER_TOKEN_PREFIX ?? ''
}

/** Whether self-service signer registration is possible at all. */
export function signerRegistrationAvailable(): boolean {
  return allowedHosts().size > 0 && tokenPrefix().length > 0
}

/**
 * Validate a proposed signer registration.
 *
 * Returns the normalized values to store, or a reason the caller cannot register one. Absence of
 * both fields is valid and means "this organization does not use external signer settlement";
 * providing one without the other is rejected, since a half-registered signer would fail at
 * settlement time instead of at registration time.
 */
export function validateSignerRegistration(input: SignerRegistrationInput): SignerRegistrationResult {
  const url = input.signerUrl?.trim() ?? ''
  const tokenEnv = input.signerTokenEnv?.trim() ?? ''

  if (!url && !tokenEnv) return { ok: false, reason: 'no signer registration supplied' }
  if (!url || !tokenEnv) {
    return {
      ok: false,
      reason: 'a signer URL and token variable name must be provided together',
    }
  }

  const hosts = allowedHosts()
  const prefix = tokenPrefix()
  if (hosts.size === 0 || prefix.length === 0) {
    return {
      ok: false,
      reason: 'this deployment does not allow self-service signer registration',
    }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'the signer URL is not a valid URL' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'the signer URL must use https' }
  }
  if (parsed.username || parsed.password) {
    // Embedded credentials would be sent to the signer host alongside the bearer token.
    return { ok: false, reason: 'the signer URL must not embed credentials' }
  }

  // Exact host match. No suffix matching: allowing "example.com" must not implicitly allow
  // "evil-example.com" or "example.com.attacker.net".
  if (!hosts.has(parsed.hostname.toLowerCase())) {
    return { ok: false, reason: `the signer host ${parsed.hostname} is not permitted by this deployment` }
  }

  if (!tokenEnv.startsWith(prefix)) {
    return {
      ok: false,
      reason: `the token variable name must start with ${prefix}`,
    }
  }
  if (!/^[A-Z0-9_]+$/.test(tokenEnv)) {
    return { ok: false, reason: 'the token variable name contains unsupported characters' }
  }
  if (!process.env[tokenEnv]) {
    // Caught now rather than at first settlement. The variable name is the whole reason the
    // token is not stored, so an unset name means the registration cannot work.
    return { ok: false, reason: `${tokenEnv} is not set in this process` }
  }

  return {
    ok: true,
    signerUrl: parsed.toString(),
    signerTokenEnv: tokenEnv,
  }
}