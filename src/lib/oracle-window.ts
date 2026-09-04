/**
 * How long after expiry a position can still be settled.
 *
 * Settlement is priced at the oracle's reading for the expiry timestamp, and
 * the contract fails closed when it cannot get one. Reflector keeps a ring
 * buffer of historical prices, not a permanent record: once the expiry period
 * is pruned, `price(asset, expiry)` returns nothing, and the contract's only
 * fallback — the live price — is gated on being within an hour of expiry, so
 * that a late settlement cannot pick its own price. Past that point nothing can
 * settle the position: not the runner, not the writer, not a stranger. There is
 * no admin override and no upgrade entrypoint, so the collateral stays escrowed.
 *
 * Measured against the live testnet feed: the reading 20h back was still
 * served, the one 22h back was gone.
 *
 * This lives alone in a leaf module because both sides of the app need it and
 * only one of them can afford the settlement runner's imports. The server uses
 * it to decide what to attempt; the dashboard uses it to stop describing a
 * position nobody can close as one that is about to be closed.
 */
export const ORACLE_HISTORY_SECS = 24 * 60 * 60

/** Whether the oracle can still price this expiry. */
export function withinOracleWindow(expiry: Date, now: Date = new Date()): boolean {
  return now.getTime() <= expiry.getTime() + ORACLE_HISTORY_SECS * 1000
}
