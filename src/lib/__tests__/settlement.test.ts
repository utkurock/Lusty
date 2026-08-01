import { describe, it, expect, vi, beforeEach } from 'vitest'
import { intParam } from '../utils'
import type { VaultPosition } from '../vault-contract'

// The chain is the only thing mocked. Everything the scan decides — expired or
// not, settled or not, where to resume — is exercised for real.
vi.mock('../vault-contract', () => ({
  getVaultStats: vi.fn(),
  getPosition: vi.fn(),
  settlePosition: vi.fn(),
}))

import { getVaultStats, getPosition, settlePosition } from '../vault-contract'
import {
  scanForSettlement,
  runSettlement,
  DEFAULT_SCAN_LIMIT,
} from '../settlement'

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
    const scan = await scanForSettlement({ now: NOW })
    expect(scan.candidates.map((c) => c.id)).toEqual([0, 1])
  })

  it('skips positions that have already settled', async () => {
    book([
      position({ id: 0, settled: true, outcome: 'kept' }),
      position({ id: 1 }),
      position({ id: 2, settled: true, outcome: 'assigned' }),
    ])
    const scan = await scanForSettlement({ now: NOW })
    expect(scan.candidates.map((c) => c.id)).toEqual([1])
  })

  it('skips positions that have not expired yet', async () => {
    book([
      position({ id: 0, expiry: new Date(NOW.getTime() + day) }),
      position({ id: 1, expiry: new Date(NOW.getTime() - day) }),
      position({ id: 2, expiry: new Date(NOW.getTime() + 30 * day) }),
    ])
    const scan = await scanForSettlement({ now: NOW })
    expect(scan.candidates.map((c) => c.id)).toEqual([1])
  })

  it('treats an expiry exactly at now as due', async () => {
    book([position({ id: 0, expiry: NOW })])
    const scan = await scanForSettlement({ now: NOW })
    expect(scan.candidates).toHaveLength(1)
  })

  it('bounds the walk and says where to resume', async () => {
    book(
      Array.from({ length: 10 }, (_, id) => position({ id })),
      10
    )
    const scan = await scanForSettlement({ from: 0, limit: 4, now: NOW })

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
    const scan = await scanForSettlement({ from: 4, limit: 4, now: NOW })

    expect(scan.cursor).toBe(4)
    expect(scan.scanned).toBe(2)
    expect(scan.candidates.map((c) => c.id)).toEqual([4, 5])
    // Reached the end: nothing left to come back for.
    expect(scan.nextCursor).toBeNull()
    expect(scan.unexamined).toBe(0)
  })

  it('reports an empty book without reading anything', async () => {
    book([], 0)
    const scan = await scanForSettlement({ now: NOW })
    expect(scan.candidates).toEqual([])
    expect(scan.nextCursor).toBeNull()
    expect(scan.unexamined).toBe(0)
    expect(getPosition).not.toHaveBeenCalled()
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

    const scan = await scanForSettlement({ now: NOW })
    expect(scan.candidates.map((c) => c.id)).toEqual([0, 2])
    expect(scan.unreadable).toEqual([1])
  })

  it('defaults to the documented scan limit', async () => {
    book([], 0)
    const scan = await scanForSettlement({ now: NOW })
    expect(DEFAULT_SCAN_LIMIT).toBeGreaterThan(0)
    expect(scan.cursor).toBe(0)
  })
})

describe('runSettlement', () => {
  const signer = {} as any
  const candidates = [0, 1, 2].map((id) => ({
    id,
    owner: 'GWRITER',
    side: 'call' as const,
    strike: 0.25,
    collateral: 1000,
    expiry: new Date(NOW.getTime() - day),
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
      { id: 1, error: 'Oracle price is stale — settlement is blocked' },
    ])
    expect(settlePosition).toHaveBeenCalledTimes(3)
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
    expect(run.deferred).toEqual([2])
    expect(settlePosition).toHaveBeenCalledTimes(2)
  })

  it('submits nothing at a cap of zero', async () => {
    const run = await runSettlement(candidates, signer, 0)
    expect(run.settled).toEqual([])
    expect(run.deferred).toEqual([0, 1, 2])
    expect(settlePosition).not.toHaveBeenCalled()
  })
})
