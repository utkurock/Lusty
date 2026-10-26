# Key custody and operational security

What each key can do, what it cannot, and what breaks if one is lost.

No key in this system can take a user's collateral. The vault contract escrows
it, and it leaves only through `settle(id)`, which anybody may call and which
pays the position's owner at the oracle's expiry price. The keys below shape a
position's terms before it exists, or pay fees. Positions written before
contract custody were held in an operational account until they were wound
down; see [What is still custodial](#what-is-still-custodial).

---

## The keys

| Key | Held by | Can | Cannot |
| --- | --- | --- | --- |
| **Quoter** (a set, max 8) | This server, `VAULT_QUOTER_SECRET` | Co-sign the premium on `open`, up to `max_premium_bps` of the collateral | Move collateral · settle · alter an open position · raise its own ceiling · add another quoter |
| **Admin** | Operator, never in this app's environment | `set_limits`, `add_quoter`, `remove_quoter` | Move collateral · price an option · settle · pay a premium |
| **Treasury** | Operator | Receive assigned collateral, and spend what it has received | Nothing in the contract. It is a destination, not a role |
| **Settlement runner** | This server, `SETTLE_RUNNER_SECRET` | Call `settle(id)` and pay the fee | Everything else. It holds no standing with the contract at all |
| **LUSD issuer** | Operator, 2-of-3 | Mint testnet LUSD | Reach vault collateral |
| **LUSD distributor** | This server, `LUSD_DISTRIBUTOR_SECRET` | Fund the faucet and the swap desk | Reach anything escrowed by the contract |
| **`CRON_SECRET`** | This server | Authorize the scheduled endpoints | Sign anything. It is an endpoint credential, not a key |

Testnet addresses are in
[`contracts/README.md`](../contracts/README.md#testnet-deployment). Admin
(`GBDNJQDP…IKEC`), the quoter set's one member (`GC7Z4LVQ…HLOTX`) and treasury
(`GCXVANOI…JVUX`) are three separate accounts, for the reason in the next
section.

### The quoter is a set, not a key

Until v4, `Config` held a single immutable `quoter`. It now holds an
admin-maintained registry of up to eight addresses. Rotation is
add-then-remove: the contract refuses to empty the set (`LastQuoter`, error
17), so writers are never left without a quoter. Positions priced by a revoked
key keep their premium and escrow and settle normally, since settlement never
consults a quoter. The cap of eight limits exposure, not capacity: every member
can price up to the same ceiling.

---

## Why the admin and the quoter must be different accounts

`max_premium_bps` is the band the quoter may price inside, and the only limit
that widens rather than narrows. On v4 it is 2,000 bps: a premium may not
exceed 20% of the collateral escrowed against it.

Only the admin can raise the band (`set_limits`), and only a quoter's signature
can pay a premium on `open`. In one account, a single compromised key could
raise the ceiling to 100% and write positions that pay out the entire escrow as
premium, each step individually legitimate. `add_quoter` is admin-only, with
the same protection as `set_limits`, so a quoter cannot appoint more quoters.

The ceiling holds for two further reasons:

- Collateral is valued at the oracle price, never at the strike. The strike is
  the quoter's own number, so a strike-denominated ceiling would rise with it,
  and one stroop of XLM written at a $10,000 strike could buy an arbitrarily
  large premium.
- A stolen quoter key can at worst overpay on positions it must also
  collateralize. It cannot drain the cash pool, because every premium is
  bounded by collateral that actually arrived.

---

## Multisig policy

> **Status: applied on testnet, 2026-08-09.** 2-of-3 on the admin account,
> verified by a transaction that was rejected with one signature and accepted
> with two (see [Verification](#verification-2026-08-09) below).

Both privileged calls, `set_limits` and `add_quoter`/`remove_quoter`, are the
admin's entire power, so the admin account is a multisig account. No contract
change is involved: the contract authorizes an address and cannot see how it is
controlled. Multisig is a Stellar account setting (signers and thresholds on
the admin account), invisible to `contracts/vault`.

| Setting | Value |
| --- | --- |
| Admin account | `GBDNJQDP4HJQH6WCJCYVYGTKDRYKZXQQSVEC4FOE24CVG4VRQU26IKEC` |
| Admin signers | 3, each weight 1 (see below) |
| Admin threshold | low / med / high all `2` → **2-of-3** |
| Where the backup signer lives | A wallet on a separate device from the operational key |
| Quoter account multisig | None, deliberately (see below) |

| Signer | Weight | Held as |
| --- | --- | --- |
| `GBDNJQDP…IKEC` (master) | 1 | CLI keystore on the operator's machine, the key that deployed the vault |
| `GANN2GC2…7AYO` | 1 | Browser wallet. The human approval step: every limit change and every quoter rotation needs it |
| `GAC3MHKA…WE5U` | 1 | Backup wallet on a second device. Not used in routine operation |

Why 2-of-3 rather than 2-of-2: losing the admin has no in-contract recovery,
since there is no `upgrade` entrypoint and the admin address cannot change.
Under 2-of-2, losing either key would mean redeploying the vault and migrating
the pools, because `set_options` needs the high threshold and one survivor
cannot rotate the lost key out. Under 2-of-3 any two survivors can rotate the
third, for 0.5 XLM in base reserve.

Apply in this order, because a mistake is unrecoverable: add the signers,
verify them, then raise the thresholds. Raising the threshold to 2 with one
signer locks the account.

Limits: all three signers are currently controlled by one operator. A leaked
CLI keystore can no longer widen `max_premium_bps` or appoint a quoter, but the
operator can produce both signatures, so this guards against key theft, not a
compromised or coerced operator. On mainnet the second and third signers should
be held by different people on different devices.

The quoter stays single-signature. It signs every position, so a higher
threshold would put a human in the path of every deposit. If it leaks, the
admin rotates it, and `max_premium_bps` bounds the damage meanwhile. The runner
has no privilege and needs no multisig.

### Verification (2026-08-09)

Anyone can check the configuration:

```sh
curl -s https://horizon-testnet.stellar.org/accounts/GBDNJQDP4HJQH6WCJCYVYGTKDRYKZXQQSVEC4FOE24CVG4VRQU26IKEC \
  | jq '{signers, thresholds}'
```

It shows three signers of weight 1 and `med_threshold: 2`. Soroban authorizes a
`G…` address against that account's signers and medium threshold, so
`set_limits` and `add_quoter` inherit it.

This was also tested with a `set_limits` call that wrote back the values
already in force, exercising only the authorization path:

| Attempt | Signatures | Result |
| --- | --- | --- |
| One | admin master key only, weight 1 | **Rejected, `TxBadAuth`**, never entered a ledger |
| Two | master key + `GANN2GC2…7AYO`, weight 2 | **Accepted**, ledger 4056855 |
| Three | master key + `GAC3MHKA…WE5U`, weight 2 | **Accepted**, ledger 4057305 |

Attempts one and two share the transaction hash
`7b5142c405eb7496d05236c25342d407bca036546368c85f62ab22248fff9624`: same bytes
and sequence number, differing only in signatures. `TxBadAuth` is refused at submission and leaves nothing on
chain, so the evidence is the account configuration plus the accepted
transaction.

The third attempt
(`be0bf3addd534f7d134110acb7242f81dcaff1f427e1b5fd0a4c5c4673dcedfe`) proves the
backup signer works before it is needed. A backup key can fail silently (an
unbacked-up seed, an address copied from the wallet's wrong account, a lost
device), so two of the three signer pairs are now demonstrated.

Setup transactions: `7f8d2457…` added the second signer, `2828e304…` the third,
`8f2f93bd…` raised all three thresholds to 2.

---

## If a key is lost

Most losses are survivable because the contract holds the money, not the key.

| Key | Lost or stolen → | Not at risk | Recovery |
| --- | --- | --- | --- |
| **Quoter** | Attacker can price new positions anywhere inside `max_premium_bps`, overpaying up to 20% of collateral that they must also supply. Bounded, and it costs them collateral to exploit | Every open position. All escrow. Settlement. The cash pool beyond the bounded overpayment | Admin adds a fresh quoter, then removes the compromised one. No redeploy, no interruption to writers |
| **Admin** | One signer is not enough to act: 2-of-3 means a stolen key buys an attacker nothing on its own. Two signers together can widen `max_premium_bps` and appoint quoters, and combined with a quoter key that is a drain of the escrow via premiums | Collateral already escrowed, since tightening or widening a limit does not reach it. Settlement of existing positions | **One signer: rotate it out** with the surviving two, which is the whole reason for the third. **Two signers: none in-contract.** There is no `upgrade` entrypoint and no way to change the admin address, so recovery means deploying a new vault and migrating the pools |
| **Treasury** | Attacker takes assigned collateral that has already been paid out to it | Everything still escrowed. Every open position | Change the treasury address, which needs a redeploy, since it is set at construction |
| **Runner** | Attacker can settle positions, which anyone can already do, and spend the account's fee balance | Nothing else. It has no privilege to steal | Fund a new account, replace `SETTLE_RUNNER_SECRET`. Meanwhile settlement still works: writers or anyone else can call `settle` |
| **`CRON_SECRET`** | Attacker can trigger the monitor and settlement sweeps | Nothing. Both endpoints do only what anyone could do | Rotate the value |
| **LUSD issuer / distributor** | Attacker mints unbacked testnet LUSD and drains the faucet and swap desk | All contract-escrowed collateral | Rotate the distributor. The issuer is 2-of-3 |

The admin key is the worst case. The contract has no `upgrade` entrypoint
(deliberately, deferred to Tranche 3) and no way to reassign `admin`, so nobody,
including us, can change its behaviour under an existing position, and admin
key management has to be right the first time. That is what U3 is for.

A stolen quoter key is a bounded overpayment, not a drain: the attacker escrows
the collateral, and positions still settle honestly to the owner. The pricing
key is always online, so its compromise had to be survivable.

---

## The environment surface

### Everything `NEXT_PUBLIC_*` is in the browser

Next.js inlines these into the client bundle at build time, so anyone can read
them. Here they hold contract addresses, RPC URLs, the network name and public
account addresses, all already public on the ledger. Never give a secret this
prefix.

### Server-only

| Variable | What it is |
| --- | --- |
| `VAULT_QUOTER_SECRET` | Signs premiums. Never leaves the server; the client receives a signed authorization entry, never the key |
| `SETTLE_RUNNER_SECRET` | Signs settlement transactions. Unprivileged, but still a funded account |
| `LUSD_DISTRIBUTOR_SECRET`, `LUSD_ISSUER_SECRET` | Testnet token operations |
| `CRON_SECRET` | Authorizes `/api/cron/*`. Unset means those endpoints fail closed with 403, which is the safe default rather than an outage to work around |
| `DATABASE_URL` | Full connection string, including credentials |
| `ADMIN_WALLETS` | Addresses allowed into the admin panel. Not a key, an allowlist |

The admin key is not in this list and must never be. No request path calls
`set_limits`, `add_quoter` or `remove_quoter`; the key is used from an
operator's machine, and in a deployment environment it would give anyone who
compromises the server the admin's full power. `.env.example` carries the same
notes beside each variable.

---

## What is still custodial

Nothing. Every position is escrowed by the vault contract and settles on chain,
and no request path can move deposited collateral.

Positions written before contract custody escrowed their collateral in the LUSD
distributor account, whose key this server holds. Closing the payout route
alone would have frozen that book with claims nobody could act on, so it was
settled in full: every position priced at the close of its own expiry minute,
paid, and recorded. The distributor payout route was then deleted, not
disabled. `scripts/legacy-wind-down.mjs` did this and documents the method.

The distributor account and its server-held key remain, used only for the
faucet and the swap desk, which spend protocol funds, not user collateral.

---

## Scheduled jobs

Both `/api/cron/*` endpoints authenticate with `CRON_SECRET` and fail closed
without it.

The settlement runner is not custody. `settle` is permissionless: the contract
checks no caller identity, prices the outcome from the oracle reading at
expiry, and pays the position's owner. The runner pays a fee and receives
nothing. On chain, an account unrelated to the writer, quoter, admin and
treasury settled four positions and lost only its fees. If the runner stops,
anyone, including the writer, can close positions on identical terms; the
tests in `src/lib/__tests__/settlement-scope.test.ts` pin this.

---

## Reporting a vulnerability

Open an issue at [github.com/utkurock/Lusty](https://github.com/utkurock/Lusty)
for anything already public; for anything else, contact the maintainer before
disclosing. This is a testnet deployment with an unbacked test token, so no
funds of value are at risk, but we would still rather hear first.
