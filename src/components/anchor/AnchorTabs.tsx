'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '/anchor', label: 'overview' },
  { href: '/anchor/deposit', label: 'on-ramp' },
  { href: '/anchor/withdraw', label: 'off-ramp' },
  { href: '/anchor/convert', label: 'convert' },
  { href: '/anchor/activity', label: 'activity' },
]

/**
 * The section's own nav: the ramp and the bridge, one row.
 *
 * It is the app's segmented control, rebuilt out of the same tokens rather than
 * wearing the `.segmented` class, because that class dresses `> button` and
 * these are links. Teaching the shared stylesheet about anchors would be a
 * change to every segmented control in the app for the sake of this one.
 */
export function AnchorTabs() {
  const pathname = usePathname()

  return (
    // Five stops do not fit a phone in one line, and a wrapped segmented
    // control reads as two broken rows. It scrolls sideways instead, which is
    // what a strip of tabs is allowed to do.
    <nav className="flex gap-1 p-1 rounded-sm bg-surface-2 max-w-full overflow-x-auto scroll-slim">
      {TABS.map(t => {
        const active = t.href === '/anchor' ? pathname === '/anchor' : pathname.startsWith(t.href)
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'press rounded-inner px-3 py-1.5 font-mono text-caption whitespace-nowrap',
              active ? 'bg-card text-ink shadow-button' : 'text-ink-2 hover:text-ink'
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
