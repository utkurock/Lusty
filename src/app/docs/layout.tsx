import Link from 'next/link'

export default function DocsLayout({ children }: { children: React.ReactNode }) {
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
          <a
            href="https://lusty.finance"
            target="_blank"
            rel="noopener noreferrer"
            className="h-10 px-4 bg-inverse text-cream font-mono text-sm rounded-sm flex items-center gap-2 hover:bg-line-2 transition"
          >
            lusty.finance
          </a>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  )
}
