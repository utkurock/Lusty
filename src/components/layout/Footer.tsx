'use client'
import { usePathname } from 'next/navigation'

export function Footer() {
  const pathname = usePathname()
  if (pathname?.startsWith('/docs') || pathname?.startsWith('/architecture'))
    return null
  return (
    <footer className="w-full border-t border-line bg-surface mt-8">
      <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="font-mono text-xs text-ink-2">
          lusty_ // earn yield upfront on stellar
        </div>
        <div className="font-mono text-xs text-ink-2 flex gap-6">
          <a href="/docs" className="hover:text-ink">docs</a>
          <a
            href="https://github.com/utkurock/Lusty"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-ink"
          >
            github
          </a>
          <a
            href="https://x.com/Lustyfinance"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-ink"
          >
            twitter
          </a>
        </div>
        <div className="font-mono text-xs text-ink-2">testnet</div>
      </div>
    </footer>
  )
}
