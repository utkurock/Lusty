# Testnet evidence — the BTC book

Tranche 2, Milestone 1. Every claim below is a transaction on Stellar testnet, and every
hash can be read back at
`https://stellar.expert/explorer/testnet/tx/<hash>`.

What this records is one thing: that a covered call and a cash-secured put on BTC go the
whole way — deposit, premium, expiry, oracle-priced settlement, distribution — in a vault
instance of their own, with XLM's book untouched beside them.

## The book

One underlying, one instance. The BTC vault is a second deployment of the same contract
the XLM vault runs, from the same wasm hash, so the two provably run the same code: what
differs between them is the feed, the collateral and the limits, and nothing else.

| What | Address |
| --- | --- |
| Vault (BTC) | `CBQEACXAOZMCU3YOUWDC3MWXDSQBWKNGKBA6XMRPY5D5JQRNP2HLMVEU` |
| Vault (XLM), unchanged | `CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ` |
| Wasm hash, both | `ceb612f26516d5fcf6ac027dd0428aa471037694fa850dc697dcef6ac0b6b35b` |
| Reflector oracle | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Feed | `Other("BTC")`, 14 decimals, 300 s resolution |
| Collateral — LBTC SAC | `CDLI2GIDMYZQHK2K3TIGV5O2HQQRT36C5MV3IQWO6LX22YFTF43X74LU` |
| Cash — LUSD SAC | `CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB` |
| Writer | `GDXUHMT3QELEW6YBKSYXJBBXINUWA2MFR26RIS6C332N25EYU3D6CJ4V` |
| Quoter (pricing engine) | `GC7Z4LVQCUOU7FMRBX4WOGANARQGM4SZTACKMSQSMGIOO4KEAASHLOTX` |
| Treasury | `GCXVANOIFHM7IAAZTDEEOYW7WUDO7ETVJYVEO74LA23JSXQJP4TAJVUX` |
| Admin (2-of-3 multisig) | `GBDNJQDP4HJQH6WCJCYVYGTKDRYKZXQQSVEC4FOE24CVG4VRQU26IKEC` |

Limits, read back off the deployed instance: 0.05 BTC per call position and 5 BTC across
one expiry; 1,500 LUSD per put position and 150,000 across one expiry; premium ceiling
2,000 bps of the collateral, valued at the oracle price.

| Step | Transaction |
| --- | --- |
| Deploy the instance | `11f55a1eb9a13cee65b42ffd86922cf9f0ad09e431710065f92cd986df5cc138` |

## The collateral

**LBTC is a test asset, issued by this repository.** No anchor issues wrapped BTC on
testnet — the asset code is unreserved there, and nobody offers redemption for a coin that
has no reserve behind it on a network whose XLM comes from a faucet. So the underlying is
minted here, exactly as LUSD is: no reserve, no redemption, no custody claim.

It changes nothing about what is being demonstrated. Settlement reads the Reflector
BTC/USD feed, never the issuer, so a mainnet anchor replaces one configuration key
(`NEXT_PUBLIC_BTC_ANCHOR_ISSUER`) and the rest of this page stays true.

| What | Address / transaction |
| --- | --- |
| Issuer | `GB6274FEMTPWDEZ47P2YCXQ6JZCPRTHB5NMSFVPIUFB6MK5RXNBWZ2E2` |
| Distributor | `GDJMUSNML5ATJGJVGABBXHQSYL3PXRBGHBCZ37H4RWSUIACORAHHMWNL` |
| Distributor trustline | `f88161bfadc00380d6dab0411557d3f5d7a5116d63e8c5fa2f147f6365233d54` |
| Issuer home_domain | `70e63e673b7394fafeb813d65fa4af1f61419b2d21d5ca62133e2379ed7aa0e1` |
| Mint, 1,000 LBTC | `158784c6c4fca0d9324fc13315e332b68427ded2288bce2122ff299736bc34e8` |
| Deploy the LBTC SAC | `7f7b2ca738440347c9dc09b1757fab1cf49be1cf555d8908a69cbf23f925cba6` |

## Before either leg could settle

Three things, all of which fail late rather than at deposit — at settlement, from inside a
token contract, for a position already holding the writer's collateral.

| Step | Why | Transaction |
| --- | --- | --- |
| Treasury trustline for LBTC | An assigned call sends the collateral to the treasury. On the XLM book this was native XLM and needed nothing. | `8d014d870547fdd6ef414d207b7595f947ab6315becb848469c0ec4f7f583f4a` |
| Writer trustline for LBTC | A kept call returns the collateral; an assigned put delivers it. | `86307da66a533bf107062c797cf654e8536450936fd4c2114b45fc01147d973c` |
| Fund the cash pool, 5,000 LUSD | Premiums, and what an assigned call pays the writer. | `b0ec2fffded5802e7bcb8a5358cf1a02b3d5f106917cbae76a9d9e2e2d3a819f` |
| Fund the underlying pool, 0.5 LBTC | What an assigned put delivers. | `5ec3ffff7bc7009d0b528f06c9e44c6de80114305fbf90f44ea2632a5bcff367` |

Both pools are one-way in: `fund` and `fund_underlying` never pay back, and collateral
leaves only through `settle`.
