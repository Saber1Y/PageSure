import Link from 'next/link'
import { Brand } from '@/components/ui/brand'

/**
 * Root not-found boundary.
 *
 * Without this file Next falls back to its built-in page, which is unstyled and, on a
 * streamed dynamic render, is served with HTTP 200. That makes a missing URL look like a
 * healthy page to crawlers, uptime monitors and link checkers.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center px-6">
          <Brand href="/" />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1400px] flex-1 items-center px-6 py-16">
        <div className="max-w-[52ch]">
          <p className="mono text-[12px] text-ink-4">404</p>
          <h1 className="mt-3 text-[28px] font-medium tracking-tight text-ink">
            No route at this address
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-3">
            The page you asked for does not exist. It may have been renamed, or the link
            that brought you here may be out of date.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center rounded-control bg-accent px-4 py-2.5 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:translate-y-px"
            >
              Back to the homepage
            </Link>
            <Link
              href="/playground"
              className="inline-flex items-center rounded-control border border-line-strong px-4 py-2.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink active:translate-y-px"
            >
              Open the playground
            </Link>
          </div>
        </div>
      </main>
    </div>
  )
}