'use client'

import { SessionGate } from '@/components/anchor/SessionGate'
import { WithdrawFlow } from '@/components/anchor/WithdrawFlow'
import { ANCHOR_ASSET_CODE, FIAT_CODE } from '@/lib/anchor/config'

export default function AnchorWithdrawPage() {
  return (
    <div className="space-y-6">
      <header>
        <div className="font-mono text-caption text-brand">~/anchor/off-ramp</div>
        <h1 className="font-display text-head-lg text-ink mt-1">
          {ANCHOR_ASSET_CODE} → {FIAT_CODE}
        </h1>
        <p className="font-mono text-caption text-ink-2 mt-1.5 max-w-xl">
          Send {ANCHOR_ASSET_CODE} to the anchor&apos;s treasury with the memo it names, and the
          lira is paid out at the rate locked when the order was opened.
        </p>
      </header>

      <SessionGate intent="Signing in lets the anchor open a withdrawal against your key.">
        {(session, address) => <WithdrawFlow session={session} address={address} />}
      </SessionGate>
    </div>
  )
}
