'use client'
import { useState, useEffect, useCallback } from 'react'
import { nativeToScVal, Address } from '@stellar/stellar-sdk'
import { invokeContract, readContract, CONTRACTS } from '@/lib/stellar'
import { useWalletContext } from '@/providers/WalletProvider'
import { fromScaled, toScaled, getNextFriday, getDaysUntilExpiry } from '@/lib/utils'
import { generatePutStrikes, StrikeOption } from '@/lib/pricing'
import { useXlmPrice } from './useXlmPrice'

export interface PutVaultStats {
  totalDeposited: number // USDC
  vaultCap: number
  utilizationPercent: number
  daysToExpiry: number
  expiryDate: Date
  epochId: number
}

export interface PutUserPosition {
  usdcAmount: number
  strikeIndex: number
  strikePrice: number
  premiumPaid: number
  epochId: number
  isSettled: boolean
}

export function useCashSecuredPutVault() {
  const { address, signTransaction } = useWalletContext()
  const { price: xlmPrice } = useXlmPrice()
  const [vaultStats, setVaultStats] = useState<PutVaultStats | null>(null)
  const [userPosition, setUserPosition] = useState<PutUserPosition | null>(null)
  const [strikes, setStrikes] = useState<StrikeOption[]>([])
  const [loading, setLoading] = useState(false)
  const [txLoading, setTxLoading] = useState(false)

  useEffect(() => {
    if (xlmPrice > 0) {
      const daysToExpiry = getDaysUntilExpiry()
      setStrikes(generatePutStrikes(xlmPrice, 0.80, daysToExpiry))
    }
  }, [xlmPrice])

  // MOCK MODE: if PUT_VAULT is empty, return mock data without chain calls.
  const loadVaultStats = useCallback(async () => {
    if (!CONTRACTS.PUT_VAULT) {
      // MOCK MODE
      setVaultStats({
        totalDeposited: 340_000,
        vaultCap: 2_000_000,
        utilizationPercent: 17.0,
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
        contractId: CONTRACTS.PUT_VAULT,
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
    } catch {
      setVaultStats({
        totalDeposited: 340_000,
        vaultCap: 2_000_000,
        utilizationPercent: 17.0,
        daysToExpiry: getDaysUntilExpiry(),
        expiryDate: getNextFriday(),
        epochId: 1,
      })
    } finally {
      setLoading(false)
    }
  }, [address])

  const loadUserPosition = useCallback(async () => {
    if (!CONTRACTS.PUT_VAULT) {
      // MOCK MODE
      return
    }
    if (!address) return
    try {
      const position = await readContract({
        contractId: CONTRACTS.PUT_VAULT,
        method: 'get_user_position',
        args: [new Address(address).toScVal()],
        signerAddress: address,
      })
      if (position) {
        setUserPosition({
          usdcAmount: fromScaled(position.usdc_amount ?? position.xlm_amount),
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

  const calculatePremium = useCallback((usdcAmount: number, strikeIndex: number): number => {
    const strike = strikes[strikeIndex]
    if (!strike || xlmPrice <= 0) return 0
    // usdcAmount collateralizes usdcAmount/strike XLM equivalents; premium scales with notional
    const notionalXlm = usdcAmount / xlmPrice
    return strike.premium * notionalXlm
  }, [strikes, xlmPrice])

  const deposit = useCallback(async (usdcAmount: number, strikeIndex: number) => {
    // MOCK MODE
    if (!CONTRACTS.PUT_VAULT) {
      setTxLoading(true)
      await new Promise(r => setTimeout(r, 1500))
      const strike = strikes[strikeIndex]
      const premium = calculatePremium(usdcAmount, strikeIndex)
      setUserPosition({
        usdcAmount,
        strikeIndex,
        strikePrice: strike?.strike ?? 0,
        premiumPaid: premium,
        epochId: vaultStats?.epochId ?? 1,
        isSettled: false,
      })
      setVaultStats(prev => prev ? {
        ...prev,
        totalDeposited: prev.totalDeposited + usdcAmount,
        utilizationPercent: Math.min(100, ((prev.totalDeposited + usdcAmount) / prev.vaultCap) * 100),
      } : prev)
      setTxLoading(false)
      return premium
    }
    if (!address || !signTransaction) throw new Error('Wallet not connected')
    setTxLoading(true)
    try {
      const result = await invokeContract({
        contractId: CONTRACTS.PUT_VAULT,
        method: 'deposit',
        args: [
          new Address(address).toScVal(),
          nativeToScVal(toScaled(usdcAmount), { type: 'i128' }),
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
  }, [address, signTransaction, loadVaultStats, loadUserPosition, strikes, calculatePremium, vaultStats])

  const claim = useCallback(async () => {
    // MOCK MODE
    if (!CONTRACTS.PUT_VAULT) {
      setTxLoading(true)
      await new Promise(r => setTimeout(r, 1500))
      setUserPosition(prev => prev ? { ...prev, isSettled: true } : prev)
      setTxLoading(false)
      return [0, userPosition?.usdcAmount ?? 0]
    }
    if (!address || !signTransaction) throw new Error('Wallet not connected')
    setTxLoading(true)
    try {
      const result = await invokeContract({
        contractId: CONTRACTS.PUT_VAULT,
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
