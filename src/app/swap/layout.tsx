import { notFound } from 'next/navigation'
import { IS_TESTNET } from '@/lib/stellar'

// The swap desk trades XLM for the testnet cash token (lib/testnet-only); off
// testnet the page does not exist.
export default function SwapLayout({ children }: { children: React.ReactNode }) {
  if (!IS_TESTNET) notFound()
  return children
}
