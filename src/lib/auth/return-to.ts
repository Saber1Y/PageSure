/**
 * Where to send somebody after they finish signing in.
 *
 * A `returnTo` is attacker-controlled: it arrives in a URL that anyone can put in an email, a
 * chat message or a browser address bar. Redirecting to it unchecked is the classic open
 * redirect, which turns a trusted sign-in into a convincing way to bounce somebody to a page
 * that looks like ours and is not.
 *
 * The rules are deliberately narrow rather than clever:
 *
 * - must be a single absolute path, so `https://evil.test` is rejected outright
 * - must not start with `//`, which browsers read as protocol-relative and would send the
 *   visitor to another host
 * - must not contain a backslash, because several browsers normalize `\` to `/` and
 *   `/\evil.test` would then become protocol-relative after all
 * - no control characters, which exist only to confuse the check above
 *
 * Anything that fails falls back to the caller's own default. Failing closed into a known-good
 * page is always better than failing open into somebody else's.
 */
export function safeReturnTo(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  if (value.length === 0 || value.length > 512) return fallback
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback
  if (!value.startsWith('/')) return fallback
  if (value.startsWith('//')) return fallback
  if (value.startsWith('/\\')) return fallback
  return value
}