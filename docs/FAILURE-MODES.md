# Failure modes

What happens when one of the five things Lusty depends on but does not run
stops answering: the Reflector oracle, the settlement runner, Horizon, the
Soroban RPC and Binance. For each one, what stops, what keeps working, and
what an operator sees.

The rule behind every row is the same. A dependency that is down never lets
through something that would have been refused with it up. Where a missing
answer could be read either way, it is read as a refusal. Where a stale answer
is still good enough (a limit that moves on a one-day delay, a σ from
yesterday's closes), it is used for a bounded time and then refused.

Each row is pinned by
[`src/lib/__tests__/failure-modes.test.ts`](../src/lib/__tests__/failure-modes.test.ts),
which takes that one dependency down, leaves the other four up and asserts both
columns. The co-signature's own one-at-a-time matrix (circuit breaker,
database, feeds, limits, pause) is
[`outage-fail-closed.test.ts`](../src/lib/__tests__/outage-fail-closed.test.ts).

---

## The table

| Down | Stops | Keeps working | Seen as |
| --- | --- | --- | --- |
| **Reflector oracle** | Settlement: the contract settles only on the oracle's period records and refuses without one (#7). | Quoting: spot falls back to Binance's ticker. Opening positions. Every read. | Settlement failures reported as transient; the settlement-backlog alert once positions sit expired. |
| **Settlement runner** | Nothing that another key cannot do. Expired positions stay open until somebody calls `settle`. | Everything. `settle` is permissionless and prices itself, so any account can close the same position on the same terms. | Settlement-backlog warning, then the stranded-collateral critical alert if a position passes its oracle window. |
| **Horizon** | The co-signature on a book whose underlying is an issued asset (the trustline check), indexing a position whose open is older than the RPC's event retention, payouts and the swap desk. | Quoting, opening on the XLM book (native XLM needs no trustline read), settlement, the capacity bars. | `trustline_check_unavailable` (503) on the co-signature; the monitor's "Horizon unreachable" critical alert. |
| **Soroban RPC** | Opening and settling (both are Soroban transactions). After the grace, quoting: no reading of the limits or the pause is left to stand on. | Quoting for up to an hour on the last clean reading of the limits and the pause. Live spot, from Binance. | `limits_unreconciled` / `book_paused` (503) once the grace runs out; `/api/health` reports the book's limits as stale, then failed. |
| **Binance** | Nothing on the money path. | Spot from the oracle. σ from Bitstamp or CoinGecko. The forward at F = S, with no funding rate invented. | Nothing, by design; the quote's derivation names the source it used. |

Two dependencies down at once is where the product does stop quoting: the
oracle and Binance together leave no spot (`price_feed_unavailable`), and
every daily-close source down with nothing cached leaves no σ. Neither has a
made-up fallback. A quote priced off an invented number pays real premium.

---

## The rows in more detail

### Reflector oracle

The oracle is the settlement source and the first spot source. Spot does not
need it: [`lib/spot.ts`](../src/lib/spot.ts) takes Reflector's latest record
while it is under 15 minutes old and otherwise asks Binance. Settlement does
need it, and has no second source on purpose. The vault reads the period
record at or just after the expiry, never a live price, so nobody can choose
the print by choosing when to settle.

A run that cannot settle reports the position as transient (`permanent:
false`) while it is inside its oracle window, and the next run tries again.
Once the oracle has priced the expiry, a v5 or v6 instance can hold that price
itself (`record_price`); a position the oracle never priced is released as kept
thirty days after expiry. The collateral never stays locked.

### Settlement runner

The runner is a fee payer. `SETTLE_RUNNER_SECRET` has no standing with the
contract, and `settle` takes no authorization, so the runner being down
changes when positions settle, never how. The risk it leaves is time: the
oracle keeps 24 hours of history, and a position settled after that cannot be
priced from the oracle any more. A run that comes back late still reaches the
positions inside their window first (`prioritize`), and the ones past it fail
as permanent, which is the case that needs a person.

### Horizon

Horizon answers one question on the money path: does this writer hold a
trustline for the book's underlying. Only an issued underlying asks it. A 404
means no trustline; anything else is an outage and is refused as one, with a
503 that says so, rather than telling a writer to open a trustline they
already hold. Native XLM is nobody's trustline, so the XLM book does not read
Horizon to open a position. Settlement and quoting never read it. The indexer
reads Horizon's transaction history only for an open older than the RPC keeps
events ([`lib/open-proof.ts`](../src/lib/open-proof.ts)); that index waits,
the position on chain does not.

### Soroban RPC

Every contract read and write goes through the RPC. The app reads two things
before it quotes: the instance's limits, reconciled against the declaration
([`lib/vault-limits.ts`](../src/lib/vault-limits.ts)), and whether the
guardian has paused the book. Both are cached and both ride out an RPC outage
on their last clean reading for an hour, because an RPC blip is not drift and
not a pause, and the contract enforces both itself on every write anyway. Past
that hour, or with no reading ever taken, the book is refused.

Opening and settling are Soroban transactions and simply cannot happen. The
oracle is read over the same RPC, so spot falls to Binance.

### Binance

Binance is a second source everywhere and a first source nowhere on the money
path. Spot reads it only when the oracle cannot answer. σ is computed from
daily closes taken from Binance, Bitstamp or CoinGecko, whichever answers
first, identically; a cached σ is used for up to 24 hours when none of them
does. The forward reads Binance's perp funding rate and, without it, assumes no
carry (F = S), which is conservative and states its source as
`spot-fallback`.
