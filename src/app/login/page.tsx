import { redirect } from 'next/navigation'
import { currentUser, sessionUserId } from '@/lib/auth/session'
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

  /*
   * Three states, not two.
   *
   * currentUser() resolves only somebody with a tenant, so a bare cookie check used to sit in
   * front of it - and that check is wrong for the state in between. Somebody who has proven an
   * address and not yet joined or created an organization has a perfectly valid session and no
   * organization, so they were redirected to /overview, bounced by the dashboard shell back to
   * /login, and sent round again. That is the loop somebody hits after redeeming a sign-in link
   * and then opening /login in the same browser.
   *
   * Asking the session who they are, rather than asking whether a cookie exists, also handles a
   * stale or revoked cookie: it resolves to nobody and the form renders, which is correct.
   */
  if (await currentUser()) redirect(returnTo || '/overview')
  if (await sessionUserId()) redirect('/onboarding')

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