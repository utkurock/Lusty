// Contract-level helpers and constants
import { CONTRACTS } from './stellar'

export { CONTRACTS }

// Per-side monthly budgets, split across the open expiries ("epochs"). Each
// open expiry is its own capacity bucket; with 3 open at once the cap is
// monthly / 3 per expiry. Authoritative, env-overridable values live in
// lib/vault-state.ts (CALL_EPOCH_CAP_XLM / PUT_EPOCH_CAP_USD); these mirror the
// defaults for reference.
export const CALL_MONTHLY_CAP_XLM = 1_500_000 // → 500,000 XLM per expiry
export const PUT_MONTHLY_CAP_USD = 150_000 //    → 50,000 USD per expiry
export const EPOCHS_PER_MONTH = 3
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
