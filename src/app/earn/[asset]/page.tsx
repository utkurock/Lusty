'use client'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { StrikeSelector } from '@/components/earn/StrikeSelector'
import { PageHeader } from '@/components/shared/PageHeader'

export default function EarnAssetPage() {
  const params = useParams<{ asset: string }>()
  const search = useSearchParams()
  const type = (search.get('type') === 'put' ? 'put' : 'call') as 'call' | 'put'
  const asset = (params?.asset ?? 'xlm').toString().toUpperCase()

  return (
    <div className="page-glow max-w-content mx-auto px-6 py-10">
      {/* The way back is the action here: this page is one step in a flow, and
          the deposit button at the bottom is the step forward. */}
      <PageHeader
        path={`~/earn/${asset.toLowerCase()}`}
        title={type === 'call' ? `Sell ${asset} calls` : `Sell ${asset} puts`}
        subtitle={
          type === 'call'
            ? 'Deposit XLM, name the price you would sell at, and take the upfront now.'
            : 'Deposit cash, name the price you would buy at, and take the upfront now.'
        }
        action={
          <Link href="/earn" className="btn btn-ghost press">
            <ArrowLeft size={14} />
            all assets
          </Link>
        }
      />
      <StrikeSelector assetSymbol={asset} type={type} />
    </div>
  )
}
