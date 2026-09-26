import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// M2-06's own criterion, run instead of grepped.
// =============================================
// These modules decide money, capacity or risk for whichever book is handed to
// them. None of them may name one: not by importing `XLM` off the registry, not
// by a quoted symbol. A default is the dangerous half — a caller that forgets a
// book gets a schedule, a ladder or a cap from another one and is never told,
// which is the single failure every per-asset parameter in this tranche exists
// to prevent. Requiring the argument turns that into a compile error.
//
// Comments are exempt. Naming XLM to explain a rule is how the rule gets read;
// naming it in code is how the rule gets broken.
const GENERIC = [
  'pricing.ts',
  'pricing-server.ts',
  'portfolio.ts',
  'expiries.ts',
  'quote-inputs.ts',
  'quote-policy.ts',
  'settlement.ts',
  'settlement-sweep.ts',
  'settlement-scheduler.ts',
  'vault-state.ts',
  'vault-limits.ts',
  'monitor/checks.ts',
]

function codeOf(rel: string): string {
  const src = readFileSync(join(__dirname, '..', rel), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*\/\/.*$/gm, '')
}

describe('no generic module names one book', () => {
  for (const rel of GENERIC) {
    it(`${rel} takes its book as an argument`, () => {
      const code = codeOf(rel)
      expect(code).not.toMatch(/\bXLM\b/)
      expect(code).not.toMatch(/['"`]XLM['"`]/)
    })
  }

  it('strips comments without stripping code', () => {
    // The check above is only worth anything if what it reads is code. A bad
    // stripper that ate everything would pass every file silently.
    expect(codeOf('pricing-server.ts')).toMatch(/export function quoteOption/)
    expect(codeOf('expiries.ts')).toMatch(/export function upcomingExpiryDates/)
  })
})
