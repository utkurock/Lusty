import Link from 'next/link'

export const metadata = {
  title: 'Technical Architecture — Lusty',
  description:
    'Stellar-specific technical architecture for Lusty: Soroban vault contracts, Reflector oracle settlement, SAC-based collateral, and the server rail.',
}

export default function ArchitectureLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <header className="w-full border-b border-line bg-surface sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link
            href="/earn"
            className="font-mono font-bold text-xl tracking-tight text-ink"
          >
            lusty<span className="text-[#eab308]">_</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/docs"
              className="font-mono text-sm text-ink-2 hover:text-ink transition"
            >
              docs
            </Link>
            <a
              href="https://lusty.finance"
              target="_blank"
              rel="noopener noreferrer"
              className="h-10 px-4 bg-inverse text-cream font-mono text-sm rounded-sm flex items-center gap-2 hover:bg-line-2 transition"
            >
              lusty.finance
            </a>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  )
}
