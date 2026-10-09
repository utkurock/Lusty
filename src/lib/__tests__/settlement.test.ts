import { describe, it, expect, vi, beforeEach } from 'vitest'
import { intParam } from '../utils'
import type { VaultPosition } from '../vault-contract'

// The chain is the only thing mocked. Everything the scan decides — expired or
// not, settled or not, where to resume — is exercised for real.
vi.mock('../vault-contract', () => ({
  getVaultStats: vi.fn(),
  getPosition: vi.fn(),
  settlePosition: vi.fn(),
  recordExpiryPrice: vi.fn(),
}))

import { getVaultStats, getPosition, settlePosition, recordExpiryPrice } from '../vault-contract'
import {
  scanForSettlement,
  runSettlement,
  prioritize,
  resetSettlementMemory,
  DEFAULT_SCAN_LIMIT,
  ORACLE_HISTORY_SECS,
} from '../settlement'
import { XLM } from '../assets'

const NOW = new Date('2026-08-01T12:00:00Z')
const day = 86_400_000

function position(over: Partial<VaultPosition> & { id: number }): VaultPosition {
  return {
    owner: 'GWRITER',
    side: 'call',
    collateral: 1000,
    strike: 0.25,
    expiry: new Date(NOW.getTime() - day),
    premium: 4,
    settled: false,
    outcome: 'open',
    ...over,
  }
}

/** Serve a fixed book from the mocked chain. */
function book(positions: VaultPosition[], nextId = positions.length) {
  vi.mocked(getVaultStats).mockResolvedValue({
    escrowedCall: 0,
    escrowedPut: 0,
    owedCall: 0,
    owedPut: 0,
    cashBalance: 0,
    underlyingBalance: 0,
    nextId,
  })
  vi.mocked(getPosition).mockImplementation(async (id: number) => {
    const found = positions.find((p) => p.id === id)
    if (!found) throw new Error(`Position not found: ${id}`)
    return found
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSettlementMemory()
})

describe('intParam — the runner\'s batch limits depend on it', () => {
  it('falls back when the parameter is absent or blank', () => {
    // Caught live: the inline version of this returned 0 for a missing
    // parameter, because Number(null) is 0 and passes a >= 0 guard. The
    // sweep then scanned one position and reported success, and with the
    // same bug on maxSettlements it would have submitted nothing at all.
    const empty = new URLSearchParams()
    expect(intParam(empty, 'limit', 200)).toBe(200)
    expect(intParam(new URLSearchParams('limit='), 'limit', 200)).toBe(200)
    expect(intParam(new URLSearchParams('limit=%20'), 'limit', 200)).toBe(200)
  })

  it('reads a real value, including an explicit zero', () => {
    expect(intParam(new URLSearchParams('limit=5'), 'limit', 200)).toBe(5)
    expect(intParam(new URLSearchParams('limit=0'), 'limit', 200)).toBe(0)
    expect(intParam(new URLSearchParams('limit=7.9'), 'limit', 200)).toBe(7)
  })

  it('falls back on anything that is not a non-negative number', () => {
    expect(intParam(new URLSearchParams('limit=-1'), 'limit', 200)).toBe(200)
    expect(intParam(new URLSearchParams('limit=abc'), 'limit', 200)).toBe(200)
    expect(intParam(new URLSearchParams('limit=NaN'), 'limit', 200)).toBe(200)
  })
})

describe('scanForSettlement', () => {
  it('selects positions that have expired and not settled', async () => {
    book([
      position({ id: 0, expiry: new Date(NOW.getTime() - day) }),
      position({ id: 1, expiry: new Date(NOW.getTime() - 5 * day) }),
    ])
    const scan = await scanForSettlement({ now: NOW, asset: XLM })
    expect(scan.candidates.map((c) => c.id)).toEqual([0, 1])
  })

  it('skips positions that have already settled', async () => {
    book([
      position({ id: 0, settled: true, outcome: 'kept' }),
      position({ id: 1 }),
      position({ id: 2, settled: true, outcome: 'assigned' }),
    ])
    const scan = await scanForSettlement({ now: NOW, asset: XLM })
    expect(scan.candidates.map((c) => c.id)).toEqual([1])
  })

  it('skips positions that have not expired yet', async () => {
    book([
      position({ id: 0, expiry: new Date(NOW.getTime() + day) }),
      position({ id: 1, expiry: new Date(NOW.getTime() - day) }),
      position({ id: 2, expiry: new Date(NOW.getTime() + 30 * day) }),
    ])
    const scan = await scanForSettlement({ now: NOW, asset: XLM })
    expect(scan.candidates.map((c) => c.id)).toEqual([1])
  })

  it('treats an expiry exactly at now as due', async () => {
    book([position({ id: 0, expiry: NOW })])
    const scan = await scanForSettlement({ now: NOW, asset: XLM })
    expect(scan.candidates).toHaveLength(1)
  })

  it('bounds the walk and says where to resume', async () => {
    book(
      Array.from({ length: 10 }, (_, id) => position({ id })),
      10
    )
    const scan = await scanForSettlement({ from: 0, limit: 4, now: NOW, asset: XLM })

    expect(scan.scanned).toBe(4)
    expect(scan.candidates.map((c) => c.id)).toEqual([0, 1, 2, 3])
    expect(scan.nextCursor).toBe(4)
    expect(scan.unexamined).toBe(6)
    expect(getPosition).toHaveBeenCalledTimes(4)
  })

  it('resumes from a cursor and reports the end of the range', async () => {
    book(
      Array.from({ length: 6 }, (_, id) => position({ id })),
      6
    )
    const scan = await scanForSettlement({ from: 4, limit: 4, now: NOW, asset: XLM })

    expect(scan.cursor).toBe(4)
    expect(scan.scanned).toBe(2)
    expect(scan.candidates.map((c) => c.id)).toEqual([4, 5])
    // Reached the end: nothing left to come back for.
    expect(scan.nextCursor).toBeNull()
    expect(scan.unexamined).toBe(0)
  })

  it('reports an empty book without reading anything', async () => {
    book([], 0)
    const scan = await scanForSettlement({ now: NOW, asset: XLM })
    expect(scan.candidates).toEqual([])
    expect(scan.nextCursor).toBeNull()
    expect(scan.unexamined).toBe(0)
    expect(getPosition).not.toHaveBeenCalled()
  })

  it('flags a position the oracle can no longer price, and still lists it', async () => {
    // Past the feed's history window the contract fails closed and the
    // collateral cannot be released by anyone. The scan says so rather than
    // reporting it beside positions that will close on the next run — but it
    // keeps it in the candidate list, because the window belongs to the feed
    // and a wrong constant here must not be what abandons a position.
    book([
      position({ id: 0, expiry: new Date(NOW.getTime() - 5 * day) }),
      position({ id: 1, expiry: new Date(NOW.getTime() - 2 * 3_600_000) }),
    ])
    const scan = await scanForSettlement({ now: NOW, asset: XLM })

    expect(scan.candidates.map((c) => c.id)).toEqual([0, 1])
    expect(scan.pastDeadline).toEqual([0])
    expect(scan.candidates[0].pastDeadline).toBe(true)
    expect(scan.candidates[1].pastDeadline).toBe(false)
  })

  it('dates the deadline from expiry, not from the moment it looked', async () => {
    const expiry = new Date(NOW.getTime() - 3 * 3_600_000)
    book([position({ id: 0, expiry })])
    const scan = await scanForSettlement({ now: NOW, asset: XLM })
    expect(scan.candidates[0].settleBy.getTime()).toBe(
      expiry.getTime() + ORACLE_HISTORY_SECS * 1000
    )
  })

  it('treats the deadline itself as still in time', async () => {
    // The boundary belongs to the side that can still act. A position written
    // off one millisecond early is written off for nothing.
    book([
      position({ id: 0, expiry: new Date(NOW.getTime() - ORACLE_HISTORY_SECS * 1000) }),
      position({ id: 1, expiry: new Date(NOW.getTime() - ORACLE_HISTORY_SECS * 1000 - 1) }),
    ])
    const scan = await scanForSettlement({ now: NOW, asset: XLM })
    expect(scan.pastDeadline).toEqual([1])
  })

  it('records an unreadable position instead of hiding the ones behind it', async () => {
    vi.mocked(getVaultStats).mockResolvedValue({
      escrowedCall: 0,
      escrowedPut: 0,
      owedCall: 0,
      owedPut: 0,
      cashBalance: 0,
      underlyingBalance: 0,
      nextId: 3,
    })
    vi.mocked(getPosition).mockImplementation(async (id: number) => {
      if (id === 1) throw new Error('rpc blew up')
      return position({ id })
    })

    const scan = await scanForSettlement({ now: NOW, asset: XLM })
    expect(scan.candidates.map((c) => c.id)).toEqual([0, 2])
    expect(scan.unreadable).toEqual([1])
  })

  it('defaults to the documented scan limit', async () => {
    book([], 0)
    const scan = await scanForSettlement({ now: NOW, asset: XLM })
    expect(DEFAULT_SCAN_LIMIT).toBeGreaterThan(0)
    expect(scan.cursor).toBe(0)
  })
})

describe('runSettlement', () => {
  const signer = {} as any
  const candidates = [0, 1, 2].map((id) => ({
    id,
    owner: 'GWRITER',
    underlying: 'XLM' as const,
    side: 'call' as const,
    strike: 0.25,
    collateral: 1000,
    expiry: new Date(NOW.getTime() - day),
    settleBy: new Date(NOW.getTime() - day + ORACLE_HISTORY_SECS * 1000),
    pastDeadline: false,
  }))

  it('settles every candidate and reports the outcome', async () => {
    vi.mocked(settlePosition).mockImplementation(async (id: number) => ({
      txHash: `hash-${id}`,
      outcome: 'kept',
    }))

    const run = await runSettlement(candidates, signer)
    expect(run.settled.map((s) => s.id)).toEqual([0, 1, 2])
    expect(run.settled[0].txHash).toBe('hash-0')
    expect(run.failed).toEqual([])
    expect(run.deferred).toEqual([])
  })

  it('keeps going when one position fails, and names it', async () => {
    // A stale oracle feed is the likeliest cause, and the contract refuses on
    // purpose. The other positions are unaffected and must still close.
    vi.mocked(settlePosition).mockImplementation(async (id: number) => {
      if (id === 1) throw new Error('Oracle price is stale — settlement is blocked')
      return { txHash: `hash-${id}`, outcome: 'assigned' }
    })

    const run = await runSettlement(candidates, signer)
    expect(run.settled.map((s) => s.id)).toEqual([0, 2])
    expect(run.failed).toEqual([
      {
        id: 1,
        underlying: 'XLM',
        error: 'Oracle price is stale — settlement is blocked',
        permanent: false,
      },
    ])
    expect(settlePosition).toHaveBeenCalledTimes(3)
  })

  it('separates the failure that will never come good from the one that might', async () => {
    // Both come back from the contract as a refused price. Only one of them
    // gets better by waiting, and reporting them alike makes a position that
    // can no longer be closed look like a transient error.
    const mixed = [
      { ...candidates[0], pastDeadline: false },
      { ...candidates[1], pastDeadline: true },
    ]
    vi.mocked(settlePosition).mockRejectedValue(
      new Error('Oracle price is stale — settlement is blocked')
    )

    const run = await runSettlement(mixed, signer)
    expect(run.failed.map((f) => f.permanent)).toEqual([false, true])
  })

  it('survives a failure with no message', async () => {
    vi.mocked(settlePosition).mockRejectedValue({})
    const run = await runSettlement(candidates, signer)
    expect(run.failed.map((f) => f.error)).toEqual(['unknown', 'unknown', 'unknown'])
  })

  it('caps submissions per run and defers the rest', async () => {
    vi.mocked(settlePosition).mockImplementation(async (id: number) => ({
      txHash: `hash-${id}`,
      outcome: 'kept',
    }))

    const run = await runSettlement(candidates, signer, 2)
    expect(run.settled.map((s) => s.id)).toEqual([0, 1])
    expect(run.deferred).toEqual([{ id: 2, underlying: 'XLM' }])
    expect(settlePosition).toHaveBeenCalledTimes(2)
  })

  it('submits nothing at a cap of zero', async () => {
    const run = await runSettlement(candidates, signer, 0)
    expect(run.settled).toEqual([])
    expect(run.deferred).toEqual([
      { id: 0, underlying: 'XLM' },
      { id: 1, underlying: 'XLM' },
      { id: 2, underlying: 'XLM' },
    ])
    expect(settlePosition).not.toHaveBeenCalled()
  })
})

describe('the order a run submits in', () => {
  const at = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    owner: 'GWRITER',
    underlying: 'XLM' as const,
    side: 'call' as const,
    strike: 0.25,
    collateral: 1000,
    expiry: new Date(NOW.getTime() - day),
    settleBy: new Date(NOW.getTime() - day + ORACLE_HISTORY_SECS * 1000),
    pastDeadline: false,
    ...over,
  })

  it('puts positions it can still close ahead of ones past their deadline', () => {
    const order = prioritize([at(0, { pastDeadline: true }), at(1), at(2, { pastDeadline: true }), at(3)])
    expect(order.map((c) => c.id)).toEqual([1, 3, 0, 2])
  })

  it('closes the soonest deadline first', () => {
    const later = new Date(NOW.getTime() + day)
    const order = prioritize([at(0, { settleBy: later }), at(1)])
    expect(order.map((c) => c.id)).toEqual([1, 0])
  })

  it('sends a position that keeps failing behind ones not yet tried', async () => {
    // Positions whose payout can never land — the owner merged the account —
    // fail identically every run. In id order they would take the whole cap
    // every sweep, and every position behind them would age out unsettled.
    vi.mocked(settlePosition).mockImplementation(async (id: number) => {
      if (id < 2) throw new Error('trustline missing')
      return { txHash: `hash-${id}`, outcome: 'kept' }
    })
    const book = [at(0), at(1), at(2), at(3)]

    const first = await runSettlement(book, {} as any, 2)
    expect(first.failed.map((f) => f.id)).toEqual([0, 1])
    expect(first.settled).toEqual([])

    const second = await runSettlement(book, {} as any, 2)
    expect(second.settled.map((s) => s.id)).toEqual([2, 3])
    expect(second.deferred.map((d) => d.id)).toEqual([0, 1])
  })
})

describe('a failure inside the oracle window records its expiry s price', () => {
  const due = (id: number, expiry: Date, pastDeadline = false) => ({
    id,
    owner: 'GWRITER',
    underlying: 'XLM' as const,
    side: 'call' as const,
    strike: 0.25,
    collateral: 1000,
    expiry,
    settleBy: new Date(expiry.getTime() + ORACLE_HISTORY_SECS * 1000),
    pastDeadline,
  })

  it('writes each failing expiry once, and leaves past-deadline ones alone', async () => {
    // A position whose payout cannot land keeps failing; on v5 the price it
    // will settle at is put on chain before the oracle forgets it.
    const a = new Date(NOW.getTime() - day)
    const b = new Date(NOW.getTime() - 2 * day)
    vi.mocked(settlePosition).mockRejectedValue(new Error('trustline missing'))
    vi.mocked(recordExpiryPrice).mockResolvedValue('recorded')

    const run = await runSettlement([due(0, a), due(1, a), due(2, b, true)], {} as any)

    expect(recordExpiryPrice).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordExpiryPrice).mock.calls[0][0]).toEqual(a)
    expect(run.pricesRecorded).toEqual([{ underlying: 'XLM', expiry: a.toISOString() }])
  })

  it('reports nothing for an instance without record_price, and survives a failure', async () => {
    vi.mocked(settlePosition).mockRejectedValue(new Error('trustline missing'))
    vi.mocked(recordExpiryPrice).mockResolvedValueOnce('unsupported')
    const v4 = await runSettlement([due(0, new Date(NOW.getTime() - day))], {} as any)
    expect(v4.pricesRecorded).toEqual([])

    vi.mocked(recordExpiryPrice).mockRejectedValueOnce(new Error('rpc down'))
    const down = await runSettlement([due(1, new Date(NOW.getTime() - day))], {} as any)
    expect(down.pricesRecorded).toEqual([])
    expect(down.failed).toHaveLength(1)
  })
})
