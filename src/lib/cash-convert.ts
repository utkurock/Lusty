'use client'

/**
 * Turning the writer's stablecoin into the cash the vault escrows.
 * ===============================================================
 * A cash-secured put escrows ONE token — the `cash` address its vault instance
 * was constructed with (contracts/vault, `Config.cash`), which is LUSD on both
 * books. That is fixed at init, so "escrow my USDC instead" is not something
 * the contract can be asked for.
 *
 * What the writer means by it, though, is answerable: the balance that leaves
 * their wallet should be the stablecoin they picked, not a different one they
 * happen to hold. So when USDC is selected, the deposit spends USDC — it is
 * paid to the distributor and comes back as cash one for one, and the position
 * is escrowed with that. Their LUSD is not touched.
 *
 * Two ways across, tried in order. First a ROUTE: the writer's own path
 * payment through Stellar's liquidity (lib/routing, app/api/routing/swap),
 * atomic, so it lands at the exact amount within the route's bounds or moves
 * nothing. If the route refuses before anything is signed, which on testnet is
 * an empty or off-par book, the USDC bridge (app/api/anchor/bridge) takes it
 * at one for one out of the distributor's float, proved against the ledger
 * server-side. This module is the
 * seam: the earn screen asks the venue to "convert to cash" and does not know
 * the mechanism, and only this file knows the mechanism is the bridge. Keeping
 * that one-directional is the whole reason it is not imported there directly.
 */

import { buildBridgePaymentTx, checkBridge, claimBridge, submitSigned } from './anchor/bridge'

/** Stellar carries seven decimals; an amount with more is not representable. */
const STELLAR_DECIMALS = 7

export interface CashConversion {
  /** Hash of the writer's funding payment — the claim's only receipt. */
  fundingHash: string
  /** Cash that came back, as the route or the bridge recorded it. */
  amount: string
  /** Which way it crossed. */
  via: 'route' | 'bridge'
}

/** The route said no before anything was signed. Nothing moved. */
export class RouteUnavailable extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'RouteUnavailable'
  }
}

/** How often, and how far apart, settle is re-asked while Horizon is down. */
const SETTLE_RETRIES = 4
const SETTLE_RETRY_MS = 2_000

async function routingCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch('/api/routing/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/**
 * Receive exactly `amount` of cash for the writer's USDC over the allowlisted
 * route, or throw.
 *
 * `RouteUnavailable` means the route refused before the wallet was prompted;
 * the caller may cross another way. Any other error came after the prompt,
 * and since a path payment is atomic it still means nothing moved.
 */
export async function routeToCash(params: {
  address: string
  asset: string
  amount: number
  signTransaction: (xdr: string) => Promise<string>
  onProgress?: (message: string) => void
}): Promise<CashConversion> {
  const { address, asset, amount, signTransaction, onProgress } = params
  const exact = Number(amount.toFixed(STELLAR_DECIMALS))

  onProgress?.('Quoting USDC → LUSD on the network…')
  const prepared = await routingCall({ action: 'prepare', address, asset, destAmount: exact })
  if (!prepared.body?.ok) {
    throw new RouteUnavailable(
      prepared.body?.error ?? `the route did not answer (${prepared.status})`,
      prepared.body?.code ?? 'unreachable',
    )
  }
  const { id, xdr, sendMax } = prepared.body

  let hash: string
  try {
    onProgress?.(`Swapping at most ${sendMax} USDC for ${exact} LUSD — confirm in wallet`)
    hash = await submitSigned(await signTransaction(xdr))
  } catch (e) {
    const reason = (e as any)?.response?.data?.extras?.result_codes?.operations?.join(', ')
      ?? (e as Error)?.message
    await routingCall({ action: 'settle', id, reason }).catch(() => {})
    throw new Error(
      `The swap did not go through (${reason ?? 'not submitted'}). Nothing moved — a routed swap fills completely or not at all.`,
    )
  }

  // The swap is on the ledger; only the reading of it can fail. Horizon being
  // briefly unreachable answers `retry`, and the server keeps the swap open
  // for exactly that, so a few spaced attempts ride out a blip.
  let settled = await routingCall({ action: 'settle', id, txHash: hash })
  for (let attempt = 0; attempt < SETTLE_RETRIES && settled.body?.retry; attempt++) {
    onProgress?.('Confirming the swap on the ledger…')
    await new Promise((r) => setTimeout(r, SETTLE_RETRY_MS))
    settled = await routingCall({ action: 'settle', id, txHash: hash })
  }
  if (!settled.body?.filled) {
    // Submitted successfully but the ledger read disagreed or lagged. The
    // payment is the writer's own, so whatever it did is already in their
    // wallet; the balance refresh after this will show it.
    throw new Error(
      `The swap was submitted (${hash}) but could not be confirmed: ${settled.body?.reason ?? 'no answer'}.`,
    )
  }
  return { fundingHash: hash, amount: Number(settled.body.destAmount).toFixed(STELLAR_DECIMALS), via: 'route' }
}

/**
 * Thrown once the funding payment is irreversibly on the ledger.
 *
 * Past that point a failure is money OWED, not money lost: the same hash can
 * be claimed again. The hash travels with the error so the screen can say
 * which payment to quote, rather than reporting a generic failure over a
 * transaction the writer has already signed.
 */
export class CashConversionOwed extends Error {
  constructor(
    message: string,
    readonly fundingHash: string,
  ) {
    super(message)
    this.name = 'CashConversionOwed'
  }
}

/**
 * Spend `amount` of the writer's USDC and return the same amount in cash.
 *
 * Asks whether the crossing can be honoured BEFORE the wallet is prompted:
 * everything that decides it — the distributor's float, the replay guard —
 * fails after the money has moved otherwise.
 *
 * The caller must have ensured the writer can HOLD cash first. A payout into
 * an account with no trustline is refused by the network, and by then the
 * funding payment has already left.
 */
export async function convertToCash(params: {
  address: string
  amount: number
  signTransaction: (xdr: string) => Promise<string>
  onProgress?: (message: string) => void
}): Promise<CashConversion> {
  const { address, amount, signTransaction, onProgress } = params
  const exact = amount.toFixed(STELLAR_DECIMALS)

  onProgress?.('Checking the USDC conversion…')
  const ready = await checkBridge('anchor_to_cash', exact)
  if (!ready.ready) {
    throw new Error(
      ready.reason ??
        'the USDC conversion cannot be honoured right now — switch to LUSD or try again later',
    )
  }

  onProgress?.(`Converting ${exact} USDC — confirm in wallet`)
  const xdr = await buildBridgePaymentTx({
    from: address,
    direction: 'anchor_to_cash',
    amount: exact,
  })
  const fundingHash = await submitSigned(await signTransaction(xdr))

  // From here the USDC is gone and the claim is the only way it comes back.
  onProgress?.('Receiving the converted cash…')
  try {
    const claimed = await claimBridge({
      address,
      txHash: fundingHash,
      direction: 'anchor_to_cash',
      sourceAmount: Number(exact),
    })
    return { fundingHash, amount: claimed.destAmount, via: 'bridge' }
  } catch (e) {
    throw new CashConversionOwed(
      `Your USDC was sent but the conversion did not complete: ${
        (e as Error)?.message ?? 'the bridge refused the claim'
      }. Nothing is lost — claim it again below, or quote payment ${fundingHash} to support. No position was opened.`,
      fundingHash,
    )
  }
}

/**
 * Claim the cash for a funding payment that is already on the ledger.
 *
 * The recovery half of `convertToCash`: the server proves the hash against the
 * ledger and its replay guard pays any hash at most once, so asking again is
 * safe however many times it is pressed.
 */
export async function reclaimCash(params: {
  address: string
  fundingHash: string
  amount: number
}): Promise<CashConversion> {
  const claimed = await claimBridge({
    address: params.address,
    txHash: params.fundingHash,
    direction: 'anchor_to_cash',
    sourceAmount: Number(params.amount.toFixed(STELLAR_DECIMALS)),
  })
  return { fundingHash: params.fundingHash, amount: claimed.destAmount, via: 'bridge' }
}
