import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// One row per position, per book.
//
// The deposit route reads the position off the ledger, so it cannot be lied to
// about what a position is. What it had no answer for was being told about the
// same position twice: the only replay key was the caller's own txHash string,
// which nothing verifies on chain, so one real position could be indexed again
// under any number of invented hashes.
//
// The cost is not a cosmetic duplicate. computeExpirySold SUMS deposit rows to
// decide how much of an expiry is sold, and that ratio is the utilization every
// quote is haircut against: extra rows lower the APR offered to everyone, and
// at the top of the range the book reads as full and the screen closes it.

const schema = readFileSync(join(process.cwd(), 'src/lib/db.ts'), 'utf8')
const route = readFileSync(
  join(process.cwd(), 'src/app/api/vault/deposit/route.ts'),
  'utf8',
)

describe('the schema refuses a position indexed twice', () => {
  it('declares a unique index over the book and the position id', () => {
    expect(schema).toMatch(
      /create unique index if not exists transactions_position_uniq/,
    )
    // Both halves of the key: ids restart from zero on every instance, so
    // XLM's #3 and BTC's #3 are different positions.
    const index = schema.slice(schema.indexOf('transactions_position_uniq'))
    const statement = index.slice(0, index.indexOf(';'))
    expect(statement).toMatch(/underlying/)
    expect(statement).toMatch(/metadata->>'positionId'/)
  })

  it('scopes it to deposits that name a position', () => {
    const index = schema.slice(schema.indexOf('transactions_position_uniq'))
    const statement = index.slice(0, index.indexOf(';'))
    // A faucet payout has no position and no underlying; the index must not
    // collapse those rows into one.
    expect(statement).toMatch(/where\s+type = 'deposit'/)
    expect(statement).toMatch(/underlying is not null/)
    expect(statement).toMatch(/metadata \? 'positionId'/)
  })
})

describe('the route reports a duplicate rather than failing on it', () => {
  it('answers a unique violation as already indexed', () => {
    expect(route).toMatch(/dbErr\?\.code === '23505'/)
    const branch = route.slice(route.indexOf("dbErr?.code === '23505'"))
    expect(branch.slice(0, 400)).toMatch(/alreadyIndexed: true/)
    expect(branch.slice(0, 400)).toMatch(/status: 200/)
  })

  it('still releases the reservation, so the ledger keeps no phantom hash', () => {
    const handler = route.slice(route.indexOf('} catch (dbErr: any) {'))
    const release = handler.indexOf("releaseAction('deposit'")
    const duplicate = handler.indexOf("dbErr?.code === '23505'")
    expect(release).toBeGreaterThan(-1)
    expect(release).toBeLessThan(duplicate)
  })
})
