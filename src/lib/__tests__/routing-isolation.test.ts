import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VaultPosition } from '../vault-contract'

// Routing cannot reach a position's terms.
// ========================================
// The milestone's sharpest criterion, and the one worth being paranoid about:
// a swap is the only part of this system that can fail halfway through a
// writer's intent, and a strike or an expiry that moved because a swap went
// badly would be the vault rewriting a trade after the fact.
//
// It cannot, and there are two separate reasons — which is the point of testing
// both. The STRUCTURAL one is that settlement never imports routing, so there
// is no call path along which an outcome could travel. The BEHAVIOURAL one is
// that a position's terms are read from the contract, which is a different
// authority entirely: they were fixed at write time, they live in contract
// storage, and nothing off chain can edit them.
//
// A test of only the second would pass on a system where the first was about
// to become false.

// ── Structural ──────────────────────────────────────────────────────────────

const SETTLEMENT_MODULES = [
  'settlement.ts',
  'settlement-sweep.ts',
  'settlement-scheduler.ts',
  'vault-contract.ts',
  'reflector.ts',
  'oracle-window.ts',
]

function sourceOf(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

describe('nothing on the settlement path can see routing', () => {
  for (const rel of SETTLEMENT_MODULES) {
    it(`${rel} does not import it`, () => {
      const code = sourceOf(rel)
      expect(code).not.toMatch(/from\s+['"][./@\w/]*routing/)
      expect(code).not.toMatch(/import\(['"][./@\w/]*routing/)
    })
  }

  it('and routing cannot settle, quote a premium, or write a position', () => {
    // The other direction. Routing moving one stablecoin into another is the
    // whole of what it does; a module that could also call `settle` or the
    // pricing engine would be one refactor away from a swap outcome reaching a
    // premium.
    for (const rel of ['routing/allowlist.ts', 'routing/quote.ts', 'routing/execute.ts']) {
      const code = sourceOf(rel)
      expect(code).not.toMatch(/from\s+['"][./@\w/]*(vault-contract|settlement|pricing)/)
      expect(code).not.toMatch(/\bsettlePosition\b|\bquoteOption\b|\bopen\b\s*\(/)
    }
  })
})

// ── Behavioural ─────────────────────────────────────────────────────────────

vi.mock('../vault-contract', () => ({
  getVaultStats: vi.fn(),
  getPosition: vi.fn(),
  settlePosition: vi.fn(),
}))

import { getVaultStats, getPosition, settlePosition } from '../vault-contract'
import { scanForSettlement, runSettlement } from '../settlement'
import { XLM } from '../assets'
import { Keypair } from '@stellar/stellar-sdk'
import { quoteRoute, type RouteRefusalCode } from '../routing/quote'
import { prepareSwap } from '../routing/execute'
import { routeFor } from '../routing/allowlist'
import { LUSD_CODE, LUSD_ISSUER } from '../lusd'
import { USDC_CODE, USDC_ISSUER } from '../usdc'

const NOW = new Date('2026-08-01T12:00:00Z')
const day = 86_400_000
const ROUTE = routeFor(
  { code: USDC_CODE, issuer: USDC_ISSUER },
  { code: LUSD_CODE, issuer: LUSD_ISSUER },
)!

/** The terms a writer agreed to. Whatever happens, these come back unchanged. */
const TERMS = {
  owner: 'GWRITER',
  side: 'put' as const,
  collateral: 250,
  strike: 0.21,
  expiry: new Date(NOW.getTime() - day),
  premium: 4,
}

function position(over: Partial<VaultPosition> = {}): VaultPosition {
  return { id: 0, ...TERMS, settled: false, outcome: 'open', ...over }
}

beforeEach(() => {
  vi.mocked(getVaultStats).mockReset()
  vi.mocked(getPosition).mockReset()
  vi.mocked(settlePosition).mockReset()
  vi.mocked(getVaultStats).mockResolvedValue({
    escrowedCall: 0,
    escrowedPut: 250,
    owedCall: 0,
    owedPut: 0,
    cashBalance: 1_000,
    underlyingBalance: 1_000,
    nextId: 1,
  })
  vi.mocked(getPosition).mockResolvedValue(position())
  vi.mocked(settlePosition).mockResolvedValue({ txHash: 'HASH', outcome: 'kept' })
})

/**
 * Every way routing can fail, each one made to happen for real rather than
 * described. The assertion after each is the same, deliberately: the position
 * is what it was.
 */
const FAILURES: Array<[string, RouteRefusalCode, () => Promise<unknown>]> = [
  [
    'the path finder is unreachable',
    'unreachable',
    async () => {
      const g: any = globalThis
      const saved = g.fetch
      g.fetch = async () => {
        throw new Error('ECONNREFUSED')
      }
      try {
        return await quoteRoute(ROUTE, 100)
      } finally {
        g.fetch = saved
      }
    },
  ],
  [
    'the amount is above what one swap may carry',
    'above_notional',
    () => quoteRoute(ROUTE, ROUTE.maxNotional + 1),
  ],
  [
    'the amount is not an amount',
    'invalid_amount',
    () => quoteRoute(ROUTE, 0),
  ],
  [
    'the quote has gone stale before it could be spent',
    'stale_quote',
    async () =>
      prepareSwap(
        { route: ROUTE, destAmount: 100, sendAmount: 100, hops: [], quotedAt: 0 },
        TERMS.owner,
        ROUTE.quoteMaxAgeMs + 1,
      ),
  ],
  [
    'the quote is for more than the route ceiling',
    'above_notional',
    async () =>
      prepareSwap(
        {
          route: ROUTE,
          destAmount: ROUTE.maxNotional + 1,
          sendAmount: ROUTE.maxNotional + 1,
          hops: [],
          quotedAt: 0,
        },
        TERMS.owner,
        0,
      ),
  ],
]

describe('a routing failure leaves an open position exactly as written', () => {
  for (const [what, code, fail] of FAILURES) {
    it(`survives: ${what}`, async () => {
      // The code, not just the type: 'the finder is unreachable' passing
      // because it quietly reached the network and found no liquidity would be
      // a test of nothing.
      await expect(fail()).rejects.toMatchObject({ name: 'RouteRefused', code })

      // Read the position back the way settlement reads it: off the contract.
      const scan = await scanForSettlement({ now: NOW, asset: XLM })
      expect(scan.candidates).toHaveLength(1)

      const p = await getPosition(0, XLM)
      expect(p.strike).toBe(TERMS.strike)
      expect(p.expiry.getTime()).toBe(TERMS.expiry.getTime())
      expect(p.collateral).toBe(TERMS.collateral)
      expect(p.premium).toBe(TERMS.premium)
      expect(p.side).toBe(TERMS.side)
      expect(p.owner).toBe(TERMS.owner)
    })
  }

  it('and settles at those terms, with no routing input anywhere in the call', async () => {
    for (const [, code, fail] of FAILURES) {
      await expect(fail()).rejects.toMatchObject({ name: 'RouteRefused', code })
    }

    const scan = await scanForSettlement({ now: NOW, asset: XLM })
    const run = await runSettlement(scan.candidates, Keypair.random())

    expect(run.settled).toHaveLength(1)
    expect(run.failed).toHaveLength(0)
    // The whole argument in one line: settling takes an id, a signer and a
    // book. There is no third thing a swap could have changed.
    expect(vi.mocked(settlePosition).mock.calls[0]).toHaveLength(3)
    expect(vi.mocked(settlePosition).mock.calls[0][0]).toBe(0)
    expect(vi.mocked(settlePosition).mock.calls[0][2]).toBe(XLM)
  })
})
