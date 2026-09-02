/**
 * Server start-up hook. Next.js calls `register` once per server process,
 * before the first request is handled.
 *
 * The settlement sweep starts here rather than from a route, because a route
 * only runs when someone visits and settlement cannot wait for traffic.
 */
export async function register() {
  // Also evaluated on the edge runtime, where there is no signing and no timer
  // worth keeping alive.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { startSettlementScheduler } = await import('@/lib/settlement-scheduler')
  startSettlementScheduler()
}
