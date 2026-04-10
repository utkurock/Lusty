// Contract-level helpers and constants
import { CONTRACTS } from './stellar'

export { CONTRACTS }

export const VAULT_CAP_XLM = 5_000_000
export const EPOCH_DURATION_LEDGERS = 120_960 // 7 days, 1 ledger ≈ 5s
export const DEFAULT_IV = 0.80
export const RISK_FREE_RATE = 0.05

export const ASSETS = [
  {
    symbol: 'XLM',
    name: 'Stellar Lumens',
    slug: 'xlm',
    icon: '✦',
  },
] as const

export type AssetSymbol = (typeof ASSETS)[number]['symbol']

export const VAULT_TYPES = {
  COVERED_CALL: 'covered_call',
  CASH_SECURED_PUT: 'cash_secured_put',
} as const
export type VaultType = (typeof VAULT_TYPES)[keyof typeof VAULT_TYPES]
