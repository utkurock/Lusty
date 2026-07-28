// Local cache of a user's positions, keyed by wallet address, so the dashboard
// renders instantly on reload. Contract state is the source of truth — see
// lib/vault-contract's getPositionsOf — and this only holds what the browser
// already saw at deposit time.

export interface StoredPosition {
  id: string                  // deposit tx hash
  address: string             // user wallet
  type: 'call' | 'put'
  asset: string               // 'XLM' for call, stable code for put
  collateralAmount: number
  strikePrice: number
  strikeIndex: number
  apr: number
  premium: number             // LUSD actually received
  depositHash: string
  premiumHash: string
  /** Contract-assigned position id, for reading it back from vault state. */
  positionId?: number
  expiryIso: string           // ISO date string
  expiryLabel: string         // e.g. "Apr_17"
  daysToExpirySnapshot: number
  createdAt: number           // ms epoch
  settled: boolean
}

const KEY = 'lusty_positions_v1'

function readAll(): StoredPosition[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(list: StoredPosition[]) {
  if (typeof window === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify(list))
}

export function getPositionsFor(address: string | null): StoredPosition[] {
  if (!address) return []
  return readAll()
    .filter((p) => p.address === address)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function savePosition(pos: StoredPosition) {
  const all = readAll()
  // De-dup by deposit hash
  if (all.some((p) => p.depositHash === pos.depositHash)) return
  all.push(pos)
  writeAll(all)
}

export function markSettled(depositHash: string) {
  const all = readAll()
  const next = all.map((p) =>
    p.depositHash === depositHash ? { ...p, settled: true } : p
  )
  writeAll(next)
}
