'use client'
import { usePathname } from 'next/navigation'

export function Footer() {
  const pathname = usePathname()
  if (pathname?.startsWith('/docs') || pathname?.startsWith('/architecture'))
    return null
  return (
    <footer className="w-full border-t border-line-light bg-surface mt-16">
      <div className="max-w-content mx-auto px-6 py-8 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="font-mono text-caption text-ink-2">
          lusty_ // earn yield upfront on stellar
        </div>
        <div className="font-mono text-caption text-ink-2 flex gap-1">
          {[
            { href: '/docs', label: 'docs', external: false },
            { href: 'https://github.com/utkurock/Lusty', label: 'github', external: true },
            { href: 'https://x.com/Lustyfinance', label: 'twitter', external: true },
          ].map(l => (
            <a
              key={l.label}
              href={l.href}
              {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="press rounded-sm px-2.5 py-1 hover:bg-raised hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </div>
        <div className="chip">testnet</div>
      </div>
    </footer>
  )
}
