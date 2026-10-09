// The adversarial testnet window, as the site needs it: when it is open, and
// the vocabulary a report is filed in. docs/ADVERSARIAL.md is the scope; this
// mirrors its dates (§ Status), its severity bar (§4) and its nineteen classes
// (§3) so the report form can offer them without the reporter opening the doc.
// Moving the window means changing it here and in the doc together.

export const WINDOW_OPENS = '2026-10-06T00:00:00Z'
export const WINDOW_CLOSES = '2026-10-20T23:59:59Z'

export type WindowState = 'before' | 'open' | 'closed'

export function windowState(now: number = Date.now()): WindowState {
  if (now < Date.parse(WINDOW_OPENS)) return 'before'
  if (now > Date.parse(WINDOW_CLOSES)) return 'closed'
  return 'open'
}

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type ReportSeverity = (typeof SEVERITIES)[number]

export const SEVERITY_LABEL: Record<ReportSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low / Informational',
}

// What each level means, in the grant's words shortened to one line.
export const SEVERITY_HINT: Record<ReportSeverity, string> = {
  critical: 'Unauthorized withdrawal, lost collateral, contract control, systemic insolvency',
  high: 'Mispricing, a bypassed risk control, a compromised role, blocked settlement',
  medium: 'Limited impact, temporary disruption, wrong behaviour under specific conditions',
  low: 'No direct financial impact: docs, usability, monitoring, hardening',
}

export const BOOKS = ['XLM', 'BTC', 'both', 'n/a'] as const
export type ReportBook = (typeof BOOKS)[number]

// docs/ADVERSARIAL.md §3, in order; the index + 1 is the class number.
export const ATTACK_CLASSES = [
  'Premium above the quote',
  'Escrow mismatch or unauthorized access',
  'Solvency break',
  'Limit evasion',
  'Invalid, replayed or abused quotes',
  'Settlement at the wrong price',
  'Outcome inversion',
  'Double settlement, double claim or replay',
  'Settlement denial',
  'Cross-book confusion',
  'Privilege escalation',
  'Session and authentication flaws',
  'Unauthenticated exposure',
  'Distributor drain',
  'Accounting corruption',
  'Configuration-shaped failure',
  'Malicious or compromised quoter',
  'Routing slippage and failure',
  'Unavailable oracle or integration',
] as const

/** The reference a reporter is handed back, and the one triage quotes. */
export function reportRef(id: number): string {
  return `LSR-${String(id).padStart(3, '0')}`
}
