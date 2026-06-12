import Link from 'next/link'

// ── Small presentational helpers (server component, no client JS) ──────────
const H2 = ({ id, children }: { id: string; children: React.ReactNode }) => (
  <h2
    id={id}
    className="scroll-mt-24 text-2xl font-bold text-ink mt-14 mb-4 pb-2 border-b border-line"
  >
    {children}
  </h2>
)
const H3 = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-lg font-bold text-ink mt-7 mb-2">{children}</h3>
)
const P = ({ children }: { children: React.ReactNode }) => (
  <p className="leading-relaxed text-ink-2 my-3">{children}</p>
)
const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="px-1.5 py-0.5 bg-card border border-line rounded text-[13px] font-mono text-ink">
    {children}
  </code>
)
const Pre = ({ children }: { children: React.ReactNode }) => (
  <pre className="bg-inverse text-cream p-4 rounded text-xs leading-relaxed overflow-x-auto my-4 font-mono whitespace-pre">
    {children}
  </pre>
)
const List = ({ children }: { children: React.ReactNode }) => (
  <ul className="list-disc pl-5 space-y-2 my-3 text-ink-2 leading-relaxed">
    {children}
  </ul>
)
const Today = ({ children }: { children: React.ReactNode }) => (
  <div className="my-5 rounded-lg border-l-4 border-ink bg-card p-4 text-[14px] leading-relaxed text-ink-2">
    <div className="font-mono text-[11px] uppercase tracking-wider text-ink font-bold mb-1.5">
      Live today
    </div>
    {children}
  </div>
)
const Next = ({ children }: { children: React.ReactNode }) => (
  <div className="my-5 rounded-lg border-l-4 border-[#eab308] bg-card p-4 text-[14px] leading-relaxed text-ink-2">
    <div className="font-mono text-[11px] uppercase tracking-wider text-[#eab308] font-bold mb-1.5">
      This grant (Tranche 1–2)
    </div>
    {children}
  </div>
)

const TOC = [
  ['summary', '1. Summary'],
  ['rails', '2. Two rails, one engine'],
  ['building-blocks', '3. Stellar building blocks'],
  ['contract', '4. The Soroban vault'],
  ['oracle', '5. Reflector oracle integration'],
  ['flows', '6. End-to-end flows'],
  ['pricing', '7. Pricing engine'],
  ['security', '8. Security architecture'],
  ['plan', '9. Integration plan & tranches'],
  ['addresses', '10. Deployed addresses'],
]

export default function ArchitecturePage() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-12 flex gap-10">
      {/* TOC */}
      <nav className="hidden lg:block w-56 shrink-0">
        <div className="sticky top-24">
          <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2 mb-3">
            Contents
          </div>
          <ul className="space-y-1.5 text-sm">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="text-ink-2 hover:text-ink transition block"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      {/* Body */}
      <article className="min-w-0 flex-1">
        <div className="font-mono text-[11px] uppercase tracking-wider text-[#eab308] font-bold mb-2">
          Technical Architecture
        </div>
        <h1 className="text-4xl font-bold text-ink mb-3">
          Lusty on Stellar
        </h1>
        <p className="text-lg text-ink-2 leading-relaxed">
          An on-chain options-yield protocol: sell covered calls and
          cash-secured puts on XLM, receive the premium up front, and settle at
          expiry against the Reflector oracle. This document describes the
          system that exists today and the Stellar integration this grant
          completes.
        </p>

        <div className="mt-8 rounded-lg overflow-hidden border border-line bg-inverse text-cream aspect-[16/6] flex flex-col items-center justify-center font-mono">
          <div className="text-5xl tracking-[0.3em] font-bold">lusty</div>
          <div className="mt-4 text-xs tracking-[0.25em] text-[#eab308]">
            SOROBAN · REFLECTOR · STELLAR CLASSIC
          </div>
        </div>

        {/* 1 */}
        <H2 id="summary">1. Summary</H2>
        <P>
          Lusty lets an XLM holder earn yield by writing options. You pick a
          strike and an expiry, deposit collateral, and the premium lands in
          your wallet immediately. At expiry the position settles against an
          on-chain price: your collateral comes back, or you are assigned at the
          strike you chose. Either way the premium is yours.
        </P>
        <P>
          The protocol runs on two rails that share one pricing engine and one
          oracle. The <strong>server rail</strong> on Stellar Classic is the
          production testnet app. The <strong>Soroban rail</strong> is the
          trust-minimized version: a deployed contract that escrows collateral,
          pays the premium atomically, and settles permissionlessly against
          Reflector. Both rails settle a given position at the same number,
          because both read the same Reflector feed pinned to the same expiry
          timestamp.
        </P>
        <Today>
          The Soroban vault is deployed on testnet and has settled real ITM and
          OTM positions end to end against the live Reflector feed. The server
          rail is the user-facing app at lusty.finance. Pricing and settlement
          already run on-chain; custody is the one trust assumption still on the
          server rail.
        </Today>

        {/* 2 */}
        <H2 id="rails">2. Two rails, one engine</H2>
        <P>
          Splitting the system this way is deliberate. The server rail let us
          ship a complete, hardened product and a real pricing engine without
          waiting on contract work; the Soroban rail removes the custody and
          settlement trust assumptions one at a time. The migration is a matter
          of moving each responsibility from the server to the contract, not a
          rewrite.
        </P>
        <Pre>{`                          ┌──────────────────────────┐
        user wallet ──────►│   Pricing engine (shared)│
   (Freighter / xBull /    │  Black-76 + vol + forward│
    Albedo / Lobstr)       └────────────┬─────────────┘
                                        │ same quote
                  ┌─────────────────────┴─────────────────────┐
                  ▼                                            ▼
       ┌──────────────────────┐                  ┌────────────────────────┐
       │   SERVER RAIL        │                  │   SOROBAN RAIL         │
       │  Stellar Classic     │                  │  smart contract        │
       │                      │                  │                        │
       │ • distributor holds  │                  │ • contract escrows     │
       │   collateral         │                  │   collateral (SAC)     │
       │ • server pays premium│                  │ • premium paid atomic  │
       │ • DB position ledger │                  │   in deposit()         │
       └──────────┬───────────┘                  └───────────┬────────────┘
                  │                                          │
                  └──────────────┬───────────────────────────┘
                                 ▼
                  ┌──────────────────────────────┐
                  │  Reflector oracle (Soroban)  │
                  │  XLM/USD, price @ expiry      │
                  └──────────────────────────────┘`}</Pre>

        {/* 3 */}
        <H2 id="building-blocks">3. Stellar building blocks</H2>
        <P>
          Lusty is built from Stellar primitives end to end. Nothing in the
          settlement path is off-chain except the realized-volatility history
          used as a pricing input.
        </P>

        <H3>Soroban smart contracts</H3>
        <P>
          The vault is a Rust/Soroban contract (<Code>contracts/vault</Code>).
          It escrows collateral, pays premiums from a cash pool, and settles
          positions. It is deployed on testnet and its WASM is reproducible from
          source. See <a href="#contract" className="text-[#eab308] underline">section 4</a>.
        </P>

        <H3>Reflector oracle (the integration target)</H3>
        <P>
          Settlement price comes from <strong>Reflector</strong>, the Stellar
          ecosystem oracle. On the Soroban rail the vault makes a
          cross-contract call to Reflector&apos;s{' '}
          <Code>price(asset, timestamp)</Code>; on the server rail the same feed
          is read through Soroban RPC simulation. This is the building block the
          grant integrates against, and the integration is live, not planned.
          See <a href="#oracle" className="text-[#eab308] underline">section 5</a>.
        </P>

        <H3>Stellar Asset Contract (SAC)</H3>
        <P>
          Collateral and cash move as SAC tokens. The vault holds native XLM
          through its SAC (<Code>CDLZ…CYSC</Code>) and pays premiums in a cash
          SAC. The contract is cash-token agnostic: a constructor parameter
          selects the cash asset, so the same WASM runs with LUSD on testnet and
          Circle&apos;s native USDC on mainnet.
        </P>

        <H3>Stellar Classic: multisig, trustlines, payments</H3>
        <List>
          <li>
            <strong>Multisig.</strong> The LUSD issuer requires 2-of-3
            signatures for every operation, including minting. The distributor
            keeps payments hot (bounded by the deposit caps) and requires 2-of-3
            for any signer or threshold change.
          </li>
          <li>
            <strong>Trustlines.</strong> The server rail verifies a recipient
            holds the required trustline before any payout, and rejects
            otherwise instead of failing on-chain.
          </li>
          <li>
            <strong>Payments &amp; Horizon.</strong> Deposits are verified
            against Horizon: the server confirms the source account, destination
            and amount of the on-chain payment before recording a position.
          </li>
        </List>

        <H3>Soroban RPC</H3>
        <P>
          The server rail reads Reflector through Soroban RPC{' '}
          <Code>simulateTransaction</Code> — a free, read-only simulation that
          signs nothing and touches no key. This is what lets both rails share
          one oracle source code path.
        </P>

        {/* 4 */}
        <H2 id="contract">4. The Soroban vault</H2>
        <P>
          The contract closes the full money loop: escrow, premium, settlement.
        </P>
        <Pre>{`fund(from, amount)
    permissionless top-up of the cash pool

deposit(owner, amount, strike, expiry, premium) -> id
    • require_auth(owner)   writer signs the collateral transfer
    • require_auth(quoter)  the pricing engine co-signs the premium (RFQ)
    • escrow collateral (SAC) + pay premium from the pool — one atomic tx

settle(id) -> "kept" | "assigned"
    • permissionless; outcome is deterministic from the oracle
    • price@expiry  > strike -> assigned: collateral to treasury,
                                strike value paid to writer in cash
    • price@expiry <= strike -> kept: collateral returned whole`}</Pre>
        <P>
          Two design choices matter for trust. First, <strong>deposit is
          dual-authorized</strong>: the writer and the protocol&apos;s quoter
          key both sign, so neither can set the premium unilaterally — the
          on-chain equivalent of an RFQ quote. Custody and settlement never
          depend on the quoter. Second, <strong>settle is permissionless</strong>:
          anyone can trigger it because the outcome is fully determined by the
          oracle price at expiry, so a writer never depends on the protocol
          being online to get paid.
        </P>

        {/* 5 */}
        <H2 id="oracle">5. Reflector oracle integration</H2>
        <P>
          Settlement is pinned to the oracle price <strong>at the expiry
          timestamp</strong>, normalized to the feed&apos;s 300-second
          resolution. This is the core economic invariant: when the writer
          chooses to claim cannot change the outcome. Without it, a covered-call
          writer could wait for a post-expiry dip and always claim &quot;kept&quot;,
          dodging assignment and leaving the vault structurally unhedged.
        </P>
        <H3>Fail-closed price sourcing</H3>
        <P>
          Reflector retains roughly 24 hours of history. The price resolution is
          ordered so it is always expiry-pinned and never silently degrades to a
          live price:
        </P>
        <List>
          <li>
            <strong>Primary:</strong> Reflector{' '}
            <Code>price(XLM, expiry_period)</Code> — the historical record at
            the expiry minute.
          </li>
          <li>
            <strong>Prompt-claim fallback:</strong> the live{' '}
            <Code>lastprice</Code>, accepted only when the claim happens within
            the staleness window of expiry (before the period record is
            queryable). A late claim cannot use it.
          </li>
          <li>
            <strong>Durable fallback (server rail):</strong> the Binance 1-minute
            kline at the expiry minute — also expiry-pinned, retained
            effectively forever.
          </li>
          <li>
            <strong>Otherwise:</strong> the settlement is refused. The contract
            reverts; the server returns an error. No expired position is ever
            settled at a live price.
          </li>
        </List>
        <P>
          A stale or empty feed therefore blocks settlement rather than settling
          at a wrong price — the same fail-closed rule the contract and the
          server enforce identically.
        </P>

        {/* 6 */}
        <H2 id="flows">6. End-to-end flows</H2>
        <H3>Deposit (Soroban rail)</H3>
        <Pre>{`writer ──build tx──► deposit(owner, amount, strike, expiry, premium)
        │
        ├─ require_auth(owner)   + require_auth(quoter)
        ├─ token(collateral).transfer(owner -> contract)   [escrow]
        ├─ token(cash).transfer(contract -> owner, premium) [atomic payout]
        └─ store Position{open}, emit "deposit"
                                   ▼
                 premium is in the writer's wallet in the same ledger`}</Pre>
        <H3>Settlement (either rail)</H3>
        <Pre>{`anyone ──► settle(id)            (server: POST /api/vault/claim)
   │
   ├─ load Position; require expiry in the past; require not settled
   ├─ price = Reflector.price(XLM, expiry)          [expiry-pinned]
   │     └─ missing + late claim -> revert/refuse   [fail-closed]
   ├─ assigned (price > strike): collateral -> treasury,
   │                             strike value -> writer (cash)
   ├─ kept     (price <= strike): collateral -> writer
   └─ mark settled, emit "settle"`}</Pre>
        <P>
          On the server rail the same logic runs with replay protection: a
          unique-constraint ledger reserves the deposit hash before any payout,
          so a claim or swap cannot be replayed and one on-chain payment cannot
          fund both a deposit and a swap.
        </P>

        {/* 7 */}
        <H2 id="pricing">7. Pricing engine</H2>
        <P>
          One engine (<Code>src/lib/pricing-server.ts</Code>) prices everything
          the UI shows and everything the vault pays. There is no second
          adjustment layer, so the quoted number is the paid number.
        </P>
        <Pre>{`σ_realized  ← XLM price history (EWMA, RiskMetrics λ=0.94)
σ_offered   = σ_realized × 1.10 + 0.03      vol risk premium, capped 100%
F           ← forward from perp funding      (≈ spot for weeklies)
P_fair      = Black-76(side, F, K, T, σ_offered)
APR ladder  : nearest strike pinned to a time-scaled ceiling,
              farther strikes fall on the Black-76 gradient
× taper     : offered APR falls linearly with pool utilization
− fee       : 10% of the upfront, taken from the premium (not collateral)`}</Pre>
        <P>
          Two invariants are unit-tested: the user is never paid above the
          haircut fair value (the protocol keeps at least a 20% edge against its
          own Black-76 estimate), and no strike — including an off-ladder one a
          client might submit — can quote above the displayed ceiling. The
          forward carries cost-of-carry from perp funding rather than an assumed
          risk-free rate, and there is no fabricated volatility smile, because
          XLM has no listed options surface to read one from.
        </P>

        {/* 8 */}
        <H2 id="security">8. Security architecture</H2>
        <P>
          The money paths are server-canonical and fail-closed. Every item here
          is in source and most are covered by tests.
        </P>
        <List>
          <li>
            <strong>Server-recomputed premiums.</strong> The premium is computed
            from the quote engine; any premium or APR field a client sends is
            ignored.
          </li>
          <li>
            <strong>Server-canonical settlement.</strong> Strike, expiry, type
            and collateral at claim come from the recorded position, never from
            the claimant.
          </li>
          <li>
            <strong>Replay protection.</strong> A unique-constraint ledger
            covers deposit, claim and swap, including cross-endpoint reuse.
          </li>
          <li>
            <strong>Atomic capacity caps.</strong> Per-user (30-day), per-user
            per-expiry, per-strike and per-expiry caps are checked and reserved
            in one advisory-locked database transaction, so concurrent requests
            cannot overshoot them.
          </li>
          <li>
            <strong>Fail-closed everywhere.</strong> If the price feed, the
            database, the breaker state or the oracle is unavailable or stale,
            the operation is refused.
          </li>
          <li>
            <strong>Circuit breaker.</strong> Deposits halt automatically on a
            volatility spike (3× the daily baseline), on oracle stress (a 10%
            one-minute move or an unreachable feed), and on a per-epoch loss
            cap. A manual trip clears only by a human.
          </li>
          <li>
            <strong>Multisig.</strong> 2-of-3 on the issuer for every operation;
            2-of-3 on distributor signer/threshold changes.
          </li>
          <li>
            <strong>Tests.</strong> 48 unit tests on the pricing path (which
            caught a real CDF scaling bug) and 18 on the contract, including a
            mock Reflector oracle and a late-claim settlement-discretion test.
          </li>
        </List>

        {/* 9 */}
        <H2 id="plan">9. Integration plan &amp; tranches</H2>
        <P>
          Scope is narrowed to what one engineer can ship safely: the security
          rewrite, the Soroban migration, the Reflector integration, multisig,
          and a hardened testnet that can stand up to adversarial review. BTC
          multi-asset and Aquarius integration are out of this cycle.
        </P>
        <Next>
          <strong>Tranche 1 — security &amp; risk (complete in code).</strong>{' '}
          Server-recomputed premiums, server-canonical settlement, replay
          protection on claim and swap, fail-closed caps, the circuit breaker,
          and multisig. All verifiable in the commit history and covered by
          tests.
        </Next>
        <Next>
          <strong>Tranche 2 — custody on-chain.</strong> Point the web app&apos;s
          deposit flow at the deployed vault contract so collateral is escrowed
          by the contract rather than the distributor; add an in-contract
          premium ceiling and a multisig quoter to remove the pool-drain trust
          assumption; bring cash-secured puts into the contract; and run an
          independent audit before any mainnet path. On mainnet the cash asset
          is Circle&apos;s native USDC; LUSD is a testnet convenience token with
          no mainnet path.
        </Next>

        {/* 10 */}
        <H2 id="addresses">10. Deployed addresses (testnet)</H2>
        <Pre>{`Soroban vault (LUSD cash)  CAWDKJUH5WSXJVOOAUGULE4HY2TTYSXUSI5QXTDKUZ6J5L4UTXWPK2Y4
Soroban vault (USDC cash)  CASVHBJ7MOZ5YFSVAYXKZFWIYAR6Y3Q4JI2P6GGJMRFUJBZN6APTZEZD
Reflector oracle (CEX/DEX) CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63
XLM SAC (collateral)       CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
LUSD issuer (2-of-3)       GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6
LUSD distributor           GBAIN6CHZJGBL365JNXSRQEKALXYTWKXANQZ3RBM7AGUEYYKLJJ6SNR6`}</Pre>
        <P>
          Source, contract, and tests live in the project repository. The
          contract README documents the deploy command, the unit-test suite, and
          the end-to-end testnet settlement that has already run against the live
          Reflector feed.
        </P>

        <div className="mt-14 pt-6 border-t border-line flex items-center justify-between text-sm">
          <Link href="/docs" className="text-ink-2 hover:text-ink transition">
            ← Product docs
          </Link>
          <Link href="/earn" className="text-[#eab308] hover:underline">
            Open the app →
          </Link>
        </div>
      </article>
    </div>
  )
}
