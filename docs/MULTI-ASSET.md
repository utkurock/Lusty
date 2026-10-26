# Adding an underlying

Every underlying Lusty lists is one entry in `src/lib/assets/config.ts`; adding one needs
no other code change. Below are each field's meaning, units, and what happens when it is
wrong.

Short version: copy the `ETH` entry, change the symbol and the env keys, deploy an
instance, and set the four `NEXT_PUBLIC_*` values. ETH is deliberately left gated as a
worked example.

---

## 1. The shape of it

You normally touch only `config.ts`.

| File | What lives there |
|---|---|
| `lib/assets/config.ts` | the declarations: the data, plus `BROWSER_ENV` |
| `lib/assets/schema.ts` | the types, env resolution, and `declare()` |
| `lib/assets/validate.ts` | what makes a declaration unservable |
| `lib/assets/index.ts` | the lookups every caller imports |

A field is a literal or `{ env, fallback }`. `env` may list renamed keys and the first one
set wins, so XLM reads `NEXT_PUBLIC_VAULT_CONTRACT` before `VAULT_CONTRACT`. A blank value
counts as unset, so `''` is never taken as a contract address.

---

## 2. Every field

### Identity

| Field | Units | Wrong → |
|---|---|---|
| `symbol` | 1 to 12 upper-case letters or digits | `invalid`. It is a `Map` key and comes from URLs, so it is matched rather than trusted. A repeated symbol does not gate: it throws at load, because the second entry would replace the first in every lookup. |
| `name` | free text | `invalid` if empty |
| `slug` | lower-case URL segment | `invalid`. This is `/earn/<slug>`. |
| `icon` | one glyph | `invalid` if empty. The fallback for a surface with no room for an image. |
| `logo` | path under `public/` | `invalid` unless it starts with `/`. The file's existence is not checked at load, because validation also runs in the browser; `asset-by-config.test.ts` checks it instead. Add the file. |

### Where it settles

| Field | Units | Wrong → |
|---|---|---|
| `contracts.vault` | contract id (C…) | absent → `unconfigured`; malformed → `invalid`. Never give this a fallback: another book's would put this asset's money in that contract. |
| `contracts.token` | contract id | as above. The SAC of the collateral a call escrows. |
| `contracts.cash` | contract id | as above. The SAC premiums are paid in and a put escrows. Both live books share `LUSD_SAC`, declared once so they cannot drift, but still per asset, so a book settling in something else is a config change. |

Each underlying gets its own deployment of the same parameterised contract, so escrow,
exposure and limits never share a pool.

### What it escrows

`collateral` is `{ kind: 'native' }` or `{ kind: 'issued', code, issuer }`.

| Field | Wrong → |
|---|---|
| `code` | `invalid` if empty or over 12 characters |
| `issuer` | absent → `unconfigured` ("nobody anchors this asset yet"); not an account address → `invalid` |

Anything an assignment pays needs a trustline, and only settlement discovers a missing one:
an assigned call sends collateral to the treasury, and an assigned put delivers the
underlying to the writer. Native XLM needed neither, so this stayed hidden until BTC. Check
the treasury can hold each new asset's receivable before its first expiry.

### How it is priced

| Field | Units | Wrong → |
|---|---|---|
| `feedSymbol` | Reflector `Other(Symbol)` name | `invalid` if empty. This is the settlement price source; without it a book could be written and never settled. |
| `binanceSymbol` | e.g. `ETHUSDT` | `invalid` if empty. Quote inputs, spot fallback, and the USDⓈ-M perp the forward reads funding from. An asset with no perp falls back to F = S rather than inventing a carry. |
| `coingeckoId` | e.g. `ethereum` | `invalid` if empty. Second source for the realized-vol series. |
| `bitstampPair` | e.g. `ethusd` | not validated. Third source. σ is on the money path and fails closed, so each source is one more venue outage it survives. |

The testnet Reflector oracle carries BTC, ETH, USDT, XRP, SOL, USDC, ADA, AVAX, DOT,
MATIC, LINK, DAI, ATOM, XLM, UNI and EURC, all at 14 decimals on a 300-second grid with
about 24 hours of history. Confirm your symbol is listed before declaring it. Nothing else
checks, and an unknown feed reads as a stale price, not a missing one.

### How it is counted

| Field | Units | Wrong → |
|---|---|---|
| `unitDecimals` | whole number ≥ 0 | `invalid`. Stellar carries 7 for every asset; there is no reason to declare anything else. |
| `displayDecimals` | whole number ≥ 0 | `invalid` if above `unitDecimals`, which would show precision the ledger does not carry. |

`displayDecimals` affects more than looks: at two places 0.001 BTC shows as zero, and a
"0 BTC" minimum cannot be met. Use enough places to resolve a few cents at the asset's
price: 2 at $0.23, 5 at $4,000, 6 at $77,000.

### The ladder — `strike`

| Field | Units | Wrong → |
|---|---|---|
| `callOtm` | multiples of spot, nearest the money first | `invalid` if empty, if any rung is ≤ 1, or if they do not strictly increase |
| `putOtm` | multiples of spot, nearest the money first | `invalid` if empty, if any rung is outside (0, 1), or if they do not strictly decrease |
| `tickFraction` | fraction of spot | `invalid` if ≤ 0 or ≥ 1 |

Rung order sets the premium. `quoteOption` pins index 0 to the APR ceiling and scales every
other strike by the same factor, so a rung that steps back toward the money moves the
maximum off index 0 and the whole ladder scales off the wrong reference.

The tick is a fraction of spot because an absolute step would be meaningless at $0.23 or at
$77,000. A ladder reflects how far an underlying travels in a week; all three books share
the same rungs today because that ladder is in force, not because they must.

### The schedule — `expiry`

| Field | Units | Wrong → |
|---|---|---|
| `openExpiries` | whole number ≥ 1 | `invalid` |
| `minDaysToExpiry` | days, positive | `invalid` |
| `tenorDays` | days, positive | `invalid` |

`openExpiries` is the one envelope number that cannot be shared between books. It divides
monthly capacity into the per-expiry figure reconciled against the instance's
`max_expiry_*` (§3), so another book's count would be checked against a bound this
contract never enforces.

### The envelope

All seven are positive and overridable per deployment. Call-side figures are in units of
the underlying; put-side figures are in USD.

| Field | Units | Also checked |
|---|---|---|
| `minSize` | underlying | positive |
| `maxSize` | underlying | ≥ `minSize` |
| `userEpochCall` | underlying | ≥ `maxSize`: a wallet's call allowance for one expiry cannot be below a single position |
| `maxSizeCash` | USD | positive |
| `userEpochPutUsd` | USD | ≥ `maxSizeCash` |
| `callMonthlyCap` | underlying | ≥ `maxSize`: a month of capacity cannot be smaller than one position |
| `putMonthlyCapUsd` | USD | ≥ `maxSizeCash` |

The screen refuses against each of these, so contradictory bounds offer a user a position
and then deny it. Size them in the asset's own units: XLM's 10,000 reused for a BTC book
caps it at 10,000 BTC, which caps nothing.

### `onchainLimits`

The `Limits` the instance was deployed with, in the collateral's own units: five positive
numbers, with `maxPremiumBps` at most 10,000 so a premium cannot exceed its collateral.
This second record of a rule the contract owns lets `lib/vault-limits` check both it and
the envelope against what the instance actually enforces (§3).

---

## 3. What reconciliation expects

Before quoting a book, `lib/vault-limits` reads `limits()` off the instance and checks for:

- `declared` drift: the contract enforces something other than `onchainLimits`, as after
  an unplanned `set_limits`. A change reverted before the next reading is caught by the
  monitor's `limits` event watch (`lib/monitor/limits-watch`), which also forces an
  immediate reading.
- `envelope` drift: the desk would quote past what the contract accepts, so positions
  would be signed and then reverted.

Either refuses the asset with a 503 `limits_unreconciled` on quote, deposit and authorize,
and both are reported per book on `/api/health`.

The app's monthly capacity is not the contract's per-expiry cap: `callMonthlyCap` is spread
across `openExpiries` buckets, so `max_expiry_call` is compared against the quotient. A
deploy script comment claimed the opposite for most of Tranche 2.

Verdicts are cached for 5 minutes and served for up to an hour past a failed refresh, since
an unreachable RPC is not evidence of drift. After that hour the book is refused.

---

## 4. The one part that is not configuration

A new `NEXT_PUBLIC_*` key must also go in `BROWSER_ENV` in `config.ts`.

The bundler substitutes `process.env.NEXT_PUBLIC_X` only where it is written out by name.
Declarations hold key names as data, and the bundler cannot rewrite `process.env[key]`, so
public values are undefined in the browser while working on the server.

There is no error. The server renders the book, the client renders "No underlying is
configured to quote right now", and hydration disagrees. CI cannot catch it because
`vitest` and `next build` both run with a real `process.env`; a green suite and a clean
build once sat on top of a broken page.

`asset-browser-env.test.ts` walks the declarations' env keys and fails on any public one
missing from the table, or any stale one left in it. Server-only keys stay out of
`BROWSER_ENV`; a non-public cap falls back to its default in the browser, as it always has.

---

## 5. Gated, and what that does not stop

`enabled` is exactly `issues.length === 0`. A gated book is absent from
`enabledUnderlyings()`, `resolveUnderlying()` returns null for it, and quote, deposit and
authorize answer a 400 `asset_unavailable` instead of falling through to another book's
vault, where position #3 belongs to somebody else.

Issues come in two kinds, fixed by different people:

- `unconfigured`: no value supplied yet, as expected on a fresh environment. It does not
  count against overall status on `/api/health`: an unfinished asset is a plan, and a red
  probe for it would teach everyone to ignore the probe.
- `invalid`: the value present cannot be right in any environment. That is a shipped bug,
  and it does turn the probe red.

A gated book still settles: `settleableUnderlyings()` asks only whether there is an
instance, because collateral has to come back whether or not the book is being written. Use
`resolveUnderlying` for anything that writes and `settleableUnderlying` for anything that
closes. Mixing them up strands collateral, and nothing in the code warns you.

Gating one book leaves the others up, a far cheaper failure than serving a book whose
configuration contradicts itself.

---

## 6. Listing an asset, start to finish

1. Check the Reflector feed carries it (§2). No feed, no settlement, no book.
2. Add the entry to `DECLARATIONS` in `lib/assets/config.ts`. Copy `ETH`.
3. Add its public env keys to `BROWSER_ENV` in the same file (§4).
4. Add `public/<symbol>.png|svg` for the mark.
5. Document the env keys in `.env.example`.
6. Run `npx vitest run`. A self-contradicting declaration fails
   `asset-validation.test.ts`; a missing public key fails `asset-browser-env.test.ts`; a
   missing logo fails `asset-by-config.test.ts`.
7. Set the deploy caps and deploy the instance. The script reads them from the environment
   (`VAULT_ONCHAIN_MAX_POSITION_CALL_<SYM>`, `…_MAX_EXPIRY_CALL_<SYM>`,
   `…_MAX_POSITION_PUT_<SYM>`, `…_MAX_EXPIRY_PUT_<SYM>`, optionally
   `…_MAX_PREMIUM_BPS_<SYM>`) and refuses without all four, since an unstated cap is one
   nobody chose. Size them in the asset's own units. Run
   `node scripts/deploy-vault.mjs <SYMBOL> --dry-run`, then without the flag once it prints
   what you meant.
8. Record the deployed limits in `onchainLimits`, read back off the instance with
   `--check` rather than copied from the deploy command.
9. Establish the trustlines the treasury and the distributor need for the new receivable.
10. Set the env values and rebuild. `NEXT_PUBLIC_*` is inlined at build time: adding them
    to the host without redeploying changes nothing, and redeploying without them lists
    the book as gated.
11. Check `/api/health`: the book should be absent from the gated list.

Step 10 is the one that costs an afternoon, and it already has once.

---

## 7. Worked example: what ETH is missing

ETH is declared in `config.ts` and gated on exactly three values:

```
contracts.vault      no vault instance is deployed for this book
contracts.token      the collateral a call escrows has no SAC
stellarAsset.issuer  nobody anchors this asset yet
```

All three are `unconfigured`, not `invalid`: nobody has deployed it yet. Pricing needs
nothing, since the Reflector ETH/USD feed publishes on testnet at the same scale and
cadence as the other two.

Supply `NEXT_PUBLIC_VAULT_CONTRACT_ETH`, `NEXT_PUBLIC_ETH_CONTRACT` and
`NEXT_PUBLIC_ETH_ANCHOR_ISSUER` and the book is live. That is the claim M2-07 makes, and
`asset-by-config.test.ts` tests it by declaring ETH with those three keys supplied and
asserting `issues` is empty.
