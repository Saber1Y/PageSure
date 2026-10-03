'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createSession, sessionCookieName, sessionTtlMs, verifyLogin } from '@/lib/auth/session'

/**
 * Login server action.
 *
 * Lives in its own module rather than in page.tsx. A page that exports an action AND
 * gets imported by a Client Component pulls its whole import graph into the client
 * bundle, which dragged better-sqlite3 (via auth/session -> db/client) into the browser
 * build. Keeping the action in a 'use server' module lets Next split it correctly.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')

  const user = verifyLogin(email, password)
  if (!user) redirect('/login?error=1')

  const store = await cookies()
  const { token } = createSession(user.id, null)
  store.set(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(sessionTtlMs() / 1000),
  })

  redirect('/overview')
}