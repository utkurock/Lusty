# Adversarial testnet report

This report covers the adversarial window described in [`ADVERSARIAL.md`](./ADVERSARIAL.md).
The window opened on 2026-10-06 00:00 UTC, passed the grant's fourteen-day minimum on
2026-10-20, and stays open until mainnet. Findings reported later are added here; the last
update is 2026-11-08, after the v5 contract went live.

## Status

| | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Found | 1 | 8 | 10 | 40 | 59 |
| Fixed and live | 1 | 8 | 10 | 40 | 59 |
| Open | 0 | 0 | 0 | 0 | 0 |

Every Critical and High finding is fixed and running on `lusty.finance`. We retested them
against the live site on 2026-10-25 and 2026-10-26, apart from the few that need a signed,
funded transaction or a Horizon outage. Our regression tests cover those.

Every Medium finding is fixed too. 54 and 55 were in the settlement path of the v4 contract
and closed when both books moved to v5 on 2026-11-08. 59 was in v5's first fix for 54 and
was reported from outside before v5 took any position; the instances now live include its
fix. The last Low finding, 58, is fixed as well, so no finding is open.

One report came from outside the team: 59, by email on 2026-11-08. The private report form
received nothing (`security_reports` is empty), and no GitHub issue was filed. Every other
finding below comes from our own reviews.

Severity uses the grant's definitions, quoted in `ADVERSARIAL.md` §4. We count a finding as
fixed only when it meets the five conditions in §5: root cause found, fix merged, regression
test in the same commit, redeployed, and the original scenario retried.

## Deployment under test

| | |
|---|---|
| Application | `https://lusty.finance`, Stellar testnet |
| Deployed commit | [`718dab4`](https://github.com/utkurock/Lusty/commit/718dab4), deployed 2026-11-08 |
| XLM book | `CDRRLRY3KSYAGKMSHBQ6NWQNWPVSF46DTNEADJBONMNJ7USF32H32TE2` (vault v5) |
| BTC book | `CCE2WCB43ZGSWPLD3XRCECOYGXPBH5625RZZHJDHLQ4HD6YR35K2OYHQ` (vault v5) |
| v5 wasm | `b61d403ad03ab430181455351355e34235685bbeedcf99948c3167ab993fbf64` |
| Retired, still settled | `CBJZGTCF…UCJZ` (XLM v4), `CBQEACXA…MVEU` (BTC v4) |
| Admin | `GBDNJQDP4HJQH6WCJCYVYGTKDRYKZXQQSVEC4FOE24CVG4VRQU26IKEC` (2-of-3 multisig) |
| Quoter | `GC7Z4LVQCUOU7FMRBX4WOGANARQGM4SZTACKMSQSMGIOO4KEAASHLOTX` |

The site served `2e4dffb` during the retests of 2026-10-25 and was redeployed at `b7b672e` on
2026-10-26 with the fixes for 56 and 57. We checked each version from the outside: the docs
page shows the text that commit added (this report, for `b7b672e`), the CSP no longer allows
`'unsafe-eval'` (`5435f35`), and `/api/swap` returns the canonical-hash error added in
`93ca969`. Other addresses are in
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

The v4 books are retired, not abandoned. They are listed in `VAULT_RETIRED_XLM` and
`VAULT_RETIRED_BTC`, and the settlement sweep keeps settling their open positions where they
were written, so the move did not have to wait for v4 to drain. XLM v4 still had one live
position, #29, expiring 2026-11-13.

Fixes 1 to 53 and 56 to 58 are off-chain, in the API and the operator scripts. 54, 55 and 59
needed the new contract.

The findings came from these reviews:

| Review | Date | Findings |
|---|---|---|
| Money paths, auth and deployment config | 2026-09-18 (before the window) | 1 to 6 |
| Outage scripting, one dependency down at a time | 2026-10-06 | 7 to 9 |
| Money path, settlement and public routes | 2026-10-09 | 27 to 47 |
| Dependency advisories | 2026-10-09 to 10-10 | 48 |
| Full audit of `8b4bae9` (19 agents, each candidate re-verified) | 2026-10-10 | 10 to 26, plus leads 49 to 54 and 57 |
| Retest for this report | 2026-10-25 | 58 |
| External report, by email | 2026-11-08 | 59 |

## Findings

Class numbers refer to `ADVERSARIAL.md` §3. "Retested" means we replayed the attack against
the live site; "test" means a regression test covers it.

### Critical and High: all fixed

| # | Severity | Finding | Fix | Status |
|---|---|---|---|---|
| 1 | Critical | `/api/swap` accepted a failed transaction as proof of payment, which let one underfunded transaction drain the distributor. | `b41d54c` | fixed, retested |
| 2 | High | `lusd_to_xlm` only checked that the asset was not native, so any issued asset would have paid out at the LUSD rate. | `b41d54c` | fixed, test |
| 3 | High | `/api/debug/db` needed no login. It showed the DB host and role and let anyone run DDL. | `92f1078` | fixed, retested |
| 4 | High | A position could be indexed twice, which lowered everyone's APR and could make the book look full. | `92f1078` | fixed, test |
| 7 | High | A Horizon 504 released the swap and bridge replay guard, so a payout that landed late could be paid twice. | `47f7cf6` | fixed, test |
| 10 | High | The replay guard used the raw `txHash` string, so `x/../<hash>` paid the same funding again. | `93ca969` | fixed, retested |
| 27 | High | Fee-bumped funding was accepted. Horizon answers to both hashes of a fee bump, so it was paid twice. | `d38e1b1` | fixed, test |
| 28 | High | Quotes counted against wallet, expiry and strike limits only after the client reported its deposit. A client that never reported skipped the limits. | `6df2f28` | fixed, test |
| 29 | High | The quoter signed expiries off the schedule. One second off gave a new per-expiry cap that settled on the same price. | `47a0380` | fixed, retested |

### Medium: all fixed

| # | Finding | Fix | Status |
|---|---|---|---|
| 5 | The quoter checked only the root of the authorization tree it signed. | `92f1078` | fixed, test |
| 6 | A revoked admin could still get a session for two minutes, and admin login had no rate limit. | `92f1078` | fixed, test |
| 11 | Quote reservations from throwaway addresses could block a strike for 14 days. | `b855903` | fixed, test |
| 30 | Swap funding had no age limit and could pay more than the quote, which gave the caller a free option on the price. | `fc3e066` | fixed, retested |
| 31 | Anyone could index a dust position under someone else's funding hash and get that person's swap refused. | `1e6510c` | fixed, retested |
| 32 | A few unsettleable positions could use up the settlement runner's whole cap. | `d48a360` | fixed, test |
| 33 | A wallet removed from the admin list kept its session until it expired. | `b1ac59c` | fixed, test |
| 54 | If Reflector has no record for the exact expiry period, v4 falls back to `lastprice` and the first settler picks the price. | v5, `718dab4` | fixed, test |
| 55 | On v4, a position not settled within about a day of oracle history is locked for good. | v5, `583ef6a` | fixed, test |
| 59 | v5's first fix for 54 still took `lastprice`, from any time after expiry within the hour, so the first caller of `settle` or `record_price` could wait for the print that suited them and pin it for the whole expiry. | `718dab4` | fixed, test |

### Low: all fixed

| # | Finding | Fix | Status |
|---|---|---|---|
| 8 | Routed swap settle read a Horizon outage as "not filled". | `2361971` | fixed |
| 9 | Volatility and funding had no age limit when every price feed was down. | `12dd382` | fixed |
| 12 | The utilization taper ignored deposits that were never indexed. | `b855903` | fixed |
| 13 | The per-strike USD cap stopped working for indexed BTC calls. | `b855903` | fixed |
| 14 | One hash could record unlimited routed-swap fills. | `f63d12c` | fixed |
| 15 | `anchor-bridge-setup` signed an unverified SEP-10 challenge with the distributor key. | `93ca969` | fixed |
| 16 | The replay backfill copied unverified hashes into the intake index. | `93ca969` | fixed |
| 17 | Cached commentary reads used up the global model limit. | `f63d12c` | fixed |
| 18 | Swaps were priced at claim time, giving a free 15-minute option. | `93ca969` | fixed |
| 19 | Faucet LUSD could be swapped for distributor XLM with no outflow cap. | `93ca969` | fixed |
| 20 | Leaderboard points for calls used the price at indexing, not at open. | `b855903` | fixed |
| 21 | `vault/stats` and `vault/events` shared one rate-limit key for all clients. | `f63d12c` | fixed |
| 22 | Hourly in-memory limits reset after 10 minutes. | `f63d12c` | fixed |
| 23 | The settlement sweep never reached ids more than 2,000 past the oldest open one. | `f63d12c` | fixed |
| 24 | Anyone could use up a named wallet's co-signature rate limit. | `b855903` | fixed |
| 25 | A co-signature held the premium for 100 ledgers. It now lasts 12. | `b855903` | fixed |
| 26 | Anyone could index another wallet's position under a chosen `txHash`. | `b855903` | fixed, retested |
| 34 | Form rate limits trusted the client-written forwarded IP. | `b13a504` | fixed |
| 35 | Alerts reached Slack unescaped. | `4a47dc1` | fixed |
| 36 | Health probes were unbounded and showed host and role names in errors. | `82b6bc8` | fixed |
| 37 | Public route errors leaked DB hosts, roles and RPC endpoints. | `738aa46` | fixed |
| 38 | Analytics bodies had no size cap and were limited per session id. | `915dff2` | fixed |
| 39 | Read routes shared one rate-limit bucket, and anyone could force a paid commentary refresh. | `e8b715f` | fixed |
| 40 | `CRON_SECRET` was compared in non-constant time. | `87bdba6` | fixed |
| 41 | Random keys could inflate the user count. | `3ce4d96` | fixed |
| 42 | A news feed could link a headline to a `javascript:` URL. | `d7a5c3c` | fixed |
| 43 | `sslmode=no-verify` in `DATABASE_URL` could turn off the certificate check. | `2847d69` | fixed |
| 44 | The Gemini key went in the query string. | `3646201` | fixed |
| 45 | The production CSP allowed `'unsafe-eval'`. | `5435f35` | fixed |
| 46 | The wallet kit tracked `latest`. | `02929cf` | fixed |
| 47 | Report IPs were kept forever. They are now cleared after 90 days. | `87b0df9` | fixed |
| 48 | Next.js, axios, protobufjs, postcss, ws and other dependency advisories. | `10c863c`, `2fbd859`, `8b4bae9` | fixed |
| 49 | Analytics rows were never deleted. | `f63d12c` | fixed |
| 50 | Public routes read the whole request body before any size check. | `fbfeb4f`, `f63d12c` | fixed |
| 51 | Public chain reads were rate-limited by the caller's chosen address. | `f63d12c` | fixed |
| 52 | Bridge crossings could earn deposit points through the APR backfill. | `b855903` | fixed |
| 53 | One client could use up the faucet's global daily cap. | `93ca969` | fixed |
| 56 | `hasTrustline` read a Horizon outage as "no trustline" and told writers to open one they already had. Only a 404 now means no trustline, and the co-signature answers an outage with `503 trustline_check_unavailable`. | `f57d560` | fixed, retested |
| 57 | Report alerts shared an email quota with the risk monitor's critical alerts. Reports now get at most 10 emails a day; past that they still reach Slack and the admin panel. | `1d7d734` | fixed, test |
| 58 | A position can't be indexed once its opening transaction is past the RPC's event retention. | `6a08abb` | fixed, retested |

`ADVERSARIAL.md` §6 describes findings 1 to 26 in full. Each fix commit includes its
regression test.

## Retests

We replayed each of these against `https://lusty.finance`, at `2e4dffb` on 2026-10-25, at
`b7b672e` on 2026-10-26 for 56, and against the v5 instances on 2026-11-08 for 54, 55 and
59. Every request got the answer the fix introduced.

| # | Attack | Result |
|---|---|---|
| 1 | `POST /api/swap` with a failed 1 LUSD payment to the distributor (`02d1645d…b882`) | `400 tx_failed` |
| 3 | `GET /api/debug/db` with no session | `403 not authorized` |
| 10 | `POST /api/swap` with `txHash` = `x/../a2ee9636…af4` | `400 invalid_tx_hash` |
| 10 | `POST /api/anchor/bridge` with `txHash` = `x/../e85eb526…602` | `400 invalid_tx_hash` |
| 29 | `POST /api/vault/authorize` with expiry `2026-11-06T08:00:01Z`, one second off the schedule | `400 unscheduled_expiry` |
| 30 | `POST /api/swap` with a real 50 LUSD payment from 2026-09-19 | `400 funding_stale` |
| 31 | `POST /api/vault/deposit` for XLM position #28 from another address | `403 owner_mismatch` |
| 26 | `POST /api/vault/deposit` for position #28 with position #27's `txHash` | `409 open_mismatch` |
| 56 | `POST /api/vault/authorize` on the BTC book from an account Horizon has never seen | `400 trustline_required` (the 404 branch) |
| 56 | The same, from an account that holds the LBTC trustline | passes the check, stops at the placeholder entry |
| 54, 59 | `record_price` simulated on the XLM v5 book for the 02:15 UTC period of 2026-11-08 | `15071809198399`, the Reflector record for that period, to the unit |
| 54, 59 | `record_price` for an expiry an hour ahead | `NotExpired` |
| 55 | `/api/health` after the redeploy | both books on their v5 instance, limits reconciled, no drift |
| 58 | `proveOpen` against XLM v4 #21 and #12, opened 2026-09-17 and 2026-08-16, whose `deposit` events the RPC no longer has | each proven from Horizon by exactly one of the owner's 18 contract calls, at its close time |

`node scripts/adversarial/refuse.mjs` simulates contract attacks on both live books without
submitting anything. Each attempt failed with the expected error: `AlreadySettled`,
`PositionNotFound`, `LastQuoter`, `InvalidLimit`, or a required admin signature for
`set_limits` and quoter changes.

`npx vitest run` at `6a08abb` passes all 848 tests in 85 files, and `cargo test` in
`contracts` passes all 91 contract tests. At `b7b672e` the app suite was 821 tests in 83 files. `trustline-check`,
`security-report` and `notify-escape` cover 56 and 57, and each of their new tests fails on
the code before the fix. A Horizon outage (56's other branch) and an alert flood (57) can't be
staged against the live site without causing the problem, so those tests are the retest. The same
holds for the branch of 54 and 59 that matters, a Reflector record missing at expiry, and for
55's 30-day release: `a_late_first_caller_cannot_pick_a_later_print`,
`record_price_takes_the_first_record_after_a_missing_one`, `settle_falls_back_to_the_next_period_record`
and the unpriced-release tests each fail on the code before the fix. Findings 2, 4, 7, 27 and 28
can't be replayed live without a signed, funded transaction or a Horizon outage, so their
tests are the retest: `swap-proof`, `anchor-bridge-proof`, `deposit-dedupe`, `payout-submit`
and `quote-reservations`. `outage-fail-closed` takes each dependency down in turn and checks
that quoting, co-signing and payouts refuse.

## Fixed in v5

54: if Reflector skips the record for an expiry period, v4 falls back to any `lastprice` from
within an hour of expiry, including one from just before it, so whoever settles first chooses
the price. v5 reads only the oracle's period records: the expiry period's, else the first
record after it within `MAX_PRICE_STALENESS_SECS` (one hour), never `lastprice`. A record does
not change once written, so every caller gets the same price whenever they ask, and the first
settlement or `record_price` stores it on chain for every later position on that expiry.

59: v5 as first written limited the fallback to `lastprice` readings from at or after
expiry. That still let the first caller wait inside the hour, while the latest print moved
every five minutes, and pin whichever suited them. It was reported by email on 2026-11-08,
before any v5 instance had taken a position, and fixed in `718dab4` by the rule above. The two
v5 instances deployed earlier that day without it were replaced unused.

55: Reflector keeps about a day of history. After that, v4's `settle` fails with
`StalePrice`, and v4 has no admin release and no upgrade path. Nine XLM v4 positions (#8 to
#18) were stranded this way in Tranche 1, before this window, when the settlement sweep was
switched off. v5 stores each expiry's price on chain at the first settlement and releases a
position nobody could price as kept 30 days after expiry. The sweep now also walks retired
instances (`583ef6a`), so moving a book to a new instance no longer strands what is open on
the old one.

## Fixed after the v5 move

58: the indexer proves a position's open from the `deposit` event its transaction emitted,
and the Soroban RPC keeps events and transactions for a few days only, so a position indexed
later was refused for good. It moved no funds and recorded nothing wrong. Past the RPC's
retention, `proveOpen` (`6a08abb`) now reads the transaction from Horizon, which keeps the
history: the envelope must be one successful `open` or `deposit` on this instance whose
arguments are this position's terms, and the close time stands in for the event's. Horizon
no longer returns a call's result, so it cannot name the id the call produced; when the owner
holds another position with identical terms, the claim is refused rather than guessed. Fee
bumps are refused, as for 27.

## Remaining risks

These limits are accepted and listed in `ADVERSARIAL.md` §7. LBTC and LUSD are unbacked test
assets. Test capital comes from a faucet.

The vault has not been independently audited. v5 is new code, and 59 shows the settlement
path can hide a mistake our own reviews and tests missed. An external audit is planned
before mainnet.

The v4 instances, and the two v5 instances replaced on 2026-11-08 by the fix for 59, cannot
return their pool liquidity: they predate `request_withdrawal`. From the instances now live
on, idle liquidity can go back to the treasury, a day after an announced request the admin
can cancel. That path is admin-only and can never reach collateral or a reserved payout.

The admin multisig is the bound on `set_limits`: on v5 a raise binds only after 24 hours,
announced by a `lim_raise` event the monitor alerts on, and the same holds for withdrawals
(`wd_req`). The admin and the quoter are separate accounts, which v5 also enforces on chain.

## Reproducing

```bash
git checkout 6a08abb && npm ci
npx vitest run
cargo test --manifest-path contracts/Cargo.toml
node scripts/adversarial/refuse.mjs
```

The HTTP retests are plain `curl` requests with the bodies above. Every hash is a public
testnet transaction you can look up on Horizon.
