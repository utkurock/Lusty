# Lusty Soroban Contracts

Trustless settlement layer for the Lusty options vault. v2 closes the **full
money loop on-chain** — escrow, premium payout, and oracle settlement are all
contract-enforced; no custodial account and no server-side payout to trust.

## `vault` — covered-call vault (v2)

```
fund(from, amount)                                  permissionless cash-pool top-up
deposit(owner, amount, strike, expiry, premium) → id
    escrow collateral + pay the premium in cash (USDC) — one atomic tx
settle(id) → "kept" | "assigned"                    permissionless, oracle-decided
position(id), config()                              views
```

Covered-call economics, enforced by `settle()`:

- The settlement price is read from the Reflector feed **at the expiry
  timestamp** (normalized to the feed resolution), so claim timing gives the
  writer no optionality. Falls back to `lastprice` only while fresh (≤ 1 h).
- `price > strike` → **assigned**: collateral goes to the treasury and the
  writer receives the strike value in cash — economically identical to
  selling the collateral at the strike.
- `price ≤ strike` → **kept**: collateral returned whole; the writer keeps
  the premium either way.
- Stale or empty feed **blocks settlement** (fail-closed) instead of settling
  at a wrong price.

Pricing is a signed offer (RFQ): `deposit` requires auth from both the writer
and the protocol's **quoter** key, so neither side can set the premium alone.
Custody and settlement never depend on the quoter.

Units: strikes are scaled to the oracle's `decimals()` (Reflector: 14);
collateral and cash amounts are 7-decimal token units, so
`strike_value = amount × strike / 10^14`.

### Out of scope for this PoC (Tranche 3)

Cash-secured puts, position tokens, upgrade governance, automated pool
solvency management (today ops funds the pool via `fund`).

## Build & test

```sh
cd contracts
cargo test                # 17 unit tests incl. a mock Reflector oracle
stellar contract build    # target/wasm32v1-none/release/lusty_vault.wasm
```

## Testnet deployment (v2)

The contract is cash-token agnostic (`cash` is a constructor parameter). Two
v2 instances are live on testnet:

| What | Address |
| --- | --- |
| **Vault v2 — LUSD cash** (matches the testnet web app) | `CDKFRHEK2BAST2RWQIM254UGBRPCUDS5P3TRPW2EQCHANVMPQQYPKOAR` |
| Vault v2 — USDC cash (mainnet framing demo) | `CASVHBJ7MOZ5YFSVAYXKZFWIYAR6Y3Q4JI2P6GGJMRFUJBZN6APTZEZD` |
| Reflector oracle (external CEX/DEX feed) | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Feed asset | `Other("XLM")`, 14 decimals, 300 s resolution |
| Collateral token | native XLM SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| LUSD SAC | `CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB` |
| Test USDC SAC | `CA7W4C26OTIHHFK3KMP7HGJH63ZD337534OPMGCKDZFNW62BCLRIQL6B` |
| Vault v1 (escrow-only PoC) | `CDUHKBXJCIQCU4PCHBJRN5BNFGNLXGKXKA74YAJHF3B7XABIFMGURB4B` |

On testnet the LUSD instance is the product-consistent one (the web app pays
premiums in LUSD). On mainnet the cash token is Circle's native USDC — LUSD
has no mainnet path. The live testnet demo deployments set `quoter` to the
demo wallet for CLI convenience; the dual-auth requirement itself is enforced
by the contract and covered by unit tests.

Deploy command:

```sh
stellar contract deploy \
  --wasm target/wasm32v1-none/release/lusty_vault.wasm \
  --network testnet --source-account <key> \
  -- \
  --oracle CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63 \
  --feed XLM \
  --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --cash <USDC SAC> \
  --treasury <treasury account> \
  --quoter <pricing engine key>
```

### Verified on-chain (testnet, 2026-06-12)

ITM and OTM positions opened and settled end-to-end against the live
Reflector feed: premium received atomically at deposit; assigned position
paid the writer exactly `50 XLM × $0.15 = $7.50` in cash with collateral
routed to the treasury; kept position returned collateral whole; vault
balance zero after settlement.
