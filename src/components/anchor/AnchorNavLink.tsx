'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Landmark } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The anchor's door, kept with the theme toggle rather than in the nav.
 *
 * The nav names the product: earn, swap, dashboard. The ramp is not another
 * corner of the product, it is a way in and out of it, so it sits with the
 * other utilities on the right and is built like the faucet beside it: the
 * icon carries the meaning, the word says which one it is.
 */
export function AnchorNavLink({ className }: { className?: string }) {
  const pathname = usePathname()
  const active = pathname?.startsWith('/anchor')

  return (
    <Link
      href="/anchor"
      aria-label="Anchor: Turkish lira on and off ramp"
      aria-current={active ? 'page' : undefined}
      title="Anchor · TRY ⇄ USDC"
      className={cn(
        'press h-10 px-3 rounded-sm border border-line font-mono text-body flex items-center gap-2 transition',
        active ? 'bg-card text-ink' : 'text-ink-2 hover:text-ink hover:bg-card',
        className
      )}
    >
      <Landmark size={14} />
      anchor
    </Link>
  )
}
