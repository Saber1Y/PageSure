import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import { sessionUserId } from '@/lib/auth/session'
import { Card } from '@/components/ui/primitives'
import { Brand } from '@/components/ui/brand'
import { NameOrganization } from '@/components/dashboard/onboarding'
import { PendingInvitations } from '@/components/dashboard/pending-invitations'
import { listPendingInvitations } from '@/lib/auth/identity'

export const dynamic = 'force-dynamic'

/**
 * Onboarding for a proven email that has no organization yet.
 *
 * This route deliberately lives outside the `(app)` group. That shell redirects anyone
 * `currentUser()` cannot resolve, and a user mid-onboarding is exactly such a person: their
 * address is proven, their row exists, and their organization does not. Inside the shell
 * they would be bounced to /login, back here, bounced again.
 *
 * It also does not use `currentUser()` for the same reason, and resolves the user through
 * `sessionUserId()` plus a direct read instead. That is the one place in the app that treats
 * "signed in but tenantless" as a legitimate state rather than a half-authenticated one.
 */
export default async function OnboardingPage() {
  const userId = await sessionUserId()
  if (!userId) redirect('/login')

  const user = db().select().from(users).where(eq(users.id, userId)).get()
  if (!user) redirect('/login')

  // Someone who finished onboarding and then reopened this link is already somewhere they
  // belong. Sending them to the dashboard is the correct answer, not a second org form.
  if (user.organizationId) redirect('/overview')

  // Wallet signups do not collect an email. They arrive here tenantless only if something
  // removed their organization underneath them, and "finish your email signup" is the
  // correct thing to show them rather than an org form they cannot finish.
  if (!user.email) redirect('/login')

  // An invited person does not need to create an organization, they need to be told where they
  // were invited. Showing them an org-creation form at this exact moment is the worst possible
  // first impression: it asks somebody who was already given a place to make their own.
  const invitations = listPendingInvitations(user.email)

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <Brand href="/" />
          <h1 className="mt-6 text-[26px] leading-tight font-semibold tracking-tight">
            Set up your organization
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-3">
            {invitations.length > 0
              ? 'Or set up an organization of your own. Nothing here needs a wallet or a payment.'
              : 'One step, then you are in. Nothing here needs a wallet or a payment.'}
          </p>
        </div>
        {invitations.length > 0 ? <PendingInvitations invitations={invitations} /> : null}

        <Card className="p-5">
          <NameOrganization email={user.email} />
        </Card>
      </div>
    </div>
  )
}