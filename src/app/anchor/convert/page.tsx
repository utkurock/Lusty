'use client'

import Link from 'next/link'
import { ConvertFlow } from '@/components/anchor/ConvertFlow'
import { ANCHOR_ASSET_CODE } from '@/lib/anchor/config'
import { LUSD_CODE } from '@/lib/lusd'

export default function AnchorConvertPage() {
  return (
    <div className="space-y-6">
      <header>
        <div className="font-mono text-caption text-brand">~/anchor/convert</div>
        <h1 className="font-display text-head-lg text-ink mt-1">
          {ANCHOR_ASSET_CODE} ⇄ {LUSD_CODE}
        </h1>
        <p className="font-mono text-caption text-ink-2 mt-1.5 max-w-xl">
          The ramp pays {ANCHOR_ASSET_CODE}. The vault escrows {LUSD_CODE}. Both are dollars on a
          test network, so this trades them one for one in either direction, with no spread and
          nothing to quote.
        </p>
      </header>

      <ConvertFlow />

      {/* Why two dollars exist at all. Without this the screen reads like a
          toll booth someone forgot to remove. */}
      <div className="notice notice-quiet max-w-xl">
        {LUSD_CODE} is Lusty&apos;s own testnet dollar, and it is what a cash-secured put escrows.
        The anchor issues neither it nor the {ANCHOR_ASSET_CODE} it ramps — that issuer belongs to
        the anchor — so a crossing between them is a payment in each direction rather than a mint.
        On mainnet this step is where a real USDC would meet whatever the vault settles in, and it
        may well disappear.
      </div>

      <div className="font-mono text-caption text-ink-2">
        <Link href="/earn" className="press rounded-sm hover:text-ink">
          go to earn →
        </Link>
      </div>
    </div>
  )
}
