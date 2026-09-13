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

## The run

Six positions, one expiry, both legs on both sides of the strike — so each of the four
settlement branches happens once and none of them is argued from the others.

Strikes were placed ±2% around the price the oracle was publishing when the positions were
written (**$77,305.02**), not around a number chosen in advance. Expiry `1789321200`
(2026-09-13 08:20:00 UTC), on the feed's own 300-second grid.

| # | Leg | Collateral | Strike | Premium paid | Opened |
| --- | --- | --- | --- | --- | --- |
| 0 | call | 0.01 LBTC | $78,851.12 | 8 LUSD | first run |
| 1 | call | 0.01 LBTC | $75,758.92 | 12 LUSD | first run |
| 2 | call | 0.01 LBTC | $78,851.12 | 8 LUSD | `b9f18c1b27d188102cc909dce13e7c00cfbac28cdc9b03a42be5bfba4e01fd5d` |
| 3 | call | 0.01 LBTC | $75,758.92 | 12 LUSD | `f3c3936d2d2589cbee3af8e9d509764e4ae713ed9427120c6dce7a18bbf71713` |
| 4 | put | 500 LUSD | $75,758.92 | 5 LUSD | `b81acd96b2e3dc29c071bfac8a3f9ba45ecb05090e99257a95a24b8ad2d51388` |
| 5 | put | 500 LUSD | $78,851.12 | 7.5 LUSD | `eee32e498c040152c609e020c711544eb23a1bd887fd1264e94d01dd72ebe7aa` |

Escrow and premium are one transaction. The writer signs it, the quoter co-signs the
premium and nothing else, and no server-held account touches the collateral at any point —
which is why the premium column has no second hash beside it.

## Settlement

Priced at the expiry, not at the moment somebody got around to settling:

**`Other("BTC")` at `1789321200` = $77,251.76** — the oracle record whose own timestamp is
the expiry, read back from `CCYOZJCO…KOMJRN63`.

| # | Leg | Strike vs $77,251.76 | Outcome | Transaction |
| --- | --- | --- | --- | --- |
| 0 | call | strike above | kept | `fc9d7041ef5ee4abea1b96ce720f58e1e5cd560a9def13f0390f1f3426eb8911` |
| 1 | call | strike below | assigned | `84d569004f4cf89024a5bab5313e2257aee2ef26a55cfb7cad34d9f268d16575` |
| 2 | call | strike above | kept | `6af40e7d1af1066b7835b43aa7bff5ced7107ba6816ec2974780b14c2425cdc8` |
| 3 | call | strike below | assigned | `0573d3dec8ac4acc902b86e3301798354b15741e83ac603793dae55188c4a12c` |
| 4 | put | strike below | kept | `304b4eb908b628ea50768f3f8e30face5cccaa6c408e2fb0bb7fb16e8b076877` |
| 5 | put | strike above | assigned | `537cc2a530559c05df31411c6a405ddfc1e5d00d9262f5c534b07fe2bd647ed5` |

Settlement is permissionless: these six calls carry no admin or quoter signature. Anyone
can settle any expired position, and the outcome is the same whoever sends it, because the
price is pinned to the expiry rather than to the moment of the call.

## What moved, and whether it adds up

The point of writing the balances down is that they can be checked against the rules rather
than taken on trust.

**The writer** ends with **0.496341 LBTC** and **4,167.18 LUSD**, from 0.46 LBTC and
2,152.00 LUSD before settlement:

- kept calls (#0, #2) returned their collateral whole: **+0.02 LBTC**
- assigned calls (#1, #3) sold at the strike: 2 × 0.01 × $75,758.92 = **+1,515.18 LUSD**
- the kept put (#4) returned its cash collateral: **+500.00 LUSD**
- the assigned put (#5) bought BTC at the strike, as agreed: 500 ÷ $78,851.12 =
  **+0.006341 LBTC**
- and a 0.01 LBTC faucet drip landed in between, which is the remaining difference

**The treasury** holds **0.02 LBTC** — exactly the collateral of the two assigned calls,
and nothing else. That is the covered-call economics the contract implements: the writer is
paid the strike in cash, the asset goes to the treasury.

**The vault** ends solvent on both legs with nothing escrowed and nothing owed:

| | Before the run | After settlement |
| --- | --- | --- |
| Cash pool | 5,000.00 LUSD | 3,432.32 LUSD |
| Underlying pool | 0.500000 LBTC | 0.493659 LBTC |
| Escrowed | — | none |
| Owed if assigned | — | none |

The cash pool is down by the 1,515.18 it paid the two assigned calls and the 500 it returned
to the kept put, less the 32.5 of premiums it took in. The underlying pool is down by the
0.006341 it delivered on the assigned put. Everything else that left the contract went back
to the writer or to the treasury.

## XLM, beside it, untouched

The XLM instance was not redeployed, not upgraded and not configured during any of this.
Separate escrow, separate exposure, separate limits and a separate solvency guard are not a
claim about the code here — they are what a second instance *is*.

## Reproducing it

```sh
node scripts/deploy-vault.mjs BTC --check       # what still has to be true
node scripts/verify-lifecycle.mjs BTC fund 5000 0.5
node scripts/verify-lifecycle.mjs BTC open      # prints the ids and the expiry
node scripts/verify-lifecycle.mjs BTC settle <ids>   # after the expiry passes
node scripts/verify-lifecycle.mjs BTC stats
```

Strikes are placed around whatever the oracle is publishing at the time, so a rerun
exercises the same four branches at a different price rather than repeating these numbers.
