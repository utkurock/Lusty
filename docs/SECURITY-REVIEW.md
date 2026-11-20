# Security review

What is being reviewed, where every area the review has to cover lives in the code, what the
review is looking for, how severity is decided, and how to build the exact artefact that was
reviewed. Findings and their remediation are recorded here too, as they arrive.

The review covers a release candidate, not a branch. The candidate is frozen at a signed tag
before the review starts and the wasm hash below is the hash deployed to the public network —
if a finding changes the contract, the hash changes, the manifest changes with it, and the
reviewer retests. Nothing reaches the public network that the reviewer has not seen at the
hash it runs.

---

## 1. The release candidate

| | |
| --- | --- |
| Tag | `rc1` *(annotated and signed; filled in at freeze)* |
| Commit | *(filled in at freeze)* |
| Contract version | v6 |
| Wasm hash (sha-256) | *(filled in at freeze, from the CI build; written to `release/public.json`)* |
| Built by | `.github/workflows/release.yml` from the tag, with a provenance attestation |
| Manifest | [`release/public.json`](../release/public.json) — the reviewed hash, each book's config and limits, every role account's signers and thresholds |
| Networks | Reviewed for the public network. The same code runs on testnet. |

The contract is immutable: there is no upgrade entrypoint and no admin path to collateral. A
change to the contract is a new instance plus a `VAULT_RETIRED_<SYMBOL>` entry, which is how
v5 replaced v4 and v6 replaces v5. For the review this is the point: the artefact cannot be
mutated out from under the report.

---

## 2. Scope

Every area in scope, mapped to the file and the function that implements it. A reviewer should
not have to guess where "signed-quote verification" lives.

### 2.1 The contract

`contracts/vault/src/lib.rs`, with its tests in `contracts/vault/src/test.rs`.

| Area | Where |
| --- | --- |
| Collateral custody and withdrawal authorization | `open`, `settle`, `request_withdrawal`, `cancel_withdrawal`, `execute_withdrawal`, `free_liquidity` |
| Covered-call and cash-secured-put accounting | `open`, `settle`, `owed`, `escrowed`, `exposure`, `Position` |
| Solvency | `require_solvent`, `Error::InsufficientPool` (10), `stats` |
| Signed-quote verification, replay and expiration | `open`'s quoter auth entry, and the co-signature's own window in `src/lib/quoter.ts` / `src/lib/quote-client.ts` (12 ledgers) |
| Quoter permissions | `add_quoter`, `remove_quoter`, `is_quoter`, `MAX_QUOTERS`, `Error::QuoterIsAdmin` (19), `LastQuoter` (17), `TooManyQuoters` (18) |
| Premium ceilings | `Limits::max_premium_bps`, `Error::PremiumTooHigh` (14) |
| Position, expiry and open-interest limits | `Limits`, `set_limits`, `pending_limits` (raises bind after one day, narrowings at once), `Error::PositionTooLarge` (11), `ExpiryFull` (13), `OpenInterestFull` (27) |
| Emergency pause | `pause` (guardian), `unpause` (admin only), `paused`, `Error::Paused` (24), `GuardianIsAdmin` (25), `GuardianIsQuoter` (26) |
| Reflector integration, expiry and settlement-price selection | the reflector client, `feed_params`, `record_price`, `recorded_price`, `Error::NoPrice` (7), `StalePrice` (8) |
| Permissionless settlement and double settlement | `settle`, `Error::AlreadySettled` (5), `NotExpired` (6) |
| The thirty-day release | `settle`'s release path for a position the oracle can no longer price |
| Decimals and precision | every division in `open` and `settle`; the boundary tests in `test.rs` at public-network magnitudes |
| Admin and multisig | `Config::admin`, `Config::guardian`, the account controls in [`SECURITY.md`](./SECURITY.md) |
| Multi-asset isolation | one instance per book: `__constructor` takes the feed, the collateral and the cash, and there is no shared balance |

### 2.2 The money path in the application

| Area | Where |
| --- | --- |
| Quote pricing and its inputs | `src/lib/pricing-server.ts`, `src/lib/pricing.ts`, `src/lib/vol.ts`, `src/lib/smile.ts`, `src/lib/forward.ts` |
| Quote signing, reservations and replay | `src/lib/quoter.ts`, `src/lib/quote-policy.ts`, `src/lib/quote-client.ts`, `src/lib/idempotency.ts` |
| Limits reconciliation before anything is quoted | `src/lib/vault-limits.ts` (declared ↔ instance, fail-closed after a one-hour grace) |
| Pause read | `src/lib/vault-contract.ts` (`getVaultPaused`), refused at quote and authorize |
| Deposit indexing and position proof | `src/lib/deposit-client.ts`, `src/lib/open-proof.ts`, `src/lib/positions.ts` |
| Settlement runner | `src/lib/settlement.ts`, `src/lib/settlement-sweep.ts`, `src/lib/settlement-scheduler.ts`, `src/app/api/cron/settle` |
| Payouts | `src/lib/payout-submit.ts` |
| Liquidity-routing boundaries | `src/lib/routing/*`, [`LIQUIDITY-ROUTING.md`](./LIQUIDITY-ROUTING.md) |
| Asset declarations and their validation | `src/lib/assets/*` (public-network cash must be Circle's USDC; no asset this repository issues) |
| Network resolution | `src/lib/network.mjs`, `src/lib/stellar.ts`, `scripts/lib/network.mjs` — one variable, no testnet fallback on the public network |

### 2.3 Deployment, release and operations

| Area | Where |
| --- | --- |
| Deployment procedures | `scripts/deploy-vault.mjs`, `scripts/lib/deploy-guard.mjs` (refuses the public network unless the wasm, the desk, the limits and every role account match the manifest) |
| Release manifest and drift | `release/<network>.json`, `src/lib/drift.mjs`, `scripts/check-drift.mjs` |
| Role accounts, signers and thresholds | [`SECURITY.md`](./SECURITY.md), and `ROLE_CONTROLS` in `scripts/lib/deploy-guard.mjs` |
| Behaviour when a dependency is unavailable | [`FAILURE-MODES.md`](./FAILURE-MODES.md), `src/lib/__tests__/failure-modes.test.ts` |
| Monitoring and automatic halts | `src/lib/monitor/*`, `src/lib/circuit-breaker.ts` |

### 2.4 Explicitly out of scope

Not because it does not matter, but so the review's time goes where the money is:

- Testnet-only surfaces: the faucet, the LUSD and LBTC mints, the swap desk and the
  circle-style USDC bridge. All four answer 404 on the public network
  (`src/lib/testnet-only.ts`, `testnet-only-surfaces.test.ts`).
- Front-end presentation: the landing page, charts, docs rendering, analytics.
- The admin dashboard's own authentication beyond the fact that it cannot sign anything.
- Marketing copy and the published documents, except where they state a security property.

---

## 3. Threat model

Who is assumed to be hostile, what they are assumed to hold, and what must still be true.

| Adversary | Holds | Must not be able to |
| --- | --- | --- |
| Any user | A funded account, the public endpoints | Write a position outside the limits, pay itself a premium, settle a position at a price other than its expiry's, settle twice, open while paused, or make another writer's collateral unreachable |
| A compromised quoter key | A quoter's signature | Exceed `max_premium_bps`, raise it, appoint another quoter, move collateral, or settle. At worst it overpays on positions that are collateralized anyway |
| A compromised settlement runner | `SETTLE_RUNNER_SECRET` and the fee account | Do anything an anonymous account cannot: `settle` is permissionless, pays the owner, and prices off the expiry's oracle record |
| A single admin signer | One of the admin account's three keys | Change anything. The admin is 2-of-3, and a raise it does schedule does not bind for a day |
| A single guardian signer | One of the guardian account's keys | Anything but pause. Pause stops new positions; settlement, `record_price` and the thirty-day release keep working, and only the admin unpauses |
| A compromised application server | The quoter key, the runner key, the database | Reach escrowed collateral. The server holds no admin key, no guardian key and no issuer key, and the contract takes its orders from signatures, not from this server |
| A hostile oracle operator | Reflector's feed | Be the only input. Settlement reads period records, never the live price, and a position the oracle cannot price is released after thirty days rather than locked |
| The asset issuers | Circle's USDC, the BTC anchor's asset | Nothing within the protocol's control — a frozen or clawed-back trustline is an accepted risk, recorded in §6 and stated to users |

Assumptions the review is entitled to challenge: that Reflector's period records for an expiry
are available for roughly a day on the public network; that one instance per book is sufficient
isolation; and that a quoter's twelve-ledger signature window is short enough.

---

## 4. Severity

The reviewer's severity is the one recorded. These are the definitions used when one has to be
argued about.

| Severity | Definition | Response |
| --- | --- | --- |
| **Critical** | Collateral can be taken, destroyed, or made permanently unreachable; or the solvency invariant can be broken | Fix and a regression test in one commit, then retest, before anything reaches the public network |
| **High** | A limit, a permission or the settlement price can be bypassed without taking collateral directly; or a position can be made unsettleable | Same: fix, regression test, retest |
| **Medium** | A bound can be reached that the design did not intend, or an operational step can fail in a way that needs a human and has no alert | Fix, or a recorded mitigation with a remediation plan and a date |
| **Low** | Defence in depth, or a failure that is visible and recoverable | Fix, or a reasoned "won't fix" in the table below |
| **Info** | Observation, style, or a documentation correction | Fix at will |

Every Critical and High fix carries its regression test in the same commit, and the commit
names the finding (`Fix R-xx: …`).

---

## 5. Building and reproducing the reviewed artefact

```sh
git clone https://github.com/utkurock/Lusty && cd Lusty && git checkout rc1
npm install
```

**The contract.** Built in CI from the tag so the hash can be traced to the source; the same
build locally:

```sh
cd contracts/vault
cargo test                       # the contract's own suite
stellar contract build
sha256sum ../target/wasm32v1-none/release/lusty_vault.wasm
```

That hash must equal the one in §1 and in `release/public.json`.

**The application.**

```sh
npm test                         # the whole suite
npx tsc --noEmit
```

**Against a live deployment.** [`REPRODUCE.md`](./REPRODUCE.md) runs every flow from a clean
checkout against the deployed instances — reading a book, quoting, writing a covered call and a
cash-secured put, settling, and the solvency invariant printed from the chain.

**Against the release manifest.**

```sh
node scripts/check-drift.mjs --manifest release/public.json
```

Compares each instance's wasm hash, config, limits, quoter set and guardian, and every role
account's signers and thresholds, against the reviewed record. It reads only and needs no key,
so a reviewer can run it unaided.

---

## 6. Accepted risks

Stated here rather than discovered: these are known, deliberate, and visible to users.

- **Issuer controls on the settlement assets.** Circle can freeze a USDC trustline; the BTC
  anchor can freeze, and depending on the asset's flags claw back. If the vault's trustline is
  frozen, settlement stops for that leg. The protocol has no defence beyond the choice of
  asset, which is why the anchor's `auth_revocable` and `clawback_enabled` flags are part of
  the deployment record.
- **Oracle availability.** A feed that stops publishing stops settlement at the expiry's price.
  Positions past the oracle window are released after thirty days rather than locked, which
  bounds the loss to the price difference, not the collateral.
- **The guardian can pause.** Any single guardian signer can stop new positions. That is the
  point of it, and it cannot reach collateral, settlement or a payout.

---

## 7. Findings

Filled in as the review proceeds. One row per finding, the reviewer's severity, the commit that
fixes it, the test that would catch it again, and the retest.

| id | Finding | Severity | Status | Fix | Regression test | Retested |
| --- | --- | --- | --- | --- | --- | --- |
| | *(none recorded yet — the review has not started)* | | | | | |

---

## 8. Changes since the review

Any change to the contract or the money path after the reviewed tag goes here, with why it was
made and whether it was re-reviewed. CI fails when a commit touches a scope path above and is
not recorded here.

| Commit | What changed | Why | Re-reviewed |
| --- | --- | --- | --- |
| | *(none)* | | |

---

## 9. Summary

Filled in when the review closes: the reviewed version, the scope, every finding and its
remediation status, and the reviewer's own report.
