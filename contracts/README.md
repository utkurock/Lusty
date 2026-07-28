# Lusty Soroban contracts

Trustless settlement layer for the Lusty options vault. The full money loop
runs on-chain: escrow, premium payout and oracle settlement are all enforced by
the contract. There is no custodial account and no server payout to trust.

## `vault`, the options vault (v3)

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

The solvency check and the settlement payout are computed by the same
function, so the amount reserved at open is exactly the amount paid at
settlement — the guard cannot drift from what it guards.

### Roles

Pricing works like an RFQ. `open` requires auth from the writer and from the
protocol's quoter key (the pricing engine), so neither side can set the premium
alone. Custody and settlement never depend on the quoter.

`admin` sets the risk limits, and that is its only power: it cannot move
collateral, price an option, or settle a position, and tightening a limit does
not reach collateral already escrowed under the old one.

Units: strikes use the oracle's `decimals()` scale (Reflector: 14). Collateral
and cash amounts are 7-decimal token units, so
`strike_value = amount × strike / 10^14`.

### Known limitation, tracked for T2

The quoter key bounds the premium, and nothing else does: a compromised quoter
could quote itself the entire cash pool. The planned fix is an in-contract
premium ceiling (a percentage of collateral value) plus a multi-sig quoter.
Until then the pool should hold working capital only.

### Out of scope (Tranche 3)

Position tokens, upgrade governance, and automated pool solvency management.
Today ops funds both pools through `fund` / `fund_underlying`.

## Build and test

```sh
cd contracts
cargo test                # 37 unit tests incl. a mock Reflector oracle
stellar contract build    # target/wasm32v1-none/release/lusty_vault.wasm
```

## Deploying

v3 changes the constructor — it takes an `admin` and an initial `Limits` — so
an existing v2 instance cannot be upgraded into it. A v3 instance is a new
deployment.

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
  --quoter <pricing engine key> \
  --admin <admin account> \
  --limits '{"max_position_call":"100000000000","max_position_put":"100000000000","max_expiry_call":"5000000000000","max_expiry_put":"5000000000000"}'
```

Limits are in the kind's collateral units at 7 decimals — the values above are
10,000 XLM and 10,000 cash per position, 500,000 per expiry.

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

| What | Address |
| --- | --- |
| **Vault v3** (calls + puts, LUSD cash) | `CDNES2LSMDPISV6W3PT3KHZXCLGBU6FG2EK6S3V422V6ZYIMVRGXTHKG` |
| Reflector oracle (external CEX/DEX feed) | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Feed asset | `Other("XLM")`, 14 decimals, 300 s resolution |
| Underlying — native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Cash — LUSD SAC | `CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB` |
| Treasury | `GCXVANOIFHM7IAAZTDEEOYW7WUDO7ETVJYVEO74LA23JSXQJP4TAJVUX` |
| Quoter (pricing engine) | `GC7Z4LVQCUOU7FMRBX4WOGANARQGM4SZTACKMSQSMGIOO4KEAASHLOTX` |
| Admin (limits only) | `GBDNJQDP4HJQH6WCJCYVYGTKDRYKZXQQSVEC4FOE24CVG4VRQU26IKEC` |

Limits at deploy: 10,000 per position on both legs; 500,000 XLM and 50,000 cash
per expiry. Pools seeded with 20,000 LUSD and 100,000 XLM.

### Verified on testnet (2026-07-28)

Five positions written and settled end to end against the live Reflector feed,
covering both legs on both sides of the strike. Settlement price at expiry:
$0.17284.

| Position | Strike | Outcome | Payout |
| --- | --- | --- | --- |
| call, 100 XLM (×2) | $0.20 | kept | collateral returned whole |
| call, 100 XLM | $0.15 | assigned | collateral to treasury, $15 cash to the writer |
| put, 20 LUSD | $0.15 | kept | collateral returned whole |
| put, 20 LUSD | $0.20 | assigned | cash to treasury, 100 XLM delivered to the writer |

Every premium arrived in the writer's wallet inside the opening transaction.
Escrow, outstanding obligations and per-expiry exposure all returned to zero
after the last settlement, and the writer's balances reconcile exactly:
100 → 100.5 LUSD (premiums +5.50, put collateral −40, kept put +20, call
assignment +15) with XLM back where it started net of fees.

The put assignment is where the treasury trustline requirement surfaced: the
first attempt reverted inside the LUSD contract with "trustline entry is
missing", not in the vault. Adding the trustline settled it unchanged.

### Superseded deployments

These ran the v2 (call-only) contract against the previous testnet and are kept
for provenance; testnet resets have since cleared their state.

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
