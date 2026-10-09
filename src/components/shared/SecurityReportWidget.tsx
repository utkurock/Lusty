'use client'

import { useEffect, useRef, useState } from 'react'
import { ShieldAlert, Loader2, Check, ExternalLink } from 'lucide-react'
import { Modal } from './Modal'
import { useWalletContext } from '@/providers/WalletProvider'
import { track } from '@/lib/analytics'
import {
  ATTACK_CLASSES,
  BOOKS,
  SEVERITIES,
  SEVERITY_HINT,
  SEVERITY_LABEL,
  WINDOW_CLOSES,
  WINDOW_OPENS,
  windowState,
  type ReportSeverity,
} from '@/lib/adversarial'

type Status = 'idle' | 'submitting' | 'done' | 'error'

const EMPTY = {
  summary: '',
  reproduction: '',
  transactions: '',
  expected: '',
  actual: '',
  contact: '',
  credit: '',
}

function day(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const inputClass =
  'w-full px-3 py-2 rounded-sm border border-line bg-card text-ink font-mono text-body focus:outline-none focus:border-ink transition'

// The adversarial window's report form, stacked above the feedback button.
// It exists so an attacker does not have to leave the site, find REPORTING.md
// and copy a template: the template's five parts are the form's fields, and
// the report lands privately with the maintainers. Shown only while the
// window is open — outside it a report is not triaged against the window's
// commitments, and a button that says otherwise would be a promise.
export function SecurityReportWidget() {
  const { address } = useWalletContext()
  // Decided after mount: the server's clock and the visitor's may straddle
  // the window's edge, and a mismatch there is a hydration error.
  const [visible, setVisible] = useState(false)
  const [open, setOpen] = useState(false)
  const [severity, setSeverity] = useState<ReportSeverity | ''>('')
  const [attackClass, setAttackClass] = useState('')
  const [book, setBook] = useState('')
  const [fields, setFields] = useState(EMPTY)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [ref, setRef] = useState<string | null>(null)
  const [honeypot, setHoneypot] = useState('')
  const openedAt = useRef(0)

  useEffect(() => {
    setVisible(windowState() === 'open')
  }, [])

  if (!visible) return null

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setFields((f) => ({ ...f, [k]: e.target.value }))

  function openForm() {
    setOpen(true)
    openedAt.current = Date.now()
    track('security_report_open', undefined, address)
  }

  function close() {
    setOpen(false)
    // Keep a half-written report if the dialog is dismissed by accident;
    // clear it only once it has been sent.
    if (status === 'done') {
      setSeverity('')
      setAttackClass('')
      setBook('')
      setFields(EMPTY)
      setRef(null)
      setStatus('idle')
    }
    setError(null)
  }

  async function submit() {
    if (!severity) return setError('Pick the severity you are claiming.')
    for (const [k, label] of [
      ['summary', 'a one-line summary'],
      ['reproduction', 'the reproduction'],
      ['expected', 'what you expected'],
      ['actual', 'what happened'],
      ['contact', 'how to reach you'],
    ] as const) {
      if (!fields[k].trim()) return setError(`Add ${label}.`)
    }
    setStatus('submitting')
    setError(null)
    try {
      const res = await fetch('/api/security-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          severity,
          attackClass: attackClass ? Number(attackClass) : null,
          book: book || null,
          address: address ?? null,
          website: honeypot,
          elapsedMs: openedAt.current ? Date.now() - openedAt.current : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setStatus('error')
        setError(data.error ?? 'Something went wrong. Try again.')
        return
      }
      setRef(data.ref ?? null)
      setStatus('done')
      track('security_report_submit', { severity, attackClass }, address)
    } catch {
      setStatus('error')
      setError('Network error. Try again — nothing you typed is lost.')
    }
  }

  const urgent = severity === 'critical' || severity === 'high'

  return (
    <>
      {/* Sits directly above the feedback button (bottom-6, h-10). */}
      <button
        onClick={openForm}
        className="press fixed bottom-[4.5rem] left-6 z-40 h-10 px-3 rounded-sm border border-line bg-card hover:bg-raised text-ink font-mono text-body flex items-center gap-2 shadow-sm transition"
        title={`Report a vulnerability — adversarial window open until ${day(WINDOW_CLOSES)}`}
        aria-label="Report a vulnerability"
      >
        <span className="relative flex">
          <ShieldAlert size={14} />
          <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-accent-red animate-pulse" />
        </span>
        <span className="hidden sm:inline">report vulnerability</span>
      </button>

      <Modal open={open} onClose={close} title="Report a vulnerability" size="lg">
        {status === 'done' ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="w-12 h-12 rounded-full bg-accent-green/15 flex items-center justify-center">
              <Check size={24} className="text-accent-green" />
            </div>
            <p className="font-mono text-body text-ink">Report received{ref ? ` — ${ref}` : ''}</p>
            <p className="font-mono text-caption text-ink-2 max-w-sm">
              {urgent
                ? 'Critical and High are acknowledged the same day.'
                : 'We acknowledge within three days.'}{' '}
              The reply goes to {fields.contact.trim()} with the severity we assign. Quote{' '}
              {ref ?? 'the summary'} if you follow up.
            </p>
            <button
              onClick={close}
              className="press mt-2 px-4 py-2 rounded-sm border border-line bg-card hover:bg-raised font-mono text-body transition"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-sm border border-line bg-surface-2 px-4 py-3 font-mono text-caption text-ink-2 space-y-1">
              <p className="text-ink">
                Adversarial testnet window open · {day(WINDOW_OPENS)} – {day(WINDOW_CLOSES)} (UTC)
              </p>
              <p>
                Reports here are private — only the maintainers read them, so this is the right
                place for Critical and High too. Testnet only, no bounty; you are credited in the
                final report.
              </p>
              <a href="/docs#adversarial" className="inline-flex items-center gap-1 text-brand hover:underline">
                Scope, rules and the nineteen classes <ExternalLink size={11} />
              </a>
            </div>

            {/* Severity */}
            <div>
              <label className="label mb-2 block">Severity you are claiming *</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SEVERITIES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSeverity(s)}
                    className={`press text-left px-3 py-2 rounded-sm border transition ${
                      severity === s
                        ? 'bg-inverse text-cream border-ink'
                        : 'bg-card text-ink border-line hover:bg-raised'
                    }`}
                  >
                    <div className="font-mono text-body">{SEVERITY_LABEL[s]}</div>
                    <div className={`font-mono text-tiny ${severity === s ? 'text-cream/70' : 'text-ink-2'}`}>
                      {SEVERITY_HINT[s]}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="label mb-2 block">Class</label>
                <select value={attackClass} onChange={(e) => setAttackClass(e.target.value)} className={inputClass}>
                  <option value="">Not sure / none of them</option>
                  {ATTACK_CLASSES.map((c, i) => (
                    <option key={c} value={i + 1}>
                      {i + 1}. {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label mb-2 block">Book</label>
                <select value={book} onChange={(e) => setBook(e.target.value)} className={inputClass}>
                  <option value="">—</option>
                  {BOOKS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="label mb-2 block">Summary *</label>
              <input
                value={fields.summary}
                onChange={set('summary')}
                maxLength={200}
                placeholder="One sentence: what an attacker achieves"
                className={inputClass}
              />
            </div>

            <div>
              <label className="label mb-2 block">Reproduction *</label>
              <textarea
                value={fields.reproduction}
                onChange={set('reproduction')}
                rows={6}
                maxLength={8000}
                placeholder={'Exact steps in order, or a script. The account you used, and any starting state that mattered.\n1.\n2.\n3.'}
                className={`${inputClass} resize-y`}
              />
            </div>

            <div>
              <label className="label mb-2 block">Transaction hashes</label>
              <textarea
                value={fields.transactions}
                onChange={set('transactions')}
                rows={3}
                maxLength={4000}
                placeholder="Every tx in order, failed ones included. For an API-only finding: method, path, body and response."
                className={`${inputClass} resize-y`}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label mb-2 block">Expected *</label>
                <textarea
                  value={fields.expected}
                  onChange={set('expected')}
                  rows={3}
                  maxLength={2000}
                  placeholder="What the system should have done"
                  className={`${inputClass} resize-y`}
                />
              </div>
              <div>
                <label className="label mb-2 block">Actual *</label>
                <textarea
                  value={fields.actual}
                  onChange={set('actual')}
                  rows={3}
                  maxLength={2000}
                  placeholder="What it did"
                  className={`${inputClass} resize-y`}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label mb-2 block">Contact *</label>
                <input
                  value={fields.contact}
                  onChange={set('contact')}
                  maxLength={200}
                  placeholder="Email, Discord, X or Telegram"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="label mb-2 block">Credit as</label>
                <input
                  value={fields.credit}
                  onChange={set('credit')}
                  maxLength={100}
                  placeholder="Name or handle — blank for anonymous"
                  className={inputClass}
                />
              </div>
            </div>

            {/* Honeypot — see FeedbackWidget. */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
              className="absolute -left-[9999px] w-px h-px opacity-0"
            />

            {error && <p className="font-mono text-caption text-accent-red">{error}</p>}

            <button
              onClick={submit}
              disabled={status === 'submitting'}
              className="press w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-sm bg-inverse text-cream font-mono text-body hover:opacity-90 disabled:opacity-50 transition"
            >
              {status === 'submitting' ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Sending…
                </>
              ) : (
                'Send report'
              )}
            </button>

            <p className="font-mono text-tiny text-ink-2 text-center">
              Prefer email or GitHub? Both still work —{' '}
              <a
                href="https://github.com/utkurock/Lusty/blob/main/docs/REPORTING.md"
                target="_blank"
                rel="noreferrer"
                className="text-brand hover:underline"
              >
                REPORTING.md
              </a>
              .
            </p>
          </div>
        )}
      </Modal>
    </>
  )
}
