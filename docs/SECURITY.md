# Key custody and operational security

What each key can do, what it cannot, and what breaks if one is lost.

The short version: **no key in this system can take a user's collateral.**
Collateral is escrowed by the vault contract and leaves only through
`settle(id)`, which pays the position's owner at a price the oracle fixed at
expiry and which anybody may call. Everything below is about keys that shape
the terms of a position before it exists, or that pay transaction fees — not
about keys that hold what users deposited.

One exception, and it is a real one: a book of positions written before contract
custody is still escrowed in an operational account. See
[What is still custodial](#what-is-still-custodial).

---

## The keys

| Key | Held by | Can | Cannot |
| --- | --- | --- | --- |
| **Quoter** (a set, max 8) | This server, `VAULT_QUOTER_SECRET` | Co-sign the premium on `open`, up to `max_premium_bps` of the collateral | Move collateral · settle · alter an open position · raise its own ceiling · add another quoter |
| **Admin** | Operator, never in this app's environment | `set_limits`, `add_quoter`, `remove_quoter` | Move collateral · price an option · settle · pay a premium |
| **Treasury** | Operator | Receive assigned collateral, and spend what it has received | Nothing in the contract. It is a destination, not a role |
| **Settlement runner** | This server, `SETTLE_RUNNER_SECRET` | Call `settle(id)` and pay the fee | Everything else. It holds no standing with the contract at all |
| **LUSD issuer** | Operator, 2-of-3 | Mint testnet LUSD | Reach vault collateral |
| **LUSD distributor** | This server, `LUSD_DISTRIBUTOR_SECRET` | Fund the faucet and the swap desk; pay out the legacy book when explicitly enabled | Reach anything escrowed by the contract |
| **`CRON_SECRET`** | This server | Authorize the scheduled endpoints | Sign anything. It is an endpoint credential, not a key |

Testnet addresses are in
[`contracts/README.md`](../contracts/README.md#testnet-deployment). Admin is
`GBDNJQDP…IKEC`, the quoter set's one member is `GC7Z4LVQ…HLOTX`, treasury is
`GCXVANOI…JVUX` — three separate accounts, which is the point of the next
section.

### The quoter is a set, not a key

`Config` carried a single immutable `quoter` until v4. It now holds a registry
of up to eight addresses, maintained by the admin.

Rotation is **add-then-remove**. The contract refuses to empty the set
(`LastQuoter`, error 17), so there is no ledger in between where a writer would
be turned away for want of anyone to price them. Revocation does not reach
backwards: positions a revoked key priced keep their premium and their escrow
and settle normally, because settlement never consults a quoter.

The bound of eight is a trust surface, not a capacity limit. Every member can
price up to the same ceiling, so a bigger set is strictly more exposure.

---

## Why the admin and the quoter must be different accounts

This is the load-bearing paragraph of this document.

`max_premium_bps` is the only limit that *widens* something rather than
narrowing it: it is the band the quoter is allowed to price inside. On v4 it is
2,000 bps — a premium may not exceed 20% of the collateral escrowed against it.

The admin can raise that band. The admin cannot pay a premium, because only a
quoter's signature satisfies `open`. The quoter can pay a premium up to the
band. The quoter cannot raise the band, because `set_limits` is admin-only.

Each key is bounded by the other. Merge them into one account and the bound
disappears: a single compromised key could raise the ceiling to 100% and then
write positions that pay out the entire escrow as premium. Nothing else in the
contract would object — every individual step is legitimate.

The same reasoning covers `add_quoter`, which is why it belongs to the admin and
why it deserves the same protection as `set_limits`. It is the one call that
widens *who* may sign premiums, and a quoter that could appoint another quoter
would be able to grow its own trust surface.

Two more details that make the ceiling hold:

- Collateral is valued at the **oracle price, never at the strike**. The strike
  is the quoter's own number, so a strike-denominated ceiling would rise with
  it, and one stroop of XLM written at a $10,000 strike could buy an
  arbitrarily large premium.
- The worst a stolen quoter key can do is overpay its share on positions it
  must also collateralize. It cannot drain the cash pool, because every premium
  is bounded by collateral that actually arrived.

---

## Multisig policy

> **Status: applied on testnet, 2026-08-09.** 2-of-3 on the admin account,
> verified by a transaction that was rejected with one signature and accepted
> with two — see [Verification](#verification-2026-08-09) below.

**Both privileged calls sit behind multisig:** `set_limits` and
`add_quoter`/`remove_quoter`. Those are the admin's entire power, so in practice
this means *the admin account is a multisig account*.

**This is not a contract change, and cannot be.** The contract authorizes an
address. It has no view of how that address is controlled — whether one key
signs for it, or three of five. Multisig is a Stellar account-level setting:
signers and thresholds on the admin account itself. Nothing in
`contracts/vault` needs to know, and nothing in it would change.

| Setting | Value |
| --- | --- |
| Admin account | `GBDNJQDP4HJQH6WCJCYVYGTKDRYKZXQQSVEC4FOE24CVG4VRQU26IKEC` |
| Admin signers | 3, each weight 1 — see below |
| Admin threshold | low / med / high all `2` → **2-of-3** |
| Where the backup signer lives | A wallet on a separate device from the operational key |
| Quoter account multisig | None, deliberately — see below |

| Signer | Weight | Held as |
| --- | --- | --- |
| `GBDNJQDP…IKEC` (master) | 1 | CLI keystore on the operator's machine — the key that deployed the vault |
| `GANN2GC2…7AYO` | 1 | Browser wallet. The human approval step: every limit change and every quoter rotation needs it |
| `GAC3MHKA…WE5U` | 1 | Backup wallet on a second device. Not used in routine operation |

**Why 2-of-3 and not 2-of-2.** Read the admin row of the key-loss table below:
losing the admin is the one failure with no in-contract recovery, because there
is no `upgrade` entrypoint and no way to change the admin address. Under 2-of-2,
losing *either* key produces exactly that — `set_options` needs the high
threshold, so the survivor cannot even rotate the dead signer out, and the only
exit is redeploying the vault and migrating the pools. Under 2-of-3 any two
survivors can rotate the third. The third signer costs 0.5 XLM in base reserve
and removes the whole failure mode.

**Order matters when applying this**, and getting it wrong is unrecoverable: add
the signers first, verify them, and raise the thresholds last. Raising the
threshold to 2 while the account still has one signer locks the account in the
same transaction that was meant to protect it.

**What this does not protect against, stated plainly.** All three signers are
currently controlled by one operator. This raises the cost of a *key* compromise
— a leaked CLI keystore is no longer sufficient to widen `max_premium_bps` or
appoint a quoter — but it does not defend against the operator themselves being
compromised or coerced, because the same person can produce both signatures. A
2-of-3 whose signers are one human is a real control against key theft and a
theatrical one against everything else. Mainnet should place the second and
third signers with different people, on different devices; until then this
document should not be read as claiming more than it does.

**The quoter is a separate decision, and the answer is no.** It signs on every
single position, so a threshold above 1 puts a human in the path of every
deposit. It stays single-signature and is protected by rotation speed instead:
if it leaks, the admin adds a new key and removes the old one, and the damage is
bounded by `max_premium_bps` in the meantime. That trade is worth stating
explicitly rather than leaving it to look like an oversight.

**The runner needs none.** It has no privilege to protect.

### Verification (2026-08-09)

Anyone can confirm the configuration without trusting this document:

```sh
curl -s https://horizon-testnet.stellar.org/accounts/GBDNJQDP4HJQH6WCJCYVYGTKDRYKZXQQSVEC4FOE24CVG4VRQU26IKEC \
  | jq '{signers, thresholds}'
```

Three signers of weight 1, `med_threshold: 2`. Since Soroban authorizes a
`G…` address against that account's own signers and medium threshold,
`set_limits` and `add_quoter` inherit it with no contract involvement.

The behaviour was then demonstrated rather than inferred, on a `set_limits` call
that wrote back the values already in force, so nothing changed but the
authorization path:

| Attempt | Signatures | Result |
| --- | --- | --- |
| One | admin master key only, weight 1 | **Rejected, `TxBadAuth`** — never entered a ledger |
| Two | master key + `GANN2GC2…7AYO`, weight 2 | **Accepted**, ledger 4056855 |

Both attempts carry the **same transaction hash**,
`7b5142c405eb7496d05236c25342d407bca036546368c85f62ab22248fff9624`: identical
bytes, identical sequence number, differing only in the signature set. The
rejection leaves no on-chain artifact — `TxBadAuth` is refused at submission —
so the reproducible evidence is the account configuration above, and the
accepted transaction is what proves the same bytes pass once the threshold is
met.

Setup transactions: `7f8d2457…` added the second signer, `2828e304…` the third,
`8f2f93bd…` raised all three thresholds to 2.

---

## If a key is lost

The column that matters is the third one. Most of these are survivable because
the contract, not the key, is what holds the money.

| Key | Lost or stolen → | Not at risk | Recovery |
| --- | --- | --- | --- |
| **Quoter** | Attacker can price new positions anywhere inside `max_premium_bps`, overpaying up to 20% of collateral that they must also supply. Bounded, and it costs them collateral to exploit | Every open position. All escrow. Settlement. The cash pool beyond the bounded overpayment | Admin adds a fresh quoter, then removes the compromised one. No redeploy, no interruption to writers |
| **Admin** | One signer is not enough to act: 2-of-3 means a stolen key buys an attacker nothing on its own. Two signers together can widen `max_premium_bps` and appoint quoters, and combined with a quoter key that is a drain of the escrow via premiums | Collateral already escrowed — tightening or widening a limit does not reach it. Settlement of existing positions | **One signer: rotate it out** with the surviving two, which is the whole reason for the third. **Two signers: none in-contract.** There is no `upgrade` entrypoint and no way to change the admin address, so recovery means deploying a new vault and migrating the pools |
| **Treasury** | Attacker takes assigned collateral that has already been paid out to it | Everything still escrowed. Every open position | Change the treasury address — which needs a redeploy, since it is set at construction |
| **Runner** | Attacker can settle positions, which anyone can already do, and spend the account's fee balance | Nothing else. It has no privilege to steal | Fund a new account, replace `SETTLE_RUNNER_SECRET`. Meanwhile settlement still works: writers or anyone else can call `settle` |
| **`CRON_SECRET`** | Attacker can trigger the monitor and settlement sweeps | Nothing. Both endpoints do only what anyone could do | Rotate the value |
| **LUSD issuer / distributor** | Attacker mints unbacked testnet LUSD and drains the faucet and swap desk, and the legacy book if the payout flag is on | All contract-escrowed collateral | Rotate the distributor. The issuer is 2-of-3 |

Two things worth reading twice:

**Losing the admin key is the worst case, and it has no in-contract recovery.**
The contract has no `upgrade` entrypoint — deliberately, deferred to Tranche 3 —
and no way to reassign `admin`. That is a considered trade: it also means
nobody, including us, can change the contract's behaviour under an existing
position. The price is that admin key management has to be right the first time,
which is what U3 is for.

**A stolen quoter key is not a drain.** It is an overpayment bounded by a
percentage of collateral the attacker has to escrow themselves, on positions
that still settle honestly to the owner. This is the intended shape: the pricing
key is the one that is online constantly, so it is the one whose compromise had
to be survivable.

---

## The environment surface

### Everything `NEXT_PUBLIC_*` is in the browser

Next.js inlines those variables into the client bundle at build time. They are
readable by anyone who opens the page. That is correct for what carries the
prefix here — contract addresses, RPC URLs, the network name, public account
addresses — all of which are on a public ledger anyway. It would be
catastrophic for anything else, so **never prefix a secret**, and treat a
`NEXT_PUBLIC_` name as a declaration that the value is public.

### Server-only

| Variable | What it is |
| --- | --- |
| `VAULT_QUOTER_SECRET` | Signs premiums. Never leaves the server; the client receives a signed authorization entry, never the key |
| `SETTLE_RUNNER_SECRET` | Signs settlement transactions. Unprivileged, but still a funded account |
| `LUSD_DISTRIBUTOR_SECRET`, `LUSD_ISSUER_SECRET` | Testnet token operations |
| `CRON_SECRET` | Authorizes `/api/cron/*`. Unset means those endpoints fail closed with 403, which is the safe default rather than an outage to work around |
| `LEGACY_CLAIM_ENABLED` | Safety catch on the retired payout path. Anything other than `1` keeps it shut |
| `DATABASE_URL` | Full connection string, including credentials |
| `ADMIN_WALLETS` | Addresses allowed into the admin panel. Not a key — an allowlist |

The **admin key is not in this list and must never be.** It is not needed to run
the application: no request path calls `set_limits`, `add_quoter` or
`remove_quoter`. It is an operator key, used from an operator's machine, and
putting it in a deployment environment would hand the whole of the section above
to anyone who compromises the server.

`.env.example` carries the same notes next to each variable, so they travel with
a new deployment rather than only living here.

---

## What is still custodial

Positions written before contract custody escrowed their collateral in the LUSD
distributor account, which this server holds the key to. At the time of writing
that is **592 positions across 207 wallets**, holding roughly 174,000 XLM and
66,000 LUSD, all past expiry.

For those positions, and only those, the trust assumption the contract removes
still applies: a server can move what a user deposited. The payout path is
therefore closed by default — `POST /api/vault/claim` returns 410 unless
`LEGACY_CLAIM_ENABLED=1` — so it is unreachable in normal operation, and the
flag exists so the wind-down can be finished deliberately rather than the book
being abandoned. `GET` on the same route reports what remains, and needs no
flag and no key.

Nothing opened since the migration is affected. Those positions are escrowed by
the contract and settle on chain.

---

## Scheduled jobs

Both `/api/cron/*` endpoints authenticate with `CRON_SECRET` and fail closed
without it.

The settlement runner deserves a note because "a server key that settles
positions" sounds like custody and is not. `settle` is permissionless: the
contract checks no caller identity, prices the outcome from the oracle reading
at expiry, and pays the position's owner. The runner pays a fee and receives
nothing — demonstrated on chain by settling four positions from an account with
no relationship to the writer, the quoter, the admin or the treasury, which
ended the exercise down only its transaction fees.

So the runner is a convenience. If it stops, positions do not become unclaimable;
anyone, including the writer, can close them on identical terms. That property
is what the scope tests in `src/lib/__tests__/settlement-scope.test.ts` pin in
code.

---

## Reporting a vulnerability

Open an issue at [github.com/utkurock/Lusty](https://github.com/utkurock/Lusty)
for anything already public. For anything that is not, contact the maintainer
directly before disclosing. This is a testnet deployment with an unbacked test
token; there are no user funds of value at risk, and we would still rather hear
about it first.
