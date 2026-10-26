# Architecture

The components, what each is responsible for, and where the security boundaries
between them fall. Key custody is in [`docs/SECURITY.md`](SECURITY.md) and the
contract in [`contracts/README.md`](../contracts/README.md); this document places
them in the system.

## The shape of it

```
  vol.ts ─┐
forward.ts├─► smile.ts ─► pricing.ts ─► pricing-server.ts    the quote engine
          ┘                                    │
                                               ▼
      browser ──► /api/vault/quote ──────► a displayed APR
         │
         │  user picks a strike, wallet builds open()
         ▼
      /api/vault/authorize ──► quoter co-signs ONE auth entry
         │
         ▼
      vault contract: escrow + premium, one atomic transaction
         │
         ▼
      settle(id) ──► Reflector price AT EXPIRY ──► owner is paid
```

Two rules hold throughout. The contract is the source of truth and wins on
anything economic, because it is what pays ([§8](#8-data-the-ledger-and-its-mirror)).
The server can shape a position's terms, never its outcome.

## 1. The pricing engine

`vol.ts` → `forward.ts` → `smile.ts` → `pricing.ts` → `pricing-server.ts`.
One engine prices what the UI shows and what the vault pays, with no second
adjustment layer.

### What is measurement, what is policy

```
F      ← Binance perp funding                     (forward.ts)   MEASUREMENT
σ_real ← XLM klines, EWMA λ=0.94                  (vol.ts)       MEASUREMENT
σ_atm  = min(σ_real×1.10 + 0.03, MAX_PRICING_SIGMA=1.0)          POLICY ceiling
z      = ln(K/F) / (σ_atm·√T)
σ_K    = σ_atm × ψ(z)                             (smile.ts)     MEASUREMENT (shape)
fair   = Black-76(side, F, K, T, σ_K)                            MATHEMATICS
───────────────────────────────────────── real pricing ends here
apr_self  = fair × (1 − 0.20) / capital × 365/days
apr_ref   = the same calculation for the NEAREST rung
targetTop = MAX_APR(120) × min(1, days / TIME_REF_DAYS)          POLICY
scale     = min(1, targetTop / apr_ref)
apr       = min(apr_self × scale, targetTop) × util_taper × (1 − fee)
```

`apr_ref` comes out around 800%; `targetTop` is 120. So the paid premium comes
from `MAX_APR`, not fair value. Black-76 enters only through the ratio
`apr_self / apr_ref`, making a further-out strike pay strictly less than a
nearer one, in the right proportion. The shape is mathematics; the level is
policy.

Two consequences:

- Delta and vega (see [Portfolio risk](#7-portfolio-risk)) are sensitivities of
  the fair value, not of the premium paid. A full pool halves what a writer
  receives and moves neither Greek.
- The protocol's edge is the gap between fair value and the capped payout
  (`protocolEdge`, bounded from below by the tests).

### Known limits, stated rather than found

`MAX_PRICING_SIGMA = 1.0` makes realized vol a dead input today.
`offeredVol(0.90) = 1.02 → 1.0` and `offeredVol(1.50) = 1.68 → 1.0`, so above
roughly 88% realized vol, σ_atm sits at the ceiling; the ladders for σ=90% and
σ=150% test identical, so in XLM's current regime `vol.ts` never reaches the
quote. The ceiling, meant to stop a transient spike setting the price, binds
all the time.

The vol markup points the wrong way. `σ_offered = σ_real × 1.10 + 0.03` marks vol
up, which suits a seller, but the protocol is buying. With the level pinned to
`MAX_APR` the markup only shapes the gradient, so it is harmless today; it must
be corrected if the level policy changes.

Neither costs anyone money as configured.

## 2. The quote path

`/api/vault/quote` → `/api/vault/authorize` → the contract.

`quote` prices the ladder and commits to nothing; `authorize` commits. Both
take an expiry and derive days-to-expiry and pool utilization from it through
`lib/quote-inputs.ts`, so the displayed and paid premiums are one computation.
The browser used to send both, and until the vault-stats poll landed its
utilization was a fabricated 0.68, a third off the real premium in the direction
the old one-sided check let through. The earn screen reprices the selected
strike just before building the transaction, so the encoded number is live.

The contract needs authorization from the writer and one of the protocol's
quoter keys, so neither sets the premium alone:

1. Simulate `open` to learn which authorization entries it needs.
2. Send them to `/api/vault/authorize`. The server re-derives the premium from
   the engine, ignoring the client's number, and refuses to co-sign a request
   more than `PREMIUM_SLIPPAGE_BPS` (default 25 bps of the premium) above the
   fresh quote, since the two spot readings are seconds apart. That allowance is
   the worst-case overpayment per position, bounded again on chain by
   `max_premium_bps` of the collateral.
3. The server signs exactly one entry, the quoter's.
4. Rebuild the transaction with that signature, re-simulate for the larger
   footprint, and assemble.
5. The wallet signs, authorizing the writer's side.
6. Submit.

Collateral moves only at step 5, which only the user can sign.

### The part that makes it safe: `describeMismatch`

An attacker could get an honest quote for a small position, then present an
entry from a different call and collect a quoter signature on it. So the server
first checks the contract id, function name and all seven arguments byte for
byte against what it verified:

```
owner · side · collateral · strike · expiry · premium · quoter
```

A mismatch returns a 409 naming the argument. The seventh is the quoter's own
address: since v4 the transaction names the key it expects to co-sign, and the
contract checks that the key is in its set and authorized that exact call.

The signature expires after `sequence + 100` ledgers, about eight minutes.
Soroban handles replay: every `SorobanCredentials::Address`
carries a nonce and an expiration ledger, and the host rejects reuse. We keep no
nonce store of our own.

## 3. The contract

Calls and puts share the escrow, premium and settlement machinery and differ
only in which token is escrowed and which is paid out. `obligation()`, what the
vault may owe a position, is one formula used to reserve at open and to pay at
settlement, so the solvency guard cannot drift from what it guards. Entrypoints,
escrow symmetry, error codes and roles are in
[`contracts/README.md`](../contracts/README.md).

It is the one component that need not trust the others: if the engine is wrong,
the server compromised or the database lost, an existing position still settles
at the oracle's expiry price and pays its owner.

There is no `upgrade` entrypoint (deliberate, deferred to Tranche 3), so nobody,
including us, can change behaviour under a written position. A change needs a
new deployment and migration, and a retired instance keeps what is left in its
pools.

## 4. Caps live in two places, and the split is the interesting part

### Enforced by the contract — trustless

These hold even if this server is fully compromised.

| Cap | What it bounds |
| --- | --- |
| `max_position_{call,put}` | The size of any single position |
| `max_expiry_{call,put}` | How much of the book may come due on one date |
| Pool solvency | Refuses a position the pools could not settle |
| `max_premium_bps` | The largest premium a quoter may sign, as a share of collateral valued at the **oracle** price |

### Enforced by the quoter — by declining to sign

| Cap | What it bounds |
| --- | --- |
| Per-wallet 30-day notional | Concentration in one wallet over time |
| Per-wallet per-expiry allowance | Concentration in one wallet on one date |
| Per-strike inventory | How much the protocol wants against a single strike |

These live in [`src/lib/quote-policy.ts`](../src/lib/quote-policy.ts) and cannot
move on chain: a contract sees one call at a time, not a wallet's thirty-day
history. Without a quoter signature a position cannot open, so a refusal is as
final as a revert. A compromised quoter key could skip this policy but not
exceed the contract's caps, which is why limits whose violation would cost money
sit in the trustless tier.

### The race in the quoter's tier

The policy checks read and reserve nothing, so two simultaneous quote requests
can both pass and overshoot a per-wallet allowance by at most one position. A
nonce does not help, since both quotes are honest, not replays. Fixing it means
the quoter recording what it signs, a write that brings back the pending-row
bookkeeping this rail was built to drop. The overshoot is accepted: one position
per race, inside contract caps that hold regardless.

## 5. The oracle

Settlement reads Reflector at the expiry timestamp, not when `settle` is called,
so a covered-call writer cannot wait for spot to dip below the strike and claim
"kept". A missing feed, or one over an hour stale, fails closed. Reflector keeps
only about a day of history, so a late settlement finds the reading gone
([§6](#6-settlement)).

Since v4 a feed outage splits the legs:

- Calls need a fresh feed to open: the premium ceiling is a share of collateral
  valued at spot, so with no price the write fails closed.
- Puts keep trading: their collateral is already cash.

Binance supplies only quote inputs (realized vol history and perp funding),
never a settlement price.

## 6. Settlement

`settle(id)` is permissionless. The contract checks no caller identity, prices
the outcome from the oracle reading at expiry, and pays the owner. The caller
pays the fee and gets no payout, fee share or privilege. Four positions were
settled on chain from an account unrelated to the writer, quoter, admin and
treasury, which ended down only its fees
([`contracts/README.md`](../contracts/README.md#permissionless-settlement-verified-on-chain-2026-07-30)).

### Settlement expires

Permissionless does not mean indefinite. The contract needs Reflector's reading
for the expiry period, and Reflector keeps a ring buffer: on testnet the reading from 20 hours back was available and the one from 22 hours
back was gone. The only fallback, the live price, is limited to within an hour
of expiry, so late settlement cannot restore timing discretion. Once the period
is pruned, `settle` fails closed for good, with no admin override or upgrade
path, and the collateral stays escrowed (verified against the live feed).

So the sweep has a deadline: anyone may settle, but somebody must within about
a day. `/api/cron/settle` reports each due position with its deadline and lists
those past it separately, since a stale-price failure inside the window and one
outside it look alike but need opposite responses. A writer
self-settle button on the dashboard would make the runner optional (tracked for
a later tranche).

### The schedule

`/api/cron/settle` was written for a `vercel.json` cron entry, but the app runs
on self-hosted Coolify, which ignores that file. It appeared to schedule two jobs
and scheduled nothing, so it was removed. The schedule now lives with the deployment
([README](../README.md#scheduled-jobs)). The runner key has no standing with the
contract;
[`src/lib/__tests__/settlement-scope.test.ts`](../src/lib/__tests__/settlement-scope.test.ts)
pins that its transaction calls `settle` with one argument and no authorization
entries.

Positions are indexed by owner, not state, so the sweep walks ids from 0 to
`nextId`, which grows with every position ever opened. Each run is bounded and
reports where it stopped and how much it left unexamined.

## 7. Portfolio risk

`/api/vault/portfolio` aggregates a wallet's open positions and re-prices them
against live data.

Every Greek describes the writer: the engine's holder-side Greeks are negated
exactly once, in [`src/lib/portfolio.ts`](../src/lib/portfolio.ts), so a wallet
that sold calls carries negative delta.

Call and put collateral (XLM and cash) are never summed in any response field.

Vega uses each strike's own σ (sticky-strike), not σ_atm, which would need the
smile's derivative too. Reading one as the other overstates a parallel vol
shock.

## 8. Data: the ledger and its mirror

Positions live in contract state, indexed by owner and readable by anyone from
any device, even without this server and database. The database holds the APR
published at deposit time and transaction hashes; routes fall back to it when
the contract is unreachable and say so. The contract wins
any disagreement, without exception: the pre-custody book held in an
operational account has been settled in full and its payout route removed
([`docs/SECURITY.md`](SECURITY.md#what-is-still-custodial)).

## Known limits, in one place

| Limit | Where |
| --- | --- |
| The paid premium is set by `MAX_APR` policy, not by Black-76 fair value | [§1](#1-the-pricing-engine) |
| `MAX_PRICING_SIGMA` is currently binding permanently, making realized vol a dead input | [§1](#known-limits-stated-rather-than-found) |
| The vol markup points the wrong way for a buyer, harmless only because the level is pinned | [§1](#known-limits-stated-rather-than-found) |
| Concentration policy can be overshot by one position under a race | [§4](#the-race-in-the-quoters-tier) |
| Concentration policy is off-chain and a compromised quoter can decline to apply it | [§4](#enforced-by-the-quoter--by-declining-to-sign) |
| No `upgrade` entrypoint: fixing the contract means redeploying and migrating | [§3](#3-the-contract) |
| Losing the admin key has no in-contract recovery | [`SECURITY.md`](SECURITY.md#if-a-key-is-lost) |
