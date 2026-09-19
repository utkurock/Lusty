'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

interface Props {
  label: string
  value: string
  /** The sentence under the value that says what it is for. */
  hint?: string
  /** Long identifiers set in the real monospace face so they can be checked. */
  code?: boolean
}

/**
 * A value the user has to carry somewhere else by hand — an IBAN, a payment
 * reference, a memo.
 *
 * Every one of these is a string where a single wrong character sends money
 * nowhere recoverable, so each gets a copy button rather than an invitation to
 * retype it.
 */
export function CopyValue({ label, value, hint, code }: Props) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard refused: the value is on screen and selectable anyway */
    }
  }

  return (
    <div className="light-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="label">{label}</div>
          <div
            className={`mt-1 text-body text-ink break-all ${code ? 'font-code text-caption' : 'num'}`}
          >
            {value}
          </div>
        </div>
        <button
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="press press-sm rounded-sm p-2 text-ink-2 hover:bg-raised hover:text-ink shrink-0"
        >
          {copied ? <Check size={16} className="text-accent-green" /> : <Copy size={16} />}
        </button>
      </div>
      {hint && <p className="font-mono text-caption text-ink-2 mt-2">{hint}</p>}
    </div>
  )
}
