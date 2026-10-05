# Liquidity routing guardrails

What a routed swap is allowed to do, what stops it, and what happens when each
guardrail fires.

---

## 1. What routing is for, and what it is not

A cash-secured put escrows **one** token: the `cash` address its vault instance was
constructed with, which is LUSD on every book. That is fixed at the instance's
construction, so "escrow my USDC instead" is not something the contract can be asked.

What a writer means by it is answerable, though: the balance that leaves their wallet
should be the stablecoin they picked. Crossing one into the other is what routing is.

**Routing never touches a position.** It moves a stablecoin before a position exists and
it moves one after a position has closed. It cannot change a strike, an expiry, a premium
or a settlement price, and §5 is about why that is structural rather than a promise.

**Where it runs.** A put funded in USDC takes the route first: the earn screen asks
`/api/routing/swap` to `prepare` (quote, reserve the book's in-flight capacity, build the
path payment), the writer's wallet signs and submits it, and `settle` reads the operation
back from Horizon and journals the fill only if the ledger shows this account receiving
exactly this LUSD for the allowlisted USDC (`lib/routing/session`). The route holds no
float and signs nothing, so it has nothing to drain.

There is a second, older way to cross: the distributor pays LUSD out of its own float
against USDC it received (`lib/cash-convert`, the bridge at `/api/anchor/bridge`). It is
now the fallback, taken only when the route refuses **before** the wallet is prompted —
an empty or off-par book. The difference is what fails: the bridge is two steps and not
atomic, so a failure between them is money **owed**, recoverable by re-claiming the same
hash from the earn screen. A routed swap has no such state; one that was signed and failed
moved nothing, and is reported as that rather than retried through the bridge.

**Testnet liquidity is ours.** Nothing else trades LUSD against USDC directly, so
`scripts/seed-route-liquidity.mjs` keeps one distributor offer on the direct book: up to
100,000 LUSD sold for USDC at exactly 1, first placed 2026-10-03. Re-running the script
updates it in place; withdrawing and re-placing it gives it a new offer id, so read the id
off the distributor's offers rather than from here. One direction only — an offer selling
USDC for faucet LUSD would be a drain. The run that exercised this book end to end is in
`docs/TESTNET-EVIDENCE.md`, "liquidity routing".

---

## 2. Decision 2, settled: path payments over both sources

The question was which venue LUSD/USDC routing goes through — the classic DEX orderbook or
the AMM pools. The answer is **neither, separately**: Horizon's strict-receive path finder
already traverses resting offers *and* AMM pools in one query, and
`PathPaymentStrictReceive` executes across both.

So there is no venue to pick, one code path, and the allowlist becomes a set of approved
asset hops rather than a choice of market.

The two alternatives were rejected for the same reason in opposite directions. **AMM pools
only** means holding the LP position ourselves and seeding depth we control — which is
also depth an attacker can move, and the adversarial window is next. **Orderbook only**
means no LP exposure but depth that is whatever is resting, and it can vanish between the
quote and the fill.

**Strict-receive, not strict-send.** The writer needs an exact amount of cash to escrow —
the position is sized in it — so the fixed side is the output and the question is what it
costs. Strict-send answers a different question and would leave the escrow short by
whatever the book moved.

---

## 3. The guardrails

Five, in the order a swap meets them.

### 3.1 The allowlist — `lib/routing/allowlist.ts`

**Anything not on the list is not a route.** Not "is a worse route" — is not one.

| | |
|---|---|
| Declared routes | `usdc->lusd`, `lusd->usdc` |
| Allowed assets | LUSD and USDC, **by code AND issuer** |

An asset code is not an identity. Anyone can issue a token called USDC, and a route keyed
on the code alone would send a writer's dollars into whatever was minted this morning.
Both ends of every route name the issuer.

**Every intermediate hop is checked too.** A path is only as trustworthy as the least
trustworthy asset in it, and the path finder will happily route through a two-offer token
if the price is good — where the quote evaporates between being read and being sent, or
the issuer freezes the balance mid-path.

*Fires:* `RouteRefused` with code `path_not_allowed`, naming the asset.

### 3.2 The hop bound

`maxHops`, default **0** — direct only.

Both ends are dollars. A path that needs an intermediate to cross two dollars is telling
you the direct book is empty, and the right answer to that is to not trade rather than to
go around. Raise it with `ROUTING_MAX_HOPS` if a deployment genuinely needs to.

*Fires:* `path_not_allowed`, saying how long the path was.

### 3.3 The notional ceiling

`maxNotional`, default **10,000** in the receive asset, per swap. Checked at quote time
and **again** when the transaction is built — a quote is an object a caller can hold, and
the bound has to hold at the moment of signing.

*Fires:* `above_notional`.

### 3.4 The quote's age

`quoteMaxAgeMs`, default **30 s**.

A quote is a reading, and readings go off. Every one carries the instant it was taken so
whatever spends it can ask how old it is rather than trusting that not much happens in a
few seconds. On a two-offer book, a few seconds is the whole story.

*Fires:* `stale_quote`. Re-quote; do not retry.

### 3.5 The slippage allowance → the send maximum

`maxSlippageBps`, default **50 bps**.

**The send maximum is derived, never supplied.** A caller that could name its own maximum
could name one that fills at any price, which is the same as having no bound. It is the
quote times the allowance, rounded **up** to seven decimals — rounding a ceiling down would
make it tighter than the route declares and fail trades the desk said it would take.

What fifty basis points does **not** bound is the price. It is measured from the quote, so
a book whose only offer prices LUSD at three USDC quotes three and fills three with no
slippage at all. That is §3.5a's job.

### 3.5a The par bound

`maxParDeviationBps`, default **100 bps**, set only on routes between two assets that
should trade at par — today both of them.

The quoted cost per unit received may sit at most this far from 1, in either direction. A
stablecoin quoted well below par on a thin book is the same warning as one quoted above
it. Checked 2026-10-03, before the direct offer was seeded: the only path from USDC to LUSD
ran through XLM at 3.37 USDC per LUSD. The hop limit refused it; this would have too.

*Fires:* `off_par`, saying how far from par the quote was.

### 3.6 The in-flight cap — `lib/routing/budget.ts`

`routedCapUsd`, declared **per book**: 50,000 for XLM, 15,000 for BTC.

Routing is the one thing a writer does here that is neither escrowed nor instant. A
position's collateral is in the contract the moment the transaction lands; a swap is in
flight from when it is built until the ledger closes it, and during that window the money
is neither where it was nor where it is going. This bounds how much of a book can be in
that state.

**Reserve, then release.** A bound checked and then forgotten is no bound: two swaps built
a second apart would each see an empty book. A caller reserves before building and releases
when the swap resolves, either way. A reservation nobody releases **expires after two
minutes**, so a process that crashed mid-swap does not hold a book's capacity hostage until
the next deploy.

Validation refuses a declaration whose `routedCapUsd` is below the book's `maxSizeCash` — a
bound one position's cash could not fit inside is a book quietly closed to anyone
converting a stablecoin.

*Fires:* `RoutingCapExceeded`, which says what is still available rather than only that it
refused.

---

## 4. Why min-output is not a check

`PathPaymentStrictReceive` carries both bounds in the operation: a `sendMax` and an exact
`destAmount`. The **network** either delivers exactly the destination amount for no more
than the maximum, or the operation fails and nothing moves. No partial fill. No window in
which the send has happened and the check has not run yet.

That is the whole argument for decision 2. A swap whose output is verified *afterwards* has
a state where the money has left and the result is worse than quoted, and the only thing to
do about it is write it down.

The `path` in the operation is the intermediates the quote was taken over, and it is not a
suggestion — the network walks exactly that path. Which is what makes §3.1's check binding
at execution time rather than advisory at quote time.

---

## 5. Routing cannot reach a position's terms

The milestone's sharpest criterion, and there are two independent reasons.

**Structural.** Nothing on the settlement path imports routing —
`settlement.ts`, `settlement-sweep.ts`, `settlement-scheduler.ts`, `vault-contract.ts`,
`reflector.ts` and `oracle-window.ts` all have no path to it. And the reverse: routing
imports nothing that could settle, price a premium, or write a position. There is no call
path along which an outcome could travel.

**Behavioural.** A position's terms are read from the **contract**, which is a different
authority entirely. Strike, expiry, collateral and premium were fixed at write time, live in
contract storage, and nothing off chain can edit them. Settling takes an id, a signer and a
book — there is no third argument a swap could have changed.

`routing-isolation.test.ts` asserts both, and makes every routing step fail in turn while
checking the position is what it was. Testing only the second would pass on a system where
the first was about to become false.

---

## 6. When something goes wrong

| Code | What happened | What to do |
|---|---|---|
| `invalid_amount` | Not a positive finite number | Caller bug |
| `above_notional` | More than one swap may carry | Split it, or raise `ROUTING_MAX_NOTIONAL` deliberately |
| `no_liquidity` | Nothing on the ledger fills it | Do not trade. Not a retry. |
| `path_not_allowed` | Every path offered went somewhere the route may not, or was too long | Check §3.1. If the market has genuinely moved to a new venue, the allowlist is what changes — as a commit, not a config toggle |
| `off_par` | The quoted price is more than the par bound from one for one | Do not trade. The book is thin or wrong; check the direct offer (§1) |
| `stale_quote` | The reading is older than the route stands behind | Re-quote |
| `unreachable` | The path finder did not answer | An outage, not a market condition. Retry later. |
| `routing_cap` | The book already has too much in flight | Wait for a swap to resolve; the error says how much is available |
| `not_filled` | Prepared, then never signed, refused by the network, or not on the ledger as prepared | Nothing moved; quote again |

None of these is recoverable by trying harder. An unreachable path finder is deliberately
distinguished from an empty book, because a caller that conflated the two would read an
outage as a market condition and stop offering a service that was fine.

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

**The slippage one is the one that matters**, and it is the reason the monitor reads fills
rather than refusals. A book filling repeatedly at the ceiling has no depth in it — and
every one of those swaps *succeeded*, inside the bound, refusing nothing. The refusals
would never mention it.

The refusal mix is split by kind for the same reason: `no_liquidity` every time is a market
problem, `path_not_allowed` every time is an allowlist that has fallen behind the market,
and those need different people.

A single refusal raises nothing. A market is allowed to be empty for a minute.

---

## 8. Known limitations

- **The in-flight ledger and the journal are in memory, per process.** The weakness the
  rate limiter had before it moved to Postgres, and published as a limitation rather than described as a guarantee: they
  reset on deploy and do not exist across replicas. They bound an honest client and a
  single-process deployment. What they are not is a defence against somebody deliberately
  opening many swaps from many connections — the durable bound behind that is the route's
  per-swap notional ceiling, which no amount of concurrency widens.
- **The journal is an observation, not an accounting record.** Nothing is decided from it,
  so losing it on a deploy costs a window of visibility rather than correctness. Anything
  that has to survive belongs in the transactions ledger.
- **Realised slippage is recorded by whoever executes the swap.** A caller that never
  records a fill leaves the monitor blind to it, which is a coverage gap in the reporting
  and not in the bounds.
- **The routing bound is per book, not per wallet.** One writer can occupy a book's whole
  in-flight capacity for up to the reservation TTL. On testnet that is a nuisance; before
  mainnet it wants a per-wallet share as well.

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

Adding a route is a change to `ROUTES` in `lib/routing/allowlist.ts` — deliberately a
commit and not an environment variable. An allowlist a deployment can widen at runtime is
an allowlist whose contents nobody reviewed.
