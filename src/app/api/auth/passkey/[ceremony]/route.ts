import { NextResponse } from 'next/server'
import { requireUser, createSession, sessionCookieName } from '@/lib/auth/session'
import {
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from '@/lib/auth/passkey'
import { db } from '@/lib/db/client'
import { loginChallenges, passkeys } from '@/lib/db/schema'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { cookies } from 'next/headers'
import type {
  VerifyAuthenticationResponseOpts,
  VerifyRegistrationResponseOpts,
} from '@simplewebauthn/server'

/**
 * Complete a WebAuthn ceremony.
 *
 * The companion to [ceremony]/begin, which issues options and stores the challenge. This
 * route consumes that challenge atomically, verifies the ceremony, and mints the same
 * session token the wallet path mints.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ ceremony: string }> }): Promise<NextResponse> {
  const { ceremony } = await ctx.params
  if (ceremony !== 'register' && ceremony !== 'authenticate') {
    return NextResponse.json({ error: 'unknown ceremony' }, { status: 404 })
  }

  const body = (await req.json().catch(() => null)) as {
    challengeId?: string
    response?: unknown
    label?: string
  } | null

  if (!body?.challengeId || !body.response) {
    return NextResponse.json({ error: 'missing challengeId or response' }, { status: 400 })
  }

  // Consume the challenge atomically. The isNull(consumedAt) guard is what makes a
  // captured assertion single-use.
  const claimed = db()
    .update(loginChallenges)
    .set({ consumedAt: Date.now() })
    .where(
      and(
        eq(loginChallenges.id, body.challengeId),
        eq(loginChallenges.purpose, ceremony === 'register' ? 'enrol' : 'login'),
        isNull(loginChallenges.consumedAt),
        gt(loginChallenges.expiresAt, Date.now()),
      ),
    )
    .run()

  if (claimed.changes === 0) {
    return NextResponse.json({ error: 'challenge expired or already used' }, { status: 400 })
  }
  const row = db().select().from(loginChallenges).where(eq(loginChallenges.id, body.challengeId)).get()
  if (!row) return NextResponse.json({ error: 'challenge not found' }, { status: 400 })

  if (ceremony === 'register') {
    // Re-check the session: the challenge being unexpired is not authorisation to enrol.
    const user = await requireUser().catch(() => null)
    if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

    let verified: Awaited<ReturnType<typeof verifyPasskeyRegistration>>
    try {
      verified = await verifyPasskeyRegistration({
        response: body.response as VerifyRegistrationResponseOpts['response'],
        expectedChallenge: row.challenge,
      })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'registration failed' },
        { status: 400 },
      )
    }

    db()
      .insert(passkeys)
      .values({
        id: `pk_${randomBytes(12).toString('hex')}`,
        userId: user.id,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        counter: verified.counter,
        transports: JSON.stringify(verified.transports),
        label: (body.label ?? 'Passkey').slice(0, 60),
        createdAt: Date.now(),
      })
      .run()

    return NextResponse.json({ ok: true, credentialId: verified.credentialId })
  }

  // Authentication: resolve the user from the credential id the browser returned, which
  // is what makes a usernameless login possible.
  const presented = (body.response as { id?: string; rawId?: string }).id
  const credentialId = presented ?? (body.response as { rawId?: string }).rawId
  if (!credentialId) return NextResponse.json({ error: 'missing credential id' }, { status: 400 })

  const stored = db().select().from(passkeys).where(eq(passkeys.credentialId, credentialId)).get()
  if (!stored) return NextResponse.json({ error: 'unknown credential' }, { status: 404 })

  let result: Awaited<ReturnType<typeof verifyPasskeyAuthentication>>
  try {
    result = await verifyPasskeyAuthentication({
      response: body.response as VerifyAuthenticationResponseOpts['response'],
      expectedChallenge: row.challenge,
      credential: {
        id: stored.credentialId,
        publicKey: stored.publicKey,
        counter: stored.counter,
        transports: stored.transports,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'authentication failed' },
      { status: 401 },
    )
  }

  // simplewebauthn already rejects a counter that moves backwards (a cloned
  // authenticator); persisting the new value keeps the next ceremony honest.
  db()
    .update(passkeys)
    .set({ counter: result.newCounter, lastUsedAt: Date.now() })
    .where(eq(passkeys.id, stored.id))
    .run()

  const { token, expiresAt } = createSession(stored.userId, null)
  ;(await cookies()).set(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor((expiresAt - Date.now()) / 1000),
  })

  return NextResponse.json({ ok: true })
}