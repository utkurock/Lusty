import type { UnderlyingAsset } from '@/lib/assets'

/**
 * The exchange's closes for one book. A leaf module so every check that wants
 * a second opinion on a price — the vol spike, the auto-halt, the oracle's own
 * health — reads it from one place without importing the checks that use it.
 */
export async function fetchCloses(
  interval: string,
  limit: number,
  asset: UnderlyingAsset,
): Promise<number[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${asset.binanceSymbol}&interval=${interval}&limit=${limit}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`binance klines ${res.status}`)
  const rows = (await res.json()) as unknown[]
  // kline tuple: [openTime, open, high, low, close, ...]; close is index 4.
  return rows
    .map((row) => parseFloat((row as string[])[4]))
    .filter((n) => isFinite(n) && n > 0)
}
