'use client'

// Lightweight, fire-and-forget client analytics. Posts named events to
// /api/analytics with a stable per-browser session id. Never throws and
// never blocks the UI — analytics must not be able to break the page.

const SESSION_KEY = 'lusty_session_id'

/** Stable random-ish session id, persisted in localStorage. */
export function getSessionId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    let id = localStorage.getItem(SESSION_KEY)
    if (!id) {
      // crypto.randomUUID is available in all modern browsers; fall back to
      // a timestamp+random string if not.
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
      localStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    return null
  }
}

export function track(
  event: string,
  metadata?: Record<string, unknown>,
  address?: string | null
): void {
  if (typeof window === 'undefined') return
  try {
    const body = JSON.stringify({
      event,
      sessionId: getSessionId(),
      path: window.location.pathname,
      address: address ?? null,
      metadata: metadata ?? null,
    })

    // Prefer sendBeacon so the request survives page unloads (e.g. nav away
    // right after a click). Fall back to fetch with keepalive.
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon('/api/analytics', blob)
    } else {
      fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {})
    }
  } catch {
    // swallow — analytics is best-effort
  }
}
