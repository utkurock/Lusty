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
import { retiredVaults, settleableUnderlyings, vaultInstances } from './assets'

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org'

// The instances to stream come off the registry — a separate env list would
// drift, and an asset missing from it settles on chain while its writers watch
// a feed that never mentions it. The env var survives only for superseded
// instances, which the registry cannot name.
const RETIRED_VAULT_IDS = (process.env.NEXT_PUBLIC_VAULT_CONTRACTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// Instances a book was moved off (`VAULT_RETIRED_<SYMBOL>`) are still settled
// by the sweep, so their settlements belong in the index as well.
const VAULT_IDS = [
  ...new Set([
    ...vaultInstances(),
    ...settleableUnderlyings().flatMap((a) => retiredVaults(a)),
    ...RETIRED_VAULT_IDS,
  ]),
]

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
  payout?: { amount: number; asset: string }
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

/**
 * When a position opened, as the ledger recorded it: the `deposit` event its
 * open emitted, in the transaction the caller names.
 *
 * Null when the hash is not that transaction — not a hash, not found, failed,
 * or a transaction that did not open this instance's position — and when the
 * transaction has aged past the RPC's retention. Throws when the RPC cannot be
 * read, so the caller can tell "wrong" from "not now".
 *
 * One page from the transaction's own ledger is enough: the filter names the
 * event and the position, and the event is in that ledger or nowhere.
 */
export async function findOpenEvent(
  contractId: string,
  positionId: number,
  txHash: string
): Promise<{ at: number } | null> {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) return null
  const hash = txHash.toLowerCase()
  const server = new sorobanRpc.Server(RPC_URL)
  const tx = await server.getTransaction(hash)
  if (tx.status !== sorobanRpc.Api.GetTransactionStatus.SUCCESS) return null

  const topics = [
    [
      nativeToScVal('deposit', { type: 'symbol' }).toXDR('base64'),
      nativeToScVal(BigInt(positionId), { type: 'u64' }).toXDR('base64'),
    ],
  ]
  const { events } = await scanForward(server, { startLedger: tx.ledger }, topics, 1)
  const hit = events
    .map(parseEvent)
    .find(
      (e) =>
        e?.kind === 'deposit' &&
        e.contractId === contractId &&
        e.id === String(positionId) &&
        e.txHash?.toLowerCase() === hash
    )
  if (!hit) return null
  const at = Date.parse(hit.at)
  return Number.isFinite(at) ? { at } : null
}

/** One position's resolution, as the ledger recorded it. */
export interface SettlementRecord {
  positionId: number
  /** The instance that settled it. Half of the identity — see `settlementKey`. */
  contractId: string
  outcome: string
  /** Oracle price the contract settled against — the price at expiry. */
  priceUsd: number
  at: string
  txHash?: string
}

/**
 * How a settlement is addressed: by instance and id together.
 *
 * A position id alone does not identify a position. Every vault numbers its
 * own positions from zero, so XLM's #3 and BTC's #3 are two different writers'
 * money, and an index keyed on the number hands whichever settled last to
 * both. The retired instances in `NEXT_PUBLIC_VAULT_CONTRACTS` make this true
 * today, before BTC exists: they are scanned alongside the live vault and
 * their ids start at zero as well.
 */
export function settlementKey(contractId: string, positionId: number): string {
  return `${contractId}#${positionId}`
}

// The settlement index, kept between requests.
//
// Settlements are append-only and never change once written, so an entry that
// has been read once never needs reading again. What the index keeps is the
// cursor: the first scan pays for its window, and every later refresh resumes
// from where that one stopped, which is normally a single page.
const settlements = new Map<string, SettlementRecord>()
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
    settlements.set(settlementKey(e.contractId, positionId), {
      positionId,
      contractId: e.contractId,
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
 * Settlements, indexed by instance and position id — see `settlementKey`.
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
export async function fetchSettlements(): Promise<Map<string, SettlementRecord>> {
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

/** One `set_limits` call, as the instance announced it. */
export interface LimitsChange {
  contractId: string
  ledger: number
  at: string
  txHash?: string
  maxPositionCall: number
  maxPositionPut: number
  maxPremiumBps: number
  /** v5 instances only: v4 left the per-expiry caps out of the event. */
  maxExpiryCall?: number
  maxExpiryPut?: number
  /**
   * Set when this is a raise the instance scheduled (`lim_raise`, v5) rather
   * than limits it applied: the values bind from this time unless the admin
   * sets the limits again first.
   */
  effectiveAt?: string
}

/**
 * Read a `limits` event, or a `lim_raise` one. Every instance publishes the two
 * position caps and the premium ceiling; v5 appends the two per-expiry caps. On
 * a v4 instance a change to the per-expiry caps alone still shows up here, with
 * values that look unchanged. A v5 raise is first announced as `lim_raise`,
 * with the time it binds from appended, a day before it can be used.
 */
export function parseLimitsEvent(e: sorobanRpc.Api.EventResponse): LimitsChange | null {
  try {
    const topics = e.topic.map((t: xdr.ScVal) => scValToNative(t))
    const kind = String(topics[0])
    if (kind !== 'limits' && kind !== 'lim_raise') return null
    const [call, put, bps, expCall, expPut, effectiveAt] = scValToNative(e.value) as [
      bigint,
      bigint,
      number | bigint,
      bigint?,
      bigint?,
      bigint?,
    ]
    if (kind === 'lim_raise' && effectiveAt === undefined) return null
    return {
      contractId: e.contractId?.contractId() ?? '',
      ledger: e.ledger,
      at: e.ledgerClosedAt,
      txHash: e.txHash,
      maxPositionCall: Number(call) / TOKEN_SCALE,
      maxPositionPut: Number(put) / TOKEN_SCALE,
      maxPremiumBps: Number(bps),
      ...(expCall !== undefined ? { maxExpiryCall: Number(expCall) / TOKEN_SCALE } : {}),
      ...(expPut !== undefined ? { maxExpiryPut: Number(expPut) / TOKEN_SCALE } : {}),
      ...(kind === 'lim_raise'
        ? { effectiveAt: new Date(Number(effectiveAt) * 1000).toISOString() }
        : {}),
    }
  } catch {
    return null
  }
}

/** First scan with no cursor: two pages, about twenty hours. */
const LIMITS_LOOKBACK_LEDGERS = 2 * LEDGERS_PER_PAGE

/**
 * Every `set_limits` since `cursor`, applied or scheduled, oldest first, and the cursor to resume
 * from next time.
 *
 * Unlike the settlement index this throws on an RPC failure: the caller is a
 * monitor, and a scan that silently found nothing is indistinguishable from a
 * quiet admin.
 */
export async function scanLimitsChanges(
  cursor?: string,
): Promise<{ changes: LimitsChange[]; cursor?: string }> {
  if (VAULT_IDS.length === 0) return { changes: [], cursor }
  const server = new sorobanRpc.Server(RPC_URL)
  const topic = (name: string) => nativeToScVal(name, { type: 'symbol' }).toXDR('base64')

  let start: { startLedger: number } | { cursor: string }
  if (cursor) {
    start = { cursor }
  } else {
    const { sequence } = await server.getLatestLedger()
    start = { startLedger: Math.max(sequence - LIMITS_LOOKBACK_LEDGERS, 1) }
  }

  const page = await scanForward(
    server,
    start,
    [[topic('limits')], [topic('lim_raise')]],
    cursor ? 3 : LIMITS_LOOKBACK_LEDGERS / LEDGERS_PER_PAGE,
  )
  const changes = page.events
    .map(parseLimitsEvent)
    .filter((c): c is LimitsChange => c !== null)
  return { changes, cursor: page.cursor ?? cursor }
}

/** A step in withdrawing a pool's free liquidity to the treasury (v5). */
export interface WithdrawalEvent {
  contractId: string
  ledger: number
  at: string
  txHash?: string
  step: 'requested' | 'cancelled' | 'executed'
  pool: 'cash' | 'underlying'
  /** Requested: the most it will pay. Executed: what it paid. */
  amount?: number
  /** Requested only: when it may be executed. */
  executableAt?: string
}

const POOLS: Record<number, WithdrawalEvent['pool']> = { 0: 'cash', 1: 'underlying' }

const WITHDRAWAL_STEPS = {
  wd_req: 'requested',
  wd_cancel: 'cancelled',
  withdraw: 'executed',
} as const

/**
 * Read a `wd_req`, `wd_cancel` or `withdraw` event. The pool is the second
 * topic. `Pool` has explicit discriminants, so it travels as a u32 (0 cash,
 * 1 underlying), the same way `Kind` does.
 */
export function parseWithdrawalEvent(e: sorobanRpc.Api.EventResponse): WithdrawalEvent | null {
  try {
    const topics = e.topic.map((t: xdr.ScVal) => scValToNative(t))
    const step = WITHDRAWAL_STEPS[String(topics[0]) as keyof typeof WITHDRAWAL_STEPS]
    if (!step) return null
    const pool = POOLS[Number(topics[1])]
    if (!pool) return null
    const base = {
      contractId: e.contractId?.contractId() ?? '',
      ledger: e.ledger,
      at: e.ledgerClosedAt,
      txHash: e.txHash,
      step,
      pool,
    } as const
    if (step === 'cancelled') return base
    const value = scValToNative(e.value) as [bigint, bigint] | [string, bigint]
    if (step === 'requested') {
      const [amount, executableAt] = value as [bigint, bigint]
      return {
        ...base,
        amount: Number(amount) / TOKEN_SCALE,
        executableAt: new Date(Number(executableAt) * 1000).toISOString(),
      }
    }
    return { ...base, amount: Number((value as [string, bigint])[1]) / TOKEN_SCALE }
  } catch {
    return null
  }
}

/**
 * Every withdrawal step since `cursor`, oldest first, and the cursor to resume
 * from. Throws on an RPC failure, like `scanLimitsChanges`, for the same
 * reason: a monitor must not read an outage as a quiet admin.
 */
export async function scanWithdrawals(
  cursor?: string,
): Promise<{ withdrawals: WithdrawalEvent[]; cursor?: string }> {
  if (VAULT_IDS.length === 0) return { withdrawals: [], cursor }
  const server = new sorobanRpc.Server(RPC_URL)
  const topic = (name: string) => nativeToScVal(name, { type: 'symbol' }).toXDR('base64')

  let start: { startLedger: number } | { cursor: string }
  if (cursor) {
    start = { cursor }
  } else {
    const { sequence } = await server.getLatestLedger()
    start = { startLedger: Math.max(sequence - LIMITS_LOOKBACK_LEDGERS, 1) }
  }

  const page = await scanForward(
    server,
    start,
    Object.keys(WITHDRAWAL_STEPS).map((name) => [topic(name), '*']),
    cursor ? 3 : LIMITS_LOOKBACK_LEDGERS / LEDGERS_PER_PAGE,
  )
  const withdrawals = page.events
    .map(parseWithdrawalEvent)
    .filter((w): w is WithdrawalEvent => w !== null)
  return { withdrawals, cursor: page.cursor ?? cursor }
}
