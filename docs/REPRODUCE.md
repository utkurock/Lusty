# Reproducing every protocol flow

Runnable, from a clean checkout, against the deployed testnet instances. This is what to
start from before reporting anything — a finding expressed as a diff against one of these
is a finding that can be triaged in an hour instead of a week.

Scope and severity: [`ADVERSARIAL.md`](./ADVERSARIAL.md). Addresses:
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md). How to report: [`REPORTING.md`](./REPORTING.md).

```sh
git clone https://github.com/utkurock/Lusty && cd Lusty && npm install
```

Nothing below needs a `.env.local`. The published addresses are the defaults.

---

## 0. Read the book — no key, no permission

```sh
node scripts/reproduce/read.mjs XLM
node scripts/reproduce/read.mjs BTC
node scripts/reproduce/read.mjs BTC 3        # and position #3
```

Prints `config()`, `quoters()`, `limits()`, `stats()`, the solvency invariant computed
from the contract's own figures, and `exposure(kind, expiry)` for every open date.

Everything is simulated, never submitted. The one account named is a probe that simulation
requires to exist.

**What to check first.** The solvency lines are the contract's own invariant:

```
balance(payout) − escrowed(opposite) ≥ owed(kind)
```

A call pays cash and a put escrows cash, so the two legs share the cash balance; a put pays
the underlying and a call escrows it. Neither leg may dip into what the other is holding
for somebody else. If either line prints `*** BROKEN ***`, that is Critical on its own and
needs no further exploit — report it with the output.

The same output is how you check the published manifest rather than believing it: run it
and compare against [`DEPLOYMENTS.md`](./DEPLOYMENTS.md) line by line.

---

## 1. Quote

The public quote endpoint is the single source of truth for what the vault will pay. It
takes no key and is rate limited per IP.

```sh
BASE=https://lusty.finance

# The whole ladder for one expiry
curl -s "$BASE/api/vault/quote?asset=BTC&side=call&expiry=2026-10-09T08:00:00.000Z" | jq

# One strike
curl -s "$BASE/api/vault/quote?asset=BTC&side=call&expiry=2026-10-09T08:00:00.000Z&strike=80000" | jq

# By tenor instead of date, with a utilization of your choosing
curl -s "$BASE/api/vault/quote?asset=XLM&side=put&days=7&strike=0.21&util=0.4" | jq
```

**Prefer `expiry` over `days`.** With a date, the tenor *and* the pool utilization are
derived server-side by the same function the co-signature calls — so the quote you are
shown was priced from the inputs the premium will actually be priced from. A
caller-supplied `util` is a display convenience for exploring the curve; it cannot raise
what the vault pays, because the authorize step reprices from the expiry regardless.

Spot is fetched server-side, so a caller cannot bias a quote with a stale or inflated
price. Attacking that claim is class 1 in [`ADVERSARIAL.md` §3](./ADVERSARIAL.md).

The response carries the full derivation — realized σ, the σ sold at, the forward, the
haircut, the ladder normalization — so "where does this APR come from" has an arithmetic
answer rather than an assurance.

**Things worth trying here:** an off-ladder strike nearer the money than any rung; a strike
from one book against another book's `asset`; a tenor shorter than the book's declared
minimum; an expiry that is not one the schedule keeps open; a `util` outside 0..1.

---

## 2. Open a position — the co-signed write

`open` requires authorization from **two** parties: the writer, who escrows the collateral,
and the quoter, who attests the premium. Only one of them can be the transaction source, so
the quoter's entry is signed on its own and merged in. The Stellar CLI cannot do this,
which is why there is a script.

With the quoter's key (maintainers):

```sh
node scripts/verify-lifecycle.mjs BTC fund 5000 0.5   # both pools, one-way
node scripts/verify-lifecycle.mjs BTC open            # 4 positions, prints ids
node scripts/verify-lifecycle.mjs BTC stats           # pools, escrow, solvency
```

Without it — which is the position an attacker is in — the quoter's signature comes from
the public endpoint, exactly as the browser gets it:

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

   The route reprices the premium from the engine rather than trusting `premium`, and
   matches the authorization entry against that quote **byte for byte** — contract,
   function, every argument, and everything nested beneath the call. A mismatch is
   described rather than merely refused, so the response tells you which argument differed.

3. Rebuild the transaction carrying the returned quoter entry, sign as the writer, submit.
4. `POST /api/vault/deposit` with the `txHash` and the contract-assigned `positionId` to
   index it. The route reads the position **off the ledger**, so it cannot be lied to about
   what the position is — only about whether to record it.

`asset` absent means XLM, which is the Tranche 1 default and still honoured.

**Things worth trying here:** an entry whose root matches and whose sub-invocations do not;
a premium above the repriced quote; a strike outside the ladder; the same `positionId`
reported twice under different hashes; a position opened in one book and indexed as
another; a size above `max_position_*`; enough positions to cross `max_expiry_*` or the
per-wallet epoch allowance. Classes 1, 2, 4, 5, 10 and 15.

---

## 3. Expiry and settlement — permissionless

`settle` checks **no caller identity**. It prices the outcome from the oracle's reading at
the position's own expiry and pays the position's owner. Anyone can settle anyone's
position; the settler pays a fee and receives nothing.

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

The recorded lifecycle's six settlements were submitted exactly this way, from an account
with no relationship to the writer, the quoter, the admin or the treasury — see
[`TESTNET-EVIDENCE.md`](./TESTNET-EVIDENCE.md).

**The deadline.** Reflector keeps about 24 hours of history. A position whose expiry has
rolled out of that window can no longer be priced at its expiry, and the contract refuses
rather than settling it against a price it was not written against. `read.mjs` shows the
expiry; the sweep reports such positions as stranded.

**Things worth trying here:** settling before expiry; settling twice; settling a position
whose expiry is outside the oracle window; settling with a price record from a neighbouring
timestamp; settling an id from one book against the other book's instance; making a
position that is expired and inside the window refuse to settle. Classes 6 to 10.

---

## 4. Claim

There is nothing to claim. The contract pays at settlement, straight to the writer's
wallet, in the same transaction that closes the position. A kept call returns its
collateral; an assigned call pays the strike in cash and sends the collateral to the
treasury; a kept put returns its cash; an assigned put delivers the underlying bought at
the strike.

Verify by reading the balances either side of a `settle`:

```sh
node scripts/reproduce/read.mjs BTC          # before
node scripts/verify-lifecycle.mjs BTC settle <id>
node scripts/reproduce/read.mjs BTC          # after
```

The arithmetic for one full run — four branches, one settlement price, every balance
reconciled against the rule that produced it — is written out in
[`TESTNET-EVIDENCE.md`](./TESTNET-EVIDENCE.md).

A payout the writer cannot receive is a real failure mode: an assignment pays in a token
that needs a trustline. `node scripts/deploy-vault.mjs BTC --check` reports whether the
treasury can receive what an assignment would send it.

---

## 5. Fund the pools

A book with empty pools refuses to write, correctly: a premium it cannot pay and an
assignment it cannot deliver are the two promises a vault must never make.

```sh
node scripts/verify-lifecycle.mjs BTC fund 5000 0.5    # 5,000 cash, 0.5 underlying
```

Funding is one-way. There is no withdrawal entrypoint, which is why
`scripts/reproduce/read.mjs` prints the pool balances beside what is escrowed and owed
against them — the only thing that can happen to funded capital is that it pays somebody.

`fund` publishes a `fund` event naming which pool, so the indexer shows top-ups alongside
deposits and settlements.

---

## 6. Admin

Two entrypoints, both behind the admin: `set_limits` and the quoter set. The admin account
is a **2-of-3 multisig** and cannot source a single-signature transaction at all.

Read what is currently in force — no key needed:

```sh
node scripts/reproduce/read.mjs XLM     # limits() and quoters(), off the chain
```

The admin cannot take custody. It cannot move collateral, settle a position, or alter one
after the fact. The quoter cannot either: its only power is to decline to co-sign. That
separation is the point, and
[`SECURITY.md`](./SECURITY.md) documents why the two accounts must be different.

**Things worth trying here:** any admin action without the multisig; adding yourself to the
quoter set; obtaining an admin session on the HTTP API without an allowlisted key; keeping
a session past a revocation; replaying a challenge or reusing a nonce. Classes 11 and 12.

---

## 7. Protocol rails — faucet, swap, anchor

These spend protocol funds rather than user collateral, and one of them has already been
drained once (finding 1 in [`ADVERSARIAL.md` §6](./ADVERSARIAL.md)).

```sh
BASE=https://lusty.finance
curl -s -X POST "$BASE/api/faucet/xlm"  -d '{"address":"G…"}' -H 'content-type: application/json'
curl -s -X POST "$BASE/api/faucet/lusd" -d '{"address":"G…"}' -H 'content-type: application/json'
curl -s -X POST "$BASE/api/faucet/lbtc" -d '{"address":"G…"}' -H 'content-type: application/json'
```

One claim per address per asset per day, with a per-address lifetime cap and a global daily
cap behind it. Those caps are durable; the rate limiter in front of them is not (see the
known limitations).

The swap desk pays out against a payment you claim to have made. It now requires a
**successful** transaction, from the address claiming it, to the distributor, in the asset
the direction names, and in the amount claimed — and it sizes the payout from the ledger's
number, never the caller's.

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

LBTC is the tight one: its whole supply was minted once and the vault's pool comes out of
it. If the daily bound is stopping you from reaching a limit you are trying to test, say so
in a report rather than working around it — being unable to reach a bound is itself worth
knowing, and we would rather raise it than have the class go untested.

---

## What is not scripted yet

The unprivileged open path in §2 is documented step by step but has no script of its own;
today it is exercised through the browser or through `verify-lifecycle.mjs`, which needs
the quoter's key. A script that walks it using only `/api/vault/authorize` — the same way
an outside attacker would — is the missing piece, and it is what the scripted attack
harness is built on top of.
