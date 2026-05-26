/**
 * Alert delivery for the risk-monitoring layer (P1-7).
 *
 * Two independent channels, both best-effort and both optional:
 *   - Slack incoming webhook  (MONITOR_SLACK_WEBHOOK_URL)
 *   - Email via Resend's REST API (RESEND_API_KEY + MONITOR_ALERT_EMAIL_TO/FROM)
 *
 * Delivery uses plain `fetch` so there is no new dependency to audit. A
 * channel that isn't configured is reported as `skipped`, never an error —
 * the monitor should keep running even if only one channel is wired up.
 */

export type Severity = 'info' | 'warning' | 'critical'

export interface AlertField {
  label: string
  value: string
}

export interface Alert {
  severity: Severity
  /** Short, stable title — also used for grouping/dedupe later. */
  title: string
  /** Human-readable detail. */
  message: string
  /** Optional key/value context (utilization, balances, ping ms, …). */
  fields?: AlertField[]
}

export type ChannelResult =
  | { channel: 'slack' | 'email'; status: 'sent' }
  | { channel: 'slack' | 'email'; status: 'skipped'; reason: string }
  | { channel: 'slack' | 'email'; status: 'error'; reason: string }

export interface DeliveryResult {
  delivered: boolean
  results: ChannelResult[]
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
}

const SLACK_WEBHOOK_URL = process.env.MONITOR_SLACK_WEBHOOK_URL ?? ''
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? ''
const EMAIL_TO = process.env.MONITOR_ALERT_EMAIL_TO ?? ''
const EMAIL_FROM =
  process.env.MONITOR_ALERT_EMAIL_FROM ?? 'Lusty Monitor <alerts@lusty.finance>'
const ENV_LABEL = process.env.MONITOR_ENV_LABEL ?? 'testnet'

function plainText(a: Alert): string {
  const head = `${SEVERITY_EMOJI[a.severity]} [${a.severity.toUpperCase()}] [Lusty ${ENV_LABEL}] ${a.title}`
  const fields = (a.fields ?? [])
    .map((f) => `  • ${f.label}: ${f.value}`)
    .join('\n')
  return [head, '', a.message, fields].filter(Boolean).join('\n')
}

async function sendSlack(a: Alert): Promise<ChannelResult> {
  if (!SLACK_WEBHOOK_URL) {
    return { channel: 'slack', status: 'skipped', reason: 'MONITOR_SLACK_WEBHOOK_URL not set' }
  }
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: plainText(a) }),
      cache: 'no-store',
    })
    if (!res.ok) {
      return { channel: 'slack', status: 'error', reason: `slack ${res.status}` }
    }
    return { channel: 'slack', status: 'sent' }
  } catch (e: any) {
    return { channel: 'slack', status: 'error', reason: e?.message ?? 'slack post failed' }
  }
}

async function sendEmail(a: Alert): Promise<ChannelResult> {
  if (!RESEND_API_KEY || !EMAIL_TO) {
    return {
      channel: 'email',
      status: 'skipped',
      reason: 'RESEND_API_KEY or MONITOR_ALERT_EMAIL_TO not set',
    }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean),
        subject: `${SEVERITY_EMOJI[a.severity]} [Lusty ${ENV_LABEL}] ${a.title}`,
        text: plainText(a),
      }),
      cache: 'no-store',
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { channel: 'email', status: 'error', reason: `resend ${res.status} ${detail.slice(0, 120)}` }
    }
    return { channel: 'email', status: 'sent' }
  } catch (e: any) {
    return { channel: 'email', status: 'error', reason: e?.message ?? 'resend post failed' }
  }
}

/**
 * Fan an alert out to every configured channel. Never throws — returns a
 * per-channel breakdown so callers (and the test endpoint) can see exactly
 * what was delivered, skipped, or failed. `delivered` is true if at least one
 * channel actually sent.
 */
export async function sendAlert(alert: Alert): Promise<DeliveryResult> {
  const results = await Promise.all([sendSlack(alert), sendEmail(alert)])
  return {
    delivered: results.some((r) => r.status === 'sent'),
    results,
  }
}
