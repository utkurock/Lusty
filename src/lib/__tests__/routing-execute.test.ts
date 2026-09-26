import { describe, it, expect } from 'vitest'
import { routeFor, type RoutedAsset } from '../routing/allowlist'
import { RouteRefused, type RouteQuote } from '../routing/quote'
import {
  prepareSwap,
  sendMaxFor,
  slippageBps,
  swapOperation,
} from '../routing/execute'
import { LUSD_CODE, LUSD_ISSUER } from '../lusd'
import { USDC_CODE, USDC_ISSUER } from '../usdc'

const LUSD: RoutedAsset = { code: LUSD_CODE, issuer: LUSD_ISSUER }
const USDC: RoutedAsset = { code: USDC_CODE, issuer: USDC_ISSUER }
const ROUTE = routeFor(USDC, LUSD)!
const NOW = 1_700_000_000_000
const WRITER = 'GDXUHMT3QELEW6YBKSYXJBBXINUWA2MFR26RIS6C332N25EYU3D6CJ4V'

function quote(over: Partial<RouteQuote> = {}): RouteQuote {
  return {
    route: ROUTE,
    destAmount: 100,
    sendAmount: 100,
    hops: [],
    quotedAt: NOW,
    ...over,
  }
}

describe('the send maximum is derived, never supplied', () => {
  it('sits exactly the route s allowance above the quote', () => {
    const q = quote({ sendAmount: 100 })
    const max = sendMaxFor(q)
    expect(slippageBps(q, max)).toBeLessThanOrEqual(ROUTE.maxSlippageBps + 1e-6)
    expect(max).toBeGreaterThan(q.sendAmount)
  })

  it('rounds the ceiling up to something representable', () => {
    // Seven decimals is what the ledger carries. Rounding a ceiling DOWN would
    // make it tighter than the route declares and fail trades the desk said it
    // would take; a ceiling is the one bound where up is the safe direction.
    const max = sendMaxFor(quote({ sendAmount: 3.3333333 }))
    expect(max).toBeCloseTo(Number(max.toFixed(7)), 12)
    expect(max * 1e7).toBeCloseTo(Math.round(max * 1e7), 6)
  })

  it('scales with the quote rather than with the amount received', () => {
    const cheap = sendMaxFor(quote({ sendAmount: 99 }))
    const dear = sendMaxFor(quote({ sendAmount: 101 }))
    expect(dear).toBeGreaterThan(cheap)
  })
})

describe('a swap is refused in every state where sending is worse than not', () => {
  it('refuses a quote older than the route stands behind', () => {
    const q = quote()
    expect(() => prepareSwap(q, WRITER, NOW + ROUTE.quoteMaxAgeMs)).not.toThrow()
    expect(() => prepareSwap(q, WRITER, NOW + ROUTE.quoteMaxAgeMs + 1)).toThrow(RouteRefused)
  })

  it('refuses an amount above the route ceiling even if it was quoted', () => {
    // The ceiling is checked again here rather than trusted from quote time:
    // a quote is an object a caller can hold, and the bound has to hold at the
    // moment the transaction is built.
    const q = quote({ destAmount: ROUTE.maxNotional + 1, sendAmount: ROUTE.maxNotional + 1 })
    try {
      prepareSwap(q, WRITER, NOW)
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e).toBeInstanceOf(RouteRefused)
      expect(e.code).toBe('above_notional')
    }
  })

  it('does not let a caller widen the bound by handing back a cheaper quote', () => {
    // A caller holding a quote object could try claiming a tiny sendAmount to
    // make the ratio look tight. It cannot help them: the maximum is derived
    // from that same number, so understating it lowers the ceiling.
    const understated = prepareSwap(quote({ sendAmount: 1 }), WRITER, NOW)
    const honest = prepareSwap(quote({ sendAmount: 100 }), WRITER, NOW)
    expect(understated.sendMax).toBeLessThan(honest.sendMax)
  })
})

describe('the operation carries both bounds, so the network enforces them', () => {
  it('names the exact amount received and the most that may be spent', () => {
    const swap = prepareSwap(quote({ destAmount: 250, sendAmount: 249.5 }), WRITER, NOW)
    const op = swapOperation(swap) as any
    const body = op.body().pathPaymentStrictReceiveOp()

    // destAmount is exact: the network delivers this or the operation fails.
    expect(Number(body.destAmount().toString()) / 1e7).toBeCloseTo(250, 7)
    // sendMax is the ceiling, and it is the derived one.
    expect(Number(body.sendMax().toString()) / 1e7).toBeCloseTo(swap.sendMax, 7)
    expect(swap.sendMax).toBeGreaterThan(249.5)
  })

  it('sends the path the quote was taken over, not an empty one', () => {
    // The path is not a suggestion — the network walks exactly this one, which
    // is what makes the allowlist check at quote time binding at execution
    // time rather than advisory.
    const wide = { ...ROUTE, maxHops: 1 }
    const swap = prepareSwap(
      quote({ route: wide, hops: [{ code: 'XLM', issuer: null }] }),
      WRITER,
      NOW,
    )
    const body = (swapOperation(swap) as any).body().pathPaymentStrictReceiveOp()
    expect(body.path()).toHaveLength(1)
  })

  it('pays whoever the swap names, and nobody else', () => {
    const swap = prepareSwap(quote(), WRITER, NOW)
    const body = (swapOperation(swap) as any).body().pathPaymentStrictReceiveOp()
    expect(body.destination().switch().name).toBe('keyTypeEd25519')
    expect(swap.destination).toBe(WRITER)
  })
})
