import { headers } from 'next/headers'

/**
 * Best-effort client identity for throttling.
 *
 * Every candidate header is client-controlled when the app is reached directly, so this is used
 * only to slow down casual attempts, never as an identity claim. The real limits are elsewhere:
 * a forged signature cannot verify, and a sign-in token is single-use.
 *
 * The order matters behind the deployed proxy chain (Vercel rewrite -> Caddy -> Next). Caddy
 * replaces `x-forwarded-for` with the address it was connected from, which is a Vercel edge
 * node, so reading it first puts every visitor behind the same few keys and one person's
 * attempts throttle everyone. Vercel's own headers carry the visitor and Caddy passes them
 * through untouched, so they are read first, then the generic ones.
 */
export async function throttleKey(): Promise<string> {
  const hdrs = await headers()
  const first = (value: string | null) => value?.split(',')[0]?.trim() || ''
  const ip =
    first(hdrs.get('x-vercel-forwarded-for')) ||
    first(hdrs.get('x-real-ip')) ||
    first(hdrs.get('x-forwarded-for')) ||
    'local'
  return ip.slice(0, 64)
}
