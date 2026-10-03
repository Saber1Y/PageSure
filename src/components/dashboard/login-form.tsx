'use client'

import { useFormStatus } from 'react-dom'
import { loginAction } from '@/app/login/actions'

/**
 * Label ABOVE input, helper text in markup, error text BELOW input. No
 * placeholder-as-label. The submit label is short so it never wraps.
 *
 * The server action is passed straight to <form action>, so no client state machine is
 * involved. useFormStatus lives in a child because it only works inside a form.
 */
export function LoginForm() {
  return (
    <form action={loginAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="email" className="text-[13px] font-medium text-ink">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          defaultValue="provider@pagesure.dev"
          className="rounded-control border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="text-[13px] font-medium text-ink">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-control border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink outline-none transition-colors focus:border-accent"
        />
        <p className="text-[12px] text-ink-3">
          Seeded by npm run db:seed from PROVIDER_ADMIN_PASSWORD.
        </p>
      </div>

      <SubmitButton />
    </form>
  )
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-1 rounded-control bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover active:translate-y-px disabled:opacity-50"
    >
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  )
}