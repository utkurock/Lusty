# Lusty Soroban Contracts

Trustless settlement layer for the Lusty options vault. This is the Tranche-1
proof of concept: it moves the two trust assumptions of the server-side vault
(custodial collateral, server-decided settlement) into a Soroban contract with
on-chain Reflector oracle settlement.

## `vault` — covered-call escrow PoC

```
deposit(owner, amount, strike, expiry) → id   collateral escrowed by the contract
settle(id) → "kept" | "assigned"              permissionless, oracle-decided
position(id), config()                        views
```

Settlement rule (mirrors the off-chain vault exactly):

- The price is read from the Reflector feed **at the expiry timestamp**
  (normalized to the feed resolution), so claim timing gives the writer no
  optionality. Falls back to `lastprice` only while fresh (≤ 1 h).
- `price > strike` → assigned: collateral routed to the treasury.
- `price ≤ strike` → kept: collateral returned to the writer.
- Stale or empty feed **blocks settlement** (fail-closed) instead of settling
  at a wrong price.

Strikes are scaled to the oracle's `decimals()` (Reflector: 14), amounts are in
token stroops.

### Out of scope for the PoC (Tranche 2)

Premium payout in LUSD at deposit, cash-secured puts, swapping assigned
collateral at the strike (today it routes to the treasury whole), position
tokens, admin/upgrade governance.

## Build & test

```sh
cd contracts
cargo test                # 14 unit tests incl. a mock Reflector oracle
stellar contract build    # target/wasm32v1-none/release/lusty_vault.wasm
```

## Testnet deployment

| What | Address |
| --- | --- |
| Vault contract | `CDUHKBXJCIQCU4PCHBJRN5BNFGNLXGKXKA74YAJHF3B7XABIFMGURB4B` |
| Reflector oracle (external CEX/DEX feed) | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Feed asset | `Other("XLM")`, 14 decimals, 300 s resolution |
| Collateral token | native XLM SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

Deploy command:

```sh
stellar contract deploy \
  --wasm target/wasm32v1-none/release/lusty_vault.wasm \
  --network testnet --source-account <key> \
  -- \
  --oracle CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63 \
  --feed XLM \
  --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --treasury <treasury account>
```
