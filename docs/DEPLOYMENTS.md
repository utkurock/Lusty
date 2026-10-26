# Testnet deployment manifest

Everything Lusty runs on Stellar testnet, each checkable on the network:

- contracts: `https://stellar.expert/explorer/testnet/contract/<id>`
- accounts: `https://stellar.expert/explorer/testnet/account/<id>`
- transactions: `https://stellar.expert/explorer/testnet/tx/<hash>`

Network: Stellar testnet (`Test SDF Network ; September 2015`). No mainnet
deployment exists; nothing here holds real value or is insured. Last read back:
2026-09-15 (limits, wasm hash) and 2026-09-13 (lifecycle balances in
[`TESTNET-EVIDENCE.md`](./TESTNET-EVIDENCE.md)).

## 1. Vault instances

One instance per underlying, each redeployed from the reference instance's wasm
hash rather than rebuilt, so they provably run the same code and differ only in
feed, collateral and limits.

| Book | Contract | Feed | Status |
|---|---|---|---|
| XLM | `CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ` | `Other("XLM")` | live |
| BTC | `CBQEACXAOZMCU3YOUWDC3MWXDSQBWKNGKBA6XMRPY5D5JQRNP2HLMVEU` | `Other("BTC")` | live |
| ETH | — | `Other("ETH")` | declared, not deployed ([MULTI-ASSET.md §7](./MULTI-ASSET.md)) |

Wasm hash, both instances: `ceb612f26516d5fcf6ac027dd0428aa471037694fa850dc697dcef6ac0b6b35b`

Superseded instances are out of scope but still streamed by the event indexer
(`NEXT_PUBLIC_VAULT_CONTRACTS`) to keep old positions' history. Position ids
restart at zero on every instance, so positions are keyed on instance and id
together.

### Limits, as the instances enforce them

Read back on 2026-09-15; calls in the underlying, puts in cash. The contract
enforces these on every write, the desk quotes inside them, and the two are
reconciled before a book is served ([MULTI-ASSET.md §3](./MULTI-ASSET.md)).

| | XLM | BTC |
|---|---|---|
| `max_position_call` | 10,000 | 0.05 |
| `max_expiry_call` | 500,000 | 5 |
| `max_position_put` | 10,000 | 1,500 |
| `max_expiry_put` | 500,000 | 150,000 |
| `max_premium_bps` | 2,000 | 2,000 |

`max_premium_bps` applies to collateral valued at the oracle price, so it needs
no asset-specific handling.

## 2. Oracle

| What | Value |
|---|---|
| Reflector (testnet) | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Decimals | 14 |
| Resolution | 300 s |
| History retained | ~24 hours |

Settlement reads only this contract; the issuer, Binance and the app's spot
endpoint price the quote. The ~24 hour history gives settlement a deadline: a
position whose expiry leaves the window cannot be priced at expiry, and the
sweep reports it as stranded rather than settle it at another price.

## 3. Stellar Asset Contracts

| Asset | SAC | Role |
|---|---|---|
| XLM (native) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | collateral, XLM calls |
| LBTC | `CDLI2GIDMYZQHK2K3TIGV5O2HQQRT36C5MV3IQWO6LX22YFTF43X74LU` | collateral, BTC calls |
| LUSD | `CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB` | cash — premiums, and what a put escrows |

## 4. Accounts

| Role | Address | What it can do |
|---|---|---|
| Admin (2-of-3 multisig) | `GBDNJQDP4HJQH6WCJCYVYGTKDRYKZXQQSVEC4FOE24CVG4VRQU26IKEC` | `set_limits`, manage the quoter set. Cannot take custody. |
| Treasury | `GCXVANOIFHM7IAAZTDEEOYW7WUDO7ETVJYVEO74LA23JSXQJP4TAJVUX` | receives the collateral of an assigned call |
| Quoter (pricing engine) | `GC7Z4LVQCUOU7FMRBX4WOGANARQGM4SZTACKMSQSMGIOO4KEAASHLOTX` | co-signs a position's premium. **No custody**: it cannot move collateral, settle a position, or change one after the fact. |
| LUSD issuer | `GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6` | mints the test cash |
| LUSD distributor | `GBAIN6CHZJGBL365JNXSRQEKALXYTWKXANQZ3RBM7AGUEYYKLJJ6SNR6` | faucet and swap payouts |
| LBTC issuer | `GB6274FEMTPWDEZ47P2YCXQ6JZCPRTHB5NMSFVPIUFB6MK5RXNBWZ2E2` | mints the test underlying |
| LBTC distributor | `GDJMUSNML5ATJGJVGABBXHQSYL3PXRBGHBCZ37H4RWSUIACORAHHMWNL` | faucet payouts |

The multisig admin cannot source a single-signature transaction, so the deploy
script uses a separate deployer key and passes the admin as a constructor
argument. Settlement needs no admin or quoter signature: anyone can settle any
expired position, and the recorded lifecycle's six settlements were submitted
that way.

## 5. Test assets, and what they are not

This repository mints LBTC and LUSD, with no reserve, redemption, custody claim
or anchor, because nobody anchors wrapped BTC or a dollar on a faucet-funded
network. Settlement reads Reflector, never the issuer, so mainnet changes one
configuration key per asset (`NEXT_PUBLIC_BTC_ANCHOR_ISSUER`). "The issuer can
mint more LBTC" describes a test asset, not a vulnerability.

A put can be funded with the testnet circle-style USDC pinned at
`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`; the bridge swaps it
one for one into LUSD, the vault's cash, before the position opens.

## 6. Endpoints

| What | Where |
|---|---|
| Soroban RPC | `https://soroban-testnet.stellar.org` |
| Horizon | `https://horizon-testnet.stellar.org` |

## 7. Reading it back yourself

Anyone can verify every line above:

```sh
# The config each instance was constructed with — oracle, feed, token, cash,
# treasury, admin.
node scripts/deploy-vault.mjs BTC --check

# The limits it enforces, its pools, its escrow, and whether it is solvent.
node scripts/verify-lifecycle.mjs BTC stats
```

Both only simulate and need no key. `--check` also reports whether the treasury
has the trustline to receive an assignment, which otherwise only settlement
would reveal.
