import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { ProductMockup } from '@/components/landing/ProductMockup'
import { ScfMark } from '@/components/landing/ScfMark'
import { Showcase } from '@/components/landing/Showcase'
import { Faq } from '@/components/landing/Faq'

const STELLAR_URL = 'https://stellar.org/'

const LINKS = [
  { href: '/docs', label: 'Docs', external: false },
  { href: 'https://github.com/utkurock/Lusty', label: 'GitHub', external: true },
  { href: 'https://x.com/Lustyfinance', label: 'X', external: true },
]

/* The landing page is short: a bar, the hero with the product under it, the
   two-up, the questions, a footer line. It is dark
   whatever theme the app is in (`theme-dark` takes the dark tokens): the
   screenshot under the hero is of the dark app, and a light page around it
   would frame it in the wrong colour. */
export default function Home() {
  return (
    <div className="theme-dark flex min-h-screen flex-col bg-surface text-ink">
      <header className="sticky top-0 z-40 border-b border-line-light bg-surface/80 backdrop-blur">
        <div className="flex h-14 items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="font-display text-head-sm">
            lusty<span className="text-brand">_</span>
          </Link>
          <Link href="/earn" className="press ml-auto rounded-sm bg-brand px-3 py-1.5 font-mono text-caption text-[#1a1a1a]">
            Launch app
          </Link>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="relative mx-auto flex max-w-3xl flex-col items-center px-6 pt-24 text-center animate-stagger sm:pt-28">
          <div className="font-mono text-caption text-ink-2">Crypto Options Protocol</div>
          <h1 className="mt-5 font-display text-[48px] leading-[50px] tracking-[-0.03em] sm:text-[80px] sm:leading-[80px]">
            Earn yield upfront<span className="text-brand">_</span>
          </h1>
          <p className="mt-6 max-w-md text-lead text-ink-2">
            Sell covered calls and cash-secured puts. The premium lands in your wallet the moment you deposit.
          </p>
          <div>
            <Link
              href="/earn"
              className="press mt-10 inline-flex items-center gap-2 rounded-sm bg-brand px-6 py-3 font-mono text-body text-[#1a1a1a]"
            >
              Start earning <ArrowRight size={16} />
            </Link>
          </div>
          <a
            href={STELLAR_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-10 inline-flex items-center gap-2.5 text-ink-2 transition-colors duration-fast hover:text-ink"
          >
            <span className="text-caption">Backed by</span>
            <ScfMark className="h-5 w-auto text-ink" />
            <span className="text-body text-ink">Stellar Community Fund</span>
          </a>
        </div>

        {/* The product itself, running: the earn flow in a browser window
            that straightens as it scrolls into view. */}
        <div className="relative mx-auto mb-20 mt-16 max-w-[1035px] px-4 sm:mt-20 sm:px-6 animate-rise" style={{ animationDelay: '300ms' }}>
          <ProductMockup />
        </div>
      </section>

      <Showcase />
      <Faq />

      <footer className="border-t border-line-light px-4 py-6 sm:px-6">
        <div className="flex items-center justify-between gap-4 font-mono text-caption text-ink-2">
          <span>© 2026 lusty<span className="text-brand">_</span></span>
          <nav className="flex gap-4">
            {LINKS.map(l => (
              <a
                key={l.label}
                href={l.href}
                {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="hover:text-ink"
              >
                {l.label}
              </a>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  )
}
