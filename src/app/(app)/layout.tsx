import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/session'
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
  const user = await currentUser()
  if (!user) redirect('/login')

  return (
    <div className="min-h-[100dvh]">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-6 px-6">
          <div className="flex items-center gap-8">
            <Brand href="/overview" />
            <Nav />
          </div>
          <AccountChip name={user.displayName} email={user.email} />
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  )
}