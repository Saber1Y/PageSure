import Link from 'next/link'

/**
 * The wordmark, in one place, because it appears in four headers and drift between
 * copies is how a brand stops looking like a brand.
 *
 * There is no dot, orb or glyph in front of the name. A coloured circle next to a
 * wordmark carries no information and reads as decoration, which is exactly the kind
 * of filler mark this design system is trying to avoid. The mark is set in type
 * instead: "Page" in the secondary ink, "Sure" in full ink, so the name has internal
 * contrast and holds up as a plain word at any size.
 *
 * The link carries vertical padding so it clears the 24px WCAG 2.5.8 minimum target
 * height. A wordmark set flush to its own line height is 23px tall and awkward to hit on
 * a phone.
 *
 * `suffix` renders a quieter qualifier after a hairline, for the surfaces that need to
 * say which part of the product you are in.
 */
export function Brand({
  href,
  suffix,
  className = '',
}: {
  href?: string
  suffix?: string
  className?: string
}) {
  const name = (
    <span className={`text-[15px] font-semibold tracking-tight ${className}`}>
      <span className="text-ink-3">Page</span>
      <span className="text-ink">Sure</span>
    </span>
  )

  const inner = suffix ? (
    <span className="flex items-baseline gap-3">
      {name}
      <span aria-hidden className="h-3 w-px translate-y-px bg-line-strong" />
      <span className="text-[13px] text-ink-3">{suffix}</span>
    </span>
  ) : (
    name
  )

  if (!href) return inner

  // The visible wordmark is already the accessible name ("Page" + "Sure" concatenate
  // to PageSure), so there is no visually hidden label to add here. One would make
  // assistive tech announce the name twice.
  return (
    <Link href={href} className="inline-flex items-center py-1">
      {inner}
    </Link>
  )
}