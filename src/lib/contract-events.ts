// On-chain vault event reader (server-side, via Soroban RPC getEvents).
// =====================================================================
// The vault contract (contracts/vault) publishes an event for every state
// change: `deposit` when a writer opens a position, `settle` when one is
// resolved against the oracle, and `fund` on a cash-pool top-up. This streams
// those events out of the ledger so the UI can show real on-chain activity,
// closing the loop the contract opens with `env.events().publish(...)`.
//
// Reads only — getEvents submits nothing, signs nothing, costs nothing.

import { SorobanRpc, scValToNative, xdr } from '@stellar/stellar-sdk'

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org'

// The deployed vault instances (see contracts/README.md). The LUSD instance is
// the one the testnet web app uses; the USDC instance is the mainnet-framing
// demo. We stream both so the feed reflects all on-chain activity.
const VAULT_IDS = (
  process.env.NEXT_PUBLIC_VAULT_CONTRACTS ??
  'CAWDKJUH5WSXJVOOAUGULE4HY2TTYSXUSI5QXTDKUZ6J5L4UTXWPK2Y4,CASVHBJ7MOZ5YFSVAYXKZFWIYAR6Y3Q4JI2P6GGJMRFUJBZN6APTZEZD'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// How far back to scan. ~100k ledgers ≈ 6 days at testnet cadence, kept just
// inside the RPC's ~7-day event retention window (with margin so a stale
// oldest-ledger boundary never trips the request).
const LOOKBACK_LEDGERS = 100_000

// Token amounts are 7-decimal stroops; oracle-scaled values use 14 decimals.
const TOKEN_SCALE = 1e7
const ORACLE_SCALE = 1e14

export interface VaultEvent {
  kind: 'deposit' | 'settle' | 'fund'
  id: string | null
  ledger: number
  at: string
  contractId: string
  txHash?: string
  // deposit
  owner?: string
  amountXlm?: number
  strikeUsd?: number
  expiry?: number
  premiumCash?: number
  // settle
  outcome?: string
  priceUsd?: number
  // fund
  from?: string
  amountCash?: number
}

function parseEvent(e: SorobanRpc.Api.EventResponse): VaultEvent | null {
  try {
    const topics = e.topic.map((t: xdr.ScVal) => scValToNative(t))
    const name = String(topics[0])
    const data = scValToNative(e.value) as unknown[]
    const base = {
      ledger: e.ledger,
      at: e.ledgerClosedAt,
      contractId: e.contractId?.contractId() ?? '',
      txHash: e.txHash,
    }

    if (name === 'deposit') {
      const [owner, amount, strike, expiry, premium] = data as [
        string,
        bigint,
        bigint,
        bigint,
        bigint,
      ]
      return {
        ...base,
        kind: 'deposit',
        id: topics[1] != null ? String(topics[1]) : null,
        owner,
        amountXlm: Number(amount) / TOKEN_SCALE,
        strikeUsd: Number(strike) / ORACLE_SCALE,
        expiry: Number(expiry),
        premiumCash: Number(premium) / TOKEN_SCALE,
      }
    }

    if (name === 'settle') {
      const [outcome, price] = data as [string, bigint]
      return {
        ...base,
        kind: 'settle',
        id: topics[1] != null ? String(topics[1]) : null,
        outcome: String(outcome),
        priceUsd: Number(price) / ORACLE_SCALE,
      }
    }

    if (name === 'fund') {
      const [from, amount] = data as [string, bigint]
      return {
        ...base,
        kind: 'fund',
        id: null,
        from,
        amountCash: Number(amount) / TOKEN_SCALE,
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Recent vault events across the deployed instances, newest first. Returns an
 * empty array on any RPC error rather than throwing — the activity feed is
 * non-critical and must never break the page.
 */
export async function fetchVaultEvents(limit = 25): Promise<VaultEvent[]> {
  if (VAULT_IDS.length === 0) return []
  try {
    const server = new SorobanRpc.Server(RPC_URL)
    const { sequence } = await server.getLatestLedger()
    const startLedger = Math.max(sequence - LOOKBACK_LEDGERS, 1)

    const res = await server.getEvents({
      startLedger,
      filters: [{ type: 'contract', contractIds: VAULT_IDS, topics: [] }],
      limit: 100,
    })

    return res.events
      .map(parseEvent)
      .filter((e): e is VaultEvent => e !== null)
      .reverse()
      .slice(0, limit)
  } catch (err) {
    console.warn('contract-events: getEvents failed', err)
    return []
  }
}
