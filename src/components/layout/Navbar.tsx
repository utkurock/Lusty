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
    <header className="w-full border-b border-line bg-surface sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/earn" className="font-mono font-bold text-xl tracking-tight text-ink">
          lusty<span className="text-[#eab308]">_</span>
        </Link>

        <nav className="hidden md:flex items-center gap-8">
          {LINKS.map(l => {
            const active = pathname === l.href || (l.href !== '#' && pathname.startsWith(l.href))
            return (
              <Link
                key={l.label}
                href={l.href}
                className={cn(
                  'font-mono text-sm transition',
                  active ? 'text-ink font-semibold' : 'text-ink-2 hover:text-ink'
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
            className="p-2"
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {open && (
        <div className="md:hidden border-t border-line px-6 py-4 flex flex-col gap-4 bg-surface">
          {LINKS.map(l => (
            <Link
              key={l.label}
              href={l.href}
              onClick={() => setOpen(false)}
              className="font-mono text-sm text-ink"
            >
              {l.label.toLowerCase()}
            </Link>
          ))}
          <WalletButton />
        </div>
      )}
    </header>
  )
}
