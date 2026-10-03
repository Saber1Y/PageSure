import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/session'
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
} from '@/lib/auth/passkey'
import { db } from '@/lib/db/client'
import { loginChallenges, passkeys } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'

/**
 * Issue WebAuthn ceremony options and remember the challenge.
 *
 * Separate from the completion route because the browser needs options BEFORE it has
 * anything to send: the challenge has to be stored server-side first, or there would be
 * nothing to compare the response against.
 *
 * Registration REQUIRES a session (requireUser). There is deliberately no way to
 * register a passkey without already being authenticated, so a passkey can never be the
 * credential that bootstraps an account — wallet sign-in is the only root.
 *
 * Authentication is PUBLIC, and that asymmetry is the whole point: the ceremony that
 * SIGNED IN must be reachable while signed out. It sends no allowCredentials list, so
 * the browser offers whichever discoverable credential it holds for this RP ID and the
 * server resolves the user from the credential id that comes back.
 *
 * The WebAuthn challenge lives in the same login_challenges table as the wallet
 * challenge under a distinct purpose, so the two ceremonies cannot consume each other's
 * challenges and both get single-use semantics for free.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: Request, ctx: { params: Promise<{ ceremony: string }> }): Promise<NextResponse> {
  const { ceremony } = await ctx.params

  if (ceremony !== 'register' && ceremony !== 'authenticate') {
    return NextResponse.json({ error: 'unknown ceremony' }, { status: 404 })
  }

  const remember = (options: { challenge: string }, purpose: 'enrol' | 'login') => {
    // The stored row id MUST come back to the client. The completion route looks the row
    // up by id; returning only the WebAuthn options would leave the client holding the
    // challenge string with no way to name the row, and the ceremony would fail silently
    // after the browser had already done all the work.
    const challengeId = `chl_${randomBytes(12).toString('hex')}`
    db()
      .insert(loginChallenges)
      .values({
        id: challengeId,
        challenge: options.challenge,
        purpose,
        expiresAt: Date.now() + 5 * 60 * 1000,
        createdAt: Date.now(),
      })
      .run()
    return NextResponse.json({ ...options, challengeId })
  }

  if (ceremony === 'register') {
    const user = await requireUser().catch(() => null)
    if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

    const existing = db()
      .select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
      .from(passkeys)
      .where(eq(passkeys.userId, user.id))
      .all()
      .map((c) => ({ credentialId: c.credentialId, transports: c.transports ?? '[]' }))

    return remember(await passkeyRegistrationOptions({ id: user.id, name: user.displayName }, existing), 'enrol')
  }

  // Public. No user is known yet, so no credential list is sent.
  return remember(await passkeyAuthenticationOptions([]), 'login')
}