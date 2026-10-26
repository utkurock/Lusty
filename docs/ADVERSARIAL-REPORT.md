# Adversarial testnet report

This report covers the adversarial window described in [`ADVERSARIAL.md`](./ADVERSARIAL.md).
The window opened on 2026-10-06 00:00 UTC, passed the grant's fourteen-day minimum on
2026-10-20, and stays open until mainnet. Findings reported after 2026-10-26 will be added
here.

## Status

| | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Found | 1 | 8 | 9 | 40 | 58 |
| Fixed and live | 1 | 8 | 7 | 39 | 55 |
| Open | 0 | 0 | 2 | 1 | 3 |

Every Critical and High finding is fixed and running on `lusty.finance`. We retested them
against the live site on 2026-10-25 and 2026-10-26, apart from the few that need a signed,
funded transaction or a Horizon outage. Our regression tests cover those.

Three findings are still open. Two are Medium. Both sit in the settlement path
of the live v4 contract and are fixed by deploying v5, which is due by 2026-11-20 (see "Open
findings"). The third is Low and fails closed.

Nobody outside the team submitted a report during the window. The private report form
received nothing (`security_reports` is empty), and no GitHub issue was filed. Every finding
below comes from our own reviews.

Severity uses the grant's definitions, quoted in `ADVERSARIAL.md` §4. We count a finding as
fixed only when it meets the five conditions in §5: root cause found, fix merged, regression
test in the same commit, redeployed, and the original scenario retried.

## Deployment under test

| | |
|---|---|
| Application | `https://lusty.finance`, Stellar testnet |
| Deployed commit | [`b7b672e`](https://github.com/utkurock/Lusty/commit/b7b672e), deployed 2026-10-26 |
| XLM book | `CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ` (vault v4) |
| BTC book | `CBQEACXAOZMCU3YOUWDC3MWXDSQBWKNGKBA6XMRPY5D5JQRNP2HLMVEU` (vault v4) |
| Admin | `GBDNJQDP4HJQH6WCJCYVYGTKDRYKZXQQSVEC4FOE24CVG4VRQU26IKEC` (2-of-3 multisig) |
| Quoter | `GC7Z4LVQCUOU7FMRBX4WOGANARQGM4SZTACKMSQSMGIOO4KEAASHLOTX` |

The site served `2e4dffb` during the retests of 2026-10-25 and was redeployed at `b7b672e` on
2026-10-26 with the fixes for 56 and 57. We checked each version from the outside: the docs
page shows the text that commit added (this report, for `b7b672e`), the CSP no longer allows
`'unsafe-eval'` (`5435f35`), and `/api/swap` returns the canonical-hash error added in
`93ca969`. Other addresses are in
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

All fixes in this report are off-chain, in the API and the operator scripts, so none needed a
new contract. The v5 contract in `contracts/vault` is not deployed yet.

The findings came from these reviews:

| Review | Date | Findings |
|---|---|---|
| Money paths, auth and deployment config | 2026-09-18 (before the window) | 1 to 6 |
| Outage scripting, one dependency down at a time | 2026-10-06 | 7 to 9 |
| Money path, settlement and public routes | 2026-10-09 | 27 to 47 |
| Dependency advisories | 2026-10-09 to 10-10 | 48 |
| Full audit of `8b4bae9` (19 agents, each candidate re-verified) | 2026-10-10 | 10 to 26, plus leads 49 to 54 and 57 |
| Retest for this report | 2026-10-25 | 58 |

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

### Medium: seven fixed, two open

| # | Finding | Fix | Status |
|---|---|---|---|
| 5 | The quoter checked only the root of the authorization tree it signed. | `92f1078` | fixed, test |
| 6 | A revoked admin could still get a session for two minutes, and admin login had no rate limit. | `92f1078` | fixed, test |
| 11 | Quote reservations from throwaway addresses could block a strike for 14 days. | `b855903` | fixed, test |
| 30 | Swap funding had no age limit and could pay more than the quote, which gave the caller a free option on the price. | `fc3e066` | fixed, retested |
| 31 | Anyone could index a dust position under someone else's funding hash and get that person's swap refused. | `1e6510c` | fixed, retested |
| 32 | A few unsettleable positions could use up the settlement runner's whole cap. | `d48a360` | fixed, test |
| 33 | A wallet removed from the admin list kept its session until it expired. | `b1ac59c` | fixed, test |
| 54 | If Reflector has no record for the exact expiry period, v4 falls back to `lastprice` and the first settler picks the price. | v5 | open, due 2026-11-20 |
| 55 | On v4, a position not settled within about a day of oracle history is locked for good. | v5 | open, due 2026-11-20 |

### Low: 39 fixed, one open

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
| 58 | A position can't be indexed once its opening transaction is past the RPC's event retention. | not a code fix | open |

`ADVERSARIAL.md` §6 describes findings 1 to 26 in full. Each fix commit includes its
regression test.

## Retests

We replayed each of these against `https://lusty.finance`, at `2e4dffb` on 2026-10-25 and at
`b7b672e` on 2026-10-26 for 56. Every request got the answer the fix introduced.

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

`node scripts/adversarial/refuse.mjs` simulates contract attacks on both live books without
submitting anything. Each attempt failed with the expected error: `AlreadySettled`,
`PositionNotFound`, `LastQuoter`, `InvalidLimit`, or a required admin signature for
`set_limits` and quoter changes.

`npx vitest run` at `b7b672e` passes all 821 tests in 83 files. `trustline-check`,
`security-report` and `notify-escape` cover 56 and 57, and each of their new tests fails on
the code before the fix. A Horizon outage (56's other branch) and an alert flood (57) can't be
staged against the live site without causing the problem, so those tests are the retest. Findings 2, 4, 7, 27 and 28
can't be replayed live without a signed, funded transaction or a Horizon outage, so their
tests are the retest: `swap-proof`, `anchor-bridge-proof`, `deposit-dedupe`, `payout-submit`
and `quote-reservations`. `outage-fail-closed` takes each dependency down in turn and checks
that quoting, co-signing and payouts refuse.

## Open findings

54 and 55 are Medium. Both are in the live v4 contract and are fixed by the same v5
deployment, due 2026-11-20 and in any case before mainnet.

54: if Reflector skips the exact record for an expiry period, v4 falls back to any
`lastprice` from within an hour of expiry, including one from just before it. Whoever settles
first chooses the price. In normal operation `lastprice` is the latest record, so the fallback
does not come into play. The settlement runner also settles each expiry within 15 minutes, and
the off-chain gate refuses off-schedule expiries (29). The fix is v5 with the fallback limited
to the first record at or after the expiry, deployed as new instances for both books.

55: Reflector keeps about a day of history. After that, v4's `settle` fails with `StalePrice`,
and v4 has no admin release and no upgrade path. This happened in Tranche 1, before this
window, when the settlement sweep was switched off and nine positions passed the deadline.
Their collateral is still escrowed. We rate it Medium because we found no way for an attacker
to cause it: `settle` is permissionless, so a position is stranded only if the runner and
every owner miss a full day. The runner now sweeps every book from the lowest unsettled id
(23, 32), and the monitor raises a critical alert for any position past the window. v5 stores
each expiry's price on chain at the first settlement and releases positions nobody could price
after 30 days. The runner already supports this (`b1f4406`).

58, the one open Low finding, moves no funds. It refuses late indexing rather than recording
anything wrong, and utilization already reads on-chain exposure (12). It comes from how long
the Soroban RPC keeps events, so there is no code fix to make.

## Remaining risks

These limits are accepted and listed in `ADVERSARIAL.md` §7. LBTC and LUSD are unbacked test
assets. Test capital comes from a faucet. The rate limiter can let one extra request through
when replicas race, and falls back to a per-process count if the database is down. One
circuit breaker covers every book. A `set_limits` raised and then restored between two
readings is reported afterwards rather than blocked; the admin multisig is the real bound.

Until v5 is deployed, the off-chain gate enforces the expiry grid, and the admin and quoter
are kept separate by configuration. A stolen quoter key is then bounded by v4's premium
ceiling and caps.

## Reproducing

```bash
git checkout b7b672e && npm ci
npx vitest run
node scripts/adversarial/refuse.mjs
```

The HTTP retests are plain `curl` requests with the bodies above. Every hash is a public
testnet transaction you can look up on Horizon.
