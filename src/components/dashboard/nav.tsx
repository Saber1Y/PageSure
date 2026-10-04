'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Primary navigation. One line at desktop; collapses to a scrollable row on mobile
 * rather than wrapping to two lines, which would be broken at any width.
 *
 * Current section is marked with aria-current and a filled pill, so position in the
 * console is readable without relying on colour alone.
 */
const LINKS = [
  { href: '/overview', label: 'Overview' },
  { href: '/services', label: 'Services' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/policies', label: 'Policies' },
  { href: '/review', label: 'Review' },
  { href: '/settlements', label: 'Settlements' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/settings', label: 'Settings' },
]

export function Nav() {
  const pathname = usePathname()

  return (
    <nav className="-mx-2 overflow-x-auto" aria-label="Console sections">
      <ul className="flex items-center gap-1 whitespace-nowrap">
        {LINKS.map((link) => {
          // Detail routes such as /services/:id keep their parent section current.
          const current = pathname === link.href || pathname.startsWith(`${link.href}/`)
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={current ? 'page' : undefined}
                className={
                  current
                    ? 'inline-flex items-center rounded-control bg-surface-2 px-2.5 py-1.5 text-[13px] font-medium text-ink'
                    : 'inline-flex items-center rounded-control px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink'
                }
              >
                {link.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}