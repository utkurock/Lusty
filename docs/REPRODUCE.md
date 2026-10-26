# Reproducing every protocol flow

Every flow below runs from a clean checkout against the deployed testnet instances. A
finding written as a diff against one of them is the quickest to triage.

Scope and severity: [`ADVERSARIAL.md`](./ADVERSARIAL.md). Addresses:
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md). How to report: [`REPORTING.md`](./REPORTING.md).

```sh
git clone https://github.com/utkurock/Lusty && cd Lusty && npm install
```

Nothing below needs a `.env.local`; the published addresses are the defaults.

---

## 0. Read the book — no key, no permission

```sh
node scripts/reproduce/read.mjs XLM
node scripts/reproduce/read.mjs BTC
node scripts/reproduce/read.mjs BTC 3        # and position #3
```

Prints `config()`, `quoters()`, `limits()`, `stats()`, the solvency invariant and
`exposure(kind, expiry)` for every open date. All of it is simulated; the one named account
is a probe that simulation needs.

**What to check first.** The solvency lines are the contract's own invariant:

```
balance(payout) − escrowed(opposite) ≥ owed(kind)
```

Cash pays calls and escrows puts; the underlying pays puts and escrows calls. Neither leg
may dip into the other's escrow. `*** BROKEN ***` on either line is Critical on its own, so
report it with the output. The same output lets you check
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md) line by line.

---

## 1. Quote

The public quote endpoint is the source of truth for what the vault pays. No key; rate
limited per IP.

```sh
BASE=https://lusty.finance

# The whole ladder for one expiry
curl -s "$BASE/api/vault/quote?asset=BTC&side=call&expiry=2026-10-09T08:00:00.000Z" | jq

# One strike
curl -s "$BASE/api/vault/quote?asset=BTC&side=call&expiry=2026-10-09T08:00:00.000Z&strike=80000" | jq

# By tenor instead of date, with a utilization of your choosing
curl -s "$BASE/api/vault/quote?asset=XLM&side=put&days=7&strike=0.21&util=0.4" | jq
```

**Prefer `expiry` over `days`.** With a date, the server derives tenor and utilization
exactly as the co-signature does, so the quote matches the premium. A caller's `util` only
explores the curve; authorize reprices from the expiry. Spot is fetched server-side
(attacking that is class 1 in [`ADVERSARIAL.md` §3](./ADVERSARIAL.md)), and the response
shows the full derivation: realized σ, σ sold at, forward, haircut, ladder normalization.

**Things worth trying here:** an off-ladder strike nearer the money than any rung; a strike
from one book against another book's `asset`; a tenor shorter than the book's declared
minimum; an expiry the schedule does not keep open; a `util` outside 0..1.

---

## 2. Open a position — the co-signed write

`open` needs the writer's authorization (escrowing collateral) and the quoter's (attesting
the premium). Only one can source the transaction, so the quoter's entry is signed
separately and merged in, which the Stellar CLI cannot do.

With the quoter's key (maintainers):

```sh
node scripts/verify-lifecycle.mjs BTC fund 5000 0.5   # both pools, one-way
node scripts/verify-lifecycle.mjs BTC open            # 4 positions, prints ids
node scripts/verify-lifecycle.mjs BTC stats           # pools, escrow, solvency
```

Without the key, as an attacker, get the quoter's signature from the public endpoint like
the browser does:

1. Build the `open` invocation against the book's instance and **simulate** it. The
   simulation returns the authorization entries the call needs.
2. `POST /api/vault/authorize` with those entries:

   ```json
   {
     "address":          "G… the writer",
     "asset":            "BTC",
     "side":             "call",
     "collateralAmount": 0.01,
     "strikePrice":      80000,
     "expiryIso":        "2026-10-09T08:00:00.000Z",
     "premium":          8.0,
     "authEntries":      ["<base64 SorobanAuthorizationEntry>", "…"]
   }
   ```

   The route reprices instead of trusting `premium` and matches the entry against its own
   quote byte for byte, down to every nested argument. A mismatch response names the
   argument that differed.

3. Rebuild the transaction with the returned quoter entry, sign as the writer, submit.
4. `POST /api/vault/deposit` with the `txHash` and the contract-assigned `positionId` to
   index it. The route reads the position from the ledger; the caller only decides whether
   it is recorded.

No `asset` means XLM (the Tranche 1 default).

**Things worth trying here:** an entry whose root matches and whose sub-invocations do not;
a premium above the repriced quote; a strike outside the ladder; the same `positionId`
reported twice under different hashes; a position opened in one book and indexed as
another; a size above `max_position_*`; enough positions to cross `max_expiry_*` or the
per-wallet epoch allowance. Classes 1, 2, 4, 5, 10 and 15.

---

## 3. Expiry and settlement — permissionless

`settle` checks no caller identity: it prices from the oracle at the position's expiry and
pays the owner. Anyone can settle; the settler pays the fee and gets nothing.

```sh
node scripts/reproduce/read.mjs BTC 3     # is it expired? still open?
node scripts/verify-lifecycle.mjs BTC settle 2 3 4 5
```

Or directly, with any funded account:

```sh
stellar contract invoke \
  --id CBQEACXAOZMCU3YOUWDC3MWXDSQBWKNGKBA6XMRPY5D5JQRNP2HLMVEU \
  --source-account <your-key> --network testnet \
  -- settle --id 3
```

The six settlements in [`TESTNET-EVIDENCE.md`](./TESTNET-EVIDENCE.md) were sent this way by
an account unrelated to the writer, quoter, admin and treasury.

**The deadline.** Reflector keeps about 24 hours of history; after that a position cannot
be priced at its expiry and will not settle. `read.mjs` shows the expiry, and the sweep
reports such positions as stranded.

**Things worth trying here:** settling before expiry; settling twice; settling a position
whose expiry is outside the oracle window; settling with a price record from a neighbouring
timestamp; settling an id from one book against the other book's instance; making a
position that is expired and inside the window refuse to settle. Classes 6 to 10.

---

## 4. Claim

Nothing to claim: settlement pays the writer's wallet in the closing transaction. A kept
call returns its collateral; an assigned call pays the strike in cash and sends the
collateral to the treasury; a kept put returns its cash; an assigned put delivers the
underlying bought at the strike.

Compare the balances either side of a `settle`:

```sh
node scripts/reproduce/read.mjs BTC          # before
node scripts/verify-lifecycle.mjs BTC settle <id>
node scripts/reproduce/read.mjs BTC          # after
```

[`TESTNET-EVIDENCE.md`](./TESTNET-EVIDENCE.md) reconciles one full run. Assignment payouts
need a trustline; `node scripts/deploy-vault.mjs BTC --check` reports whether the treasury
can receive them.

---

## 5. Fund the pools

Empty pools refuse to write: they could not pay premiums or deliver assignments.

```sh
node scripts/verify-lifecycle.mjs BTC fund 5000 0.5    # 5,000 cash, 0.5 underlying
```

Funding is one-way (no withdrawal entrypoint), so funded capital leaves only by paying
someone; `scripts/reproduce/read.mjs` prints pool balances beside what is escrowed and
owed. Each `fund` emits an event naming the pool for the indexer.

---

## 6. Admin

`set_limits` and the quoter set sit behind the admin, a 2-of-3 multisig that cannot source
a single-signature transaction. Read what is in force:

```sh
node scripts/reproduce/read.mjs XLM     # limits() and quoters(), off the chain
```

Neither admin nor quoter can take custody, move collateral, or settle or alter a position;
the quoter can only decline to co-sign. [`SECURITY.md`](./SECURITY.md) explains why they
must be different accounts.

**Things worth trying here:** any admin action without the multisig; adding yourself to the
quoter set; obtaining an admin session on the HTTP API without an allowlisted key; keeping
a session past a revocation; replaying a challenge or reusing a nonce. Classes 11 and 12.

---

## 7. Protocol rails — faucet, swap, anchor

These spend protocol funds; one was drained once (finding 1 in
[`ADVERSARIAL.md` §6](./ADVERSARIAL.md)).

```sh
BASE=https://lusty.finance
curl -s -X POST "$BASE/api/faucet/xlm"  -d '{"address":"G…"}' -H 'content-type: application/json'
curl -s -X POST "$BASE/api/faucet/lusd" -d '{"address":"G…"}' -H 'content-type: application/json'
curl -s -X POST "$BASE/api/faucet/lbtc" -d '{"address":"G…"}' -H 'content-type: application/json'
```

One claim per address per asset per day, under a per-address lifetime cap and a global
daily cap; caps and rate limiter survive deploys.

The swap desk pays only against a successful payment from the claiming address to the
distributor, in the asset and amount claimed, sized from the ledger rather than the caller.

**Things worth trying here:** proof that is forged, replayed, failed, partial, in the wrong
asset, or from a different account; the same hash twice; a payment to a lookalike issuer's
token. Class 14.

---

## 8. Getting test capital

Everything above needs a funded testnet account.

```sh
# A testnet account with XLM
curl "https://friendbot.stellar.org?addr=<your-G-address>"

# Then the vault's own assets, one claim per day each
curl -s -X POST https://lusty.finance/api/faucet/lusd -d '{"address":"G…"}' -H 'content-type: application/json'
curl -s -X POST https://lusty.finance/api/faucet/lbtc -d '{"address":"G…"}' -H 'content-type: application/json'
```

### What that reaches, and what it does not

| | faucet drip | lifetime, one address | global, one day |
|---|---|---|---|
| XLM | 10,000 (friendbot, once per account) | 10,000 | 1,000,000 |
| LUSD | 1,000 | 10,000 | 500,000 |
| LBTC | 0.01 | 0.05 | 1 |

Against the caps the contracts enforce:

| Cap | XLM book | reachable solo? | BTC book | reachable solo? |
|---|---|---|---|---|
| `max_position_call` | 10,000 | **yes**, exactly | 0.05 | **yes**, after 5 daily claims |
| `max_position_put` | 10,000 | yes, 10 daily claims | 1,500 | yes, 2 daily claims |
| `max_expiry_call` | 500,000 | **no** — 50 funded accounts | 5 | **no** — 100 addresses, 5 days |
| `max_expiry_put` | 500,000 | no — 50 addresses, a day | 150,000 | no — 15 addresses, a day |

One tester can reach every position cap but no expiry cap, so class 4 (limit evasion) is
only half testable from the faucet.

**If a bound is what you are trying to test, ask.** Email the address in
[`REPORTING.md`](./REPORTING.md) with the cap and amount, and we will fund accounts
directly. For LBTC, whose supply was minted once and funds the vault's pool, we may raise
the instance's cap for a day instead. An unreachable bound is worth reporting too.

---

## 9. Our own attempts, and whether they still fail

```sh
node scripts/adversarial/refuse.mjs          # every book
node scripts/adversarial/refuse.mjs BTC      # one
```

One scripted attempt per class the chain can answer, against the live instances, asserting
that the vault refuses for the right reason. It submits nothing, needs no key, funding or
permission, and exits non-zero if anything gets through. Two details keep it honest:

- **`require_auth` cannot be tested by expecting an error.** Simulation records the
  signatures a call needs instead of rejecting, so `set_limits` from a stranger simulates
  cleanly. The check is that the call demanded the admin's signature.
- **An error code belongs to whichever contract raised it.** A token contract's error read
  as the vault's names the wrong rule, so codes are interpreted only when the error names
  the vault.

Each run ends by listing the classes it cannot reach.

---

## What is not scripted yet

The unprivileged open path in §2 has no script; today it runs through the browser or
`verify-lifecycle.mjs`, which needs the quoter's key. The scripted attack harness builds on
the missing piece: a script that walks it using only `/api/vault/authorize`, as an outside
attacker would.

