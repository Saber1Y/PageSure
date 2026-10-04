import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { currentUser, sessionCookieName } from '@/lib/auth/session'
import { Card } from '@/components/ui/primitives'
import { LoginPanel } from '@/components/dashboard/login-form'
import { Brand } from '@/components/ui/brand'
import { safeReturnTo } from '@/lib/auth/return-to'

export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const raw = params.returnTo
  // Sanitized here as well as at the point of use: the login page also decides where an
  // *already authenticated* visitor goes, so an unchecked value would be an open redirect even
  // for people who never see the form.
  const returnTo = safeReturnTo(typeof raw === 'string' ? raw : undefined, '')

  const store = await cookies()
  if (store.get(sessionCookieName())) redirect(returnTo || '/overview')

  // currentUser() rather than a bare cookie check: the cookie alone proves nothing, and a
  // stale or revoked cookie would otherwise bounce an authenticated visitor into a loop
  // through a page that is pointless for them.
  if (await currentUser()) redirect(returnTo || '/overview')

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <Brand href="/" />
          <h1 className="mt-6 text-[26px] leading-tight font-semibold tracking-tight">
            Provider console
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-3">
            Sign in with your work email. A Stellar wallet is only needed later, when you
            connect the account your payments settle into.
          </p>
        </div>
        <Card className="p-5">
          <LoginPanel returnTo={returnTo} />
        </Card>
      </div>
    </div>
  )
}