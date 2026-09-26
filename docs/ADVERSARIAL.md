# Adversarial testnet program

An open window in which anyone is invited to attack the deployed Lusty vault on Stellar
testnet, with the scope, the rules and the severity bar written down before it opens
rather than argued about afterwards.

**Status: not open yet.** This document is the scope; the window has a start and end date
and neither is set. Attacking the testnet deployment outside the window is not forbidden —
it is a public network and the contracts are permissionless — but only reports received
during the window are triaged against the commitments below.

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

> **A note on the in-scope list.** The sixteen classes in §3 are written from this
> system's own surfaces. The grant names its own list, and the two should be reconciled —
> line by line — before the window is announced. Where they differ, the grant's wording
> governs and this file is what changes.

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

## 3. In scope — the sixteen classes

These are the ways this specific system can be made to do the wrong thing. Each names what
the attack would achieve, because a class nobody can state an outcome for is not a class.

### The money path

1. **Premium above the quote.** Get the vault to pay a premium the pricing engine did not
   produce, or one it produced for different inputs — a different strike, tenor, ladder,
   utilization or book.
2. **Escrow mismatch.** Open a position that escrows less than the payout it can claim, or
   that the contract records as escrowing something it does not hold.
3. **Solvency break.** Drive any instance to a state where
   `balance(payout) − escrowed(opposite) < owed(kind)` — the vault owing more than it can
   pay, in either leg.
4. **Limit evasion.** Exceed `max_position_*`, `max_expiry_*`, the per-wallet epoch
   allowance or the monthly capacity, by any route including splitting, racing, or
   reporting the same position twice.
5. **Quoter signature abuse.** Get the quoter's co-signature applied to an invocation it
   did not authorize — a different contract, function, argument, or anything nested under
   the call it was shown.

### Settlement

6. **Settlement at the wrong price.** Make a position settle against a price other than
   the oracle's reading at its own expiry — a stale record, a future one, another book's
   feed, or a fabricated one.
7. **Outcome inversion.** Make a position that should be assigned settle as kept, or the
   reverse, without moving the underlying price past the strike.
8. **Double settlement or replay.** Settle a position twice, settle one that is already
   settled, or make one payout land more than once.
9. **Settlement denial.** Make a position that is expired and inside the oracle window
   permanently unsettleable, stranding its collateral.
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

14. **Distributor drain.** Get the faucet, the swap desk or the anchor ramp to pay out
    against proof that is forged, replayed, failed, or in an asset it never received.
    (A live instance of exactly this is recorded in §6.)
15. **Accounting corruption.** Make the deposit ledger, the utilization figure, the
    capacity bar or the leaderboard report something the chain does not support —
    duplicated positions, invented volume, or amounts summed across assets.
16. **Configuration-shaped failure.** Make a check that is satisfied by the *deployment*
    rather than by the code stop holding: an asset gated when it should not be, a book
    served when it should be gated, a limit that is reconciled against nothing, or a rail
    whose safety depends on a trustline that does not exist yet. See §8.

---

## 4. Severity

| Level | What it means here |
|---|---|
| **Critical** | Collateral can be taken, or the vault can be made insolvent. Anyone can extract value that is not theirs, or a writer can be prevented from ever recovering what they escrowed. |
| **High** | Money moves wrongly but recoverably, or an authorization boundary fails. A premium paid above the quote, a limit evaded, an admin action performed without the admin, a distributor drained. |
| **Medium** | The system reports or enforces something false without moving funds directly: a wrong price on a screen that sizes a decision, an accounting figure that misstates exposure, a gate that fails open. |
| **Low** | A weakness with no demonstrated path to any of the above — a missing bound with durable caps behind it, an information disclosure of published data, a hardening gap. |

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
- **The rate limiter is in-memory, per process.** Every bound in the app — deposit,
  authorize, swap, faucet, admin auth — is a `Map` in one Node process. It resets on
  deploy and does not exist across replicas, so it bounds an honest client and not an
  attacker. The durable caps behind it (the faucet's, the quote policy's) are the ones that
  hold. Making it durable is real work and is scheduled inside this milestone.
- **Database TLS is encrypted but not verified.** The deployment runs with
  `DB_SSL_REJECT_UNAUTHORIZED=false` pending a CA certificate in `DB_SSL_CA`. A MITM on the
  database path would be invisible. `lib/db` already prefers the verified path.
- **The circuit breaker is one switch for every book.** Volatility on any asset halts all
  of them. That is conservative on purpose, and it is also a shape worth attacking: moving
  one thin market to stop the whole desk. A report demonstrating that is in scope and is a
  finding, not a limitation — what is known is the design, not that it is fine.
- **Limit reconciliation compares two readings**, so a `set_limits` raised and reverted
  between them is invisible. The contract publishes a `limits` event on every change and
  the indexer already streams both instances; watching the event is the stronger version
  and is not built yet.
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

See [`REPORTING.md`](./REPORTING.md) for the intake template and where to send it. In
short: the reproduction, the transaction hashes, what you expected versus what happened,
and the severity you are claiming.
