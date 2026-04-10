export const SCALE = 10_000_000 // 1e7

// Deposit limits, denominated in XLM (the call vault asset).
// Put vault converts these to USDC at the current spot price.
export const MIN_DEPOSIT_XLM = 100
export const MAX_DEPOSIT_XLM = 10_000

export function toScaled(value: number): bigint {
  return BigInt(Math.round(value * SCALE))
}

export function fromScaled(value: bigint | number): number {
  return Number(value) / SCALE
}

export function formatUsdc(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount)
}

export function formatXlm(amount: number): string {
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} XLM`
}

export function formatAPR(apr: number): string {
  return `${apr.toFixed(2)}%`
}

export function isValidStellarAddress(address: unknown): address is string {
  return (
    typeof address === 'string' &&
    address.length === 56 &&
    address.startsWith('G') &&
    /^G[A-Z2-7]{55}$/.test(address)
  )
}

export function formatAddress(address: string): string {
  if (!address) return ''
  return `${address.slice(0, 4)}...${address.slice(-4)}`
}

export function getNextFriday(): Date {
  const now = new Date()
  const dayOfWeek = now.getDay()
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7
  const nextFriday = new Date(now)
  nextFriday.setDate(now.getDate() + daysUntilFriday)
  nextFriday.setHours(8, 0, 0, 0)
  return nextFriday
}

export function getDaysUntilExpiry(): number {
  const expiry = getNextFriday()
  const now = new Date()
  return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

export function formatExpiry(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function ledgersToSeconds(ledgers: number): number {
  return ledgers * 5
}

export function daysToLedgers(days: number): number {
  return Math.floor((days * 24 * 3600) / 5)
}

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}
