import type { ReactNode } from 'react'

/**
 * Presentational primitives. Server Components only: no state, no hooks, so they stay
 * on the server render path. Interactive leaves live in components/dashboard.
 */

/**
 * Placeholder for a value that has not been set.
 *
 * This used to be an em-dash, which is the single most recognisable LLM typography
 * tell and reads as broken punctuation rather than as an absent value. Words are
 * clearer than any dash, and they survive a screen reader, a copy-paste, and a
 * column of numbers.
 */
export const NOT_SET = 'not set'

export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`rounded-card border border-line bg-surface ${className}`}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-medium tracking-tight text-ink">{title}</h2>
        {hint ? <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{hint}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="label-xs">{children}</span>
}

/**
 * Metric tile. Values are mono with tabular numerals so a row of tiles aligns.
 * At density 7 the number is the design: no card chrome beyond a hairline.
 */
export function Metric({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'neutral' | 'allow' | 'block' | 'review' | 'accent'
}) {
  const toneClass = {
    neutral: 'text-ink',
    allow: 'text-allow',
    block: 'text-block',
    review: 'text-review',
    accent: 'text-accent',
  }[tone]

  return (
    <div className="px-5 py-4">
      <Label>{label}</Label>
      <div className={`mono mt-2 text-[26px] leading-none font-medium tracking-tight ${toneClass}`}>
        {value}
      </div>
      {sub ? <div className="mt-1.5 text-[12px] text-ink-3">{sub}</div> : null}
    </div>
  )
}

/** Truncate a Stellar address or hash for display without hiding that it is truncated. */
export function short(value: string | null | undefined, head = 6, tail = 4): string {
  if (!value) return NOT_SET
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export type DecisionTone = 'allow' | 'block' | 'review' | 'neutral' | 'pending'

export function Badge({
  tone,
  children,
}: {
  tone: DecisionTone
  children: ReactNode
}) {
  const cls = {
    allow: 'bg-allow-soft text-allow',
    block: 'bg-block-soft text-block',
    review: 'bg-review-soft text-review',
    neutral: 'bg-neutral-soft text-ink-2',
    pending: 'bg-accent-soft text-accent-ink',
  }[tone]

  return (
    <span
      className={`mono inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium tracking-tight ${cls}`}
    >
      {children}
    </span>
  )
}

export function Dot({ tone }: { tone: DecisionTone }) {
  const cls = {
    allow: 'bg-allow',
    block: 'bg-block',
    review: 'bg-review',
    pending: 'bg-accent',
    neutral: 'bg-ink-4',
  }[tone]
  return <span className={`inline-block size-1.5 rounded-full ${cls}`} aria-hidden />
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-5 py-10">
      <p className="text-[14px] font-medium text-ink">{title}</p>
      <p className="max-w-[52ch] text-[13px] leading-relaxed text-ink-3">{body}</p>
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  )
}

export function KeyValue({
  k,
  v,
  mono = false,
}: {
  k: string
  v: ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-line py-2.5 last:border-b-0">
      <span className="text-[13px] text-ink-3">{k}</span>
      <span className={`text-[13px] text-ink ${mono ? 'mono' : ''} text-right`}>{v}</span>
    </div>
  )
}

export function Button({
  children,
  href,
  variant = 'primary',
  type,
  disabled,
  onClick,
}: {
  children: ReactNode
  href?: string
  variant?: 'primary' | 'ghost'
  type?: 'submit' | 'button'
  disabled?: boolean
  onClick?: () => void
}) {
  const base =
    'inline-flex items-center justify-center rounded-control px-4 py-2 text-[13px] font-medium transition-colors active:translate-y-px disabled:pointer-events-none disabled:opacity-50'
  const styles = {
    // Contrast: the filled button resolves its text through --color-on-accent, which
    // flips with the theme because the accent inverts. Dark ink on the light dark-mode
    // accent and white on the dark light-mode accent both land around 7:1. Hardcoding
    // text-white here would put white on #6b86ff in dark mode, about 2.3:1.
    primary: 'bg-accent text-on-accent hover:bg-accent-hover',
    ghost: 'border border-line-strong text-ink-2 hover:bg-surface-2 hover:text-ink',
  }[variant]

  const cls = `${base} ${styles}`
  if (href) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    )
  }
  return (
    <button type={type ?? 'button'} disabled={disabled} onClick={onClick} className={cls}>
      {children}
    </button>
  )
}