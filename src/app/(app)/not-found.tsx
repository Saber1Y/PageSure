import Link from 'next/link'

/**
 * Console not-found boundary, rendered inside the dashboard shell so the operator keeps
 * their navigation after following a stale record link.
 */
export default function ConsoleNotFound() {
  return (
    <div className="flex flex-col items-start gap-4 rounded-card border border-line bg-surface px-5 py-6">
      <div>
        <p className="mono text-[12px] text-ink-4">404</p>
        <h1 className="mt-2 text-[18px] font-medium tracking-tight text-ink">
          That record does not exist
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[14px] leading-relaxed text-ink-3">
          This service, session or request was not found in the gateway write tables. It may
          have been removed, or the identifier in the link may be wrong.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/overview"
          className="inline-flex items-center rounded-control bg-accent px-4 py-2 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:translate-y-px"
        >
          Back to overview
        </Link>
        <Link
          href="/services"
          className="inline-flex items-center rounded-control border border-line-strong px-4 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink active:translate-y-px"
        >
          Browse services
        </Link>
      </div>
    </div>
  )
}