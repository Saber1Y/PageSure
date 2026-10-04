import { currentUser } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import { Nav } from '@/components/dashboard/nav'
import { AccountChip } from '@/components/dashboard/account-chip'
import { Brand } from '@/components/ui/brand'

/**
 * Dashboard shell. Theme is locked here: one canvas, one ink, one accent, for every
 * page beneath. Sections never invert.
 *
 * The gateway and playground are deliberately outside this shell and stay public,
 * because agents have no session and authenticate by paying.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  /*
   * Redirect, never requireUser(). requireUser() throws by design so server actions and
   * route handlers cannot accidentally continue unauthenticated, but a thrown error in a
   * layout surfaces as a 500 on every dashboard page rather than a redirect to /login.
   * The children are separately gated, so this redirect is the shell, not the guard.
   */
  const user = await currentUser()
  if (!user) redirect('/login')

  return (
    <div className="min-h-[100dvh]">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-sm">
        <div className="mx-auto max-w-[1400px] px-6">
          {/*
            Desktop is one row: brand, sections, account. The section list is intrinsically
            wider than a phone, so on small screens it wraps onto its own full-width row
            instead of being squeezed into a few unusable pixels beside the account chip.
            min-w-0 on the nav wrapper is what lets its overflow-x-auto actually engage:
            without it the flex item refuses to shrink and pushes the whole document wide.
          */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3 lg:h-16 lg:flex-nowrap lg:py-0">
            <Brand href="/overview" />
            <div className="order-last -mx-2 w-full min-w-0 lg:order-none lg:mx-0 lg:w-auto lg:flex-1">
              <Nav />
            </div>
            <div className="ml-auto shrink-0 lg:ml-0">
              <AccountChip
                name={user.displayName}
                email={user.email}
                wallet={user.walletPublicKey}
                organization={user.organizationName}
                role={user.role}
              />
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  )
}