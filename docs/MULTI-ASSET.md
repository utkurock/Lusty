# Adding an underlying

Every underlying Lusty lists is one entry in `src/lib/assets/config.ts`. That entry is
the whole change: no type to widen, no branch to extend, no rail to teach a new symbol.
This document is what each field means, what units it is in, and what happens when it is
wrong.

If you only want the short version: copy the `ETH` entry, change the symbol and the env
keys, deploy an instance, and set the four `NEXT_PUBLIC_*` values. ETH is declared and
deliberately left gated precisely so there is a worked example in the tree.

---

## 1. The shape of it

Three files, and you normally touch one.

| File | What lives there |
|---|---|
| `lib/assets/config.ts` | **the declarations** — the data, plus `BROWSER_ENV` |
| `lib/assets/schema.ts` | the types, env resolution, and `declare()` |
| `lib/assets/validate.ts` | what makes a declaration unservable |
| `lib/assets/index.ts` | the lookups every caller imports |

A field is either a literal or `{ env, fallback }`. `env` takes a list where a key has
been renamed — the first one set wins, so XLM reads `NEXT_PUBLIC_VAULT_CONTRACT` before
`VAULT_CONTRACT` without either spelling being special-cased in code.

**Blank counts as unset.** An env file naming a key it has no value for is stating
absence, and treating `''` as a contract address would list an asset with nowhere to
settle.

---

## 2. Every field

### Identity

| Field | Units | Wrong → |
|---|---|---|
| `symbol` | 1–12 upper-case letters or digits | `invalid`. It is a `Map` key and comes from URLs, so it is matched rather than trusted. A **repeated** symbol does not gate — it **throws at load**, because the second entry would replace the first and every lookup would answer with a book nobody meant. |
| `name` | free text | `invalid` if empty |
| `slug` | lower-case URL segment | `invalid`. This is `/earn/<slug>`. |
| `icon` | one glyph | `invalid` if empty. The fallback for a surface with no room for an image. |
| `logo` | path under `public/` | `invalid` unless it starts with `/`. **The file's existence is not checked at load** — validation runs in the browser too, where there is no filesystem. `asset-by-config.test.ts` checks it instead. Add the file. |

### Where it settles

| Field | Units | Wrong → |
|---|---|---|
| `contracts.vault` | contract id (C…) | absent → `unconfigured`; malformed → `invalid`. **Never give this a fallback.** Falling back to another book's would put this asset's money in that contract. |
| `contracts.token` | contract id | as above. The SAC of the collateral a call escrows. |
| `contracts.cash` | contract id | as above. The SAC premiums are paid in and a put escrows. Both live books share `LUSD_SAC`, declared once so they cannot drift — still per asset, so a book settling in something else stays a config change. |

One instance per underlying. A second book is a second deployment of the same
parameterised contract, which is what keeps one asset's escrow, exposure and limits out
of another's. There is no shared pool to leak across.

### What it escrows

`collateral` is `{ kind: 'native' }` or `{ kind: 'issued', code, issuer }`.

| Field | Wrong → |
|---|---|
| `code` | `invalid` if empty or over 12 characters |
| `issuer` | absent → `unconfigured` ("nobody anchors this asset yet"); not an account address → `invalid` |

Anything an assignment pays needs a trustline, and only settlement finds out. An assigned
call sends collateral to the treasury; an assigned put delivers the underlying to the
writer. Native XLM needed neither, so the whole class was invisible until BTC. **Any new
asset adds a receivable somebody has to be able to hold** — check the treasury's
trustlines before the first expiry, not after.

### How it is priced

| Field | Units | Wrong → |
|---|---|---|
| `feedSymbol` | Reflector `Other(Symbol)` name | `invalid` if empty. **This is the settlement price source.** An empty one is a book that could be written and never settled. |
| `binanceSymbol` | e.g. `ETHUSDT` | `invalid` if empty. Quote inputs, spot fallback, and the USDⓈ-M perp the forward reads funding from. An asset with no perp falls back to F = S rather than fabricating a carry. |
| `coingeckoId` | e.g. `ethereum` | `invalid` if empty. Second source for the realized-vol series. |
| `bitstampPair` | e.g. `ethusd` | not validated. Third source. σ is on the money path and fails closed, so the number of places it can come from is the number of outages the venue survives. |

The testnet Reflector oracle carries BTC, ETH, USDT, XRP, SOL, USDC, ADA, AVAX, DOT,
MATIC, LINK, DAI, ATOM, XLM, UNI and EURC — all at 14 decimals on a 300-second grid, and
all with about 24 hours of history. **Check your symbol is on that list before declaring
it**, because nothing else will: an unknown feed reads as a stale price, not as a missing
one.

### How it is counted

| Field | Units | Wrong → |
|---|---|---|
| `unitDecimals` | whole number ≥ 0 | `invalid`. Stellar carries 7 for every asset; there is no reason to declare anything else. |
| `displayDecimals` | whole number ≥ 0 | `invalid` if above `unitDecimals` — that shows precision the ledger does not carry. |

`displayDecimals` is not cosmetic. Two places reads 0.001 BTC as zero, and a minimum
written as "0 BTC" is not a minimum anybody can meet. Pick the number of places that
resolves a few cents at the asset's price: 2 at $0.23, 5 at $4,000, 6 at $77,000.

### The ladder — `strike`

| Field | Units | Wrong → |
|---|---|---|
| `callOtm` | multiples of spot, nearest the money first | `invalid` if empty, if any rung is ≤ 1, or if they do not strictly increase |
| `putOtm` | multiples of spot, nearest the money first | `invalid` if empty, if any rung is outside (0, 1), or if they do not strictly decrease |
| `tickFraction` | fraction of spot | `invalid` if ≤ 0 or ≥ 1 |

**Order is load-bearing, and it is the part that pays money.** `quoteOption` pins index 0
of the ladder to the APR ceiling and scales every other strike by the same factor, so the
ladder a quote is normalized against decides the premium. A rung that steps back toward
the money puts the maximum somewhere other than index 0 and the whole ladder scales off
the wrong reference.

The tick is a fraction rather than an absolute step because an absolute one is either
meaningless at $0.23 or meaningless at $77,000.

A ladder is a view on how far an underlying travels in a week. All three books declare
the same rungs today because that is what is in force, not because a ladder has to be
shared.

### The schedule — `expiry`

| Field | Units | Wrong → |
|---|---|---|
| `openExpiries` | whole number ≥ 1 | `invalid` |
| `minDaysToExpiry` | days, positive | `invalid` |
| `tenorDays` | days, positive | `invalid` |

`openExpiries` is **the one number in the envelope that cannot be shared**. It is the
divisor that turns a monthly capacity into the per-expiry figure reconciled against the
instance's `max_expiry_*` (§3), so a book dividing by another book's count is checked
against a bound its own contract never enforces.

### The envelope

All seven are positive numbers, overridable per deployment. Call-side figures are in
units of the underlying; put-side figures are in USD.

| Field | Units | Also checked |
|---|---|---|
| `minSize` | underlying | positive |
| `maxSize` | underlying | ≥ `minSize` |
| `userEpochCall` | underlying | ≥ `maxSize` — a wallet's call allowance for one expiry cannot be below a single position |
| `maxSizeCash` | USD | positive |
| `userEpochPutUsd` | USD | ≥ `maxSizeCash` |
| `callMonthlyCap` | underlying | ≥ `maxSize` — a month of capacity cannot be smaller than one position |
| `putMonthlyCapUsd` | USD | ≥ `maxSizeCash` |

Every one of these is a bound the screen refuses against, and a bound that contradicts
another is a position a user is offered and then denied.

**Size them in the asset's own units.** Reusing XLM's 10,000 for a BTC book caps it at
10,000 BTC, which is not a cap.

### `onchainLimits`

The `Limits` the instance was deployed with, in the collateral's own units. Five positive
numbers; `maxPremiumBps` additionally cannot exceed 10,000, which would let a premium
exceed the collateral behind it.

This is a **second record** of a rule the contract owns. It exists so `lib/vault-limits`
can compare both the declared record and the operating envelope against what the instance
actually enforces, rather than assuming they agree. See §3.

---

## 3. What reconciliation expects

Before a book is quoted, `lib/vault-limits` reads `limits()` off the instance and compares
two things against it:

- **`declared` drift** — the contract enforces something other than what `onchainLimits`
  says. This is what an unplanned `set_limits` looks like.
- **`envelope` drift** — the desk would quote past what the contract will accept, so the
  position gets signed and then reverted.

Either refuses the asset with a 503 `limits_unreconciled` on quote, deposit and authorize,
and both are reported per book on `/api/health`.

The comparison that catches people: **the app's monthly capacity is not the contract's
per-expiry cap.** The app spreads `callMonthlyCap` across `openExpiries` buckets, so the
number compared against `max_expiry_call` is the quotient. A deploy script comment claimed
the opposite for most of Tranche 2.

Verdicts are cached for 5 minutes and served for up to an hour past a failed refresh — an
unreachable RPC is not evidence of drift. Past the hour there is nothing left to stand on
and the book is refused.

---

## 4. The one part that is not configuration

**A new `NEXT_PUBLIC_*` key must be added to `BROWSER_ENV` in `config.ts` as well.**

The bundler substitutes `process.env.NEXT_PUBLIC_X` where it is written out by name. A
declaration names its keys as *data*, which is the point of it — so `process.env[key]` is
a lookup the bundler cannot rewrite, and every public value comes back undefined in the
browser while working perfectly on the server.

What that looks like is not an error. The server renders the book, the client renders
"No underlying is configured to quote right now", and the page disagrees with itself on
hydration. Nothing in CI can catch it: `vitest` and `next build` both run where
`process.env` is real, which is why a green suite and a clean build once sat on top of a
broken page.

`asset-browser-env.test.ts` walks the declarations for their env keys and fails on any
public one missing from the table, or any stale one left in it.

Server-only keys stay out of `BROWSER_ENV`. They have never reached the browser, and a cap
that is not public falls back to its default there as it always has.

---

## 5. Gated, and what that does not stop

`enabled` is exactly `issues.length === 0`. A gated book is absent from
`enabledUnderlyings()`, `resolveUnderlying()` returns null for it, and quote, deposit and
authorize answer a 400 `asset_unavailable` — not a silent fall-through to another book's
vault, where position #3 belongs to somebody else.

Two kinds of issue, because different people fix them:

- **`unconfigured`** — the deployment has not supplied a value. Expected on a fresh
  environment. On `/api/health` this does **not** count against the overall status: an
  asset nobody has finished wiring is a plan, and turning the probe red for it would train
  everyone to ignore it.
- **`invalid`** — the value that is there cannot be right whatever the environment says.
  That is a bug somebody shipped, and it does turn the probe red.

**A gated book still settles.** `settleableUnderlyings()` asks only whether there is an
instance, because collateral has to come back whether or not the book is being written.
This is the distinction to get right: `resolveUnderlying` for anything that writes,
`settleableUnderlying` for anything that closes. Using the first where the second belongs
strands people's collateral, and nothing about the code says so.

Gating one book leaves the others up. That is the cheap failure; serving a book whose
configuration contradicts itself is the expensive one.

---

## 6. Listing an asset, start to finish

1. **Check the Reflector feed carries it** (§2). No feed, no settlement, no book.
2. **Add the entry** to `DECLARATIONS` in `lib/assets/config.ts`. Copy `ETH`.
3. **Add its public env keys** to `BROWSER_ENV` in the same file (§4).
4. **Add `public/<symbol>.png|svg`** for the mark.
5. **Document the env keys** in `.env.example`.
6. Run `npx vitest run`. A declaration that contradicts itself fails
   `asset-validation.test.ts`; a missing public key fails `asset-browser-env.test.ts`; a
   missing logo fails `asset-by-config.test.ts`.
7. **Set the deploy caps and deploy the instance.** The script reads them off the
   environment by the same convention — `VAULT_ONCHAIN_MAX_POSITION_CALL_<SYM>`,
   `…_MAX_EXPIRY_CALL_<SYM>`, `…_MAX_POSITION_PUT_<SYM>`, `…_MAX_EXPIRY_PUT_<SYM>`, and
   optionally `…_MAX_PREMIUM_BPS_<SYM>` — and **refuses without all four**, because a cap
   the deployment did not state is not a looser cap, it is one nobody chose. Size them in
   the asset's own units. Then `node scripts/deploy-vault.mjs <SYMBOL> --dry-run`, and
   without the flag when it prints what you meant.
8. **Record the deployed limits** in `onchainLimits`, read back off the instance with
   `--check` rather than copied from the deploy command.
9. **Establish the trustlines** the treasury and the distributor need for the new
   receivable.
10. **Set the env values** and rebuild. `NEXT_PUBLIC_*` is inlined at build time: adding
    them to the host without redeploying changes nothing, and redeploying without them
    lists the book as gated.
11. Check `/api/health` — the book should be absent from the gated list.

Step 10 is the one that costs an afternoon. It has already cost one.

---

## 7. Worked example: what ETH is missing

ETH is declared in `config.ts` and gated on exactly three values:

```
contracts.vault      no vault instance is deployed for this book
contracts.token      the collateral a call escrows has no SAC
stellarAsset.issuer  nobody anchors this asset yet
```

All three are `unconfigured`, not `invalid` — nobody has deployed it, which is a plan
rather than a bug. The price half needs nothing at all: the Reflector ETH/USD feed
publishes on testnet at the same scale and cadence as the other two.

Supply `NEXT_PUBLIC_VAULT_CONTRACT_ETH`, `NEXT_PUBLIC_ETH_CONTRACT` and
`NEXT_PUBLIC_ETH_ANCHOR_ISSUER` and the book is live. That is the claim M2-07 makes, and
`asset-by-config.test.ts` runs it: it declares ETH with those three keys supplied and
asserts `issues` is empty.
