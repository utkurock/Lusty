// The surfaces that exist only because testnet has no real money: the faucet
// (friendbot XLM, LUSD and LBTC drips), the XLM⇄LUSD swap desk and the
// circle-style USDC→LUSD bridge. Each pays out of a server-held distributor
// key, which is tolerable for test tokens and is not a surface the public
// network gets. There they answer as if they were never built.

import { NextResponse } from 'next/server'
import { IS_TESTNET } from './stellar'

/**
 * A 404 for a testnet-only route off testnet, else null. Called first in the
 * handler, before rate limits, the database or any key is touched.
 */
export function testnetOnly(): NextResponse | null {
  return IS_TESTNET ? null : NextResponse.json({ error: 'not found' }, { status: 404 })
}
