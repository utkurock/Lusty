# Adversarial testnet program

An open window in which anyone is invited to attack the deployed Lusty vault on Stellar
testnet, with the scope, the rules and the severity bar written down before it opens
rather than argued about afterwards.

**Status: open from 2026-10-06 00:00 UTC to 2026-10-20 23:59 UTC** (fifteen days). This
document is the scope. Attacking the testnet deployment outside the window is not
forbidden — it is a public network and the contracts are permissionless — but only reports
received during the window are triaged against the commitments below. Reports go through
[`REPORTING.md`](./REPORTING.md).

**It will be announced publicly, not to a list** (decision 4, settled 2026-09-26). The
grant asks for a public, open attack window and a list is not one; the point of the
exercise is people we did not choose. Two consequences worth stating rather than
discovering:

- **Test capital has to be reachable without asking.** An announcement to strangers with a
  faucet that cannot reach the caps is an invitation to bounce off §7. See
  [`REPRODUCE.md` §8](./REPRODUCE.md), which says exactly which bounds the faucet reaches
  and which it does not.
- **Triage load is unbounded.** The commitment in §5 — same-day acknowledgement for
  Critical and High — is a commitment to whoever turns up, and the volume is not something
  we get to cap after announcing. That is the cost of the public form and it is accepted.

> **A note on the in-scope list.** The classes in §3 are written from this system's own
> surfaces. The grant names its own list of sixteen; the two were reconciled line by line
> on 2026-10-06, which added classes 17–19 and widened seven others. The table at the end of
> §3 maps every item on the grant's list to the class that carries it. Where the two still
> differ, the grant's wording governs and this file is what changes.

---

## 1. What is deployed, and what it is worth

Everything in scope is on **Stellar testnet**. Every address is published in
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md) — both vault instances, the oracle, the SACs, the
admin, the treasury and the quoter.

**The collateral is not real.** LBTC and LUSD are minted by this repository: no reserve, no
redemption, no custody claim. Testnet XLM comes from a faucet. Nobody loses money here, and
that is the point of doing this before mainnet rather than after.

What that means for a report: an attack that succeeds is worth exactly as much as it would
be worth against the same code holding real collateral, and is triaged that way. An attack
that only succeeds *because* the assets are unbacked is a known limitation (§7), not a
finding.

---

## 2. Rules of engagement

**Allowed, and encouraged:**

- Anything against the deployed contracts, in any order, from any account.
- Anything against the public HTTP API at any rate you like.
- Reading every key, id and configuration value that is published — they are published so
  you do not have to guess.
- Running the repository yourself, reading the source, and attacking from it.
- Automated tooling, fuzzing, and scripted campaigns against the testnet endpoints.

**Out of bounds:**

- **Anything off testnet.** No mainnet, no other network, no infrastructure that is not
  the deployed app and contracts.
- **The people.** No social engineering, phishing, or contacting anyone involved under a
  pretext. No physical access to anything.
- **The hosts underneath.** The application is in scope; the hosting provider, the
  database vendor, Horizon, the Soroban RPC, CoinGecko and Binance are not. If a finding
  depends on compromising one of them, report the dependency rather than doing it.
- **Denial of service as a goal.** Volume-testing a bound is in scope and welcome —
  exhausting a shared testnet resource so nobody else can work is not. If you are about to
  send sustained load, say so in the report and keep it bounded.
- **Destroying evidence.** Do not delete or overwrite data to prove you could. Show the
  write is possible and stop.

**Disclosure.** Report first, publish afterwards. There is no embargo period we will
enforce against anyone on a testnet deployment — we ask, we do not demand — but a finding
we hear about first is a finding we can fix before it is a headline.

---

## 3. In scope — the nineteen classes

These are the ways this specific system can be made to do the wrong thing. Each names what
the attack would achieve, because a class nobody can state an outcome for is not a class.

### The money path

1. **Premium above the quote.** Get the vault to pay a premium the pricing engine did not
   produce, or one it produced for different inputs — a different strike, tenor, ladder,
   utilization or book — or one past the instance's premium ceiling.
2. **Escrow mismatch or unauthorized access.** Open a position that escrows less than the
   payout it can claim, or that the contract records as escrowing something it does not
   hold — or move escrowed collateral or a pool balance anywhere without the authorization
   the contract requires for it.
3. **Solvency break.** Drive any instance to a state where
   `balance(payout) − escrowed(opposite) < owed(kind)` — the vault owing more than it can
   pay, in either leg.
4. **Limit evasion.** Exceed `max_position_*`, `max_expiry_*`, the per-wallet epoch
   allowance or the monthly capacity, by any route including splitting, racing, or
   reporting the same position twice.
5. **Invalid, replayed or abused quotes.** Get a signed quote accepted that is invalid,
   expired or already used, or get the quoter's co-signature applied to an invocation it
   did not authorize — a different contract, function, argument, or anything nested under
   the call it was shown.

### Settlement

6. **Settlement at the wrong price.** Make a position settle against a price other than
   the oracle's reading at its own expiry — a stale record, a future one, another book's
   feed, a feed the book was never configured with, or a fabricated one.
7. **Outcome inversion.** Make a position that should be assigned settle as kept, or the
   reverse, without moving the underlying price past the strike.
8. **Double settlement, double claim or replay.** Settle a position twice, settle one that
   is already settled, claim the same position twice, or make one payout land more than
   once.
9. **Settlement denial.** Make a position that is expired and inside the oracle window
   permanently unsettleable, stranding its collateral — including by interrupting,
   starving or wedging the settlement runner until the window passes.
10. **Cross-book confusion.** Make one book's instance act on another's position, price,
    feed, escrow or id. Position ids restart at zero in every instance, and this is the
    class that lives in that gap.

### Authorization and access

11. **Privilege escalation.** Perform an admin action (`set_limits`, quoter-set changes)
    without the admin multisig, or a quoter action without the quoter key.
12. **Session and authentication flaws.** Obtain an admin session without holding an
    allowlisted key — replay a challenge, reuse a nonce, or keep a session past a
    revocation.
13. **Unauthenticated exposure.** Reach data or an operation through the HTTP API that
    should require a session, a signature, or a secret — including anything that reveals
    internal state, configuration, or another user's positions.

### Protocol funds and rails

14. **Distributor drain.** Get the faucet, the swap desk or the USDC bridge to pay out
    against proof that is forged, replayed, failed, or in an asset it never received.
    (A live instance of exactly this is recorded in §6.)
15. **Accounting corruption.** Make the deposit ledger, the utilization figure, the
    capacity bar or the leaderboard report something the chain does not support —
    duplicated positions, invented volume, or amounts summed across assets.
16. **Configuration-shaped failure.** Make a check that is satisfied by the *deployment*
    rather than by the code stop holding: an asset gated when it should not be, a book
    served when it should be gated, a limit that is reconciled against nothing, a rail
    whose safety depends on a trustline that does not exist yet, or a registry entry
    corrupted so one book quotes, books or settles with another's parameters. See §8.

### Around the vault

17. **Malicious or compromised quoter.** Holding the quoter key, get the vault to pay a
    premium past `max_premium_bps`, pay anyone but the writer, or do anything other than
    co-sign a premium. The quoter is assumed hostile here: the ceiling and the admin
    separation are what bound it, and getting past either is the finding.
18. **Routing slippage and failure.** Make a routed swap fill below its enforced minimum,
    take a path off the allowlist, push more than the in-flight bound through a route, or
    turn a failed or partial route into lost cash or a position written on terms other
    than the ones it was quoted at. See [`LIQUIDITY-ROUTING.md`](./LIQUIDITY-ROUTING.md).
19. **Unavailable oracle or integration.** Use an outage — Reflector, Soroban RPC, Horizon,
    the off-chain price sources, the database — to get a quote, a deposit, a payout or a
    settlement through that would have been refused with the dependency up. Every one of
    these is meant to fail closed; one that fails open is the finding. Our own matrix,
    one dependency down at a time, is `src/lib/__tests__/outage-fail-closed.test.ts`;
    findings 7 to 9 below came out of writing it.

### The grant's list, mapped

| The grant's scope item | Class |
|---|---|
| Reach collateral without authorization | 2, 3 |
| Submit invalid or replayed signed quotes | 5 |
| Act as a compromised or malicious quoter | 17 |
| Get past premium ceilings | 1, 17 |
| Get past position and exposure limits | 4 |
| Push the vault into insolvency or undercollateralization | 3 |
| Force the wrong oracle feed | 6 |
| Mishandle the expiry price | 6 |
| Settle in-the-money or out-of-the-money positions incorrectly | 7 |
| Double-settle or claim the same position twice | 8 |
| Escalate administrative permissions | 11, 12 |
| Break BTC/XLM vault isolation | 10 |
| Corrupt multi-asset configuration | 16 |
| Exploit liquidity-routing slippage or transaction failure | 18 |
| Interrupt the settlement runner | 9 |
| Exploit an unavailable oracle or external integration | 19 |

---

## 4. Severity

The definitions are the grant's, word for word. The last column is what each looks like
in this system; where the two seem to disagree, the definition decides.

| Level | Definition | Here, for example |
|---|---|---|
| **Critical** | Unauthorized withdrawal, permanent loss of collateral, arbitrary contract control, systemic insolvency, or invalid settlement across multiple positions. | Escrow taken by someone who is not its owner; a book driven insolvent; a run of positions settled at the wrong price. |
| **High** | A bug that materially misprices positions, bypasses a core risk control, compromises a privileged role, prevents correct settlement, or puts a meaningful amount of collateral at risk. | A premium paid above the quote or past the ceiling; a limit evaded; an admin or quoter action without its key; a distributor drained; one position made unsettleable. |
| **Medium** | Limited financial impact, temporary disruption, or wrong behavior under specific conditions, without immediate systemic loss. | An accounting figure that misstates exposure; a gate that fails open behind a durable cap; a book taken offline by an outage it should have ridden out. |
| **Low / Informational** | No direct financial impact: documentation gaps, usability issues, monitoring improvements, and general hardening suggestions. | A missing bound with durable caps behind it; disclosure of already-published data; an alert that should exist and does not. |

Severity is assigned by us on receipt, stated back to the reporter, and argued about if
they disagree. A report that claims a level and shows a reproduction that supports it will
generally get the level it claims.

---

## 5. When a finding is resolved

**All five, or it is not closed:**

1. The root cause is identified — not the symptom, the cause.
2. A fix is in place.
3. A regression test guards it, in the same commit as the fix.
4. The build is redeployed to testnet, with the new contract id recorded if the fix
   touched Rust.
5. The original scenario is retried and no longer reproduces.

Triage runs continuously rather than at the end of the window. A **Critical** or **High**
finding gets a same-day acknowledgement and a fix branch, so the window does not become a
queue. The milestone's own completion criterion is that **no Critical or High remains
unresolved** — if the window produces more than the schedule assumed, the schedule is what
moves.

Anything **Medium** left open at the end is published with a mitigation and a remediation
deadline set before mainnet. Nothing is quietly carried.

---

## 6. What we have already found ourselves

An unscheduled security pass ran on **2026-09-18** — an hour of reading the money paths,
the auth surfaces and the deployment's own configuration. It produced five findings, and
they are listed here because a report of one of them should be triaged as known rather
than counted twice.

| # | Severity | Finding | State |
|---|---|---|---|
| 1 | Critical | `/api/swap` accepted a **failed** transaction as proof of payment. Horizon returns a failed transaction's payment operations without `include_failed`, so every field the route checked passed on a payment that moved nothing. One underfunded transaction drained the distributor. | fixed, `b41d54c` |
| 2 | High | `lusd_to_xlm` checked only that the asset was *not native*. Any issued asset would have been paid out at the LUSD rate. Unreachable only because the distributor held exactly one trustline. | fixed, `b41d54c` |
| 3 | High | `/api/debug/db` was unauthenticated: row counts, table names, driver error strings naming the host and role, and the TLS setting read back to the caller. It also ran `ensureSchema`, so an anonymous request drove DDL. | fixed, `92f1078` |
| 4 | High | A position could be indexed more than once. The only replay key was a caller-supplied `txHash`, and `computeExpirySold` SUMS those rows to decide utilization — so duplicates lowered the APR offered to everyone and could read the book as full. | fixed, `92f1078` |
| 5 | Medium | The quoter co-signed an authorization tree it only compared the root of. Not exploitable against this version of the contract — `open` makes no nested call — but that is a fact about the contract, not about the check. | fixed, `92f1078` |
| 6 | Medium | Admin authorization went stale between challenge and verify: a revoked admin could still collect an hour-long session for two minutes afterwards. The route also had no rate limit. | fixed, `92f1078` |
| 7 | High | `/api/swap` and `/api/anchor/bridge` released the replay guard on **any** payout submit error. A Horizon 504 does not mean the payout failed: it can still land before its time bound, and the released guard then let the same funding hash be paid again. Found 2026-10-06 while scripting class 19. Now only a 400 carrying result codes releases the guard; anything else keeps it, records the payout hash and answers `payout_unconfirmed`. | fixed, `47f7cf6`, live 2026-10-06 |
| 8 | Low | A routed swap's settle read a Horizon outage as "no path payment". It closed the swap, released its routing capacity and journaled a refusal for what may have been a fill, and the writer's put stopped after a swap that had gone through. Found 2026-10-06 while scripting class 19. Now only a 404 means not on the ledger; an unreadable ledger keeps the swap open and answers 503 `retry`, and the client re-asks. | fixed, `2361971`, live 2026-10-06 |
| 9 | Low | Market inputs had no age limit in an outage. With Binance, Bitstamp and CoinGecko all down, the last σ priced every quote for as long as the process stayed up, and the last perp funding rate rolled every forward the same way. Found 2026-10-06 while scripting class 19. σ is now served stale for at most 24 hours, then quoting fails closed; funding for at most one 8-hour interval, then the forward is F = S. | fixed, `12dd382`, live 2026-10-06 |

Full write-up, including what was checked and found sound, is in the security-pass section
of the tranche notes.

---

## 7. Known limitations

Reporting one of these is welcome and will be acknowledged, but it is triaged as known.

- **LBTC and LUSD are unbacked test assets** minted by this repository. The issuer can mint
  more. There is no reserve and no redemption. This is stated in four places and is not a
  finding.
- **Testnet XLM comes from a faucet**, so the cost of any attack is the transaction fee.
  That is deliberate: it is what makes the window worth running.
- **The rate limiter is durable, and approximate at the edge.** Deposit, authorize, swap,
  routing, bridge, faucet, admin auth, feedback, wallet connect and the paid commentary
  endpoint count in Postgres (`rate_limits`), so a limit survives a deploy and holds across
  replicas. Two things are known: replicas racing on one key in one instant can each admit
  the last slot, and if the database is unreachable the limiter falls back to the old
  per-process count rather than refusing. Read-only endpoints (price, quote, stats,
  leaderboard, news) stay per-process on purpose. The durable caps behind the limiter (the
  faucet's, the quote policy's) are still what decide a payout.
- **The circuit breaker is one switch for every book.** Volatility on any asset halts all
  of them. That is conservative on purpose, and it is also a shape worth attacking: moving
  one thin market to stop the whole desk. A report demonstrating that is in scope and is a
  finding, not a limitation — what is known is the design, not that it is fine.
- **A raised-and-reverted limit is seen after the fact, not prevented.** Reconciliation
  compares two readings, so a `set_limits` raised and restored between them passes it. The
  monitor now also reads every `limits` event forward from a durable cursor and alerts on
  each one, critical when it departs from the declared values or when more than one lands
  in an interval. That reports the write that used the wider cap; it does not stop it,
  because the bound is the admin multisig. The event carries the two position caps and the
  premium ceiling, not the per-expiry caps, so a change to those alone is reported with
  unchanged values and left to the next reading.
- **Retired vault instances are still streamed** by the event indexer so old positions keep
  their history. They are not in scope as live contracts.

---

## 8. The shape worth hunting

Two of the six findings above were the same shape, and it is the one to look for: **a check
that is satisfied by the deployment rather than by the code.**

"Not native" is a real check only while the distributor holds one trustline. An unchecked
sub-invocation tree is safe only while `open` makes no nested call. Both read as correct.
Both pass every test anybody would think to write. Both fail the moment a configuration
changes somewhere else entirely — opening a trustline, adding a contract call, listing an
asset — which is exactly the kind of change nobody reviews as a security change.

This milestone follows one that added an asset by configuration and a routing layer by
allowlist. That is where the class multiplies.

---

## 9. How to report

The **report vulnerability** button on every page of the site, above the feedback button,
is the shortest path: private, any severity, and its fields are the intake template.
Email and GitHub issues still work — see [`REPORTING.md`](./REPORTING.md). In short: the
reproduction, the transaction hashes, what you expected versus what happened, and the
severity you are claiming.
