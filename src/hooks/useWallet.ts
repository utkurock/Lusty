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

// stellar-wallets-kit v2.x — every entry point is static. Call
// StellarWalletsKit.init(...) once per page load, then all subsequent
// calls (authModal, signTransaction, disconnect) hit the same singleton.
let _inited = false
function ensureInit() {
  if (_inited || typeof window === 'undefined') return
  StellarWalletsKit.init({
    network: Networks.TESTNET,
    selectedWalletId: FREIGHTER_ID,
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
    const saved = localStorage.getItem('lusty_wallet_address')
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
    StellarWalletsKit.refreshSupportedWallets()
      .then(setSupportedWallets)
      .catch(() => {})
  }, [])

  const connect = useCallback(async () => {
    ensureInit()
    setModalOpen(true)
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
        localStorage.setItem('lusty_wallet_address', address)
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
    localStorage.removeItem('lusty_wallet_address')
  }, [])

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
  }
}
