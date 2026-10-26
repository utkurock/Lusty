
// The technical architecture, as a section of the documentation page.
// It used to be a page of its own at /architecture, which now points here.

// ── Small presentational helpers (server component, no client JS) ──────────
const H2 = ({ id, children }: { id: string; children: React.ReactNode }) => (
  <h2
    id={id}
    className="font-display scroll-mt-24 text-head-md text-ink mt-14 mb-4 pb-2 border-b border-line"
  >
    {children}
  </h2>
)
const H3 = ({ children }: { children: React.ReactNode }) => (
  <h3 className="font-display text-head-sm text-ink mt-7 mb-2">{children}</h3>
)
const P = ({ children }: { children: React.ReactNode }) => (
  <p className="leading-relaxed text-ink-2 my-3">{children}</p>
)
const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="px-1.5 py-0.5 bg-card border border-line rounded text-caption font-code text-ink">
    {children}
  </code>
)
const Pre = ({ children }: { children: React.ReactNode }) => (
  <pre className="scroll-slim bg-inverse text-cream p-4 rounded text-caption leading-relaxed overflow-x-auto my-4 font-code whitespace-pre">
    {children}
  </pre>
)
const List = ({ children }: { children: React.ReactNode }) => (
  <ul className="list-disc pl-5 space-y-2 my-3 text-ink-2 leading-relaxed">
    {children}
  </ul>
)
const Today = ({ children }: { children: React.ReactNode }) => (
  <div className="my-5 rounded-lg border-l-4 border-ink bg-card p-4 text-body leading-relaxed text-ink-2">
    <div className="font-mono text-tiny uppercase tracking-wider text-ink font-bold mb-1.5">
      Live today
    </div>
    {children}
  </div>
)
const Next = ({ children }: { children: React.ReactNode }) => (
  <div className="my-5 rounded-lg border-l-4 border-brand bg-card p-4 text-body leading-relaxed text-ink-2">
    <div className="font-mono text-tiny uppercase tracking-wider text-brand font-bold mb-1.5">
      This grant (Tranche 1–2)
    </div>
    {children}
  </div>
)

export const ARCHITECTURE_TOC: [string, string][] = [
  ['summary', '1. Summary'],
  ['rails', '2. How the pieces fit'],
  ['building-blocks', '3. Stellar building blocks'],
  ['contract', '4. The Soroban vault'],
  ['oracle', '5. Reflector oracle integration'],
  ['flows', '6. End-to-end flows'],
  ['pricing', '7. Pricing engine'],
  ['security', '8. Security architecture'],
  ['plan', '9. Integration plan & tranches'],
  ['addresses', '10. Deployed addresses'],
]

export function ArchitectureBody() {
  return (
    <>
        <p className="text-lg text-ink-2 leading-relaxed">
          An options-yield protocol on Stellar testnet: write covered calls and
          cash-secured puts on XLM or BTC, take the premium up front, and settle
          at expiry against the Reflector oracle. This is the system as it runs
          today and what the grant still covers.
        </p>

        <div className="mt-8 rounded-lg overflow-hidden border border-line bg-inverse text-cream aspect-[16/6] flex flex-col items-center justify-center font-mono">
          <div className="text-5xl tracking-[0.3em] font-bold">lusty</div>
          <div className="mt-4 text-caption tracking-[0.25em] text-brand">
            SOROBAN · REFLECTOR · STELLAR CLASSIC
          </div>
        </div>

        {/* 1 */}
        <H2 id="summary">1. Summary</H2>
        <P>
          A writer picks a strike and expiry and deposits collateral. One
          Soroban transaction escrows it in the vault contract and pays the
          premium. At expiry anyone can call <Code>settle(id)</Code>, which
          prices the position at Reflector&apos;s expiry reading and returns the
          collateral or assigns it at the strike. The server only prices: its
          quoter key co-signs premiums under an on-chain ceiling and cannot
          touch collateral or settlement. The contract is the source of truth;
          the database mirrors it.
        </P>
        <Today>
          Two vault v4 instances run from one wasm hash, an XLM book and a BTC
          book with LBTC collateral. Positions on both have settled end to end
          against the live Reflector feed, four of them from an unrelated
          account. The pre-custody operational book was settled in full and its
          payout route deleted, so no request path can move user collateral.
        </Today>

        {/* 2 */}
        <H2 id="rails">2. How the pieces fit</H2>
        <P>
          Pricing needs market data, so it runs off chain. Custody and
          settlement move money, so they run on chain. The server can shape a
          position&apos;s terms before it exists, never its outcome.
        </P>
        <Pre>{`  vol.ts ─┐
forward.ts├─► smile.ts ─► pricing.ts ─► pricing-server.ts   quote engine
          ┘                                    │
                                               ▼
      browser ──► /api/vault/quote ──────► displayed APR
         │
         │  writer picks a strike, wallet builds open()
         ▼
      /api/vault/authorize ──► quoter co-signs ONE auth entry
         │
         ▼
      vault contract: escrow + premium, one atomic transaction
         │
         ▼
      settle(id) ──► Reflector price AT EXPIRY ──► owner is paid`}</Pre>

        {/* 3 */}
        <H2 id="building-blocks">3. Stellar building blocks</H2>
        <P>
          The settlement path is entirely on chain. Only quote inputs come from
          off chain.
        </P>

        <H3>Soroban smart contracts</H3>
        <P>
          The vault (<Code>contracts/vault</Code>, Rust) escrows collateral,
          pays premiums from a cash pool and settles. Each underlying has its
          own instance, so books never share a pool.
        </P>

        <H3>Reflector oracle (the integration target)</H3>
        <P>
          The vault calls Reflector&apos;s <Code>price(asset, timestamp)</Code>{' '}
          on its book&apos;s feed; the server reads the same feed through
          Soroban RPC for spot and monitoring. The integration is live.
        </P>

        <H3>Stellar Asset Contract (SAC)</H3>
        <P>
          XLM (<Code>CDLZ…CYSC</Code>) and LBTC move as SAC collateral, LUSD as
          SAC cash. The cash token is a constructor parameter, so the same wasm
          runs on Circle&apos;s native USDC on mainnet.
        </P>

        <H3>Stellar Classic: multisig, trustlines, payments</H3>
        <List>
          <li>
            The vault admin is a 2-of-3 multisig, verified on testnet by a
            transaction rejected with one signature and accepted with two. The
            LUSD issuer needs 2 of 3 for every operation, minting included.
          </li>
          <li>
            The quoter refuses a BTC position whose writer lacks the LBTC
            trustline an assigned put would pay into.
          </li>
          <li>
            The swap desk and USDC bridge verify each funding payment on Horizon
            before paying out.
          </li>
        </List>

        <H3>Soroban RPC</H3>
        <P>
          Reads use <Code>simulateTransaction</Code>, which signs nothing. The
          earn flow also simulates <Code>open</Code> to find the auth entry the
          quoter must sign.
        </P>

        {/* 4 */}
        <H2 id="contract">4. The Soroban vault</H2>
        <P>
          Calls and puts share escrow, premium and settlement, and differ only
          in which token is escrowed and which side of the strike assigns.
        </P>
        <Pre>{`open(owner, kind, amount, strike, expiry, premium, quoter) -> id
    • require_auth(owner)   writer signs the collateral transfer
    • require_auth(quoter)  a member of the quoter set co-signs the premium
    • refuses a position over its limits, a premium over max_premium_bps
      of the collateral at the oracle price, or one the pools cannot cover
    • escrow collateral + pay premium from the cash pool, one atomic tx

settle(id) -> "kept" | "assigned"
    • permissionless; the outcome follows from the oracle price at expiry
    • call, price > strike -> collateral to treasury, strike value to writer
    • put,  price < strike -> cash to treasury, underlying at strike to writer
    • otherwise kept       -> collateral returned whole

fund / fund_underlying                  permissionless pool top-ups
set_limits, add_quoter, remove_quoter   admin only`}</Pre>
        <P>
          Opening needs both the writer and a quoter, so neither sets the
          premium alone, an on-chain RFQ. The quoter prices inside{' '}
          <Code>max_premium_bps</Code> (2,000, so 20% of collateral), which only
          the admin can widen, so the two are separate accounts. Settlement never
          consults a quoter, so writers get paid without the protocol online.
          There is no upgrade entrypoint: the code under an open position cannot
          change, and a fix means redeploying.
        </P>

        {/* 5 */}
        <H2 id="oracle">5. Reflector oracle integration</H2>
        <P>
          Settlement uses the price <strong>at the expiry timestamp</strong>,
          normalized to the feed&apos;s 300-second resolution, so settling later
          changes nothing. Otherwise a call writer could wait for a post-expiry
          dip and always claim &quot;kept&quot;.
        </P>
        <H3>Fail-closed price sourcing</H3>
        <List>
          <li>
            First, <Code>price(asset, expiry_period)</Code>, the expiry record.
            Reflector keeps about 24 hours of history.
          </li>
          <li>
            Before that record is queryable, <Code>lastprice</Code>, only if at
            most an hour old.
          </li>
          <li>Otherwise the call reverts. No expired position settles at a live price.</li>
        </List>
        <P>
          Opening a call follows the same rule, since its premium ceiling needs a
          price; puts, collateralized in cash, keep trading through an outage.
          The undeployed v5 stores each expiry price on chain at first
          settlement and releases an unpriced position as kept after 30 days.
        </P>

        {/* 6 */}
        <H2 id="flows">6. End-to-end flows</H2>
        <H3>Deposit</H3>
        <Pre>{`browser ──► /api/vault/quote        price the ladder, commit to nothing
writer picks a strike ──► simulate open() for its auth entries
        ──► /api/vault/authorize    re-price, check every argument,
                                    quoter signs one entry
wallet signs ──► open(owner, kind, amount, strike, expiry, premium, quoter)
        ├─ require_auth(owner) + require_auth(quoter)
        ├─ collateral: owner -> contract          [escrow]
        ├─ cash: contract -> owner, premium       [atomic payout]
        └─ store Position, emit event
                                   ▼
                 premium is in the writer's wallet in the same ledger`}</Pre>
        <P>
          The server re-prices and refuses more than 25 bps over a fresh quote,
          then checks the contract, function and all seven arguments byte for
          byte before signing. The signature lasts about eight minutes and
          Soroban&apos;s nonce stops replay. Collateral moves only on the
          writer&apos;s signature.
        </P>
        <H3>Settlement</H3>
        <Pre>{`anyone ──► settle(id)            (contract entrypoint, permissionless)
   │
   ├─ load Position; require expiry in the past; require not settled
   ├─ price = Reflector.price(feed, expiry)        [expiry-pinned]
   │     └─ missing or stale -> revert              [fail-closed]
   ├─ assigned: collateral -> treasury,
   │            other leg at the strike -> writer
   ├─ kept:     collateral -> writer
   └─ mark settled, emit "settle"`}</Pre>
        <P>
          No server takes part; the caller pays the fee and gains nothing. A
          runner (<Code>/api/cron/settle</Code>, every two hours) closes expired
          positions with no privilege anyone else lacks. It has a deadline: once
          Reflector prunes the expiry reading, about a day later, v4 fails
          closed and the collateral stays escrowed with no admin override, so
          the runner reports each position&apos;s deadline. The old server
          payout route, which could move user collateral, was deleted after its
          book was settled.
        </P>

        {/* 7 */}
        <H2 id="pricing">7. Pricing engine</H2>
        <P>
          One engine (<Code>src/lib/pricing-server.ts</Code>) prices what the UI
          shows and the vault pays, with no second adjustment layer.
        </P>
        <Pre>{`σ_realized ← price history (EWMA, RiskMetrics λ=0.94)
σ_atm      = min(σ_realized × 1.10 + 0.03, 1.00)
σ_strike   = σ_atm × ψ(z),  z = ln(K/F) / (σ_atm·√T)    smile shape
F          ← forward from perp funding                    (≈ spot for weeklies)
P_fair     = Black-76(side, F, K, T, σ_strike)
APR ladder : nearest strike pinned to 120% × min(1, days / ref),
             farther strikes scaled by their Black-76 ratio to it
× taper    : offered APR falls linearly with pool utilization, −50% at full
− fee      : 10% of the upfront, taken from the premium (never collateral)`}</Pre>
        <P>
          Black-76 sets the ladder&apos;s shape and policy its level. Tests hold
          two invariants: a writer is never paid above 80% of fair value, and
          no strike, even off-ladder, quotes above the displayed ceiling. The
          smile ψ is borrowed from Derive&apos;s BTC and ETH surfaces, since XLM
          has no options market. At current XLM volatility the 100% cap on σ_atm
          binds, so realized vol does not move the quote;{' '}
          <Code>docs/ARCHITECTURE.md</Code> lists this among known limits.
        </P>

        {/* 8 */}
        <H2 id="security">8. Security architecture</H2>
        <List>
          <li>
            Premiums are recomputed server side; client premiums are ignored,
            and the quoter signs only an entry matching what it priced.
          </li>
          <li>Settlement terms come from contract state, never the caller.</li>
          <li>
            The contract caps position size, per-expiry exposure, solvency and
            premium, even against a compromised server. Concentration policy
            (per wallet over 30 days, per wallet per expiry, per strike) needs
            off-chain history, so the quoter enforces it by declining to sign;
            racing requests can overshoot it by one position.
          </li>
          <li>A unique-constraint ledger blocks replayed deposit and swap proofs.</li>
          <li>An unavailable or stale feed, database, breaker or oracle refuses the operation.</li>
          <li>
            A circuit breaker halts deposits on a volatility spike (3× the 24h
            baseline), oracle stress (a 10% one-minute move or a dead feed) or a
            per-epoch loss cap. A manual trip clears only by hand.
          </li>
          <li>
            The admin and LUSD issuer are 2-of-3; admin, quoter and treasury are
            separate accounts.
          </li>
          <li>
            Unit tests cover pricing, the smile, expiries and the contract
            client (they caught a real CDF bug). The contract&apos;s Rust suite
            uses a mock Reflector and tests a late claim on pruned history.
          </li>
        </List>

        {/* 9 */}
        <H2 id="plan">9. Integration plan &amp; tranches</H2>
        <Next>
          <strong>Tranche 1, security and risk (complete).</strong>{' '}
          Server-recomputed premiums, canonical settlement terms, replay
          protection, fail-closed caps, the circuit breaker and multisig, all in
          the commit history with tests.
        </Next>
        <Next>
          <strong>Tranche 2, custody on chain (live on testnet).</strong> The
          contract escrows calls and puts; the premium ceiling and a rotatable
          quoter set bound the pricing key; the admin is 2-of-3; a runner
          settles. Milestone 1 added the BTC book, milestone 2 routes testnet
          USDC into LUSD for puts, and the adversarial window has been open
          since 2026-10-06 and stays open until mainnet. An independent audit
          precedes any mainnet path, where USDC replaces LUSD as cash.
        </Next>
        <P>
          Tranche 3: upgrade governance, position tokens, automated pool
          solvency, and recording which quoter priced each position.
        </P>

        {/* 10 */}
        <H2 id="addresses">10. Deployed addresses (testnet)</H2>
        <Pre>{`Soroban vault (XLM book)   CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ
Soroban vault (BTC book)   CBQEACXAOZMCU3YOUWDC3MWXDSQBWKNGKBA6XMRPY5D5JQRNP2HLMVEU
Reflector oracle (CEX/DEX) CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63
XLM SAC (collateral)       CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
LBTC SAC (collateral)      CDLI2GIDMYZQHK2K3TIGV5O2HQQRT36C5MV3IQWO6LX22YFTF43X74LU
LUSD SAC (cash)            CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB
LUSD issuer (2-of-3)       GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6
LUSD distributor           GBAIN6CHZJGBL365JNXSRQEKALXYTWKXANQZ3RBM7AGUEYYKLJJ6SNR6`}</Pre>
        <P>
          Both books run the same wasm and differ only in feed, collateral and
          limits. Treasury, admin, quoter, limits and how to read them off the
          chain are under{' '}
          <a href="/docs#deployments" className="text-brand hover:underline">
            deployed addresses
          </a>
          ; the contract README covers deployment, tests and the testnet
          settlements.
        </P>

    </>
  )
}
