# Lusty Soroban contracts

Trustless settlement layer for the Lusty options vault. The full money loop
runs on-chain: escrow, premium payout and oracle settlement are all enforced by
the contract. There is no custodial account and no server payout to trust.

## `vault`, the options vault (v4)

```
open(owner, kind, amount, strike, expiry, premium) → id
    escrow collateral + pay the premium in cash, one atomic tx
deposit(owner, amount, strike, expiry, premium) → id     covered-call alias for open
settle(id) → "kept" | "assigned"          permissionless, oracle-decided
fund(from, amount)                        cash pool top-up, permissionless
fund_underlying(from, amount)             underlying pool top-up, permissionless
set_limits(limits)                        admin-only

position(id), position_count(owner), positions_of(owner, start, limit)
stats(), escrowed(kind), owed(kind), exposure(kind, expiry), limits(), config()
```

### Two legs, one machine

`kind` is `Call` (0) or `Put` (1). Both share the escrow, premium and
settlement machinery; they differ only in which token is escrowed and which
side of the strike assigns. The symmetry is the design:

| | Covered call | Cash-secured put |
| --- | --- | --- |
| Collateral escrowed | the underlying | cash, `strike × units` |
| Assigns when | `price > strike` | `price < strike` |
| Assignment pays the writer | cash `amount × strike / 10^dec` | `amount × 10^dec / strike` of the underlying |
| Paid out of | the cash pool | the underlying pool |

`amount` is always the collateral, in the escrowed token's units. A call covers
one unit of the underlying per unit escrowed; a put covers whatever its cash
buys at the strike.

Each kind's collateral is denominated in the token the *other* kind pays out
in. That is what lets the two pools be kept apart: a pool's free balance is
`balance − escrowed(other kind)`, never the raw balance, so one writer's escrow
can never fund another's payout.

### Settlement

`settle()` is permissionless — the outcome is deterministic, so the writer
never depends on the protocol being online.

- The settlement price comes from the Reflector feed at the expiry timestamp,
  normalized to the feed resolution. When the writer claims has no effect on
  the outcome. The contract falls back to `lastprice` only while it is fresh
  (at most one hour old).
- On assignment the escrowed collateral goes to the treasury and the writer
  receives the other leg — the same payoff as transacting at the strike.
- Otherwise the position is kept and the collateral comes back whole. The
  writer keeps the premium either way.
- A stale or empty feed blocks settlement rather than settling at a wrong
  price.

### What the contract refuses

Checks run before any collateral moves, and a failure reverts the whole
deposit:

| Check | Error |
| --- | --- |
| Pool cannot cover this position's assignment payout | `InsufficientPool` (10) |
| Position above `Limits::max_position_{call,put}` | `PositionTooLarge` (11) |
| Limits that cannot both be satisfied | `InvalidLimit` (12) |
| Expiry at `Limits::max_expiry_{call,put}` | `ExpiryFull` (13) |
| Premium above `Limits::max_premium_bps` of the collateral | `PremiumTooHigh` (14) |

The solvency check and the settlement payout are computed by the same
function, so the amount reserved at open is exactly the amount paid at
settlement — the guard cannot drift from what it guards.

### Roles

Pricing works like an RFQ. `open` requires auth from the writer and from one of
the protocol's quoter keys (the pricing engine), so neither side can set the
premium alone. Custody and settlement never depend on a quoter.

Which quoter is signing is an argument to `open`, not something the contract
looks up. Authorization has to be demanded of one specific address: requiring
every member of the set to sign would need all of them online, and the contract
cannot ask "did any of you sign?" after the fact. Naming the signer keeps the
check exact — the address must be in the set **and** must have authorized that
exact call.

The quoter prices inside a band it cannot widen. `Limits::max_premium_bps` caps
every premium at a share of the collateral escrowed against it, so the worst a
stolen pricing key can do is overpay that share on positions it also has to
collateralize — not empty the cash pool.

The collateral is valued at the **oracle price, never at the strike**. That
distinction is the whole guard: the strike is the quoter's own number, so a
strike-denominated ceiling would rise with it, and one stroop of XLM written at
a $10,000 strike could buy an arbitrarily large premium. Priced at spot,
raising the ceiling means escrowing more real collateral, which
`max_position_{call,put}` already bounds.

A put's collateral is cash — the token the premium is paid in — so it needs no
price, and the put leg keeps trading through a feed outage. A call cannot be
written against a stale or empty feed: with no current price there is no
honest way to value what is being escrowed, so the write fails closed.

`admin` sets the risk limits and maintains the quoter set, and that is the whole
of its power: it cannot move collateral, price an option, or settle a position,
and tightening a limit does not reach collateral already escrowed under the old
one.

`add_quoter` and `remove_quoter` are how a pricing key is rotated or revoked.
Rotation is add-then-remove: the contract refuses to empty the set (`LastQuoter`),
so there is no ledger in between where a writer would be turned away. Revocation
does not reach backwards — positions the revoked key priced keep their premium
and their escrow, and settle normally, because settlement never consults a
quoter. The set is bounded at 8: every member can price up to the premium
ceiling, so it is a trust surface rather than a capacity knob.

The premium ceiling is the one limit that also widens something — the band the
quoter prices in. The admin cannot pay a premium and the quoter cannot raise
its own ceiling, so the two keys bound each other and must be separate
accounts, as they are on testnet.

Units: strikes use the oracle's `decimals()` scale (Reflector: 14). Collateral
and cash amounts are 7-decimal token units, so
`strike_value = amount × strike / 10^14`.

### What is left to the account layer

The contract now bounds what a stolen pricing key is worth (`max_premium_bps`)
and gives the admin a way to revoke it (`remove_quoter`). Both are on-chain and
enforced.

What remains is deliberately outside the contract: how the admin account itself
is controlled. `add_quoter` is the one call that can widen who may set a
premium, so the admin belongs behind a multisig — a Stellar account change this
contract neither sees nor needs to, since it authorizes an address and does not
care how that address is controlled. Until that is in place, a compromise costs
the bounded share until the key is rotated out.

The contract does not record which quoter priced which position. Attribution
would make a post-compromise audit exact rather than time-bounded; it is a
`Position` field and a Tranche 3 item, not a safety gap.

### Out of scope (Tranche 3)

Position tokens, upgrade governance, and automated pool solvency management.
Today ops funds both pools through `fund` / `fund_underlying`.

## Build and test

```sh
cd contracts
cargo test                # 60 unit tests incl. a mock Reflector oracle
stellar contract build    # target/wasm32v1-none/release/lusty_vault.wasm
```

## Deploying

Every version so far has been a fresh instance, and has had to be: the contract
has no `upgrade` entrypoint (that is Tranche 3), so its code is fixed once
deployed. v3 added `admin` and `Limits` to the constructor; v4 adds
`max_premium_bps` to `Limits` and replaces the single `--quoter` with a
`--quoters` set, changing that constructor's shape again.

```sh
stellar contract deploy \
  --wasm target/wasm32v1-none/release/lusty_vault.wasm \
  --network testnet --source-account <key> \
  -- \
  --oracle CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63 \
  --feed XLM \
  --token <underlying SAC> \
  --cash <cash token SAC> \
  --treasury <treasury account> \
  --quoters '["<pricing engine key>"]' \
  --admin <admin account> \
  --limits '{"max_position_call":"100000000000","max_position_put":"100000000000","max_expiry_call":"5000000000000","max_expiry_put":"5000000000000","max_premium_bps":2000}'
```

Position and expiry limits are in the kind's collateral units at 7 decimals —
the values above are 10,000 XLM and 10,000 cash per position, 500,000 per
expiry.

`max_premium_bps` is a share of collateral, not a token amount. 2000 (20%)
sits about 3.5× above anything the pricing engine can quote: the engine's own
ceiling is `MAX_APR` 120% scaled by tenor, so a 17-day position tops out near
5.6% of capital and a 27-day one near 8.9%. The gap is headroom for the
engine's knobs, not room the quoter is expected to use — tighten it toward the
engine's real maximum once the expiry ladder settles. Raising `MAX_APR` or
adding much longer expiries is what would push a legitimate quote into it.

Two things have to be set up before the vault can trade, and both fail late
rather than at deploy:

- **Fund both pools.** `fund` covers the cash that pays premiums and call
  assignments; `fund_underlying` covers the asset a put assignment delivers. A
  put cannot be opened against an empty underlying pool — the contract refuses
  rather than promise a delivery it cannot make.
- **Give the treasury a trustline for the cash token.** An assigned put sends
  its cash collateral to the treasury, and a classic asset cannot be received
  without a trustline. Miss this and puts open normally but revert at
  settlement, from inside the token contract rather than the vault. Calls do
  not hit it, since assigned calls route native XLM.

The application reads the deployed instance from `NEXT_PUBLIC_VAULT_CONTRACT`
and co-signs with `VAULT_QUOTER_SECRET`.

### Verifying a deployment

The Stellar CLI cannot open a position: `open` needs authorization from the
writer and the quoter, and only one of them is the transaction source, so the
quoter's entry has to be signed on its own. `scripts/verify-vault.mjs` does
that round trip locally — the same one `/api/vault/authorize` performs in
production — and exercises both legs on both sides of the strike:

```sh
node scripts/verify-vault.mjs open           # writes 4 positions, prints ids
node scripts/verify-vault.mjs settle 0 1 2 3 # after expiry
node scripts/verify-vault.mjs stats          # pools, escrow, exposure, solvency
```

## Testnet deployment

The live instance runs **v4** — the premium ceiling and the quoter set are both
enforced on chain.

| What | Address |
| --- | --- |
| **Vault v4** (calls + puts, LUSD cash) | `CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ` |
| Reflector oracle (external CEX/DEX feed) | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Feed asset | `Other("XLM")`, 14 decimals, 300 s resolution |
| Underlying — native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Cash — LUSD SAC | `CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB` |
| Treasury | `GCXVANOIFHM7IAAZTDEEOYW7WUDO7ETVJYVEO74LA23JSXQJP4TAJVUX` |
| Quoter set — one member (pricing engine) | `GC7Z4LVQCUOU7FMRBX4WOGANARQGM4SZTACKMSQSMGIOO4KEAASHLOTX` |
| Admin (limits and the quoter set) | `GBDNJQDP4HJQH6WCJCYVYGTKDRYKZXQQSVEC4FOE24CVG4VRQU26IKEC` |

Limits at deploy: 10,000 per position on both legs; 500,000 per expiry on both
legs; premium ceiling 2,000 bps (20% of collateral at spot). Pools seeded with
20,000 LUSD and 100,000 XLM.

The v3 instance is retired but its pools are not recoverable: `fund` and
`fund_underlying` are one-way, and collateral leaves only through `settle`. A
retired instance keeps whatever is left in it, which is the standing cost of
having no `upgrade` entrypoint — worth pricing in before a deployment, not
after.

### Permissionless settlement, verified on chain (2026-07-30)

Four more positions (#4–#7) were written by the usual writer and then settled
by `GAF3A2PPHM5TB56YXBNYJNWCDI4UV75BP7WUIXJQHBOTPAOMGDD6LXIC` — a freshly
funded account with no relationship to the writer, the quoter, the admin or the
treasury. Settlement price $0.172147; all four outcomes correct, escrow and
obligations back to zero.

The writer settling their own position proves nothing about who *may* settle,
which is why this was run from a stranger. What the stranger got for it: the
account went from 10,000 XLM to 9,999.98777, the difference being transaction
fees. It received no payout, no fee share and no privilege. Settlement is a
public good the vault will accept from anyone and pay nobody for, so a stalled
operator cannot strand a position — any observer can close it, and the price it
closes at was fixed by the oracle at expiry either way.

### Quoter rotation, verified on chain (2026-07-30)

Run against the live v4 instance, in order:

| Call | Source | Result |
| --- | --- | --- |
| `add_quoter` | admin | set goes to 2, `quoter`/`add` event |
| `remove_quoter` | non-admin | refused — the admin's signature is missing |
| `remove_quoter` | admin | set back to 1, `quoter`/`remove` event |
| `remove_quoter` on the last member | admin | refused, `Error(Contract, #17)` |

The last row is the one worth having: the guard that keeps rotation
add-then-remove is enforced by the contract, not by operator discipline.

### Verified on testnet (2026-07-30)

Four positions written and settled end to end against the live Reflector feed,
covering both legs on both sides of the strike. Settlement price at expiry:
$0.172713.

| Position | Strike | Outcome | Payout |
| --- | --- | --- | --- |
| call, 100 XLM | $0.20 | kept | collateral returned whole |
| call, 100 XLM | $0.15 | assigned | collateral to treasury, $15 cash to the writer |
| put, 20 LUSD | $0.15 | kept | collateral returned whole |
| put, 20 LUSD | $0.20 | assigned | cash to treasury, 100 XLM delivered to the writer |

Every premium arrived in the writer's wallet inside the opening transaction,
and every `open` named its quoter and carried that key's co-signature — the
v4 path, not a compatibility shim.

Escrow, outstanding obligations and per-expiry exposure all returned to zero
after the last settlement, and both sides reconcile to the stroop. The writer
nets −0.5 LUSD (premiums +4.5, put collateral −40, kept put +20, call
assignment +15) and zero XLM (200 escrowed, 100 returned, 100 to treasury, 100
delivered by the assigned put). The pools land where the payouts say they
should: cash 20,000 → 19,980.5 (premiums and the call's strike value),
underlying 100,000 → 99,900 (the put's delivery).

The treasury's trustline for the cash token is a standing prerequisite, found
the hard way on the v3 deployment: an assigned put sends its cash collateral
to the treasury, and without the trustline settlement reverts from inside the
LUSD contract rather than the vault. It carried over to v4 already in place.

### Superseded deployments

**Vault v3** — `CDNES2LSMDPISV6W3PT3KHZXCLGBU6FG2EK6S3V422V6ZYIMVRGXTHKG`. Both
legs, no premium ceiling, a single immutable quoter. Replaced by v4 on
2026-07-30 with no open positions outstanding, so nothing was stranded except
the pools themselves.

The ones below ran the v2 (call-only) contract against the previous testnet and
are kept for provenance; testnet resets have since cleared their state.

| What | Address |
| --- | --- |
| Vault v2, LUSD cash | `CAWDKJUH5WSXJVOOAUGULE4HY2TTYSXUSI5QXTDKUZ6J5L4UTXWPK2Y4` |
| Vault v2, USDC cash | `CASVHBJ7MOZ5YFSVAYXKZFWIYAR6Y3Q4JI2P6GGJMRFUJBZN6APTZEZD` |
| Vault v1 (escrow-only PoC) | `CDUHKBXJCIQCU4PCHBJRN5BNFGNLXGKXKA74YAJHF3B7XABIFMGURB4B` |
| Test USDC SAC | `CA7W4C26OTIHHFK3KMP7HGJH63ZD337534OPMGCKDZFNW62BCLRIQL6B` |

Verified end to end on 2026-06-12: ITM and OTM covered calls were opened and
settled against the live Reflector feed on both instances. The premium arrived
in the writer's wallet in the deposit transaction itself; the assigned position
paid exactly 50 XLM × $0.15 = $7.50 in cash and routed the collateral to the
treasury; the kept position returned its collateral whole.
