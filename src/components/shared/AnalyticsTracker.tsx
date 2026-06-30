'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { useWalletContext } from '@/providers/WalletProvider'
import { track } from '@/lib/analytics'

/**
 * Invisible analytics tracker mounted once in the root layout. Fires a
 * page_view on every route change and a single wallet_connect when a wallet
 * first connects in this session. Purely additive — renders nothing.
 */
export function AnalyticsTracker() {
  const pathname = usePathname()
  const { connected, address } = useWalletContext()
  const lastConnected = useRef(false)

  // page_view on each path change
  useEffect(() => {
    if (!pathname) return
    track('page_view', undefined, address)
    // address intentionally excluded from deps: we only want one view per nav,
    // not a duplicate when the wallet address resolves a beat later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  // wallet_connect / wallet_disconnect on connection transitions
  useEffect(() => {
    if (connected && !lastConnected.current) {
      track('wallet_connect', undefined, address)
    } else if (!connected && lastConnected.current) {
      track('wallet_disconnect')
    }
    lastConnected.current = connected
  }, [connected, address])

  return null
}
