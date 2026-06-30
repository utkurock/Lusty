'use client'

import { useState } from 'react'
import { MessageSquare, Star, Loader2, Check } from 'lucide-react'
import { Modal } from './Modal'
import { useWalletContext } from '@/providers/WalletProvider'
import { track } from '@/lib/analytics'

const CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature idea' },
  { value: 'ux', label: 'UX / design' },
  { value: 'praise', label: 'Praise' },
]

type Status = 'idle' | 'submitting' | 'done' | 'error'

export function FeedbackWidget() {
  const { address } = useWalletContext()
  const [open, setOpen] = useState(false)
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [category, setCategory] = useState('general')
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)

  function openWidget() {
    setOpen(true)
    track('feedback_open', undefined, address)
  }

  function reset() {
    setRating(0)
    setHover(0)
    setCategory('general')
    setMessage('')
    setStatus('idle')
    setError(null)
  }

  async function submit() {
    if (message.trim().length < 3) {
      setError('Please write a little more.')
      return
    }
    setStatus('submitting')
    setError(null)
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: message.trim(),
          rating: rating || null,
          category,
          address: address ?? null,
          path: typeof window !== 'undefined' ? window.location.pathname : null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setStatus('error')
        setError(data.error ?? 'Something went wrong. Try again.')
        return
      }
      setStatus('done')
      track('feedback_submit', { rating, category }, address)
      // Auto-close shortly after the success state shows.
      setTimeout(() => {
        setOpen(false)
        reset()
      }, 1400)
    } catch (e: any) {
      setStatus('error')
      setError('Network error. Try again.')
    }
  }

  return (
    <>
      {/* Floating trigger — bottom-left so it never collides with the admin
          shield (bottom-right). */}
      <button
        onClick={openWidget}
        className="fixed bottom-6 left-6 z-40 flex items-center gap-2 px-3.5 h-10 rounded-full bg-inverse text-cream shadow-lg hover:scale-105 transition opacity-80 hover:opacity-100 font-mono text-xs"
        title="Send feedback"
      >
        <MessageSquare size={16} />
        <span className="hidden sm:inline">Feedback</span>
      </button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          reset()
        }}
        title="Send feedback"
      >
        {status === 'done' ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="w-12 h-12 rounded-full bg-[#22c55e]/15 flex items-center justify-center">
              <Check size={24} className="text-[#22c55e]" />
            </div>
            <p className="font-mono text-sm text-ink">Thanks for the feedback!</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Rating */}
            <div>
              <label className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-2 block">
                How is your experience?
              </label>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setRating(n)}
                    onMouseEnter={() => setHover(n)}
                    onMouseLeave={() => setHover(0)}
                    className="p-1 transition hover:scale-110"
                    aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  >
                    <Star
                      size={24}
                      className={
                        (hover || rating) >= n
                          ? 'text-[#eab308] fill-[#eab308]'
                          : 'text-line'
                      }
                    />
                  </button>
                ))}
              </div>
            </div>

            {/* Category */}
            <div>
              <label className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-2 block">
                Topic
              </label>
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setCategory(c.value)}
                    className={`px-3 py-1.5 rounded-sm border font-mono text-xs transition ${
                      category === c.value
                        ? 'bg-inverse text-cream border-ink'
                        : 'bg-card text-ink-2 border-line hover:bg-surface'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Message */}
            <div>
              <label className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-2 block">
                Your message
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="What's working, what's confusing, what you'd love to see…"
                className="w-full px-3 py-2 rounded-sm border border-line bg-card text-ink font-mono text-sm resize-none focus:outline-none focus:border-ink transition"
              />
            </div>

            {error && (
              <p className="font-mono text-xs text-[#ef4444]">{error}</p>
            )}

            <button
              onClick={submit}
              disabled={status === 'submitting'}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-sm bg-inverse text-cream font-mono text-sm hover:opacity-90 disabled:opacity-50 transition"
            >
              {status === 'submitting' ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Sending…
                </>
              ) : (
                'Send feedback'
              )}
            </button>

            {!address && (
              <p className="font-mono text-[11px] text-ink-2 text-center">
                Tip: connect your wallet so we can follow up.
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
