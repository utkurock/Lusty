import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { WalletProvider } from '@/providers/WalletProvider'
import { Navbar } from '@/components/layout/Navbar'
import { Footer } from '@/components/layout/Footer'
import { WalletConnectModal } from '@/components/shared/WalletConnectModal'
import { AdminOverlay } from '@/components/admin/AdminOverlay'

export const metadata: Metadata = {
  title: 'Lusty — Earn yield upfront',
  description: 'Options yield venue on Stellar. Sell covered calls and cash-secured puts, receive premium upfront. Server-settled today; trustless Soroban rebuild on the roadmap.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Apply stored theme before paint to avoid a flash of the wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('lusty-theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}`,
          }}
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
          </WalletProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
