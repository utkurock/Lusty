'use client'
import { useCallback, useEffect, useState } from 'react'
import { HORIZON_URL } from '@/lib/stellar'
import type { StellarAsset } from '@/lib/assets'

// What Stellar keeps locked in every account. The protocol's minimum balance is
// (2 + subentries) × base reserve, and base reserve is 0.5 XLM. An account that
// spends into it cannot submit the transaction at all — so for native XLM the
// number worth showing next to an amount field is not the balance, it is the
// balance minus what the network will not let go of.
const BASE_RESERVE_XLM = 0.5
const BASE_ENTRIES = 2

// Room for the fee on the transaction being prepared, plus the trustline the
// deposit path may open first. Small and deliberately generous: "max" landing
// one stroop short of submittable is the failure this whole number exists to
// avoid.
const FEE_BUFFER_XLM = 1

// A balance is read to be looked at, not to be priced off, so a stale one is
// cheap and a missing one is not. Refreshed on a timer and on demand.
const POLL_MS = 30_000

export interface WalletBalance {
  /** Held in the asset's own units, or 0 when there is nothing to hold. */
  balance: number
  /**
   * What a deposit can actually use: the balance, minus the account reserve
   * and a fee buffer for native XLM. Identical to `balance` for issued assets,
   * whose reserve is paid in XLM rather than out of the line itself.
   */
  spendable: number
  /**
   * True when the account holds no line for this asset — no trustline, or the
   * account is not funded at all. Distinct from a zero balance: one is a
   * missing permission to be paid, the other is an empty wallet.
   */
  missing: boolean
  loading: boolean
  /**
   * True once a read has actually landed. A caller that refuses a deposit over
   * an insufficient balance has to know the difference between "this wallet
   * holds nothing" and "we have not managed to look yet" — the initial state
   * of every number here is zero, and refusing on that would block a deposit
   * because Horizon was slow.
   */
  read: boolean
  /** Null until a read has failed; the message is for a caller that shows it. */
  error: string | null
  refresh: () => void
}

interface HorizonBalance {
  balance: string
  asset_type: string
  asset_code?: string
  asset_issuer?: string
}

/** Picks the line for `asset` out of a Horizon account's balances. */
export function lineFor(
  balances: HorizonBalance[],
  asset: StellarAsset,
): HorizonBalance | null {
  if (asset.kind === 'native') {
    return balances.find((b) => b.asset_type === 'native') ?? null
  }
  if (!asset.issuer) return null
  return (
    balances.find(
      (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer,
    ) ?? null
  )
}

/** Balance minus what the network will not let the account spend. */
export function spendableOf(
  balance: number,
  asset: StellarAsset,
  subentryCount: number,
): number {
  if (asset.kind !== 'native') return balance
  const reserve = (BASE_ENTRIES + subentryCount) * BASE_RESERVE_XLM
  return Math.max(0, balance - reserve - FEE_BUFFER_XLM)
}

/**
 * The connected wallet's balance in one asset, read straight from Horizon.
 *
 * Client-side on purpose: it is the visitor's own public account, the endpoint
 * is already in the page's connect-src, and routing it through our server
 * would put a cache between a number and the wallet it describes.
 */
export function useBalance(
  address: string | null,
  asset: StellarAsset | null,
): WalletBalance {
  const [balance, setBalance] = useState(0)
  const [spendable, setSpendable] = useState(0)
  const [missing, setMissing] = useState(false)
  const [read, setRead] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  // The asset is an object, so it is compared by what it names rather than by
  // identity: a caller that rebuilds it each render would otherwise refetch on
  // every keystroke in the field this number sits above.
  const assetKey =
    asset === null
      ? null
      : asset.kind === 'native'
        ? 'native'
        : `${asset.code}:${asset.issuer ?? ''}`

  useEffect(() => {
    if (!address || !asset || assetKey === null) {
      setBalance(0)
      setSpendable(0)
      setMissing(false)
      setRead(false)
      setError(null)
      return
    }

    // The asset just changed, so the numbers below describe the previous one
    // until the next read lands. Nothing may be refused on them meanwhile.
    setRead(false)

    let cancelled = false
    const read = async () => {
      setLoading(true)
      try {
        const r = await fetch(`${HORIZON_URL}/accounts/${address}`, {
          cache: 'no-store',
        })
        if (cancelled) return
        // An unfunded account is a 404 and an ordinary state on testnet, not a
        // failure: it holds nothing, which is exactly what it should report.
        if (r.status === 404) {
          setBalance(0)
          setSpendable(0)
          setMissing(true)
          setRead(true)
          setError(null)
          return
        }
        if (!r.ok) throw new Error(`horizon ${r.status}`)
        const account = await r.json()
        if (cancelled) return
        const line = lineFor(account?.balances ?? [], asset)
        if (!line) {
          setBalance(0)
          setSpendable(0)
          setMissing(true)
          setRead(true)
          setError(null)
          return
        }
        const held = parseFloat(line.balance)
        const n = isFinite(held) && held > 0 ? held : 0
        setBalance(n)
        setSpendable(spendableOf(n, asset, Number(account?.subentry_count ?? 0)))
        setMissing(false)
        setRead(true)
        setError(null)
      } catch (e) {
        if (cancelled) return
        setError((e as Error)?.message ?? 'balance unavailable')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    read()
    const id = setInterval(read, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, assetKey, tick])

  return { balance, spendable, missing, read, loading, error, refresh }
}
