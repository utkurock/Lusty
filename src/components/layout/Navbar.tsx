'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Menu, X } from 'lucide-react'
import { WalletButton } from '@/components/shared/WalletButton'
import { FaucetButton } from '@/components/shared/FaucetButton'
import { ThemeToggle } from '@/components/shared/ThemeToggle'
import { cn } from '@/lib/utils'

const LINKS = [
  { href: '/earn', label: 'Earn' },
  { href: '/swap', label: 'Swap' },
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/research', label: 'Research' },
  { href: '/leaderboard', label: 'Leaderboard' },
]

export function Navbar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  if (pathname?.startsWith('/docs') || pathname?.startsWith('/architecture'))
    return null

  return (
    <header className="w-full border-b border-line-light bg-surface sticky top-0 z-40">
      <div className="max-w-content mx-auto px-6 h-nav flex items-center justify-between gap-6">
        <Link
          href="/earn"
          className="font-display text-head-sm text-ink press press-sm rounded-compact"
        >
          lusty<span className="text-brand">_</span>
        </Link>

        {/* The nav is a strip of pills: hover fills the surface one step up,
            the current page keeps that fill. Nothing moves, nothing recolours. */}
        <nav className="hidden md:flex items-center gap-1">
          {LINKS.map(l => {
            const active = pathname === l.href || (l.href !== '#' && pathname.startsWith(l.href))
            return (
              <Link
                key={l.label}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'press rounded-sm px-3 py-1.5 font-mono text-body',
                  active
                    ? 'bg-raised text-ink'
                    : 'text-ink-2 hover:bg-raised hover:text-ink'
                )}
              >
                {l.label.toLowerCase()}
              </Link>
            )
          })}
        </nav>

        <div className="hidden md:flex items-center gap-2">
          <ThemeToggle />
          <FaucetButton />
          <WalletButton />
        </div>

        <div className="md:hidden flex items-center gap-1">
          <ThemeToggle />
          <button
            aria-label="Toggle menu"
            aria-expanded={open}
            className="press press-sm rounded-sm p-2 text-ink-2 hover:bg-raised hover:text-ink"
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {open && (
        <div className="md:hidden border-t border-line-light bg-surface px-6 py-4 flex flex-col gap-1">
          {LINKS.map(l => (
            <Link
              key={l.label}
              href={l.href}
              onClick={() => setOpen(false)}
              className="press rounded-sm px-3 py-2.5 font-mono text-body text-ink-2 hover:bg-raised hover:text-ink"
            >
              {l.label.toLowerCase()}
            </Link>
          ))}
          <div className="pt-3">
            <WalletButton />
          </div>
        </div>
      )}
    </header>
  )
}
