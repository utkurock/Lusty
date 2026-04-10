'use client'
import { useState, useEffect, useCallback } from 'react'
import { nativeToScVal, Address, xdr } from '@stellar/stellar-sdk'
import { invokeContract, readContract, CONTRACTS } from '@/lib/stellar'
import { useWalletContext } from '@/providers/WalletProvider'
import { fromScaled, toScaled, getNextFriday, getDaysUntilExpiry } from '@/lib/utils'
import { generateCallStrikes, StrikeOption } from '@/lib/pricing'
import { useXlmPrice } from './useXlmPrice'

export interface VaultStats {
  totalDeposited: number
  vaultCap: number
  utilizationPercent: number
  daysToExpiry: number
  expiryDate: Date
  epochId: number
}

export interface UserPosition {
  xlmAmount: number
  strikeIndex: number
  strikePrice: number
  premiumPaid: number
  epochId: number
  isSettled: boolean
}

export function useCoveredCallVault() {
  const { address, signTransaction } = useWalletContext()
  const { price: xlmPrice } = useXlmPrice()
  const [vaultStats, setVaultStats] = useState<VaultStats | null>(null)
  const [userPosition, setUserPosition] = useState<UserPosition | null>(null)
  const [strikes, setStrikes] = useState<StrikeOption[]>([])
  const [loading, setLoading] = useState(false)
  const [txLoading, setTxLoading] = useState(false)

  useEffect(() => {
    if (xlmPrice > 0) {
      const daysToExpiry = getDaysUntilExpiry()
      setStrikes(generateCallStrikes(xlmPrice, 0.80, daysToExpiry))
    }
  }, [xlmPrice])

  // MOCK MODE: if COVERED_CALL_VAULT is empty, return mock data without chain calls.
  const loadVaultStats = useCallback(async () => {
    if (!CONTRACTS.COVERED_CALL_VAULT) {
      // MOCK MODE
      setVaultStats({
        totalDeposited: 1_250_000,
        vaultCap: 5_000_000,
        utilizationPercent: 27.98,
        daysToExpiry: getDaysUntilExpiry(),
        expiryDate: getNextFriday(),
        epochId: 1,
      })
      return
    }
    if (!address) return
    setLoading(true)
    try {
      const stats = await readContract({
        contractId: CONTRACTS.COVERED_CALL_VAULT,
        method: 'get_vault_stats',
        args: [],
        signerAddress: address,
      })
      if (stats) {
        setVaultStats({
          totalDeposited: fromScaled(stats.total_deposited),
          vaultCap: fromScaled(stats.vault_cap),
          utilizationPercent: fromScaled(stats.cap_utilization) * 100,
          daysToExpiry: getDaysUntilExpiry(),
          expiryDate: getNextFriday(),
          epochId: Number(stats.epoch_id),
        })
      }
    } catch (e) {
      setVaultStats({
        totalDeposited: 1_250_000,
        vaultCap: 5_000_000,
        utilizationPercent: 27.98,
        daysToExpiry: getDaysUntilExpiry(),
        expiryDate: getNextFriday(),
        epochId: 1,
      })
    } finally {
      setLoading(false)
    }
  }, [address])

  const loadUserPosition = useCallback(async () => {
    if (!CONTRACTS.COVERED_CALL_VAULT) {
      // MOCK MODE: no on-chain position; keep whatever was set locally.
      return
    }
    if (!address) return
    try {
      const position = await readContract({
        contractId: CONTRACTS.COVERED_CALL_VAULT,
        method: 'get_user_position',
        args: [new Address(address).toScVal()],
        signerAddress: address,
      })
      if (position) {
        setUserPosition({
          xlmAmount: fromScaled(position.xlm_amount),
          strikeIndex: Number(position.strike_index),
          strikePrice: fromScaled(position.strike_price),
          premiumPaid: fromScaled(position.premium_paid),
          epochId: Number(position.epoch_id),
          isSettled: position.is_settled,
        })
      }
    } catch {
      setUserPosition(null)
    }
  }, [address])

  useEffect(() => {
    loadVaultStats()
    loadUserPosition()
  }, [loadVaultStats, loadUserPosition])

  const calculatePremium = useCallback((xlmAmount: number, strikeIndex: number): number => {
    const strike = strikes[strikeIndex]
    if (!strike) return 0
    return (strike.premium / xlmPrice) * xlmAmount
  }, [strikes, xlmPrice])

  const deposit = useCallback(async (xlmAmount: number, strikeIndex: number) => {
    // MOCK MODE: simulate tx delay + local state update.
    if (!CONTRACTS.COVERED_CALL_VAULT) {
      setTxLoading(true)
      await new Promise(r => setTimeout(r, 1500))
      const strike = strikes[strikeIndex]
      const premium = strike ? (strike.premium / Math.max(xlmPrice, 1e-9)) * xlmAmount : 0
      setUserPosition({
        xlmAmount,
        strikeIndex,
        strikePrice: strike?.strike ?? 0,
        premiumPaid: premium,
        epochId: vaultStats?.epochId ?? 1,
        isSettled: false,
      })
      setVaultStats(prev => prev ? {
        ...prev,
        totalDeposited: prev.totalDeposited + xlmAmount,
        utilizationPercent: Math.min(100, ((prev.totalDeposited + xlmAmount) / prev.vaultCap) * 100),
      } : prev)
      setTxLoading(false)
      return premium
    }
    if (!address || !signTransaction) throw new Error('Wallet not connected')
    setTxLoading(true)
    try {
      const result = await invokeContract({
        contractId: CONTRACTS.COVERED_CALL_VAULT,
        method: 'deposit',
        args: [
          new Address(address).toScVal(),
          nativeToScVal(toScaled(xlmAmount), { type: 'i128' }),
          nativeToScVal(strikeIndex, { type: 'u32' }),
        ],
        signerAddress: address,
        signTransaction,
      })
      await loadVaultStats()
      await loadUserPosition()
      return fromScaled(result)
    } finally {
      setTxLoading(false)
    }
  }, [address, signTransaction, loadVaultStats, loadUserPosition, strikes, xlmPrice, vaultStats])

  const claim = useCallback(async () => {
    // MOCK MODE
    if (!CONTRACTS.COVERED_CALL_VAULT) {
      setTxLoading(true)
      await new Promise(r => setTimeout(r, 1500))
      setUserPosition(prev => prev ? { ...prev, isSettled: true } : prev)
      setTxLoading(false)
      return [userPosition?.xlmAmount ?? 0, 0]
    }
    if (!address || !signTransaction) throw new Error('Wallet not connected')
    setTxLoading(true)
    try {
      const result = await invokeContract({
        contractId: CONTRACTS.COVERED_CALL_VAULT,
        method: 'claim',
        args: [new Address(address).toScVal()],
        signerAddress: address,
        signTransaction,
      })
      await loadUserPosition()
      return result
    } finally {
      setTxLoading(false)
    }
  }, [address, signTransaction, loadUserPosition, userPosition])

  return {
    vaultStats,
    userPosition,
    strikes,
    loading,
    txLoading,
    calculatePremium,
    deposit,
    claim,
    refresh: () => { loadVaultStats(); loadUserPosition() },
  }
}
