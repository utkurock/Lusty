import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../routing/quote', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routing/quote')>()
  return { ...actual, quoteRoute: vi.fn() }
})
vi.mock('../routing/execute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routing/execute')>()
  return { ...actual, buildSwapTx: vi.fn() }
})

import { XLM } from '../assets'
import { LUSD_CODE, LUSD_ISSUER } from '../lusd'
import { USDC_CODE, USDC_ISSUER } from '../usdc'
import { quoteRoute, parRefusal, RouteRefused, type RouteQuote } from '../routing/quote'
import { buildSwapTx } from '../routing/execute'
import { inFlight, reserve, resetRoutingBudget } from '../routing/budget'
import { recent, resetRoutingJournal } from '../routing/journal'
import {
  cashRoute,
  fillRefusal,
  prepareRoutedSwap,
  resetRoutedSwaps,
  RoutedSwapRefused,
  settleRoutedSwap,
  type LedgerPathPayment,
} from '../routing/session'

const WRITER = 'GBAIN6CHZJGBL365JNXSRQEKALXYTWKXANQZ3RBM7AGUEYYKLJJ6SNR6'
const NOW = 1_800_000_000_000
const ROUTE = cashRoute()

function quote(sendAmount = 100.2, destAmount = 100): RouteQuote {
  return { route: ROUTE, destAmount, sendAmount, hops: [], quotedAt: NOW }
}

/** The path payment a correct fill leaves on the ledger. */
function ledgerOp(over: Partial<LedgerPathPayment> = {}): LedgerPathPayment {
  return {
    successful: true,
    type: 'path_payment_strict_receive',
    from: WRITER,
    to: WRITER,
    amount: '100.0000000',
    source_amount: '100.3000000',
    asset_code: LUSD_CODE,
    asset_issuer: LUSD_ISSUER,
    source_asset_code: USDC_CODE,
    source_asset_issuer: USDC_ISSUER as string,
    ...over,
  }
}

beforeEach(() => {
  resetRoutingBudget()
  resetRoutingJournal()
  resetRoutedSwaps()
  vi.mocked(quoteRoute).mockReset()
  vi.mocked(buildSwapTx).mockReset()
  vi.mocked(buildSwapTx).mockResolvedValue('XDR')
})

describe('a stablecoin route holds its price to par, not only to the quote', () => {
  it('refuses the testnet path as it stood on 2026-10-03: 3.37 USDC per LUSD', () => {
    expect(parRefusal(ROUTE, 33.6519045, 10)).toMatch(/from par/)
  })

  it('refuses a price as far below par as one above it', () => {
    expect(parRefusal(ROUTE, 95, 100)).toMatch(/from par/)
  })

  it('accepts a price inside the bound', () => {
    expect(parRefusal(ROUTE, 100.5, 100)).toBeNull()
    expect(parRefusal(ROUTE, 99.5, 100)).toBeNull()
  })

  it('has no par to hold a route to that declares none', () => {
    expect(parRefusal({ ...ROUTE, maxParDeviationBps: undefined }, 300, 100)).toBeNull()
  })
})

describe('prepare quotes, reserves and builds, or refuses before anything is signed', () => {
  it('returns the transaction and holds the book capacity while it is out', async () => {
    vi.mocked(quoteRoute).mockResolvedValue(quote())
    const prepared = await prepareRoutedSwap({ address: WRITER, book: XLM, destAmount: 100, now: NOW })

    expect(prepared.xdr).toBe('XDR')
    expect(prepared.destAmount).toBe(100)
    expect(prepared.sendMax).toBeGreaterThan(prepared.quoted)
    expect(inFlight(XLM.symbol, NOW)).toBe(100)
  })

  it('journals a route refusal and reserves nothing', async () => {
    vi.mocked(quoteRoute).mockRejectedValue(new RouteRefused('usdc->lusd: off par', 'off_par'))

    await expect(
      prepareRoutedSwap({ address: WRITER, book: XLM, destAmount: 100, now: NOW }),
    ).rejects.toMatchObject({ code: 'off_par' })
    expect(inFlight(XLM.symbol, NOW)).toBe(0)
    expect(recent(60_000, NOW)).toMatchObject([{ kind: 'refused', code: 'off_par', book: 'XLM' }])
    expect(buildSwapTx).not.toHaveBeenCalled()
  })

  it('refuses once swaps already out fill the book in-flight bound', async () => {
    // One swap cannot reach the bound on its own (the per-swap ceiling is
    // lower), so the book is filled the way it would be: by swaps in flight.
    reserve(XLM, XLM.routedCapUsd - 50, NOW)
    vi.mocked(quoteRoute).mockResolvedValue(quote())

    const err = await prepareRoutedSwap({ address: WRITER, book: XLM, destAmount: 100, now: NOW }).catch((e) => e)
    expect(err).toBeInstanceOf(RoutedSwapRefused)
    expect(err.code).toBe('routing_cap')
    expect(buildSwapTx).not.toHaveBeenCalled()
  })

  it('gives the capacity back if the transaction cannot be built', async () => {
    vi.mocked(quoteRoute).mockResolvedValue(quote())
    vi.mocked(buildSwapTx).mockRejectedValue(new Error('account not found'))

    await expect(
      prepareRoutedSwap({ address: WRITER, book: XLM, destAmount: 100, now: NOW }),
    ).rejects.toThrow('account not found')
    expect(inFlight(XLM.symbol, NOW)).toBe(0)
  })
})

describe('settle believes the ledger, not the caller', () => {
  async function prepared() {
    vi.mocked(quoteRoute).mockResolvedValue(quote())
    return prepareRoutedSwap({ address: WRITER, book: XLM, destAmount: 100, now: NOW })
  }

  it('records a fill at what the ledger says it cost, and releases', async () => {
    const { id } = await prepared()
    const settled = await settleRoutedSwap({ id, txHash: 'a'.repeat(64), now: NOW, read: async () => ledgerOp() })

    expect(settled).toEqual({ filled: true, destAmount: 100, spent: 100.3, quoted: 100.2 })
    expect(inFlight(XLM.symbol, NOW)).toBe(0)
    expect(recent(60_000, NOW)).toMatchObject([{ kind: 'filled', spent: 100.3, quoted: 100.2 }])
  })

  it('settles a swap once: the second call finds nothing', async () => {
    const { id } = await prepared()
    await settleRoutedSwap({ id, txHash: 'a'.repeat(64), now: NOW, read: async () => ledgerOp() })
    const again = await settleRoutedSwap({ id, txHash: 'a'.repeat(64), now: NOW, read: async () => ledgerOp() })

    expect(again.filled).toBe(false)
    expect(recent(60_000, NOW).filter((e) => e.kind === 'filled')).toHaveLength(1)
  })

  it('records an abandoned swap as not filled and releases', async () => {
    const { id } = await prepared()
    const settled = await settleRoutedSwap({ id, reason: 'op_over_source_max', now: NOW })

    expect(settled).toEqual({ filled: false, reason: 'op_over_source_max' })
    expect(inFlight(XLM.symbol, NOW)).toBe(0)
    expect(recent(60_000, NOW)).toMatchObject([{ kind: 'refused', code: 'not_filled' }])
  })

  it('does not record a fill for a transaction that is not the prepared swap', async () => {
    const { id } = await prepared()
    const settled = await settleRoutedSwap({
      id,
      txHash: 'a'.repeat(64),
      now: NOW,
      read: async () => ledgerOp({ to: 'GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6' }),
    })
    expect(settled.filled).toBe(false)
    expect(recent(60_000, NOW).filter((e) => e.kind === 'filled')).toHaveLength(0)
  })
})

describe('fillRefusal names what is wrong with a ledger operation', () => {
  const swap = { quote: quote(), sendMax: 100.71, destAmount: 100, destination: WRITER }

  it('accepts the payment that was prepared', () => {
    expect(fillRefusal(swap, WRITER, ledgerOp())).toBeNull()
  })

  it.each([
    ['missing', null, /no path payment/],
    ['failed', ledgerOp({ successful: false }), /failed/],
    ['a plain payment', ledgerOp({ type: 'payment' }), /strict-receive/],
    ['another account', ledgerOp({ from: 'GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6' }), /writer/],
    ['a lookalike USDC', ledgerOp({ source_asset_issuer: 'GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6' }), /different asset/],
    ['a short delivery', ledgerOp({ amount: '99.0000000' }), /delivered 99/],
  ])('refuses %s', (_label, op, why) => {
    expect(fillRefusal(swap, WRITER, op as any)).toMatch(why)
  })
})
