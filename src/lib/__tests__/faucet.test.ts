import { describe, it, expect, beforeEach, vi } from 'vitest'

// What the faucet will part with.
// ===============================
// It pays out of the same distributor that pays premiums and seeds offers, so
// a drained faucet is a vault that cannot pay a writer. Three limits, each
// stopping something the others cannot — and all three counted per asset,
// because a day's worth of LUSD says nothing about how much LBTC is left.

const query = vi.fn()
vi.mock('@/lib/db', () => ({
  ensureSchema: async () => {},
  getPool: () => ({ query: (...a: any[]) => query(...a) }),
}))

// The BTC drip exists only where the anchor is configured — which is the
// registry's own gate, and worth setting explicitly here rather than depending
// on whatever this machine has in .env.local.
process.env.NEXT_PUBLIC_BTC_ANCHOR_CODE = 'LBTC'
process.env.NEXT_PUBLIC_BTC_ANCHOR_ISSUER =
  'GB6274FEMTPWDEZ47P2YCXQ6JZCPRTHB5NMSFVPIUFB6MK5RXNBWZ2E2'

const { dripFor, assertDripAllowed, FaucetRejection, FAUCET_COOLDOWN_MS } = await import(
  '../faucet'
)

/** last claim, this address's total, everyone's total today. */
const ledger = (at: Date | null, mine: number, today: number) => {
  query.mockReset()
  query
    .mockResolvedValueOnce({ rows: [{ at }] })
    .mockResolvedValueOnce({ rows: [{ s: mine }] })
    .mockResolvedValueOnce({ rows: [{ s: today }] })
}

const LBTC = () => {
  const d = dripFor('lbtc')
  if (!d) throw new Error('LBTC drip not configured')
  return d
}

beforeEach(() => query.mockReset())

describe('the drips on offer', () => {
  it('pays BTC in hundredths, not in thousands', () => {
    // A thousand LUSD and a thousand BTC are not the same generosity: the
    // whole LBTC supply was minted once, and the vault's own pool comes out of
    // it. 0.01 is ten times the smallest position the book will write.
    expect(dripFor('lusd')?.amount).toBe('1000')
    expect(LBTC().amount).toBe('0.01')
    expect(LBTC().lifetimeMax).toBe(0.05)
  })

  it('does not offer an asset it has no issuer for', () => {
    expect(dripFor('doge')).toBeNull()
  })
})

describe('one claim a day', () => {
  it('refuses a second claim inside the window and says how long is left', async () => {
    ledger(new Date(Date.now() - 60 * 60 * 1000), 0.01, 0.01)
    const err = await assertDripAllowed('GA', LBTC()).catch((e) => e)
    expect(err).toBeInstanceOf(FaucetRejection)
    expect(err.code).toBe('cooldown')
    // Told in hours, because "retry after 82800 seconds" is not an answer.
    expect(err.message).toContain('23h')
  })

  it('allows it once the day has passed', async () => {
    ledger(new Date(Date.now() - FAUCET_COOLDOWN_MS - 1000), 0.01, 0.01)
    await expect(assertDripAllowed('GA', LBTC())).resolves.toBeUndefined()
  })

  it('lets a first-time address through', async () => {
    ledger(null, 0, 0)
    await expect(assertDripAllowed('GA', LBTC())).resolves.toBeUndefined()
  })
})

describe('the caps a cooldown cannot enforce', () => {
  it('stops a patient address at its lifetime bound', async () => {
    // Waiting a day between claims is exactly what a script would do.
    ledger(new Date(Date.now() - FAUCET_COOLDOWN_MS - 1000), 0.05, 0.05)
    const err = await assertDripAllowed('GA', LBTC()).catch((e) => e)
    expect(err.code).toBe('lifetime_cap')
  })

  it('stops everybody together at the daily bound', async () => {
    // The only limit that survives address farming: a fresh address passes
    // both of the first two checks every time.
    ledger(null, 0, 1)
    const err = await assertDripAllowed('GA', LBTC()).catch((e) => e)
    expect(err.code).toBe('daily_cap')
  })

  it('counts each asset separately', async () => {
    // A day of LUSD claims must not close the BTC faucet, and vice versa.
    ledger(null, 0, 0)
    await assertDripAllowed('GA', LBTC())
    for (const call of query.mock.calls) {
      expect(String(call[0])).toContain('faucet')
    }
    expect(query.mock.calls[0][1]).toEqual(['GA', 'LBTC'])
    expect(query.mock.calls[2][1]).toEqual(['LBTC'])
  })
})
