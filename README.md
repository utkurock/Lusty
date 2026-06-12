# Lusty

Options yield protocol on Stellar. Sell covered calls and cash-secured puts on
XLM, get the premium upfront, settle at expiry against an oracle price.

**Network:** Stellar Testnet · **Live:** [lusty.finance](https://lusty.finance)

---

## Where Lusty is today

Two rails, one pricing engine, one oracle:

- **Web vault (Stellar Classic).** The production testnet app. Collateral is
  held by a protocol distributor account and premiums are paid by the server —
  custodial by design while the contract rail matures. Settlement prices come
  from the **Reflector oracle**, pinned to the expiry timestamp.
- **Soroban vault (v2, deployed).** The trustless rail, live on testnet: the
  contract escrows collateral, pays the premium in USDC **atomically inside
  `deposit()`**, and settles permissionlessly against Reflector at the expiry
  price. Real ITM/OTM positions have been opened and settled end-to-end on
  testnet. See [`contracts/README.md`](contracts/README.md).

What remains for the trustless migration (Tranche 2): pointing the web app's
deposit flow at the contract, cash-secured puts in-contract, and an
independent audit. Custody is the only trust assumption left — pricing and
settlement already run on the same oracle on both rails.

**LUSD** is a testnet convenience token (faucet-issued, unbacked, documented
as such in the app). It has **no mainnet path** — mainnet settles in Circle's
native USDC, as the contract rail already does.

## How a position works

1. Pick a strike and expiry (rolling Friday expiries, 3 open at once).
2. Deposit collateral — XLM for covered calls, cash for puts. The premium
   lands in your wallet immediately; what you see quoted is exactly what you
   are paid.
3. At expiry, settlement reads the oracle price **at the expiry timestamp**
   (your claim timing cannot change the outcome):
   - covered call: spot ≤ strike → collateral back; spot > strike → assigned,
     you receive the strike value in cash.
   - put: mirrored.
4. The premium is yours either way.

## Pricing

One quote engine (`src/lib/pricing-server.ts`) prices everything the UI shows
and everything the vault pays — there is no second adjustment layer.

```
σ_realized  ← XLM price history (EWMA, RiskMetrics λ=0.94)
σ_offered   = σ_realized × 1.10 + 0.03        vol risk premium, capped at 100%
F           ← forward from perp funding        (≈ spot for weeklies)
P_fair      = Black-76(side, F, K, T, σ_offered)
APR ladder  : nearest strike pinned to a time-scaled ceiling (120% × days/ref),
              farther strikes fall away on the Black-76 gradient
× taper     : offered APR falls linearly with pool utilization (−50% at full)
− fee       : 10% of the upfront, taken from the premium (never collateral)
```

Two invariants, enforced by unit tests: the user is never paid above the
haircut fair value (protocol keeps ≥20% edge vs its own Black-76 estimate),
and an off-ladder strike can never quote above the displayed ceiling.

## Architecture

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind |
| Wallets | Stellar Wallets Kit (Freighter, xBull, Albedo, Lobstr) |
| Settlement oracle | **Reflector** (both rails; Soroban RPC simulation server-side, cross-contract call on-chain) |
| Contracts | Soroban (Rust), `contracts/vault` |
| Web settlement | Stellar Classic payments from the distributor |
| Quote inputs | Binance (realized vol history, perp funding) — quote inputs only, never the settlement price |
| Database | PostgreSQL (Supabase), deny-all RLS |

## Testnet addresses

```
Soroban vault v2     CASVHBJ7MOZ5YFSVAYXKZFWIYAR6Y3Q4JI2P6GGJMRFUJBZN6APTZEZD
Reflector oracle     CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63
LUSD issuer          GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6
LUSD distributor     GBAIN6CHZJGBL365JNXSRQEKALXYTWKXANQZ3RBM7AGUEYYKLJJ6SNR6
```

## Security

Hardened in response to (and beyond) SCF #43 panel review — every item below
is verifiable in the commit history and covered by tests where applicable.

- **Server-canonical money math.** Premiums are recomputed server-side from
  the quote engine; strike/expiry/type at claim come from the deposit record,
  never from the client.
- **Expiry-pinned settlement** from Reflector — claim timing gives the writer
  no optionality; Binance kline is only a fallback.
- **Replay protection** on deposit, claim and swap (DB unique-constraint
  ledger), including cross-endpoint reuse: one on-chain payment can fund a
  deposit *or* a swap, never both.
- **Atomic capacity caps.** Per-user/30d, per-user-per-expiry, per-strike and
  per-expiry caps are checked and reserved in a single advisory-locked DB
  transaction — concurrent requests cannot overshoot them.
- **Fail-closed everywhere.** Price feed down, DB down, breaker state
  unreadable, oracle stale → the operation is refused, never waved through.
- **Circuit breaker** with automatic halts: volatility spike (≥3× baseline),
  oracle stress (≥10% 1-minute move or feed unreachable), per-epoch loss cap.
  Manual trips can only be cleared by a human.
- **Multi-sig accounts.** Issuer requires 2-of-3 for every operation
  (including minting). Distributor payments stay hot by design (bounded by
  the caps above); its signer/threshold changes require 2-of-3.
- **Tests.** 48 unit tests on the pricing path (which caught a real CDF
  scaling bug), 17 on the Soroban contract incl. a mock oracle.
- Rate limiting, parameterized SQL, wallet-signature admin auth, CSP/HSTS
  headers, secrets gitignored.

## Project structure

```
contracts/
  vault/               Soroban covered-call vault (escrow + premium + settlement)
src/
  app/
    earn/              Strike selector, deposit, instant premium
    (app)/dashboard/   Positions & claims
    swap/  leaderboard/  docs/  (app)/research/
    api/
      vault/{quote,deposit,claim,positions,stats}
      swap/  faucet/lusd/  leaderboard/  admin/  cron/monitor/
  lib/
    pricing-server.ts  THE quote engine (Black-76 + ladder + taper + fee)
    pricing.ts         Black-76 / CDF primitives, strike ladders
    vol.ts forward.ts  Realized vol (EWMA), perp-funding forward
    reflector.ts       Reflector reads via Soroban RPC (settlement source)
    deposit-capacity.ts Atomic cap checks + pending-row reservation
    idempotency.ts     Replay ledger (deposit/claim/swap)
    circuit-breaker.ts monitor/  Risk halts & alerting
    db.ts db-queries.ts vault-state.ts expiries.ts
  components/  hooks/  providers/
```

## Running locally

```sh
npm install
npm run dev        # web app on :3000 (.env.local required)
npm test           # pricing test suite
cd contracts && cargo test && stellar contract build
```

## License

MIT
