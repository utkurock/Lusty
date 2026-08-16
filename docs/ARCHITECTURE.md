# Architecture

The components, what each is responsible for, and where the security boundaries
between them fall.

Companion documents: [`docs/SECURITY.md`](SECURITY.md) for key custody, and
[`contracts/README.md`](../contracts/README.md) for the contract itself. This
document does not repeat either — it explains where each sits in the system.

---

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

Two things run through the whole system and are worth holding on to:

**The contract is the source of truth.** The database is a mirror, useful for
what the ledger does not record — the APR published at deposit time, the
transaction hashes. Where the two disagree about anything economic, the contract
wins, because the contract is what pays.

**The server can shape a position's terms, never its outcome.** Everything below
is an elaboration of where that line is drawn.

---

## 1. The pricing engine

`vol.ts` → `forward.ts` → `smile.ts` → `pricing.ts` → `pricing-server.ts`.
One engine prices what the UI shows and what the vault pays; there is no second
adjustment layer.

### What is measurement, what is policy

This distinction matters more than any other in this document, and it is the one
most likely to be misread.

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

**`apr_ref` comes out in the 800% range. `targetTop` is 120.** So the absolute
premium a writer is paid is not the option's fair value — it is a number derived
from `MAX_APR`. Black-76 enters the paid premium only through the ratio
`apr_self / apr_ref`, which is to say as the *relative* difference between
rungs.

**The shape is mathematics. The level is policy.**

Writing "we price with Black-76" without that qualification would be misleading,
so this document does not. What Black-76 genuinely determines is that a
further-out strike pays strictly less than a nearer one, by the right
proportion. What sets the headline number is a configured ceiling.

Two consequences follow, and both are load-bearing when reading the rest of the
system:

- Delta and vega (see [Portfolio risk](#7-portfolio-risk)) are sensitivities of
  the **fair value**, not of the premium actually paid. A full pool halves what
  a writer receives and does not move either Greek.
- The protocol's edge is not "Black-76 minus a haircut" in any pure sense. It is
  whatever the gap between fair value and a policy-capped payout happens to be,
  which the engine reports as `protocolEdge` and the tests bound from below.

### Known limits, stated rather than found

**`MAX_PRICING_SIGMA = 1.0` currently produces a dead input.**
`offeredVol(0.90) = 1.02 → 1.0` and `offeredVol(1.50) = 1.68 → 1.0`. So as long
as realized vol is above roughly 88%, σ_atm is pinned at the ceiling and does
not move. Tested and confirmed: the ladders for σ=90% and σ=150% come out
identical. In XLM's current regime, `vol.ts`'s output does not reach the quote at
all. The ceiling exists to stop a transient spike from setting the price; right
now it is binding permanently rather than exceptionally.

**The vol markup is conceptually backwards.**
`σ_offered = σ_real × 1.10 + 0.03` is a markup, which is the correct direction
when *selling* an option — sell rich. The protocol is *buying*. Because the
level is currently pinned to `MAX_APR`, the markup never reaches the payout and
only shapes the gradient, so it is harmless in practice today. If the level
policy ever changes, this has to be corrected with it.

Neither of these is a bug that costs anyone money as the system is configured.
Both are recorded here because a limit that is known and written down is worth
considerably more than one that is discovered.

---

## 2. The quote path

`/api/vault/quote` → `/api/vault/authorize` → the contract.

`quote` is a read: it prices the ladder and returns what the UI renders. It
commits to nothing. `authorize` is where the protocol puts its name to a number.

Both are asked the same question — **by expiry**. Days-to-expiry and pool
utilization are the two inputs derivable from an expiry, and both routes derive
them through `lib/quote-inputs.ts` rather than accepting them from the caller.
That is what makes the displayed premium and the paid premium the same
computation instead of two computations that usually agree: before it, the
browser sent its own tenor and its own utilization, and until the vault-stats
poll landed the latter was a fabricated 0.68 — a third off the real premium, in
the direction the old one-sided check waved through. The earn screen also
reprices the selected strike immediately before building the transaction, so the
number encoded is live rather than however old the ladder on screen is.

The contract requires authorization from **both** the writer and one of the
protocol's quoter keys, so neither side sets the premium alone. Producing both
signatures takes a round trip:

1. Simulate `open` to learn which authorization entries it needs.
2. Send those entries to `/api/vault/authorize`. The server **re-derives the
   premium from the engine** — it never takes the client's number. The two
   readings of spot are taken seconds apart, so a request may sit above the
   fresh quote by at most `PREMIUM_SLIPPAGE_BPS` (default 25 bps of the
   premium); further above it and the server refuses to co-sign. That allowance
   is the protocol's worst-case overpayment on one position, and it is bounded
   again on chain by `max_premium_bps` of the collateral behind it.
3. The server signs **exactly one entry**: the quoter's. It does not touch the
   writer's.
4. Rebuild the transaction carrying that signature, simulate again to price the
   now-larger footprint, and assemble.
5. The wallet signs the transaction, authorizing the writer's side.
6. Submit.

Collateral moves only on step 5, and only the user can make that signature.

### The part that makes it safe: `describeMismatch`

Between verifying a quote and signing an entry there is a gap an attacker would
otherwise walk through: request an honest quote for a small, sensible position,
then present an authorization entry belonging to a *different* call and collect a
valid quoter signature on it.

Before signing, the server proves the entry in its hand is the one it just
verified — same contract id, same function name, and all **seven** arguments
compared byte for byte:

```
owner · side · collateral · strike · expiry · premium · quoter
```

A mismatch on any of them is a 409, named by which argument differed. Without
this check the co-signature would attest to nothing in particular. The seventh
argument is the quoter's own address: since v4 the transaction has to name which
key it expects to co-sign, and the contract verifies that key is in its set
**and** authorized that exact call.

The signature is also time-bounded: `sequence + 100` ledgers, roughly eight
minutes. Soroban's auth layer supplies replay protection on top of that — every
`SorobanCredentials::Address` carries a nonce and an expiration ledger, and the
host rejects reuse. We do not maintain a nonce store of our own; doing so would
reimplement the host's job less well.

---

## 3. The contract

Two legs, one machine. Both share the escrow, premium and settlement machinery
and differ only in which token is escrowed and which is paid out. The whole of
`obligation()` — what the vault may owe a position — is one formula used both to
reserve at open and to pay at settlement, so the solvency guard cannot drift
from the thing it guards.

[`contracts/README.md`](../contracts/README.md) documents the entrypoints, the
escrow symmetry, the error codes and the roles. It is not repeated here.

Its place in the system: **it is the only component whose correctness the rest
does not have to be trusted for.** The pricing engine can be wrong, this server
can be compromised, the database can be lost — and a position that already
exists still settles at the oracle's expiry price and still pays its owner. That
is the property the whole design is arranged around, and everything called a
"boundary" in this document is a statement about what stays true when something
on the server side does not.

There is no `upgrade` entrypoint. That is deliberate and deferred to Tranche 3:
it means nobody, including us, can change the contract's behaviour under a
position that has already been written. The cost is that a change requires a new
deployment and a migration, and a retired instance keeps whatever is left in its
pools.

---

## 4. Caps live in two places, and the split is the interesting part

If only one thing from this document survives, it should be this one, because
nothing in the code announces it.

### Enforced by the contract — trustless

Hold even if this server is fully compromised.

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

These are in [`src/lib/quote-policy.ts`](../src/lib/quote-policy.ts), and they
**cannot be moved on chain**. Not because of effort — because they depend on
off-chain history the contract has no view of. A contract cannot ask "how much
has this wallet deposited in the last thirty days"; it sees one call at a time.
Enforcement is refusal: without a quoter signature the position cannot open, so
a refusal is as final as a revert.

**This is a boundary, not a shortfall.** But it does have a consequence worth
being plain about: a compromised quoter key can decline to enforce concentration
policy. What it cannot do is exceed the contract's caps, which is why the two
tiers are drawn where they are — the trustless tier holds the limits whose
violation would actually cost money.

### The race in the quoter's tier

The policy checks read; they reserve nothing. Two quote requests arriving
together can both read the same history and both pass, overshooting a per-wallet
allowance by at most one position.

A nonce does not fix this — the two quotes are distinct and honest, not replays.
Fixing it properly means the quoter writing down what it signs, so an
outstanding signature counts against the allowance before the position exists on
chain. That is a write, and it reintroduces the pending-row bookkeeping this
rail was built to shed.

So the overshoot is accepted rather than pending. It is bounded at one position
per race, and the contract's caps hold regardless, which puts the worst case
inside limits that do not depend on this server being correct.

---

## 5. The oracle

Settlement reads Reflector at the **expiry timestamp**, not at the moment
someone calls `settle`. Timing gives the writer no discretion: a covered-call
writer cannot wait for spot to dip below the strike and claim "kept". A feed
that is missing or stale beyond an hour fails closed — the contract reverts
rather than settling on a guess. The same property has a consequence in the
other direction, since Reflector keeps only about a day of history: settle late
enough and the reading is gone, which [§6](#6-settlement) covers.

Since v4 there is an asymmetry worth knowing when a feed goes down:

- **Calls need a fresh feed to open.** The premium ceiling is a share of
  collateral valued at spot, so with no current price there is no honest way to
  value what is being escrowed, and the write fails closed.
- **Puts keep trading through a feed outage.** Their collateral is already cash,
  so the ceiling needs no price.

Binance appears in this system only as a *quote input* — realized vol history
and perp funding. It never touches a settlement price. That separation is
deliberate: the number that decides who gets paid comes from an on-chain oracle
that anyone can read, and the number that decides what we offer comes from
market data that only has to be reasonable.

---

## 6. Settlement

`settle(id)` is permissionless. The contract checks no caller identity, prices
the outcome from the oracle reading at expiry, and pays the position's owner.
The caller pays the transaction fee and receives nothing — no payout, no fee
share, no privilege.

That was demonstrated on chain rather than asserted: four positions were settled
from an account with no relationship to the writer, the quoter, the admin or the
treasury, and it finished down only its fees
([`contracts/README.md`](../contracts/README.md#permissionless-settlement-verified-on-chain-2026-07-30)).

### Settlement expires

Permissionless is not the same as indefinite, and an earlier version of this
section implied otherwise.

The price the contract needs is Reflector's reading **for the expiry period**.
Reflector serves a ring buffer, not an archive: measured on testnet, the reading
20 hours back was still available and the one 22 hours back was gone. The
contract's only fallback is the live price, and it is gated to within an hour of
expiry on purpose — a late settlement priced at the current market would hand
back exactly the timing discretion that pinning to expiry removes. So once the
period is pruned, `settle` fails closed for good. There is no admin override and
no upgrade entrypoint. The collateral stays escrowed with nothing able to
release it, which was verified against the live feed rather than read off the
oracle's documentation.

The sweep is therefore **a component with a deadline, not a convenience**. Anyone
may still settle a position on identical terms — the permission is real and
nothing above changes — but somebody has to, within about a day. `/api/cron/settle`
reports each due position with the time it must be closed by, and reports one
that is past it separately, because a stale-price failure inside the window and
one outside it are the same error message asking for opposite responses.

The deadline is also why the writer's own claim on the dashboard is a gap and
not a nicety: a self-settle button would make the runner genuinely optional
(tracked for a later tranche), since the collateral is the writer's and only the
writer reliably cares.

### The schedule

`/api/cron/settle` was written against a `vercel.json` cron entry, and the
application is deployed to a self-hosted Coolify instance, which does not read
that file. It scheduled nothing while appearing to schedule two jobs, so it was
removed; the schedule now lives with the deployment and is documented in the
[README](../README.md#scheduled-jobs). The
runner key holds no standing with the contract, which
[`src/lib/__tests__/settlement-scope.test.ts`](../src/lib/__tests__/settlement-scope.test.ts)
pins in code — the transaction it builds invokes `settle` with one argument and
carries no authorization entries, so it structurally cannot smuggle a second
signature the way `open` requires one.

Finding the work is the awkward half. The contract indexes positions by owner,
not by state, so there is no "everything unsettled" view. The sweep walks ids
from 0 to `nextId`, which grows with every position ever opened, so each run is
bounded and reports where it stopped and how much it did not examine. A sweep
that quietly checked the first slice and reported success would be
indistinguishable from one that found nothing to do.

---

## 7. Portfolio risk

`/api/vault/portfolio` aggregates a wallet's open positions and re-prices them
against live market data. Two conventions it enforces, both of which are easy to
get wrong in a way that looks plausible:

**Every Greek describes the writer.** The engine returns the option's Greeks
from the holder's side, so they are negated exactly once — in
[`src/lib/portfolio.ts`](../src/lib/portfolio.ts) — and nowhere else. A wallet
that has sold calls carries negative delta. A screen that got this backwards
would look entirely reasonable and be exactly wrong.

**Call and put collateral are never summed.** Calls escrow XLM, puts escrow
cash. There is no field anywhere in the response that adds them, because a
single number across two tokens is a currency error that reads like a portfolio
summary.

Vega is measured against each strike's own σ (sticky-strike), not against σ_atm
— the latter would need the smile's derivative as well. At this book size the
distinction is a labelling matter, but reading one for the other overstates a
parallel vol shock.

---

## 8. Data: the ledger and its mirror

Positions are read from contract state and indexed by owner there, so they are
visible from any device and readable by anyone — including after this server and
its database are gone.

The database records what the ledger does not: the APR the engine published at
deposit time, and transaction hashes. Routes degrade to it when the contract
cannot be reached, and say so in the response rather than silently.

Where they disagree, the contract wins.

There is no longer an exception to that. Positions written before contract
custody were escrowed in an operational account; that book has been settled in
full and the route that could pay from it is gone, which
[`docs/SECURITY.md`](SECURITY.md#what-is-still-custodial) records.

---

## Known limits, in one place

Every one of these is discussed in context above; this is an index, not a
disclaimer.

| Limit | Where |
| --- | --- |
| The paid premium is set by `MAX_APR` policy, not by Black-76 fair value | [§1](#1-the-pricing-engine) |
| `MAX_PRICING_SIGMA` is currently binding permanently, making realized vol a dead input | [§1](#known-limits-stated-rather-than-found) |
| The vol markup points the wrong way for a buyer, harmless only because the level is pinned | [§1](#known-limits-stated-rather-than-found) |
| Concentration policy can be overshot by one position under a race | [§4](#the-race-in-the-quoters-tier) |
| Concentration policy is off-chain and a compromised quoter can decline to apply it | [§4](#enforced-by-the-quoter--by-declining-to-sign) |
| No `upgrade` entrypoint: fixing the contract means redeploying and migrating | [§3](#3-the-contract) |
| Losing the admin key has no in-contract recovery | [`SECURITY.md`](SECURITY.md#if-a-key-is-lost) |
| A book of pre-migration positions is still custodial | [`SECURITY.md`](SECURITY.md#what-is-still-custodial) |
