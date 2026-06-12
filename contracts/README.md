# Lusty Soroban contracts

Trustless settlement layer for the Lusty options vault. As of v2 the full
money loop runs on-chain: escrow, premium payout and oracle settlement are all
enforced by the contract. There is no custodial account and no server payout
to trust.

## `vault`, the covered-call vault (v2)

```
fund(from, amount)                                  permissionless cash-pool top-up
deposit(owner, amount, strike, expiry, premium) → id
    escrow collateral + pay the premium in cash, one atomic tx
settle(id) → "kept" | "assigned"                    permissionless, oracle-decided
position(id), config()                              views
```

`settle()` enforces standard covered-call economics:

- The settlement price comes from the Reflector feed at the expiry timestamp,
  normalized to the feed resolution. When the writer claims has no effect on
  the outcome. The contract falls back to `lastprice` only while it is fresh
  (at most one hour old).
- Above the strike the position is assigned: collateral goes to the treasury
  and the writer receives the strike value in cash, the same payoff as selling
  the collateral at the strike.
- At or below the strike the position is kept and the collateral comes back
  whole. The writer keeps the premium in both cases.
- A stale or empty feed blocks settlement rather than settling at a wrong
  price.

Pricing works like an RFQ. `deposit` requires auth from the writer and from
the protocol's quoter key (the pricing engine), so neither side can set the
premium alone. Custody and settlement never depend on the quoter.

Units: strikes use the oracle's `decimals()` scale (Reflector: 14). Collateral
and cash amounts are 7-decimal token units, so
`strike_value = amount × strike / 10^14`.

### Known limitation, tracked for T2

The quoter key bounds the premium, and nothing else does: a compromised quoter
could quote itself the entire cash pool. The planned fix is an in-contract
premium ceiling (a percentage of collateral value) plus a multi-sig quoter.
Until then the pool should hold working capital only.

### Out of scope for this PoC (Tranche 3)

Cash-secured puts, position tokens, upgrade governance, and automated pool
solvency management. Today ops funds the pool through `fund`.

## Build and test

```sh
cd contracts
cargo test                # 17 unit tests incl. a mock Reflector oracle
stellar contract build    # target/wasm32v1-none/release/lusty_vault.wasm
```

## Testnet deployments

The contract takes its cash token as a constructor parameter, so the same wasm
backs both instances below.

| What | Address |
| --- | --- |
| Vault v2, LUSD cash (matches the testnet web app) | `CAWDKJUH5WSXJVOOAUGULE4HY2TTYSXUSI5QXTDKUZ6J5L4UTXWPK2Y4` |
| Vault v2, USDC cash (mainnet framing demo) | `CASVHBJ7MOZ5YFSVAYXKZFWIYAR6Y3Q4JI2P6GGJMRFUJBZN6APTZEZD` |
| Reflector oracle (external CEX/DEX feed) | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Feed asset | `Other("XLM")`, 14 decimals, 300 s resolution |
| Collateral token | native XLM SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| LUSD SAC | `CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB` |
| Test USDC SAC | `CA7W4C26OTIHHFK3KMP7HGJH63ZD337534OPMGCKDZFNW62BCLRIQL6B` |
| Vault v1 (escrow-only PoC) | `CDUHKBXJCIQCU4PCHBJRN5BNFGNLXGKXKA74YAJHF3B7XABIFMGURB4B` |

On testnet the LUSD instance is the product-consistent one, since the web app
pays premiums in LUSD. On mainnet the cash token is Circle's native USDC; LUSD
has no mainnet path. The demo deployments set `quoter` to the demo wallet for
CLI convenience. The dual-auth requirement itself is enforced by the contract
and covered by unit tests.

Deploy command:

```sh
stellar contract deploy \
  --wasm target/wasm32v1-none/release/lusty_vault.wasm \
  --network testnet --source-account <key> \
  -- \
  --oracle CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63 \
  --feed XLM \
  --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --cash <cash token SAC> \
  --treasury <treasury account> \
  --quoter <pricing engine key>
```

### Verified on testnet (2026-06-12)

ITM and OTM positions were opened and settled end to end against the live
Reflector feed, on both instances. The premium arrived in the writer's wallet
in the deposit transaction itself. The assigned position paid the writer
exactly 50 XLM × $0.15 = $7.50 in cash and routed the collateral to the
treasury. The kept position returned its collateral whole. Both vault token
balances were zero after settlement.
