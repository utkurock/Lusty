import type { Alert, Severity } from '@/lib/monitor/notify'
import {
  ATTACK_CLASSES,
  BOOKS,
  SEVERITIES,
  SEVERITY_LABEL,
  reportRef,
  type ReportSeverity,
} from '@/lib/adversarial'
import type { SecurityReportInput } from '@/lib/db-queries'
import { isValidStellarAddress } from '@/lib/utils'

// What the on-site report form may submit. Bounds are generous on purpose: a
// reproduction is a script or a list of steps, and cutting one off loses the
// part that made it reproducible. Anything past a bound is refused rather
// than truncated, for the same reason.
export const LIMITS = {
  summary: 200,
  reproduction: 8000,
  transactions: 4000,
  expected: 2000,
  actual: 2000,
  contact: 200,
  credit: 100,
} as const

export type ParsedReport = Omit<SecurityReportInput, 'ip'>

export type ParseResult =
  | { ok: true; report: ParsedReport }
  | { ok: false; field: string; error: string }

function text(
  body: Record<string, unknown>,
  field: keyof typeof LIMITS,
  required: boolean
): { ok: true; value: string | null } | { ok: false; field: string; error: string } {
  const raw = body[field]
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) {
    return required
      ? { ok: false, field, error: `${field} is required` }
      : { ok: true, value: null }
  }
  if (value.length > LIMITS[field]) {
    return { ok: false, field, error: `${field} is longer than ${LIMITS[field]} characters` }
  }
  return { ok: true, value }
}

export function parseSecurityReport(body: unknown): ParseResult {
  if (!body || typeof body !== 'object') return { ok: false, field: 'body', error: 'body required' }
  const b = body as Record<string, unknown>

  if (!SEVERITIES.includes(b.severity as ReportSeverity)) {
    return { ok: false, field: 'severity', error: 'severity must be critical, high, medium or low' }
  }

  let attackClass: number | null = null
  if (b.attackClass !== undefined && b.attackClass !== null && b.attackClass !== '') {
    const n = Number(b.attackClass)
    if (!Number.isInteger(n) || n < 1 || n > ATTACK_CLASSES.length) {
      return { ok: false, field: 'attackClass', error: `class must be 1–${ATTACK_CLASSES.length}` }
    }
    attackClass = n
  }

  let book: string | null = null
  if (typeof b.book === 'string' && b.book !== '') {
    if (!(BOOKS as readonly string[]).includes(b.book)) {
      return { ok: false, field: 'book', error: 'book must be XLM, BTC, both or n/a' }
    }
    book = b.book
  }

  const fields = {
    summary: text(b, 'summary', true),
    reproduction: text(b, 'reproduction', true),
    transactions: text(b, 'transactions', false),
    expected: text(b, 'expected', true),
    actual: text(b, 'actual', true),
    contact: text(b, 'contact', true),
    credit: text(b, 'credit', false),
  }
  for (const f of Object.values(fields)) if (!f.ok) return f

  const value = (k: keyof typeof fields) => (fields[k] as { ok: true; value: string | null }).value

  return {
    ok: true,
    report: {
      severity: b.severity as ReportSeverity,
      attackClass,
      book,
      summary: value('summary')!,
      reproduction: value('reproduction')!,
      transactions: value('transactions'),
      expected: value('expected')!,
      actual: value('actual')!,
      contact: value('contact')!,
      credit: value('credit'),
      address:
        typeof b.address === 'string' && isValidStellarAddress(b.address) ? b.address : null,
    },
  }
}

// Critical and High promise a same-day acknowledgement, so they page as
// critical; the rest only need to be seen within three days.
const ALERT_SEVERITY: Record<ReportSeverity, Severity> = {
  critical: 'critical',
  high: 'critical',
  medium: 'warning',
  low: 'info',
}

/**
 * The alert a new report raises. It carries enough to triage from the
 * notification — what, how bad, who to answer — and leaves the reproduction
 * in the database, where only an admin session reads it.
 */
export function reportAlert(id: number, r: ParsedReport): Alert {
  const severity = r.severity as ReportSeverity
  return {
    severity: ALERT_SEVERITY[severity],
    title: `Security report ${reportRef(id)} — ${SEVERITY_LABEL[severity]} claimed`,
    message: r.summary,
    fields: [
      {
        label: 'Class',
        value: r.attackClass ? `${r.attackClass}. ${ATTACK_CLASSES[r.attackClass - 1]}` : 'not given',
      },
      { label: 'Book', value: r.book ?? 'not given' },
      { label: 'Contact', value: r.contact },
      {
        label: 'Acknowledge by',
        value: severity === 'critical' || severity === 'high' ? 'today' : 'within three days',
      },
    ],
  }
}
