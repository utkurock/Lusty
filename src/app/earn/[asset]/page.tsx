'use client'
import { useParams, useSearchParams } from 'next/navigation'
import { StrikeSelector } from '@/components/earn/StrikeSelector'

export default function EarnAssetPage() {
  const params = useParams<{ asset: string }>()
  const search = useSearchParams()
  const type = (search.get('type') === 'put' ? 'put' : 'call') as 'call' | 'put'
  const asset = (params?.asset ?? 'xlm').toString().toUpperCase()

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">
      <StrikeSelector assetSymbol={asset} type={type} />
    </div>
  )
}
