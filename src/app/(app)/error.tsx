'use client'

import { useEffect } from 'react'

/**
 * Console-scoped error boundary.
 *
 * Every console page is a live query over the gateway write tables, so a database fault
 * is an expected failure mode rather than an exotic one. Without a boundary that fault
 * unmounts the whole dashboard into an unstyled stack; with it, the operator keeps the
 * navigation and gets a retry. The failure is logged rather than swallowed.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('console route failed', error)
  }, [error])

  return (
    <div className="flex flex-col items-start gap-4 rounded-card border border-line bg-surface px-5 py-6">
      <div>
        <h1 className="text-[18px] font-medium tracking-tight text-ink">
          This view could not be loaded
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[14px] leading-relaxed text-ink-3">
          The gateway write tables could not be read. Nothing was changed. Retry, and quote
          the reference below if it keeps happening.
        </p>
      </div>

      <button
        type="button"
        onClick={reset}
        className="inline-flex items-center rounded-control bg-accent px-4 py-2 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:translate-y-px"
      >
        Try again
      </button>

      {error.digest ? <p className="mono text-[11px] text-ink-4">reference {error.digest}</p> : null}
    </div>
  )
}