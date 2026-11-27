import { describe, expect, it, vi } from 'vitest'
import { isBackupDue, runBackup } from '../../../scripts/lib/backup-settle.mjs'

// The backup settlement runner.
// =============================
// It runs from another host on its own key, and settles only what the primary
// left: positions expired for longer than the grace. A settle that fails gets
// its expiry's price recorded, once per expiry, so it can still be settled
// after the oracle prunes it. One vault or one position it cannot read does not
// stop the rest.

const NOW = 1_800_000_000
const HOUR = 3600
const V1 = 'CVAULTONE'
const V2 = 'CVAULTTWO'

function world(books: Record<string, { settled: boolean; expiry: number }[]>) {
  const settle = vi.fn(async (vault: string, id: number) => {
    books[vault][id].settled = true
    return { hash: `${vault}-${id}`, outcome: 'kept' }
  })
  const recordPrice = vi.fn(async () => 'recorded' as const)
  return {
    settle,
    recordPrice,
    io: {
      vaults: Object.keys(books),
      nextId: async (v: string) => books[v].length,
      readPosition: async (v: string, id: number) => books[v][id],
      settle,
      recordPrice,
      nowSecs: NOW,
      graceSecs: HOUR,
    },
  }
}

describe('isBackupDue', () => {
  it('leaves a position inside the grace to the primary', () => {
    expect(isBackupDue({ settled: false, expiry: NOW - HOUR + 1 }, NOW, HOUR)).toBe(false)
    expect(isBackupDue({ settled: false, expiry: NOW - HOUR }, NOW, HOUR)).toBe(true)
  })

  it('never takes a settled or an unexpired position, and reads a u64 expiry', () => {
    expect(isBackupDue({ settled: true, expiry: NOW - 10 * HOUR }, NOW, HOUR)).toBe(false)
    expect(isBackupDue({ settled: false, expiry: BigInt(NOW + HOUR) }, NOW, HOUR)).toBe(false)
    expect(isBackupDue({ settled: false, expiry: BigInt(NOW - 2 * HOUR) }, NOW, HOUR)).toBe(true)
  })
})

describe('runBackup', () => {
  it('settles only what the primary left, in every vault', async () => {
    const w = world({
      [V1]: [
        { settled: true, expiry: NOW - 5 * HOUR },
        { settled: false, expiry: NOW - 3 * HOUR },
        { settled: false, expiry: NOW - 60 },
        { settled: false, expiry: NOW + HOUR },
      ],
      [V2]: [{ settled: false, expiry: NOW - 2 * HOUR }],
    })
    const r = await runBackup(w.io)
    expect(w.settle.mock.calls).toEqual([
      [V1, 1],
      [V2, 0],
    ])
    expect(r.settled.map((s: any) => s.hash)).toEqual([`${V1}-1`, `${V2}-0`])
    expect(r.failed).toEqual([])
    expect(w.recordPrice).not.toHaveBeenCalled()
  })

  it('signs nothing on a dry run, and still lists what is due', async () => {
    const w = world({ [V1]: [{ settled: false, expiry: NOW - 3 * HOUR }] })
    const r = await runBackup({ ...w.io, settle: null })
    expect(r.due).toEqual([{ vault: V1, id: 0, expiry: NOW - 3 * HOUR }])
    expect(w.settle).not.toHaveBeenCalled()
  })

  it('records the price once per expiry when settles fail, so they can be settled later', async () => {
    const expiry = NOW - 3 * HOUR
    const w = world({
      [V1]: [
        { settled: false, expiry },
        { settled: false, expiry },
      ],
    })
    w.io.settle = vi.fn(async () => {
      throw new Error('Error(Contract, #10)')
    }) as any
    const r = await runBackup(w.io)
    expect(r.failed).toHaveLength(2)
    expect(w.recordPrice.mock.calls).toEqual([[V1, expiry]])
    expect(r.pricesRecorded).toEqual([{ vault: V1, expiry }])
  })

  it('keeps going past a vault or a position it cannot read, and reports both', async () => {
    const w = world({ [V1]: [{ settled: false, expiry: NOW - 3 * HOUR }], [V2]: [{ settled: false, expiry: NOW - 3 * HOUR }] })
    const r = await runBackup({
      ...w.io,
      vaults: ['CDOWN', V1, V2],
      nextId: async (v: string) => {
        if (v === 'CDOWN') throw new Error('RPC 503')
        return 1
      },
      readPosition: async (v: string, id: number) => {
        if (v === V2) throw new Error('simulation failed')
        return w.io.readPosition(v, id)
      },
    })
    expect(r.readErrors.map((e: any) => e.vault)).toEqual(['CDOWN', V2])
    expect(r.settled.map((s: any) => s.vault)).toEqual([V1])
  })
})
