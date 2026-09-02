import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { WalletProvider } from '@/providers/WalletProvider'
import { Navbar } from '@/components/layout/Navbar'
import { Footer } from '@/components/layout/Footer'
import { WalletConnectModal } from '@/components/shared/WalletConnectModal'
import { AdminOverlay } from '@/components/admin/AdminOverlay'
import { AnalyticsTracker } from '@/components/shared/AnalyticsTracker'
import { FeedbackWidget } from '@/components/shared/FeedbackWidget'

export const metadata: Metadata = {
  title: 'Lusty — Earn yield upfront',
  description: 'Options yield venue on Stellar. Sell covered calls and cash-secured puts, receive premium upfront. Collateral is escrowed by a Soroban vault contract and settled on chain against a Reflector price.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        {/* Dark ships on the element itself, so the first paint is already the
            default theme. This only has to undo it for the wallets that chose
            light — the reverse order flashed cream on every dark visit. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('lusty-theme')==='light')document.documentElement.classList.remove('dark')}catch(e){}`,
          }}
        />
        {/* Jeko is self-hosted and sets every heading above the fold, so it is
            the one face worth preloading; Inter and JetBrains Mono swap in
            from Google without a layout shift that matters. */}
        <link
          rel="preload"
          href="/fonts/jeko-bold.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ThemeProvider>
          <WalletProvider>
            <div className="min-h-screen flex flex-col">
              <Navbar />
              <main className="flex-1">{children}</main>
              <Footer />
            </div>
            <WalletConnectModal />
            <AdminOverlay />
            <FeedbackWidget />
            <AnalyticsTracker />
          </WalletProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
