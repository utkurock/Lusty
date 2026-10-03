# Testnet deployment manifest

Everything Lusty runs on Stellar testnet, in one place, so an attacker does not have to
guess what is in scope and an auditor does not have to take a screenshot's word for it.

Every address here is readable:

- contracts — `https://stellar.expert/explorer/testnet/contract/<id>`
- accounts — `https://stellar.expert/explorer/testnet/account/<id>`
- transactions — `https://stellar.expert/explorer/testnet/tx/<hash>`

**Network:** Stellar testnet (`Test SDF Network ; September 2015`). No mainnet deployment
exists. Nothing here holds real value, and nothing here is insured by anyone.

Last read back off the network: **2026-09-15** (the limits and the wasm hash), **2026-09-13**
(the lifecycle balances in [`TESTNET-EVIDENCE.md`](./TESTNET-EVIDENCE.md)).

---

## 1. Vault instances

One underlying, one instance. A second book is a second deployment of the same wasm — the
hash is read off the reference instance and redeployed rather than rebuilt, so the two
provably run the same code. What differs between them is the feed, the collateral and the
limits, and nothing else.

| Book | Contract | Feed | Status |
|---|---|---|---|
| XLM | `CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ` | `Other("XLM")` | live |
| BTC | `CBQEACXAOZMCU3YOUWDC3MWXDSQBWKNGKBA6XMRPY5D5JQRNP2HLMVEU` | `Other("BTC")` | live |
| ETH | — | `Other("ETH")` | declared, not deployed ([MULTI-ASSET.md §7](./MULTI-ASSET.md)) |

**Wasm hash, both instances:** `ceb612f26516d5fcf6ac027dd0428aa471037694fa850dc697dcef6ac0b6b35b`

Superseded instances are not listed as scope. They are still streamed by the event
indexer (`NEXT_PUBLIC_VAULT_CONTRACTS`) so old positions keep their history, and their
position ids restart at zero like every other instance's — which is why anything that
remembers a position keys on the pair, never the number.

### Limits, as the instances enforce them

Read back off each instance on 2026-09-15. Call figures are in the underlying, put figures
in cash. These are the contract's own bounds, enforced on every write; the desk quotes
inside them and the two records are reconciled before any book is served
([MULTI-ASSET.md §3](./MULTI-ASSET.md)).

| | XLM | BTC |
|---|---|---|
| `max_position_call` | 10,000 | 0.05 |
| `max_expiry_call` | 500,000 | 5 |
| `max_position_put` | 10,000 | 1,500 |
| `max_expiry_put` | 500,000 | 150,000 |
| `max_premium_bps` | 2,000 | 2,000 |

`max_premium_bps` is applied to collateral **valued at the oracle price**, so it needs no
asset-specific handling.

---

## 2. Oracle

| What | Value |
|---|---|
| Reflector (testnet) | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Decimals | 14 |
| Resolution | 300 s |
| History retained | ~24 hours |

Settlement reads this contract and nothing else. Not the issuer, not Binance, not the
app's own spot endpoint — those price the *quote*; the oracle prices the *settlement*.

The ~24 hour retention is the reason settlement has a deadline: a position whose expiry
falls out of the window can no longer be priced at its expiry, and the sweep reports it as
stranded rather than settling it at a price it was not written against.

---

## 3. Stellar Asset Contracts

| Asset | SAC | Role |
|---|---|---|
| XLM (native) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | collateral, XLM calls |
| LBTC | `CDLI2GIDMYZQHK2K3TIGV5O2HQQRT36C5MV3IQWO6LX22YFTF43X74LU` | collateral, BTC calls |
| LUSD | `CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB` | cash — premiums, and what a put escrows |

---

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

The admin is behind a 2-of-3 multisig and **cannot source a single-signature transaction
at all**, which is why the deploy script uses a separate deployer key and passes the admin
in as a constructor argument.

**Settlement is permissionless.** It carries no admin and no quoter signature — anyone can
settle any expired position, and the recorded lifecycle's six settlements were submitted
that way.

---

## 5. Test assets, and what they are not

**LBTC and LUSD are minted by this repository.** No reserve, no redemption, no custody
claim, and no anchor behind either. They exist because nobody anchors wrapped BTC or a
dollar to a network whose XLM comes from a faucet.

This changes nothing about what the vault demonstrates: settlement reads the Reflector
feed, never the issuer, so mainnet replaces one configuration key per asset
(`NEXT_PUBLIC_BTC_ANCHOR_ISSUER`) and everything else here stays true.

It does change what a finding about them means. "The issuer can mint more LBTC" is a fact
about a test asset, not a vulnerability.

The USDC a put can be funded with is the testnet circle-style asset pinned at
`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`. It is not the vault's cash: the
bridge swaps it one for one into LUSD before the position opens.

---

## 6. Endpoints

| What | Where |
|---|---|
| Soroban RPC | `https://soroban-testnet.stellar.org` |
| Horizon | `https://horizon-testnet.stellar.org` |

---

## 7. Reading it back yourself

Nothing above has to be trusted. Every line is a read anyone can make:

```sh
# The config each instance was constructed with — oracle, feed, token, cash,
# treasury, admin.
node scripts/deploy-vault.mjs BTC --check

# The limits it enforces, its pools, its escrow, and whether it is solvent.
node scripts/verify-lifecycle.mjs BTC stats
```

Both are read-only: they simulate, they never submit, and they need no key. The `--check`
form additionally reports whether the treasury can actually receive what an assignment
would pay it, which is a fact about trustlines that only settlement would otherwise
discover.
