import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { sessionCookieName } from '@/lib/auth/session'
import { Card } from '@/components/ui/primitives'
import { LoginForm } from '@/components/dashboard/login-form'
import { Brand } from '@/components/ui/brand'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  const store = await cookies()
  if (store.get(sessionCookieName())) redirect('/overview')

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <Brand href="/" />
          <h1 className="mt-6 text-[26px] leading-tight font-medium tracking-tight">
            Provider console
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-3">
            Sign in to manage services, policies and settlements.
          </p>
        </div>
        <Card className="p-5">
          <LoginForm />
        </Card>
      </div>
    </div>
  )
}
