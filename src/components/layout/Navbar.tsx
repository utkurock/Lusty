'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Menu, X } from 'lucide-react'
import { WalletButton } from '@/components/shared/WalletButton'
import { FaucetButton } from '@/components/shared/FaucetButton'
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

  if (pathname?.startsWith('/docs')) return null

  return (
    <header className="w-full border-b border-[#c4bfb2] bg-[#e8e4d9] sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/earn" className="font-mono font-bold text-xl tracking-tight text-[#1a1a1a]">
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
                  active ? 'text-[#1a1a1a] font-semibold' : 'text-[#6b6560] hover:text-[#1a1a1a]'
                )}
              >
                {l.label.toLowerCase()}
              </Link>
            )
          })}
        </nav>

        <div className="hidden md:flex items-center gap-2">
          <FaucetButton />
          <WalletButton />
        </div>

        <button
          aria-label="Toggle menu"
          className="md:hidden p-2"
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {open && (
        <div className="md:hidden border-t border-[#c4bfb2] px-6 py-4 flex flex-col gap-4 bg-[#e8e4d9]">
          {LINKS.map(l => (
            <Link
              key={l.label}
              href={l.href}
              onClick={() => setOpen(false)}
              className="font-mono text-sm text-[#1a1a1a]"
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
