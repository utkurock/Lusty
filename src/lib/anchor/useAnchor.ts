'use client'

/**
 * The two pieces of state every anchor screen needs: what the anchor said it
 * is, and whether this wallet has logged into it.
 *
 * Both are kept here rather than in the pages so the deposit and withdrawal
 * screens cannot drift apart on what "signed in" means.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useWalletContext } from '@/providers/WalletProvider'
import { anchorCurrency, loadAnchorToml, AnchorError } from './client'
import { ANCHOR_HOME_DOMAIN, POLL_INTERVAL_MS } from './config'
import { authenticate, clearSession, readSession } from './session'
import { fetchTransaction, isSettled } from './sep6'
import type { AnchorCurrency, AnchorSession, AnchorToml, AnchorTransaction } from './types'

export interface AnchorConfig {
  toml: AnchorToml | null
  currency: AnchorCurrency | null
  loading: boolean
  error: string | null
}

/** SEP-1, once per page load. */
export function useAnchorConfig(): AnchorConfig {
  const [state, setState] = useState<AnchorConfig>({
    toml: null,
    currency: null,
    loading: true,
    error: null,
  })

  useEffect(() => {
    let live = true
    Promise.all([loadAnchorToml(), anchorCurrency()])
      .then(([toml, currency]) => live && setState({ toml, currency, loading: false, error: null }))
      .catch(
        e =>
          live &&
          setState({ toml: null, currency: null, loading: false, error: describe(e) })
      )
    return () => {
      live = false
    }
  }, [])

  return state
}

export interface AnchorSessionState {
  address: string | null
  connected: boolean
  session: AnchorSession | null
  /** The SEP-10 round trip, including connecting a wallet if there is none. */
  signIn: () => Promise<AnchorSession | null>
  signOut: () => void
  busy: boolean
  error: string | null
}

export function useAnchorSession(): AnchorSessionState {
  const { address, connected, connect, signTransaction, syncAddress } = useWalletContext()
  const [session, setSession] = useState<AnchorSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A token belongs to one account. Switching accounts in the extension has to
  // drop it, or the next call would ramp into an address nobody is looking at.
  useEffect(() => {
    setSession(address ? readSession(ANCHOR_HOME_DOMAIN, address) : null)
  }, [address])

  const signIn = useCallback(async (): Promise<AnchorSession | null> => {
    setError(null)
    if (!connected || !address) {
      await connect()
      return null
    }
    setBusy(true)
    try {
      const live = (await syncAddress()) ?? address
      const stored = readSession(ANCHOR_HOME_DOMAIN, live)
      if (stored) {
        setSession(stored)
        return stored
      }
      const fresh = await authenticate(live, signTransaction)
      setSession(fresh)
      return fresh
    } catch (e) {
      setError(describe(e))
      return null
    } finally {
      setBusy(false)
    }
  }, [address, connected, connect, signTransaction, syncAddress])

  const signOut = useCallback(() => {
    if (address) clearSession(ANCHOR_HOME_DOMAIN, address)
    setSession(null)
  }, [address])

  return { address, connected, session, signIn, signOut, busy, error }
}

/**
 * Follow one transaction until it stops moving.
 *
 * Both flows hand off to the anchor and then wait — for a simulated bank, for a
 * payment to be noticed — and neither can show anything true in the meantime
 * except the status the anchor is reporting.
 */
export function useTransactionPoll(
  id: string | null,
  token: string | undefined
): { tx: AnchorTransaction | null; error: string | null; refresh: () => void } {
  const [tx, setTx] = useState<AnchorTransaction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const settled = useRef(false)

  useEffect(() => {
    settled.current = false
    setTx(null)
    setError(null)
  }, [id])

  useEffect(() => {
    if (!id || !token) return
    let live = true

    const tick = async () => {
      try {
        const next = await fetchTransaction(id, token)
        if (!live) return
        setTx(next)
        setError(null)
        if (isSettled(next.status)) settled.current = true
      } catch (e) {
        if (live) setError(describe(e))
      }
    }

    tick()
    const timer = setInterval(() => {
      if (settled.current) clearInterval(timer)
      else tick()
    }, POLL_INTERVAL_MS)

    return () => {
      live = false
      clearInterval(timer)
    }
  }, [id, token, nonce])

  return { tx, error, refresh: () => setNonce(n => n + 1) }
}

/** What went wrong, in the anchor's words where it had any. */
export function describe(e: unknown): string {
  if (e instanceof AnchorError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}
