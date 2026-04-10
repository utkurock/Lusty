'use client'
import { usePathname } from 'next/navigation'

export function Footer() {
  const pathname = usePathname()
  if (pathname?.startsWith('/docs')) return null
  return (
    <footer className="w-full border-t border-[#c4bfb2] bg-[#e8e4d9] mt-8">
      <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="font-mono text-xs text-[#6b6560]">
          lusty_ // earn yield upfront on stellar
        </div>
        <div className="font-mono text-xs text-[#6b6560] flex gap-6">
          <a href="/docs" className="hover:text-[#1a1a1a]">docs</a>
          <a href="#" className="hover:text-[#1a1a1a]">github</a>
          <a href="#" className="hover:text-[#1a1a1a]">twitter</a>
        </div>
        <div className="font-mono text-xs text-[#6b6560]">testnet</div>
      </div>
    </footer>
  )
}
