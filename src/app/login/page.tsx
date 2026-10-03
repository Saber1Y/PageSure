import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { sessionCookieName } from '@/lib/auth/session'
import { configuredOperatorWallet } from '@/lib/auth/wallet'
import { Card } from '@/components/ui/primitives'
import { LoginPanel } from '@/components/dashboard/login-form'
import { Brand } from '@/components/ui/brand'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  const store = await cookies()
  if (store.get(sessionCookieName())) redirect('/overview')

  // The wallet is rendered from configuration, never from a request. Showing it tells the
  // operator which key they are expected to sign with, which is the whole point of the
  // ceremony; it is public information because it is the settlement address.
  let wallet = 'not configured'
  let configured = false
  try {
    wallet = configuredOperatorWallet()
    configured = true
  } catch {
    // Render the page anyway so the misconfiguration is visible rather than a blank 500.
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <Brand href="/" />
          <h1 className="mt-6 text-[26px] leading-tight font-semibold tracking-tight">Provider console</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-3">
            Sign in by proving control of the settlement wallet.
          </p>
        </div>
        <Card className="p-5">
          {configured ? (
            <LoginPanel wallet={wallet} />
          ) : (
            <p role="alert" className="rounded-control border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] leading-relaxed text-danger">
              PROVIDER_RECIPIENT_G is not set to a valid Stellar public key, so console access
              cannot be granted. Run <span className="mono">npm run keys:generate</span> and restart.
            </p>
          )}
        </Card>
      </div>
    </div>
  )
}