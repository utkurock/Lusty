# Liquidity routing guardrails

What a routed swap may do, what stops it, and what happens when each guardrail fires.

---

## 1. What routing is for, and what it is not

A cash-secured put escrows only the `cash` token its vault instance was constructed with,
LUSD on every book. Routing converts between that and the stablecoin the writer picked.

Routing never touches a position: it moves a stablecoin before one exists or after it
closes, and cannot change a strike, expiry, premium or settlement price (§5 explains why
structurally).

For a USDC-funded put, the earn screen asks `/api/routing/swap` to `prepare` (quote,
reserve the book's in-flight capacity, build the path payment), the writer's wallet signs
and submits, and `settle` reads the operation back from Horizon, journaling the fill only if
the ledger shows this account receiving exactly this LUSD for the allowlisted USDC
(`lib/routing/session`). The route holds no float and signs nothing, so it has nothing to
drain.

The fallback, used only when the route refuses before the wallet is prompted (an empty or
off-par book), is the older bridge (`lib/cash-convert`, `/api/anchor/bridge`): the
distributor pays LUSD from its own float against USDC received. Its two steps are not
atomic, so a failure between them leaves money owed, recoverable by re-claiming the same
hash from the earn screen. A signed routed swap that fails moved nothing, and is reported
that way rather than retried through the bridge.

Testnet liquidity is ours: nothing else trades LUSD against USDC directly.
`scripts/seed-route-liquidity.mjs` keeps one distributor offer on the direct book, selling
up to 100,000 LUSD for USDC at exactly 1, first placed 2026-10-03. Re-running updates it in
place; re-placing it changes the offer id, so read the id off the
distributor's offers. It sells one way only, since selling USDC for faucet LUSD would be a
drain. The end-to-end run is in `docs/TESTNET-EVIDENCE.md`, "liquidity routing".

---

## 2. Decision 2, settled: path payments over both sources

The choice was the classic DEX orderbook or the AMM pools. We take both: Horizon's
strict-receive path finder searches resting offers and AMM pools in one query, and
`PathPaymentStrictReceive` executes across both. That is one code path, and the allowlist
is a set of approved asset hops, not a choice of market.

Pools alone would mean seeding and holding LP depth ourselves, depth an attacker could move
during the adversarial window. The orderbook alone has no LP exposure, but only whatever
depth is resting, which can vanish between quote and fill.

Strict-receive, because the escrow needs the exact cash amount the position is sized in;
strict-send would leave it short by however far the book moved.

---

## 3. The guardrails

In the order a swap meets them.

### 3.1 The allowlist — `lib/routing/allowlist.ts`

Anything not on the list is not a route.

| | |
|---|---|
| Declared routes | `usdc->lusd`, `lusd->usdc` |
| Allowed assets | LUSD and USDC, **by code AND issuer** |

Anyone can issue a token called USDC, so both ends of every route name the issuer. Every
intermediate hop is checked too: the path finder will take a two-offer token for a good
price, where the quote can evaporate before sending or the issuer can freeze the balance
mid-path.

*Fires:* `RouteRefused` with code `path_not_allowed`, naming the asset.

### 3.2 The hop bound

`maxHops`, default 0 (direct only). Between two dollars, needing an intermediate means the
direct book is empty, and then we do not trade. `ROUTING_MAX_HOPS` raises it.

*Fires:* `path_not_allowed`, saying how long the path was.

### 3.3 The notional ceiling

`maxNotional`, default 10,000 in the receive asset, per swap. Checked at quote time and
again when the transaction is built, since a caller can hold a quote.

*Fires:* `above_notional`.

### 3.4 The quote's age

`quoteMaxAgeMs`, default 30 s. Every quote records when it was taken. On a two-offer book,
a few seconds is long.

*Fires:* `stale_quote`. Re-quote; do not retry.

### 3.5 The slippage allowance → the send maximum

`maxSlippageBps`, default 50 bps.

The send maximum is derived, never supplied, because a caller-named maximum could fill at
any price. It is the quote times the allowance, rounded up to seven decimals; rounding down
would fail trades the route says it accepts.

The allowance is measured from the quote, so it does not bound price: a book whose only
offer prices LUSD at three USDC fills at three with no slippage. See §3.5a.

### 3.5a The par bound

`maxParDeviationBps`, default 100 bps, set only on routes between two assets that should
trade at par (today, both).

The quoted cost per unit received may sit at most this far from 1, either way. On
2026-10-03, before the direct offer was seeded, the only USDC to LUSD path ran through XLM
at 3.37 USDC per LUSD; the hop limit refused it, and this bound would have too.

*Fires:* `off_par`, saying how far from par the quote was.

### 3.6 The in-flight cap — `lib/routing/budget.ts`

`routedCapUsd`, declared per book: 50,000 for XLM, 15,000 for BTC.

Collateral is escrowed once its transaction lands, but a swap is in flight from build until
the ledger closes it. This caps how much of a book can be in flight.

Callers reserve before building and release when the swap resolves either way, so two swaps
built a second apart cannot both see an empty book. An unreleased reservation expires after
two minutes, so a crashed process cannot hold capacity until the next deploy.

Validation refuses a declaration whose `routedCapUsd` is below the book's `maxSizeCash`,
which would close the book to anyone converting a stablecoin.

*Fires:* `RoutingCapExceeded`, saying what is still available.

---

## 4. Why min-output is not a check

`PathPaymentStrictReceive` carries both bounds in the operation, a `sendMax` and an exact
`destAmount`: the network delivers exactly that amount for no more than the maximum, or
fails and nothing moves. There is no partial fill and no moment where money has left
before the check, which verifying output afterwards would allow. That is the case for
decision 2.

The network also walks exactly the operation's `path` (the quote's intermediates), so
§3.1's check binds at execution, not just at quote time.

---

## 5. Routing cannot reach a position's terms

Two independent reasons.

Structural: `settlement.ts`, `settlement-sweep.ts`, `settlement-scheduler.ts`,
`vault-contract.ts`, `reflector.ts` and `oracle-window.ts` have no import path to routing,
and routing imports nothing that could settle, price a premium or write a position.

Behavioural: strike, expiry, collateral and premium are fixed at write time in contract
storage, and nothing off chain can edit them. Settling takes an id, a signer and a book;
there is no argument a swap could change.

`routing-isolation.test.ts` asserts both, failing every routing step in turn and checking
the position is unchanged; testing only behaviour would miss structure about to break.

---

## 6. When something goes wrong

| Code | What happened | What to do |
|---|---|---|
| `invalid_amount` | Not a positive finite number | Caller bug |
| `above_notional` | More than one swap may carry | Split it, or raise `ROUTING_MAX_NOTIONAL` deliberately |
| `no_liquidity` | Nothing on the ledger fills it | Do not trade. Not a retry. |
| `path_not_allowed` | Every path offered went somewhere the route may not, or was too long | Check §3.1. If the market has genuinely moved to a new venue, the allowlist is what changes, as a commit, not a config toggle |
| `off_par` | The quoted price is more than the par bound from one for one | Do not trade. The book is thin or wrong; check the direct offer (§1) |
| `stale_quote` | The reading is older than the route stands behind | Re-quote |
| `unreachable` | The path finder did not answer | An outage, not a market condition. Retry later. |
| `routing_cap` | The book already has too much in flight | Wait for a swap to resolve; the error says how much is available |
| `not_filled` | Prepared, then never signed, refused by the network, or not on the ledger as prepared | Nothing moved; quote again |

None of these is recoverable by trying harder. `unreachable` is kept apart from an empty
book so a caller does not mistake an outage for a market condition and stop a working
service.

---

## 7. What is watched

`checkRouting` runs per book on every monitor pass, and `/api/health` reports
`components.routing` per book.

| Signal | Level | Why |
|---|---|---|
| In-flight ≥ 100% of the cap | **critical** | Conversions are being refused right now |
| In-flight ≥ 90% | warning | About to be |
| Worst realised slippage ≥ 90% of the allowance | warning | See below |
| ≥ 50% of attempts refused, over ≥ 4 attempts | warning | Named by kind, because the kinds have different owners |

The slippage signal matters most. A book filling repeatedly at the ceiling has no depth,
yet every such swap succeeded inside the bound, so only fills show it, never refusals.

Refusals are split by kind because `no_liquidity` every time is a market problem and
`path_not_allowed` every time is an allowlist behind the market, owned by different people.
A single refusal raises nothing; a market may be empty for a minute.

---

## 8. Known limitations

- The in-flight ledger and the journal are in memory, per process (as the rate limiter was
  before Postgres): they reset on deploy and do not span replicas. They bound an honest
  client on one process, not many swaps from many connections; the durable bound there is
  the per-swap notional ceiling, which concurrency cannot widen.
- The journal is an observation, not an accounting record. Nothing is decided from it, so
  losing it on a deploy costs visibility, not correctness; anything that must survive
  belongs in the transactions ledger.
- Realised slippage is recorded by whoever executes the swap. A caller that never records a
  fill hides it from the monitor, a reporting gap rather than a gap in the bounds.
- The routing bound is per book, not per wallet: one writer can hold a book's whole
  in-flight capacity for up to the reservation TTL. A nuisance on testnet; before mainnet it
  needs a per-wallet share too.

---

## 9. Configuration

| Key | Default | What it bounds |
|---|---|---|
| `ROUTING_MAX_SLIPPAGE_BPS` | 50 | How far below the quote a fill may land |
| `ROUTING_QUOTE_MAX_AGE_MS` | 30000 | How long a quote stays usable |
| `ROUTING_MAX_NOTIONAL` | 10000 | One swap, in the receive asset |
| `ROUTING_MAX_HOPS` | 0 | Intermediate assets a path may string together |
| `ROUTING_MAX_PAR_DEVIATION_BPS` | 100 | How far a stablecoin route's price may sit from 1 |
| `ROUTING_CAP_USD_<SYM>` | 50000 / 15000 | That book's in-flight ceiling |
| `MONITOR_ROUTING_WINDOW_MS` | 3600000 | How far back the monitor looks |
| `MONITOR_ROUTING_REFUSAL_WARN_PCT` | 50 | Refusal share that warns |

Adding a route means editing `ROUTES` in `lib/routing/allowlist.ts`. It is a reviewed
commit, not an environment variable a deployment could widen at runtime.
