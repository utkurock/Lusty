'use client'

import { SessionGate } from '@/components/anchor/SessionGate'
import { DepositFlow } from '@/components/anchor/DepositFlow'
import { ANCHOR_ASSET_CODE, FIAT_CODE } from '@/lib/anchor/config'

export default function AnchorDepositPage() {
  return (
    <div className="space-y-6">
      <header>
        <div className="font-mono text-caption text-brand">~/anchor/on-ramp</div>
        <h1 className="font-display text-head-lg text-ink mt-1">
          {FIAT_CODE} → {ANCHOR_ASSET_CODE}
        </h1>
        <p className="font-mono text-caption text-ink-2 mt-1.5 max-w-xl">
          A bank transfer in lira comes back as testnet {ANCHOR_ASSET_CODE} in your own wallet. The
          rate is locked when you ask for the bank details.
        </p>
      </header>

      <SessionGate intent={`Signing in lets the anchor open a deposit against your key.`}>
        {(session, address) => <DepositFlow session={session} address={address} />}
      </SessionGate>
    </div>
  )
}
