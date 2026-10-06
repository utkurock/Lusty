// One routed swap, from quote to ledger.
// ====================================
// The pieces beside this file each answer one question — may this path be
// taken, what does it cost, how much of the book is already in flight, what
// did the routes do. Nothing composed them, so nothing called them: the USDC
// leg of a put went through the distributor's bridge instead. This is the
// composition, and it runs on the server because two of the pieces live there.
// The in-flight bound and the journal are this process's memory; a swap built
// in the browser would hold no reservation and leave no record.
//
// TWO CALLS, AND THE WALLET BETWEEN THEM. `prepareRoutedSwap` quotes, reserves
// and builds the transaction the writer signs. `settleRoutedSwap` reads what
// the ledger says happened and releases the reservation either way. Between
// them the writer's wallet signs and submits, and nothing here holds a key.
//
// THE LEDGER DECIDES WHAT FILLED. A client reporting "it filled for this much"
// is not evidence. Settle fetches the transaction and its operation from
// Horizon and records the fill only when a successful path payment with these
// ends, this account and this amount is on the ledger. Anything else releases
// the reservation and records that the swap did not fill.

import { randomUUID } from 'crypto'
import { Horizon } from '@stellar/stellar-sdk'
import { HORIZON_URL } from '../stellar'
import { LUSD_CODE, LUSD_ISSUER } from '../lusd'
import { USDC_CODE, USDC_ISSUER } from '../usdc'
import type { UnderlyingAsset } from '../assets'
import { routeFor, type Route } from './allowlist'
import { quoteRoute, RouteRefused, type RouteRefusalCode } from './quote'
import { buildSwapTx, prepareSwap, type RoutedSwap } from './execute'
import { reserve, release, RoutingCapExceeded, type Reserved } from './budget'
import { record } from './journal'

/** The one route a vault flow takes today: the writer's USDC into put cash. */
export function cashRoute(): Route {
  const route = routeFor(
    { code: USDC_CODE, issuer: USDC_ISSUER },
    { code: LUSD_CODE, issuer: LUSD_ISSUER },
  )
  // A missing route is a broken allowlist, not a market condition.
  if (!route) throw new Error('usdc->lusd is not on the routing allowlist')
  return route
}

interface Pending {
  address: string
  book: string
  reserved: Reserved
  swap: RoutedSwap
  /** Same lapse as the reservation: an abandoned swap must not linger. */
  expiresAt: number
}

/** Matches the budget's reservation TTL, so the two lapse together. */
const PENDING_TTL_MS = 120_000

const pending = new Map<string, Pending>()

function sweep(now: number): void {
  for (const [id, p] of pending) {
    if (p.expiresAt <= now) pending.delete(id)
  }
}

export interface PreparedSwap {
  id: string
  xdr: string
  /** Exactly what the writer receives. */
  destAmount: number
  /** What the path finder quoted it at. */
  quoted: number
  /** The most it may cost; the network enforces this, not us. */
  sendMax: number
}

export class RoutedSwapRefused extends Error {
  constructor(
    message: string,
    readonly code: RouteRefusalCode | 'routing_cap',
  ) {
    super(message)
    this.name = 'RoutedSwapRefused'
  }
}

/**
 * Quote, reserve and build, or refuse before anything is signed.
 *
 * Every refusal is journaled, because a refusal mix is what the monitor reads
 * to tell an empty book from an allowlist that has fallen behind the market.
 */
export async function prepareRoutedSwap(params: {
  address: string
  book: UnderlyingAsset
  destAmount: number
  now?: number
}): Promise<PreparedSwap> {
  const { address, book, destAmount } = params
  const now = params.now ?? Date.now()
  const route = cashRoute()

  const refuse = (code: RouteRefusalCode | 'routing_cap', reason: string): never => {
    record({ kind: 'refused', route: route.id, book: book.symbol, code, reason, at: now })
    throw new RoutedSwapRefused(reason, code)
  }

  let swap: RoutedSwap
  try {
    swap = prepareSwap(await quoteRoute(route, destAmount, now), address, now)
  } catch (e) {
    if (e instanceof RouteRefused) return refuse(e.code, e.message)
    throw e
  }

  // Both ends are dollars, so the receive amount is the USD the book carries.
  let reserved: Reserved
  try {
    reserved = reserve(book, destAmount, now)
  } catch (e) {
    if (e instanceof RoutingCapExceeded) return refuse('routing_cap', e.message)
    throw e
  }

  let xdr: string
  try {
    xdr = await buildSwapTx(swap, address)
  } catch (e) {
    release(reserved)
    throw e
  }

  sweep(now)
  const id = randomUUID()
  pending.set(id, { address, book: book.symbol, reserved, swap, expiresAt: now + PENDING_TTL_MS })
  return { id, xdr, destAmount: swap.destAmount, quoted: swap.quote.sendAmount, sendMax: swap.sendMax }
}

/** What Horizon says one path payment did. The subset settle reads. */
export interface LedgerPathPayment {
  successful: boolean
  type: string
  from: string
  to: string
  amount: string
  source_amount: string
  asset_code?: string
  asset_issuer?: string
  source_asset_code?: string
  source_asset_issuer?: string
}

/**
 * Why this ledger operation is not the swap that was prepared. Null means it is.
 *
 * Pure so the half that decides is testable without pretending to be Horizon.
 */
export function fillRefusal(swap: RoutedSwap, address: string, op: LedgerPathPayment | null): string | null {
  if (!op) return 'no path payment in that transaction'
  if (!op.successful) return 'the transaction failed on the ledger'
  if (op.type !== 'path_payment_strict_receive') return `expected a strict-receive path payment, found ${op.type}`
  if (op.from !== address || op.to !== address) return 'the payment is not from and to the writer who prepared it'
  const { send, receive } = swap.quote.route
  if (op.source_asset_code !== send.code || op.source_asset_issuer !== send.issuer) return 'it spent a different asset'
  if (op.asset_code !== receive.code || op.asset_issuer !== receive.issuer) return 'it delivered a different asset'
  if (Number(op.amount) !== swap.destAmount) return `it delivered ${op.amount}, not ${swap.destAmount}`
  return null
}

export type SettledSwap =
  | { filled: true; destAmount: number; spent: number; quoted: number }
  | { filled: false; reason: string; retry?: true }

/**
 * The ledger could not be asked. Not the same answer as "no such payment": an
 * outage says nothing about what the writer's transaction did, so a swap is
 * not closed on one.
 */
export class LedgerUnreadable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnreadable'
  }
}

async function readPathPayment(txHash: string): Promise<LedgerPathPayment | null> {
  let ops: any
  try {
    ops = await new Horizon.Server(HORIZON_URL).operations().forTransaction(txHash).call()
  } catch (e: any) {
    // A 404 is Horizon's answer that the transaction is not on the ledger.
    // Anything else is Horizon not answering.
    if (e?.response?.status === 404) return null
    throw new LedgerUnreadable(e?.message ?? 'horizon unreachable')
  }
  const op = ops?.records?.[0] as any
  if (!op) return null
  return { ...op, successful: op.transaction_successful }
}

/**
 * Close a prepared swap against the ledger, or against the writer's word that
 * it never reached it.
 *
 * Without a hash the swap is abandoned: the writer declined to sign, or the
 * network refused the submission, and either way nothing moved — a path
 * payment is atomic. That is the one claim taken on the caller's word, and the
 * most it can do is release a reservation the caller holds anyway.
 */
export async function settleRoutedSwap(params: {
  id: string
  txHash?: string
  reason?: string
  now?: number
  read?: (txHash: string) => Promise<LedgerPathPayment | null>
}): Promise<SettledSwap> {
  const now = params.now ?? Date.now()
  sweep(now)
  const p = pending.get(params.id)
  if (!p) return { filled: false, reason: 'no such swap, or it lapsed' }

  const { route } = p.swap.quote
  const notFilled = (reason: string): SettledSwap => {
    pending.delete(params.id)
    release(p.reserved)
    record({ kind: 'refused', route: route.id, book: p.book, code: 'not_filled', reason, at: now })
    return { filled: false, reason }
  }

  if (!params.txHash) return notFilled(params.reason?.slice(0, 200) || 'abandoned before submission')

  let op: LedgerPathPayment | null
  try {
    op = await (params.read ?? readPathPayment)(params.txHash)
  } catch (e) {
    // The swap stays pending and its reservation stays held: recording it as
    // unfilled would put a fill the ledger may well hold into the journal as a
    // refusal, and drop the only record that could be settled correctly later.
    if (e instanceof LedgerUnreadable) {
      return { filled: false, reason: `the ledger could not be read (${e.message}); try again`, retry: true }
    }
    throw e
  }
  const refusal = fillRefusal(p.swap, p.address, op)
  if (refusal) return notFilled(refusal)

  pending.delete(params.id)
  release(p.reserved)
  const spent = Number(op!.source_amount)
  record({
    kind: 'filled',
    route: route.id,
    book: p.book,
    destAmount: p.swap.destAmount,
    quoted: p.swap.quote.sendAmount,
    spent,
    at: now,
  })
  return { filled: true, destAmount: p.swap.destAmount, spent, quoted: p.swap.quote.sendAmount }
}

/** Tests only. */
export function resetRoutedSwaps(): void {
  pending.clear()
}
