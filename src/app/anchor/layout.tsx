import type { Metadata } from 'next'
import { AnchorTabs } from '@/components/anchor/AnchorTabs'
import { ANCHOR_ASSET_CODE, ANCHOR_HOME_DOMAIN, FIAT_CODE } from '@/lib/anchor/config'

export const metadata: Metadata = {
  title: 'Anchor — TRY ⇄ USDC on Stellar',
  description:
    'A Turkish lira on/off-ramp built against the Stellar SEPs: SEP-1 discovery, SEP-10 login, SEP-6 deposit and withdraw, SEP-38 quotes. Testnet sandbox.',
}

/**
 * The anchor section.
 *
 * It shares Lusty's shell and design language and nothing else: no vault, no
 * quote engine, no database, no API route of ours in the path. Everything under
 * /anchor talks to the anchor's own SEP endpoints from the browser, which is
 * why this whole feature is two directories and one line in the navbar.
 */
export default function AnchorLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-glow max-w-content mx-auto px-6 py-10 space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <AnchorTabs />
        <div className="font-mono text-caption text-ink-2">
          {FIAT_CODE} ⇄ {ANCHOR_ASSET_CODE} · {ANCHOR_HOME_DOMAIN}
        </div>
      </div>
      {children}
    </div>
  )
}
