# Adversarial testnet program

Anyone may attack the deployed Lusty vault on Stellar testnet during this window. This
document fixes the scope, the rules and the severity bar in advance.

**Status: open from 2026-10-06 00:00 UTC until mainnet.** The window passes the grant's
minimum of fourteen consecutive days on 2026-10-20 and stays open until the mainnet launch;
the closing date goes here once launch is scheduled. Attacking the testnet deployment at
other times is not forbidden (the network is public and the contracts permissionless), but
only reports received during the window get the commitments below. Reports go through
[`REPORTING.md`](./REPORTING.md).

**It will be announced publicly, not to a list** (decision 4, settled 2026-09-26), because
the grant asks for a public, open window. So test capital has to be reachable without
asking ([`REPRODUCE.md` §8](./REPRODUCE.md) says which bounds the faucet reaches and which
it does not), and triage load is unbounded: same-day acknowledgement for Critical and High
(§5) applies to whoever turns up. We accept that cost.

> **A note on the in-scope list.** §3 is written from this system's own surfaces. The
> grant's list of sixteen was reconciled against it line by line on 2026-10-06, adding
> classes 17 to 19 and widening seven others; the table at the end of §3 maps each grant
> item to a class. Where the two still differ, the grant's wording governs and this file
> changes.

---

## 1. What is deployed, and what it is worth

Everything in scope is on **Stellar testnet**. Every address (both vault instances, the
oracle, the SACs, the admin, the treasury, the quoter) is in
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

**The collateral is not real.** This repository mints LBTC and LUSD with no reserve,
redemption or custody claim, and testnet XLM comes from a faucet. An attack is triaged as if
the code held real collateral, but one that only works *because* the assets are unbacked is
a known limitation (§7).

---

## 2. Rules of engagement

**Allowed, and encouraged:** anything against the deployed contracts or the public HTTP API,
in any order, at any rate, from any account; reading every published key, id and
configuration value; running the repository and attacking from its source; automated
tooling, fuzzing and scripted campaigns against the testnet endpoints.

**Out of bounds:**

- **Anything off testnet.** No mainnet, no other network, no infrastructure beyond the
  deployed app and contracts.
- **The people.** No social engineering, phishing, contact under a pretext, or physical
  access.
- **The hosts underneath.** The hosting provider, the database vendor, Horizon, the Soroban
  RPC, CoinGecko and Binance are out of scope. If a finding needs one of them compromised,
  report the dependency instead.
- **Denial of service as a goal.** Volume-testing a bound is welcome; exhausting a shared
  testnet resource so nobody else can work is not. Flag sustained load in the report and
  keep it bounded.
- **Destroying evidence.** Show that a write is possible, then stop. Do not delete or
  overwrite data.

**Disclosure.** Report first, publish afterwards. We ask for that head start rather than
enforce it, so a finding can be fixed before it is a headline.

---

## 3. In scope — the nineteen classes

Each class is named by what the attack achieves in this system.

### The money path

1. **Premium above the quote.** Make the vault pay a premium the pricing engine did not
   produce, produced for other inputs (strike, tenor, ladder, utilization or book), or past
   the instance's premium ceiling.
2. **Escrow mismatch or unauthorized access.** Open a position escrowing less than its
   claimable payout, or recorded as escrowing what the contract does not hold; or move
   escrowed collateral or a pool balance without the required authorization.
3. **Solvency break.** Drive any instance to `balance(payout) − escrowed(opposite) < owed(kind)`
   in either leg.
4. **Limit evasion.** Exceed `max_position_*`, `max_expiry_*`, the per-wallet epoch
   allowance or the monthly capacity by any route, including splitting, racing, or
   reporting a position twice.
5. **Invalid, replayed or abused quotes.** Get an invalid, expired or used signed quote
   accepted, or the quoter's co-signature applied to an invocation it did not authorize
   (another contract, function or argument, or a call nested under it).

### Settlement

6. **Settlement at the wrong price.** Settle against anything but the oracle's reading at
   the position's expiry: a stale or future record, another book's feed, a feed the book
   was never configured with, or a fabricated one.
7. **Outcome inversion.** Settle a position that should be assigned as kept, or the
   reverse, without the underlying price crossing the strike.
8. **Double settlement, double claim or replay.** Settle or claim a position twice, settle
   one already settled, or land one payout more than once.
9. **Settlement denial.** Make an expired position inside the oracle window permanently
   unsettleable, stranding its collateral, including by interrupting, starving or wedging
   the settlement runner until the window passes.
10. **Cross-book confusion.** Make one book's instance act on another's position, price,
    feed, escrow or id. Position ids restart at zero in every instance.

### Authorization and access

11. **Privilege escalation.** An admin action (`set_limits`, quoter-set changes) without the
    admin multisig, or a quoter action without the quoter key.
12. **Session and authentication flaws.** An admin session without an allowlisted key: a
    replayed challenge, a reused nonce, a session kept past revocation.
13. **Unauthenticated exposure.** Data or operations through the HTTP API that should need a
    session, signature or secret, including internal state, configuration or another
    user's positions.

### Protocol funds and rails

14. **Distributor drain.** Make the faucet, swap desk or USDC bridge pay out against forged,
    replayed or failed proof, or proof in an asset it never received. §6 records a live
    case.
15. **Accounting corruption.** Make the deposit ledger, utilization figure, capacity bar or
    leaderboard show what the chain does not support: duplicated positions, invented
    volume, amounts summed across assets.
16. **Configuration-shaped failure.** Break a check the *deployment* satisfies rather than
    the code: an asset wrongly gated, a book served when it should be gated, a limit
    reconciled against nothing, a rail relying on a trustline that does not exist yet, or a
    corrupted registry entry making one book quote, book or settle with another's
    parameters. See §8.

### Around the vault

17. **Malicious or compromised quoter.** With the quoter key, make the vault pay past
    `max_premium_bps`, pay anyone but the writer, or do anything beyond co-signing a
    premium. Only the ceiling and the admin separation bound a hostile quoter; getting past
    either is the finding.
18. **Routing slippage and failure.** Fill a routed swap below its enforced minimum, route
    off the allowlist, exceed a route's in-flight bound, or turn a failed or partial route
    into lost cash or a position on terms other than its quote. See
    [`LIQUIDITY-ROUTING.md`](./LIQUIDITY-ROUTING.md).
19. **Unavailable oracle or integration.** Use an outage (Reflector, Soroban RPC, Horizon,
    the off-chain price sources, the database) to pass a quote, deposit, payout or
    settlement that would be refused with the dependency up. Each should fail closed. Our
    one-dependency-down matrix is `src/lib/__tests__/outage-fail-closed.test.ts`; findings 7
    to 9 came from writing it.

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

The definitions are the grant's, word for word. Where an example seems to disagree, the
definition decides.

| Level | Definition | Here, for example |
|---|---|---|
| **Critical** | Unauthorized withdrawal, permanent loss of collateral, arbitrary contract control, systemic insolvency, or invalid settlement across multiple positions. | Escrow taken by a non-owner; a book driven insolvent; a run of positions settled at the wrong price. |
| **High** | A bug that materially misprices positions, bypasses a core risk control, compromises a privileged role, prevents correct settlement, or puts a meaningful amount of collateral at risk. | A premium above the quote or past the ceiling; an evaded limit; an admin or quoter action without its key; a drained distributor; one unsettleable position. |
| **Medium** | Limited financial impact, temporary disruption, or wrong behavior under specific conditions, without immediate systemic loss. | An accounting figure misstating exposure; a gate failing open behind a durable cap; a book taken offline by an outage it should have ridden out. |
| **Low / Informational** | No direct financial impact: documentation gaps, usability issues, monitoring improvements, and general hardening suggestions. | A missing bound with durable caps behind it; disclosure of already-published data; a missing alert. |

We assign severity on receipt and tell the reporter, who can dispute it. A claimed level
backed by a supporting reproduction will generally stand.

---

## 5. When a finding is resolved

**All five, or it is not closed:**

1. The root cause is identified, not just the symptom.
2. A fix is in place.
3. A regression test guards it, in the same commit as the fix.
4. The build is redeployed to testnet, with the new contract id recorded if the fix
   touched Rust.
5. The original scenario is retried and no longer reproduces.

Triage is continuous. **Critical** and **High** findings get a same-day acknowledgement and
a fix branch, and the milestone is complete only when **no Critical or High remains
unresolved**; if there are more than planned, the schedule moves. Any **Medium** still open
at the end is published with a mitigation and a remediation deadline before mainnet.
Nothing is quietly carried.

[`ADVERSARIAL-REPORT.md`](./ADVERSARIAL-REPORT.md) is published once the fourteen-day
minimum has passed and updated with every later finding until launch.

---

## 6. What we have already found ourselves

Three of our own passes have run. A report of one of their findings is triaged as known,
not counted twice.

- **2026-09-18**: an unscheduled hour reading the money paths, the auth surfaces and the
  deployment's configuration. Findings 1 to 6.
- **2026-10-06**: scripting class 19 against outages. Findings 7 to 9.
- **2026-10-10**: a full audit of commit `8b4bae9` by nineteen AI agents across the
  contract, API and scripts in five waves, with separate agents re-verifying every
  candidate. Seventeen confirmed, findings 10 to 26.

| # | Severity | Finding | State |
|---|---|---|---|
| 1 | Critical | `/api/swap` accepted a **failed** transaction as proof of payment. Horizon returns a failed transaction's payment operations without `include_failed`, so every checked field passed on a payment that moved nothing. One underfunded transaction drained the distributor. | fixed, `b41d54c` |
| 2 | High | `lusd_to_xlm` checked only that the asset was *not native*, so any issued asset would have paid out at the LUSD rate. Unreachable only because the distributor held exactly one trustline. | fixed, `b41d54c` |
| 3 | High | `/api/debug/db` was unauthenticated, returning row counts, table names, driver errors naming the host and role, and the TLS setting. It also ran `ensureSchema`, so anonymous requests drove DDL. | fixed, `92f1078` |
| 4 | High | A position could be indexed more than once: the only replay key was a caller-supplied `txHash`, and `computeExpirySold` SUMS those rows for utilization, so duplicates lowered everyone's APR and could read the book as full. | fixed, `92f1078` |
| 5 | Medium | The quoter co-signed an authorization tree after comparing only its root. Unexploitable against this contract only because `open` makes no nested call. | fixed, `92f1078` |
| 6 | Medium | Admin authorization went stale between challenge and verify: a revoked admin could still collect an hour-long session for two minutes. The route also had no rate limit. | fixed, `92f1078` |
| 7 | High | `/api/swap` and `/api/anchor/bridge` released the replay guard on **any** payout submit error, but a payout behind a Horizon 504 can still land before its time bound, so the same funding hash could be paid again. Now only a 400 with result codes releases the guard; otherwise it holds, the payout hash is recorded and the route answers `payout_unconfirmed`. | fixed, `47f7cf6`, live 2026-10-06 |
| 8 | Low | Routed-swap settle read a Horizon outage as "no path payment": it closed the swap, released its routing capacity and journaled a refusal for a possible fill, stopping the writer's put after a completed swap. Now only a 404 means not on the ledger; otherwise the swap stays open with 503 `retry` and the client re-asks. | fixed, `2361971`, live 2026-10-06 |
| 9 | Low | Market inputs had no age limit in an outage: with Binance, Bitstamp and CoinGecko down, the last σ priced every quote and the last perp funding rate rolled every forward for as long as the process ran. σ now serves stale for at most 24 hours, then quoting fails closed; funding for one 8-hour interval, then the forward is F = S. | fixed, `12dd382`, live 2026-10-06 |
| 10 | High | The swap and bridge replay guard keyed on the raw `txHash` string, so dot-segment spellings of one funding hash (`x/../<hash>`) were fresh keys and the distributor paid the same payment again. It now keys on the canonical 64-hex hash from the Horizon record. | fixed, `93ca969`, live |
| 11 | Medium | Quote reservations for throwaway addresses could hold a strike's inventory for 14 days, blocking every honest writer there. The monitor's timer now settles lapsed reservations for every wallet, and authorize is limited per client. | fixed, `b855903`, live |
| 12 | Low | The utilization taper counted only voluntarily indexed deposits, so skipping `/api/vault/deposit` kept full APR. Utilization is now the larger of indexed rows and on-chain exposure. | fixed, `b855903`, live |
| 13 | Low | Indexing a call replaced its USD reservation with a row in collateral units, so the per-strike USD cap stopped binding for BTC calls. Strike and wallet caps now sum in USD. | fixed, `b855903`, live |
| 14 | Low | Routed-swap settle accepted any matching ledger payment, so one `txHash` could journal unlimited forged fills. Settle is now bound to the prepared transaction's hash and `sendMax`, one hash per swap. | fixed, `f63d12c`, live |
| 15 | Low | `anchor-bridge-setup` signed an unverified remote SEP-10 challenge with the distributor key. It now verifies the challenge first. | fixed, `93ca969`, live |
| 16 | Low | The replay-ledger backfill copied unverified caller hashes from contract-era deposit rows into the intake index, where they could refuse someone else's funding as already processed. Those rows are now skipped. | fixed, `93ca969`, live |
| 17 | Low | Cached commentary reads spent the global model ceiling, so three clients could block the desk note for everyone. Only regeneration is charged now. | fixed, `f63d12c`, live |
| 18 | Low | XLM↔LUSD swaps priced at claim time against a caller-chosen cap, a free 15-minute option on the distributor. They now price at the less favourable of funding-time and claim-time spot. | fixed, `93ca969`, live |
| 19 | Low | Free faucet LUSD could be swapped for the distributor's XLM with no reserve check or outflow cap. `lusd_to_xlm` is now capped by each address's XLM put in, a daily outflow ceiling and a fee floor. | fixed, `93ca969`, live |
| 20 | Low | Leaderboard points for calls used spot at indexing time, not at open. Calls are now priced from the quote live at open. | fixed, `b855903`, live |
| 21 | Low | `vault/stats` and unscoped `vault/events` each shared one process-wide limiter key, so one client could lock out every visitor. Public read limits are now per client. | fixed, `f63d12c`, live |
| 22 | Low | The in-memory limiter's sweeper dropped timestamps after 10 minutes, resetting hourly limits early. Each limit now keeps timestamps for its own window. | fixed, `f63d12c`, live |
| 23 | Low | The automatic settlement sweep never reached positions more than 2,000 ids past the oldest unsettled one. It now resumes where its budget stopped. | fixed, `f63d12c`, live |
| 24 | Low | Anyone could spend a named wallet's co-signature rate limit and lock it out of opening positions. The budget is now keyed on client and wallet. | fixed, `b855903`, live |
| 25 | Low | The quoter's co-signature held the premium for 100 ledgers, so a writer could wait for spot to move against the quote. It now lasts 12 ledgers. | fixed, `b855903`, live |
| 26 | Low | The deposit indexer let anyone index another wallet's position under a chosen `txHash`, spending that wallet's indexing limit. It now verifies the open transaction's event before reserving anything. | fixed, `b855903`, live |

Fixes 10 to 26 are on `main` with their tests and live in the deployed `2e4dffb`.
[`ADVERSARIAL-REPORT.md`](./ADVERSARIAL-REPORT.md) has the fixes from our 2026-10-09
review, the audit's leads, what is still open, and each fix's live retest. The first pass's
full write-up, including what was found sound, is in the security-pass section of the
tranche notes.

---

## 7. Known limitations

Reports of these are acknowledged but triaged as known.

- **LBTC and LUSD are unbacked test assets** minted by this repository. The issuer can mint
  more, and there is no reserve or redemption. This is stated in four places.
- **Testnet XLM comes from a faucet**, so an attack costs only the transaction fee. That is
  deliberate.
- **The rate limiter is durable, and approximate at the edge.** Deposit, authorize, swap,
  routing, bridge, faucet, admin auth, feedback, wallet connect and the paid commentary
  endpoint count in Postgres (`rate_limits`), so limits survive deploys and hold across
  replicas. Known gaps: replicas racing on one key in one instant can each admit the last
  slot, and with the database unreachable the limiter falls back to a per-process count
  instead of refusing. Read-only endpoints (price, quote, stats, leaderboard, news) stay
  per-process on purpose. The durable caps behind the limiter (the faucet's, the quote
  policy's) still decide a payout.
- **The circuit breaker is one switch for every book**, so volatility on any asset halts
  all of them. That is conservative on purpose, but moving one thin market to stop the
  whole desk is in scope and counts as a finding: the design is known, not judged safe.
- **A raised-and-reverted limit is seen after the fact, not prevented.** Reconciliation
  compares two readings, so a `set_limits` raised and restored between them passes. The
  monitor also reads every `limits` event from a durable cursor and alerts on each, at
  critical when it departs from the declared values or more than one lands in an interval.
  That reports the write but cannot stop it, because the bound is the admin multisig. The
  event carries the two position caps and the premium ceiling but not the per-expiry caps,
  so a change to those alone shows unchanged values until the next reading.
- **Retired vault instances are still streamed** by the event indexer so old positions keep
  their history. They are not in scope as live contracts.

---

## 8. The shape worth hunting

Two of the first pass's six findings (2 and 5) share the shape to look for: **a check that
is satisfied by the deployment rather than by the code.** "Not native" holds only while the
distributor has one trustline; an unchecked sub-invocation tree is safe only while `open`
makes no nested call. Both read as correct and pass every obvious test, then fail when a
configuration changes elsewhere (a trustline opened, a contract call added, an asset
listed), and nobody reviews those as security changes. This milestone follows one that
added an asset by configuration and a routing layer by allowlist, which is where the class
multiplies.

---

## 9. How to report

The **report vulnerability** button on every page of the site, above the feedback button,
is the shortest path: private, any severity, with the intake template as its fields. Email
and GitHub issues also work ([`REPORTING.md`](./REPORTING.md)). Send the reproduction, the
transaction hashes, expected versus actual behaviour, and the severity you claim.

A valid finding may earn an XLM reward; the terms are in
[`REPORTING.md`](./REPORTING.md#xlm-rewards).
