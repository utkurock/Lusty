# Testnet evidence — the BTC book

Tranche 2, Milestone 1. Every hash below is a Stellar testnet transaction, readable at
`https://stellar.expert/explorer/testnet/tx/<hash>`. A covered call and a cash-secured put
on BTC go through deposit, premium, expiry, oracle-priced settlement and distribution in
their own vault instance, beside an untouched XLM book.

## The book

Same contract and wasm hash as the XLM vault; only the feed, collateral and limits differ.

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

Limits on the deployed instance: 0.05 BTC per call position and 5 BTC across one expiry;
1,500 LUSD per put position and 150,000 across one expiry; premium ceiling 2,000 bps of
the collateral, valued at the oracle price.

| Step | Transaction |
| --- | --- |
| Deploy the instance | `11f55a1eb9a13cee65b42ffd86922cf9f0ad09e431710065f92cd986df5cc138` |

## The collateral

**LBTC is a test asset, issued by this repository.** No anchor issues wrapped BTC on
testnet, so it is minted here like LUSD: no reserve, no redemption, no custody claim.
Settlement reads the Reflector BTC/USD feed, not the issuer, so mainnet only changes
`NEXT_PUBLIC_BTC_ANCHOR_ISSUER`.

| What | Address / transaction |
| --- | --- |
| Issuer | `GB6274FEMTPWDEZ47P2YCXQ6JZCPRTHB5NMSFVPIUFB6MK5RXNBWZ2E2` |
| Distributor | `GDJMUSNML5ATJGJVGABBXHQSYL3PXRBGHBCZ37H4RWSUIACORAHHMWNL` |
| Distributor trustline | `f88161bfadc00380d6dab0411557d3f5d7a5116d63e8c5fa2f147f6365233d54` |
| Issuer home_domain | `70e63e673b7394fafeb813d65fa4af1f61419b2d21d5ca62133e2379ed7aa0e1` |
| Mint, 1,000 LBTC | `158784c6c4fca0d9324fc13315e332b68427ded2288bce2122ff299736bc34e8` |
| Deploy the LBTC SAC | `7f7b2ca738440347c9dc09b1757fab1cf49be1cf555d8908a69cbf23f925cba6` |

## Before either leg could settle

Without these, settlement fails late, inside a token contract, with the writer's
collateral already escrowed.

| Step | Why | Transaction |
| --- | --- | --- |
| Treasury trustline for LBTC | An assigned call sends the collateral to the treasury. On the XLM book this was native XLM and needed nothing. | `8d014d870547fdd6ef414d207b7595f947ab6315becb848469c0ec4f7f583f4a` |
| Writer trustline for LBTC | A kept call returns the collateral; an assigned put delivers it. | `86307da66a533bf107062c797cf654e8536450936fd4c2114b45fc01147d973c` |
| Fund the cash pool, 5,000 LUSD | Premiums, and what an assigned call pays the writer. | `b0ec2fffded5802e7bcb8a5358cf1a02b3d5f106917cbae76a9d9e2e2d3a819f` |
| Fund the underlying pool, 0.5 LBTC | What an assigned put delivers. | `5ec3ffff7bc7009d0b528f06c9e44c6de80114305fbf90f44ea2632a5bcff367` |

Both pools are one-way: `fund` and `fund_underlying` never pay back, and collateral leaves
only through `settle`.

## The run

Six positions on one expiry, calls and puts on both sides of the strike, so all four
settlement branches happen on chain. Strikes sit ±2% around the oracle price when the
positions were written (**$77,305.02**). Expiry `1789321200` (2026-09-13 08:20:00 UTC), on
the feed's 300-second grid.

| # | Leg | Collateral | Strike | Premium paid | Opened |
| --- | --- | --- | --- | --- | --- |
| 0 | call | 0.01 LBTC | $78,851.12 | 8 LUSD | first run |
| 1 | call | 0.01 LBTC | $75,758.92 | 12 LUSD | first run |
| 2 | call | 0.01 LBTC | $78,851.12 | 8 LUSD | `b9f18c1b27d188102cc909dce13e7c00cfbac28cdc9b03a42be5bfba4e01fd5d` |
| 3 | call | 0.01 LBTC | $75,758.92 | 12 LUSD | `f3c3936d2d2589cbee3af8e9d509764e4ae713ed9427120c6dce7a18bbf71713` |
| 4 | put | 500 LUSD | $75,758.92 | 5 LUSD | `b81acd96b2e3dc29c071bfac8a3f9ba45ecb05090e99257a95a24b8ad2d51388` |
| 5 | put | 500 LUSD | $78,851.12 | 7.5 LUSD | `eee32e498c040152c609e020c711544eb23a1bd887fd1264e94d01dd72ebe7aa` |

Escrow and premium share one transaction: the writer signs, the quoter co-signs only the
premium, and no server account touches the collateral. Hence no separate premium hash.

## Settlement

Priced at the expiry, not at the time of settling:

**`Other("BTC")` at `1789321200` = $77,251.76**, the oracle record at the expiry, read back
from `CCYOZJCO…KOMJRN63`.

| # | Leg | Strike vs $77,251.76 | Outcome | Transaction |
| --- | --- | --- | --- | --- |
| 0 | call | strike above | kept | `fc9d7041ef5ee4abea1b96ce720f58e1e5cd560a9def13f0390f1f3426eb8911` |
| 1 | call | strike below | assigned | `84d569004f4cf89024a5bab5313e2257aee2ef26a55cfb7cad34d9f268d16575` |
| 2 | call | strike above | kept | `6af40e7d1af1066b7835b43aa7bff5ced7107ba6816ec2974780b14c2425cdc8` |
| 3 | call | strike below | assigned | `0573d3dec8ac4acc902b86e3301798354b15741e83ac603793dae55188c4a12c` |
| 4 | put | strike below | kept | `304b4eb908b628ea50768f3f8e30face5cccaa6c408e2fb0bb7fb16e8b076877` |
| 5 | put | strike above | assigned | `537cc2a530559c05df31411c6a405ddfc1e5d00d9262f5c534b07fe2bd647ed5` |

No admin or quoter signed these six calls. Anyone can settle an expired position with the
same result, since the price is pinned to the expiry.

## What moved, and whether it adds up

**The writer** ends with **0.496341 LBTC** and **4,167.18 LUSD**, from 0.46 LBTC and
2,152.00 LUSD before settlement:

- kept calls (#0, #2) returned their collateral whole: **+0.02 LBTC**
- assigned calls (#1, #3) sold at the strike: 2 × 0.01 × $75,758.92 = **+1,515.18 LUSD**
- the kept put (#4) returned its cash collateral: **+500.00 LUSD**
- the assigned put (#5) bought BTC at the strike: 500 ÷ $78,851.12 =
  **+0.006341 LBTC**
- a 0.01 LBTC faucet drip in between accounts for the rest

**The treasury** holds **0.02 LBTC**, the collateral of the two assigned calls: the writer
gets the strike in cash and the treasury gets the asset.

**The vault** ends solvent on both legs with nothing escrowed and nothing owed:

| | Before the run | After settlement |
| --- | --- | --- |
| Cash pool | 5,000.00 LUSD | 3,432.32 LUSD |
| Underlying pool | 0.500000 LBTC | 0.493659 LBTC |
| Escrowed | — | none |
| Owed if assigned | — | none |

The cash pool fell by the 1,515.18 paid to the assigned calls and the 500 returned to the
kept put, less 32.5 of premiums taken in; the underlying pool fell by the 0.006341
delivered on the assigned put. Everything else went to the writer or the treasury.

## XLM, beside it, untouched

The XLM instance was not redeployed, upgraded or reconfigured. As a separate instance it
keeps its own escrow, exposure, limits and solvency guard.

## Reproducing it

```sh
node scripts/deploy-vault.mjs BTC --check       # what still has to be true
node scripts/verify-lifecycle.mjs BTC fund 5000 0.5
node scripts/verify-lifecycle.mjs BTC open      # prints the ids and the expiry
node scripts/verify-lifecycle.mjs BTC settle <ids>   # after the expiry passes
node scripts/verify-lifecycle.mjs BTC stats
```

Strikes follow the oracle's current price, so a rerun hits the same four branches at
different numbers.

---

# Testnet evidence — liquidity routing

Tranche 2, Milestone 2. A cash-secured put funded in USDC through a routed swap on
Stellar's own liquidity instead of the distributor's bridge, plus the route guardrails,
each fired on testnet. Run 2026-10-03 against the XLM book
(`CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ`), writer
`GDXUHMT3QELEW6YBKSYXJBBXINUWA2MFR26RIS6C332N25EYU3D6CJ4V`.

The swap used the app's `POST /api/routing/swap` on a local `next start` of the same
commit (allowlist, par bound, quote, in-flight reservation, send maximum, and a settle that
reads the fill from Horizon), with the writer's key signing in place of a wallet.

## The book it routes through

No testnet book traded LUSD against USDC directly. The only path went through XLM at 33.65
USDC for 10 LUSD (3.37 per unit), which the direct-only route refused. So the distributor
sells LUSD for USDC at exactly 1 on the direct book (`scripts/seed-route-liquidity.mjs`),
one way only, since selling USDC for faucet LUSD would be a drain.

| Step | Transaction |
| --- | --- |
| Offer placed, 100,000 LUSD at 1 | `4b24950f3df2ca73b87c94736c8947a71bf0ea5fbc29ca79170aef349bcaab45` |

## A put funded by a route

| Step | What | Transaction |
| --- | --- | --- |
| Trustline | writer can hold USDC | `6a7b9c7cb2b616e6b2a36ed1137476c24dabd080f9bf1d93ed139538fb1adb37` |
| Test capital | distributor → writer, 30 USDC | `62b90af9fafad62099a1343d78195d8220be99814f3d36dd0e0bd405249f9a99` |
| **Routed swap** | quoted 20 USDC, sendMax 20.1, delivered exactly 20 LUSD for 20 USDC, direct, zero hops | `000049c4bc29768a62af035e3d0d05ebe13f1349bf6a2b36255862326838b611` |
| Open | put #26, escrows the 20 LUSD, strike $0.210724, premium 0.08 | `4664dabe89e41d7449d178a607257f427d7399999d728fd1d816fb5af1ce18d6` |
| Settle | Reflector `XLM` at expiry `1791036300`: $0.215564 → **kept**, 20 LUSD back | `4c837cb9e01c108f720c65fc37e457a1eae833dd59e77d9a823f942ae61630a7` |

The settle call answered `{"filled":true,"destAmount":20,"spent":20,"quoted":20}`: a
successful strict-receive path payment from and to this writer, USDC in and LUSD out at the
prepared amount, journaled with zero realised slippage.

| Writer | USDC | LUSD |
| --- | --- | --- |
| Before | 30.0000000 | 4,167.1784384 |
| After the swap | 10.0000000 | 4,187.1784384 |
| After the open | 10.0000000 | 4,167.2584384 |
| After settlement | 10.0000000 | 4,187.2584384 |

Twenty USDC became the put's twenty LUSD of escrow, returned at settlement with the 0.08
premium. The vault's escrowed put cash went 50 → 70 → 50 and its cash pool 19,753.1577 →
19,773.0777 → 19,753.0777: in by the escrow, out by the premium, then the escrow paid back.

## The guardrails, fired

| Guardrail | Attempt | Outcome |
| --- | --- | --- |
| Min-output, enforced by the network | strict-receive 10 LUSD for at most 9.9 USDC | `op_over_source_max`, failed on the ledger, nothing moved but the 100-stroop fee: `e65df2a645d277268312843bd64fa157f5bcb27890f2fa790a8c2d73a5f2b3cf` |
| Per-swap ceiling | prepare 20,000 LUSD | `409 above_notional`, refused before anything was built |
| Approved routes only | prepare 10 LUSD with the direct offer withdrawn (`cffdf7d47f90fca1c6d2b0aea32cc00da58ac3691c1aba91fbb0154ea7c137ff`) | `409 path_not_allowed`: "usdc->lusd is direct only, and this path goes through 1 other asset(s)". Offer restored: `2ddc3ab22425c7257a91ad6cb4ae56a033723c18d60debfd7c4bcaadb33a2124` |

The par bound (`off_par`) and the in-flight cap (`routing_cap`) are covered by
`src/lib/__tests__/routing-session.test.ts` instead: firing them would need a deliberately
mispriced direct book and 50,000 of concurrent swaps.

## Reproducing it

```sh
npx next build && npx next start -p 3999 &     # the route's reservation lives in this process
node scripts/seed-route-liquidity.mjs          # the direct book, if it is not there
node scripts/verify-routing.mjs fund 30
node scripts/verify-routing.mjs swap 20
node scripts/verify-lifecycle.mjs XLM put 20   # prints the id and the expiry
node scripts/verify-lifecycle.mjs XLM settle <id>   # after the expiry passes
node scripts/verify-routing.mjs refuse         # withdraws and restores the direct offer
```
