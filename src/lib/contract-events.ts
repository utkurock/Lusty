// On-chain vault event reader (server-side, via Soroban RPC getEvents).
// =====================================================================
// The vault contract (contracts/vault) publishes an event for every state
// change: `deposit` when a writer opens a position, `settle` when one is
// resolved against the oracle, and `fund` on a cash-pool top-up. This streams
// those events out of the ledger so the UI can show real on-chain activity,
// closing the loop the contract opens with `env.events().publish(...)`.
//
// Reads only — getEvents submits nothing, signs nothing, costs nothing.

import { rpc as sorobanRpc, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk'

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org'

// The vault instances to stream. Normally just the live one; the plural form
// exists so a superseded instance can be kept in the feed while its last
// positions settle.
const VAULT_IDS = (
  process.env.NEXT_PUBLIC_VAULT_CONTRACTS ??
  process.env.NEXT_PUBLIC_VAULT_CONTRACT ??
  ''
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// A single getEvents call scans a fixed slice of ledgers — 10,000 on the public
// RPC — and returns whatever it found in THAT slice, plus a cursor to continue
// from. It is not "the newest N events": asking from 100,000 ledgers back
// returns the events in the OLDEST ten thousand of that range, which for a
// quiet contract is none at all, and looks exactly like a contract that has
// never emitted anything.
//
// So every scan here pages forward explicitly and says how many pages it will
// spend. Nothing scans from the far edge of retention and hopes.
const LEDGERS_PER_PAGE = 10_000

/** How far back the activity feed looks: three pages, about a day and a half. */
const FEED_LOOKBACK_LEDGERS = 3 * LEDGERS_PER_PAGE

// Token amounts are 7-decimal stroops; oracle-scaled values use 14 decimals.
const TOKEN_SCALE = 1e7
const ORACLE_SCALE = 1e14

/** Contract-side `Kind` discriminant, as emitted on the deposit event. */
const SIDES = ['call', 'put'] as const
export type OptionSide = (typeof SIDES)[number]

export interface VaultEvent {
  kind: 'deposit' | 'settle' | 'fund'
  /**
   * Where the row came from. 'chain' is an event read out of the ledger;
   * 'mirror' is a deposit this application recorded when it landed, used only
   * for history older than the RPC's event window. Both name a real
   * transaction; only the first can carry a settlement or a pool top-up.
   */
  source?: 'chain' | 'mirror'
  id: string | null
  ledger: number
  at: string
  contractId: string
  txHash?: string
  // deposit
  owner?: string
  /** Collateral escrowed — XLM for a call, cash for a put (see `side`). */
  amount?: number
  side?: OptionSide
  strikeUsd?: number
  expiry?: number
  premiumCash?: number
  // settle
  outcome?: string
  priceUsd?: number
  /**
   * What settlement moved, filled in by whoever reads the position behind the
   * event. The event itself carries only the outcome and the price — the
   * amounts live in contract state — and the outcome alone is the half of the
   * story that does not say where the money went.
   */
  payout?: { amount: number; asset: 'XLM' | 'LUSD' }
  /** Collateral the writer gave up, when assigned. */
  releasedAmount?: number
  // fund
  from?: string
  pool?: 'cash' | 'underlying'
  amountCash?: number
}

function parseEvent(e: sorobanRpc.Api.EventResponse): VaultEvent | null {
  try {
    const topics = e.topic.map((t: xdr.ScVal) => scValToNative(t))
    const name = String(topics[0])
    const data = scValToNative(e.value) as unknown[]
    const base = {
      source: 'chain' as const,
      ledger: e.ledger,
      at: e.ledgerClosedAt,
      contractId: e.contractId?.contractId() ?? '',
      txHash: e.txHash,
    }

    if (name === 'deposit') {
      // `side` is absent on events emitted by the call-only v2 contract, which
      // is still within the RPC's retention window — default those to 'call'.
      const [owner, amount, strike, expiry, premium, side] = data as [
        string,
        bigint,
        bigint,
        bigint,
        bigint,
        number | undefined,
      ]
      return {
        ...base,
        kind: 'deposit',
        id: topics[1] != null ? String(topics[1]) : null,
        owner,
        amount: Number(amount) / TOKEN_SCALE,
        side: SIDES[Number(side ?? 0)] ?? 'call',
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
        // Second topic names the pool: 'cash' backs premiums and call
        // assignments, 'under' the underlying a put assignment delivers.
        pool: topics[1] === 'under' ? 'underlying' : 'cash',
        amountCash: Number(amount) / TOKEN_SCALE,
      }
    }

    return null
  } catch {
    return null
  }
}

/** One page of a forward scan, plus where to continue from. */
interface EventPage {
  events: sorobanRpc.Api.EventResponse[]
  cursor?: string
  latestLedger: number
}

/** The ledger a paging cursor has scanned through. */
function cursorLedger(cursor: string): number {
  try {
    return Number(BigInt(cursor.split('-')[0]) >> 32n)
  } catch {
    return 0
  }
}

/**
 * Page forward from `start` until the scan reaches the tip or runs out of
 * pages, gathering everything it passes.
 *
 * `maxPages` is a budget, not a guess: each page is one RPC round trip, and
 * this runs inside a request the user is waiting on. A scan that stops early
 * returns what it has along with the cursor it stopped at, so the caller can
 * resume rather than start over.
 */
async function scanForward(
  server: sorobanRpc.Server,
  start: { startLedger: number } | { cursor: string },
  topics: (string | '*')[][],
  maxPages: number
): Promise<EventPage> {
  const filters = [{ type: 'contract' as const, contractIds: VAULT_IDS, topics }]
  const events: sorobanRpc.Api.EventResponse[] = []
  let request: any = { ...start, filters, limit: 100 }
  let cursor: string | undefined
  let latestLedger = 0

  for (let page = 0; page < maxPages; page++) {
    const res = await server.getEvents(request)
    events.push(...res.events)
    latestLedger = res.latestLedger
    cursor = res.cursor
    if (!cursor || cursorLedger(cursor) >= res.latestLedger) break
    request = { cursor, filters, limit: 100 }
  }

  return { events, cursor, latestLedger }
}

/**
 * Recent vault events across the deployed instances, newest first. Returns an
 * empty array on any RPC error rather than throwing — the activity feed is
 * non-critical and must never break the page.
 */
export async function fetchVaultEvents(limit = 25): Promise<VaultEvent[]> {
  if (VAULT_IDS.length === 0) return []
  try {
    const server = new sorobanRpc.Server(RPC_URL)
    const { sequence } = await server.getLatestLedger()
    const { events } = await scanForward(
      server,
      { startLedger: Math.max(sequence - FEED_LOOKBACK_LEDGERS, 1) },
      [],
      FEED_LOOKBACK_LEDGERS / LEDGERS_PER_PAGE
    )

    return events
      .map(parseEvent)
      .filter((e): e is VaultEvent => e !== null)
      .reverse()
      .slice(0, limit)
  } catch (err) {
    console.warn('contract-events: getEvents failed', err)
    return []
  }
}

/** One position's resolution, as the ledger recorded it. */
export interface SettlementRecord {
  positionId: number
  outcome: string
  /** Oracle price the contract settled against — the price at expiry. */
  priceUsd: number
  at: string
  txHash?: string
}

// The settlement index, kept between requests.
//
// Settlements are append-only and never change once written, so an entry that
// has been read once never needs reading again. What the index keeps is the
// cursor: the first scan pays for its window, and every later refresh resumes
// from where that one stopped, which is normally a single page.
const settlements = new Map<number, SettlementRecord>()
let settlementCursor: string | undefined
let settlementsFreshUntil = 0
let settlementScan: Promise<void> | null = null

const SETTLEMENT_TTL_MS = 60_000
/** First scan: two pages, about twenty hours — comfortably past any sweep. */
const SETTLEMENT_LOOKBACK_LEDGERS = 2 * LEDGERS_PER_PAGE

async function refreshSettlements(): Promise<void> {
  const server = new sorobanRpc.Server(RPC_URL)
  const settleTopic = nativeToScVal('settle', { type: 'symbol' }).toXDR('base64')

  let start: { startLedger: number } | { cursor: string }
  if (settlementCursor) {
    start = { cursor: settlementCursor }
  } else {
    const { sequence } = await server.getLatestLedger()
    start = { startLedger: Math.max(sequence - SETTLEMENT_LOOKBACK_LEDGERS, 1) }
  }

  // Filtered on the topic rather than after the fact: a page is capped at 100
  // events and deposits are the commoner kind, so an unfiltered scan would
  // spend its budget on rows this function throws away.
  const { events, cursor } = await scanForward(
    server,
    start,
    [[settleTopic, '*']],
    settlementCursor ? 3 : SETTLEMENT_LOOKBACK_LEDGERS / LEDGERS_PER_PAGE
  )

  for (const raw of events) {
    const e = parseEvent(raw)
    if (!e || e.kind !== 'settle' || e.id == null) continue
    const positionId = Number(e.id)
    if (!Number.isFinite(positionId)) continue
    settlements.set(positionId, {
      positionId,
      outcome: e.outcome ?? 'unknown',
      priceUsd: e.priceUsd ?? 0,
      at: e.at,
      txHash: e.txHash,
    })
  }

  if (cursor) settlementCursor = cursor
  settlementsFreshUntil = Date.now() + SETTLEMENT_TTL_MS
}

/**
 * Settlements, indexed by position id.
 *
 * The position itself already says that it settled and how; what it cannot say
 * is when, at what price, or in which transaction — the contract keeps no room
 * for that and publishes it as an event instead. So a writer asking why their
 * collateral came back as cash is answered from here, with a hash they can open.
 *
 * Bounded by the RPC's event retention and by the scan budget above, so an old
 * settlement comes back missing rather than wrong. An absent record means "not
 * recorded here" and never "did not settle" — the position is the authority on
 * that, and callers must not infer settlement from this map.
 */
export async function fetchSettlements(): Promise<Map<number, SettlementRecord>> {
  if (VAULT_IDS.length === 0) return settlements
  if (Date.now() < settlementsFreshUntil) return settlements

  // One scan at a time: a dashboard load asks for positions and portfolio at
  // once, and two identical walks of the same ledgers help nobody.
  if (!settlementScan) {
    settlementScan = refreshSettlements()
      .catch((err) => {
        console.warn('contract-events: settlement scan failed', err)
        // Back off rather than retrying on every request while RPC is unwell.
        settlementsFreshUntil = Date.now() + 10_000
      })
      .finally(() => {
        settlementScan = null
      })
  }
  await settlementScan
  return settlements
}
