'use client'

import { ReactNode } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { useAnchorSession } from '@/lib/anchor/useAnchor'
import { ANCHOR_HOME_DOMAIN } from '@/lib/anchor/config'
import type { AnchorSession } from '@/lib/anchor/types'

interface Props {
  /** What the screen is about to do, said before the user signs anything. */
  intent: string
  children: (session: AnchorSession, address: string) => ReactNode
}

/**
 * Nothing on a ramp screen can be shown before the anchor knows who is asking,
 * so every flow starts here.
 *
 * The login is a signature, not a form: the anchor sends a transaction that
 * cannot be submitted, the wallet signs it, and that proves the key. There is
 * no account to create and nothing to remember, which is worth saying on the
 * screen because a "sign this transaction" prompt otherwise reads like a
 * payment.
 */
export function SessionGate({ intent, children }: Props) {
  const { address, connected, session, signIn, signOut, busy, error } = useAnchorSession()

  if (session && address) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="font-mono text-caption text-ink-2">
            signed in to <span className="text-ink">{ANCHOR_HOME_DOMAIN}</span> as{' '}
            <span className="font-code text-ink">
              {address.slice(0, 4)}…{address.slice(-4)}
            </span>
          </div>
          <button onClick={signOut} className="press press-sm rounded-sm px-2.5 py-1 font-mono text-caption text-ink-2 hover:bg-raised hover:text-ink">
            sign out
          </button>
        </div>
        {children(session, address)}
      </div>
    )
  }

  return (
    <div className="light-card p-6 max-w-xl">
      <div className="flex items-center gap-2 text-ink">
        <KeyRound size={16} className="text-brand" />
        <h2 className="font-display text-head-sm">Sign in with your key</h2>
      </div>
      <p className="font-mono text-caption text-ink-2 mt-2">{intent}</p>
      <p className="font-mono text-caption text-ink-2 mt-3">
        {ANCHOR_HOME_DOMAIN} authenticates with SEP-10: it hands your wallet a transaction that can
        never be submitted, your wallet signs it, and that signature is the login. No email, no
        password, no custody. The session ends when you close this tab.
      </p>

      <button onClick={signIn} disabled={busy} className="btn btn-primary press mt-5">
        {busy && <Loader2 size={16} className="animate-spin" />}
        {connected ? 'sign in to the anchor' : 'connect wallet'}
      </button>

      {error && <div className="notice notice-error mt-4">{error}</div>}
    </div>
  )
}
