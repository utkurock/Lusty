'use client'
import { useState, useCallback, useEffect } from 'react'
import {
  StellarWalletsKit,
  Networks,
  type ISupportedWallet,
} from '@creit.tech/stellar-wallets-kit'
import { FreighterModule, FREIGHTER_ID } from '@creit.tech/stellar-wallets-kit/modules/freighter'
import { xBullModule } from '@creit.tech/stellar-wallets-kit/modules/xbull'
import { AlbedoModule } from '@creit.tech/stellar-wallets-kit/modules/albedo'
import { LobstrModule } from '@creit.tech/stellar-wallets-kit/modules/lobstr'

// What we remember between visits. The wallet ID belongs next to the address:
// restoring an address while defaulting the wallet back to Freighter points the
// kit at an extension that may not hold that account at all, and every later
// signature is then asked of the wrong wallet.
const SAVED_ADDRESS = 'lusty_wallet_address'
const SAVED_WALLET_ID = 'lusty_wallet_id'

// stellar-wallets-kit v2.x — every entry point is static. Call
// StellarWalletsKit.init(...) once per page load, then all subsequent
// calls (authModal, signTransaction, disconnect) hit the same singleton.
let _inited = false
function ensureInit() {
  if (_inited || typeof window === 'undefined') return
  StellarWalletsKit.init({
    network: Networks.TESTNET,
    selectedWalletId: localStorage.getItem(SAVED_WALLET_ID) ?? FREIGHTER_ID,
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new AlbedoModule(),
      new LobstrModule(),
    ],
  })
  _inited = true
}

export interface WalletState {
  address: string | null
  connected: boolean
  loading: boolean
  modalOpen: boolean
  supportedWallets: ISupportedWallet[]
  connect: () => Promise<void>
  closeModal: () => void
  selectWallet: (walletId: string) => Promise<void>
  disconnect: () => void
  signTransaction: (xdr: string) => Promise<string>
  /**
   * The account the wallet is on RIGHT NOW, reconciled with what we remembered.
   *
   * Call this before building anything that moves value. The restored address is
   * a memory of a previous visit, and the user may have switched accounts in
   * their extension since — in which case a deposit built from the remembered
   * address escrows from, and pays the premium to, an account they are no longer
   * looking at. It succeeds, too, because the kit is handed that address
   * explicitly and the wallet signs for whichever of its accounts was named.
   *
   * Resolves to the live address (state and storage updated to match), or null
   * if no wallet is connected.
   */
  syncAddress: () => Promise<string | null>
}

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [supportedWallets, setSupportedWallets] = useState<ISupportedWallet[]>([])

  // Restore address from last session + load wallet list.
  useEffect(() => {
    ensureInit()
    const saved = localStorage.getItem(SAVED_ADDRESS)
    if (saved) {
      setAddress(saved)
      setConnected(true)
      // Track returning user
      fetch('/api/users/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: saved }),
      }).catch(() => {})
    }
  }, [])

  // The wallet list is loaded when the picker opens, not on every mount.
  //
  // refreshSupportedWallets() probes each installed module to ask whether it is
  // available, and several extensions answer that probe by showing the user an
  // approval dialog. Running it on mount meant every page load — every refresh —
  // raised a wallet prompt for a question nobody had asked. The list is only
  // needed by the connect modal, so it is fetched when that opens.
  const connect = useCallback(async () => {
    ensureInit()
    setModalOpen(true)
    StellarWalletsKit.refreshSupportedWallets()
      .then(setSupportedWallets)
      .catch(() => {})
  }, [])

  const closeModal = useCallback(() => setModalOpen(false), [])

  const selectWallet = useCallback(async (walletId: string) => {
    setLoading(true)
    try {
      ensureInit()
      StellarWalletsKit.setWallet(walletId)
      const { address } = await StellarWalletsKit.fetchAddress()
      if (address) {
        setAddress(address)
        setConnected(true)
        localStorage.setItem(SAVED_ADDRESS, address)
        localStorage.setItem(SAVED_WALLET_ID, walletId)
        setModalOpen(false)
        // Track wallet connection
        fetch('/api/users/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address }),
        }).catch(() => {})
      }
    } catch (e: any) {
      console.error('Wallet select failed:', e?.message ?? e)
    } finally {
      setLoading(false)
    }
  }, [])

  const disconnect = useCallback(() => {
    try {
      StellarWalletsKit.disconnect()
    } catch {
      /* ignore */
    }
    setAddress(null)
    setConnected(false)
    localStorage.removeItem(SAVED_ADDRESS)
    localStorage.removeItem(SAVED_WALLET_ID)
  }, [])

  const syncAddress = useCallback(async (): Promise<string | null> => {
    if (!address) return null
    ensureInit()
    const { address: live } = await StellarWalletsKit.fetchAddress()
    if (!live) return address
    if (live !== address) {
      setAddress(live)
      localStorage.setItem(SAVED_ADDRESS, live)
    }
    return live
  }, [address])

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      if (!address) throw new Error('Wallet not connected')
      ensureInit()
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase: Networks.TESTNET,
        address,
      })
      return signedTxXdr
    },
    [address]
  )

  return {
    address,
    connected,
    loading,
    modalOpen,
    supportedWallets,
    connect,
    closeModal,
    selectWallet,
    disconnect,
    signTransaction,
    syncAddress,
  }
}
