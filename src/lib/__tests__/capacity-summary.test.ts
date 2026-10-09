import { describe, it, expect, vi } from 'vitest'

// The capacity bars under the asset list read `/api/vault/stats`. M2-06 renamed
// the call side from `call.utilizedXlm` / `call.capXlm` to `call.utilized` /
// `call.cap`, the bars kept reading the old names, and every book's call bar
// showed a dash however much had been written. So the bars are tested against
// what the route actually returns, not against a hand-copied shape.

vi.mock('@/lib/vault-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vault-state')>()),
  computeOpenBuckets: async () => [
    { label: 'a', expiryIso: '2026-10-16T08:00:00Z', dateKey: '2026-10-16', callUnderlying: 9000, putUsd: 1500 },
    { label: 'b', expiryIso: '2026-10-23T08:00:00Z', dateKey: '2026-10-23', callUnderlying: 0, putUsd: 0 },
    { label: 'c', expiryIso: '2026-10-30T08:00:00Z', dateKey: '2026-10-30', callUnderlying: 0, putUsd: 0 },
  ],
}))

vi.mock('@/lib/lusd', () => ({
  LUSD_CODE: 'LUSD',
  LUSD_ISSUER: 'GISSUER',
  LUSD_DISTRIBUTOR: 'GDISTRIBUTOR',
}))

vi.mock('@stellar/stellar-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stellar/stellar-sdk')>()),
  Horizon: {
    Server: class {
      loadAccount = async () => {
        throw new Error('offline')
      }
    },
  },
}))

async function stats(asset: string) {
  const { GET } = await import('@/app/api/vault/stats/route')
  const res = await GET(new Request(`http://localhost/api/vault/stats?asset=${asset}`))
  return res.json()
}

describe('capacity bars read what /api/vault/stats returns', () => {
  it('shows the call side of a book with positions in it, not a dash', async () => {
    const { capacityUsedPct } = await import('@/lib/capacity')
    const d = await stats('XLM')
    const pct = capacityUsedPct(d, 'call')
    expect(pct).not.toBeNull()
    expect(pct).toBeCloseTo((9000 / d.call.cap) * 100, 6)
    expect(pct).toBeCloseTo(d.call.utilizationPct, 6)
  })

  it('shows the put side the same way', async () => {
    const { capacityUsedPct } = await import('@/lib/capacity')
    const d = await stats('XLM')
    expect(capacityUsedPct(d, 'put')).toBeCloseTo(d.put.utilizationPct, 6)
  })

  it('answers null, not zero, when the figures are not there', async () => {
    const { capacityUsedPct } = await import('@/lib/capacity')
    expect(capacityUsedPct({ ok: false }, 'call')).toBeNull()
    expect(capacityUsedPct({ ok: true, call: { utilized: 1, cap: 0 } }, 'call')).toBeNull()
  })
})
