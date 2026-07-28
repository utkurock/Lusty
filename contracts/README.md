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

Both pools need funding before the vault can quote: `fund` for the cash that
pays premiums and call assignments, `fund_underlying` for the asset a put
assignment delivers. A put cannot be opened against an empty underlying pool —
the contract refuses rather than promise a delivery it cannot make.

The application reads the deployed instance from `NEXT_PUBLIC_VAULT_CONTRACT`
and co-signs with `VAULT_QUOTER_SECRET`.

## Reference addresses (testnet)

| What | Address |
| --- | --- |
| Reflector oracle (external CEX/DEX feed) | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Feed asset | `Other("XLM")`, 14 decimals, 300 s resolution |
| Native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

### Superseded deployments

These ran the v2 (call-only) contract against the previous testnet and are kept
for provenance; testnet resets have since cleared their state.

| What | Address |
| --- | --- |
| Vault v2, LUSD cash | `CAWDKJUH5WSXJVOOAUGULE4HY2TTYSXUSI5QXTDKUZ6J5L4UTXWPK2Y4` |
| Vault v2, USDC cash | `CASVHBJ7MOZ5YFSVAYXKZFWIYAR6Y3Q4JI2P6GGJMRFUJBZN6APTZEZD` |
| Vault v1 (escrow-only PoC) | `CDUHKBXJCIQCU4PCHBJRN5BNFGNLXGKXKA74YAJHF3B7XABIFMGURB4B` |
| LUSD SAC | `CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB` |
| Test USDC SAC | `CA7W4C26OTIHHFK3KMP7HGJH63ZD337534OPMGCKDZFNW62BCLRIQL6B` |

Verified end to end on 2026-06-12: ITM and OTM covered calls were opened and
settled against the live Reflector feed on both instances. The premium arrived
in the writer's wallet in the deposit transaction itself; the assigned position
paid exactly 50 XLM × $0.15 = $7.50 in cash and routed the collateral to the
treasury; the kept position returned its collateral whole.
