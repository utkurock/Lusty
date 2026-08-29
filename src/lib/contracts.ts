// Contract-level helpers and constants
import { XLM, enabledUnderlyings, type UnderlyingSymbol } from './assets'
import { CONTRACTS } from './stellar'

export { CONTRACTS }

// Reference mirror of the env-overridable caps in lib/vault-state.ts.
export const CALL_MONTHLY_CAP_XLM = XLM.callMonthlyCap // → /EPOCHS per expiry
export const PUT_MONTHLY_CAP_USD = XLM.putMonthlyCapUsd
export const EPOCHS_PER_MONTH = 3
export const EPOCH_DURATION_LEDGERS = 120_960 // 7 days, 1 ledger ≈ 5s
export const DEFAULT_IV = 0.80
export const RISK_FREE_RATE = 0.05

// The assets a user can pick from, straight off the registry — so a UI list
// and the rails that price it can never disagree about what is tradeable.
export const ASSETS = enabledUnderlyings().map((a) => ({
  symbol: a.symbol,
  name: a.name,
  slug: a.slug,
  icon: a.icon,
}))

export type AssetSymbol = UnderlyingSymbol

export const VAULT_TYPES = {
  COVERED_CALL: 'covered_call',
  CASH_SECURED_PUT: 'cash_secured_put',
} as const
export type VaultType = (typeof VAULT_TYPES)[keyof typeof VAULT_TYPES]
