import Link from 'next/link'

/**
 * Primary navigation. One line at desktop; collapses to a scrollable row on mobile
 * rather than wrapping to two lines, which would be broken at any width.
 */
const LINKS = [
  { href: '/overview', label: 'Overview' },
  { href: '/services', label: 'Services' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/policies', label: 'Policies' },
  { href: '/review', label: 'Review' },
  { href: '/settlements', label: 'Settlements' },
  { href: '/incidents', label: 'Incidents' },
]

export function Nav() {
  return (
    <nav className="-mx-2 overflow-x-auto">
      <ul className="flex items-center gap-1 whitespace-nowrap">
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="inline-block rounded-control px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}