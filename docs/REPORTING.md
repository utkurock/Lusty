# Reporting a finding

For the adversarial testnet window. Scope and severity definitions are in
[`ADVERSARIAL.md`](./ADVERSARIAL.md); every address in scope is in
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

---

## Where

**On the site, any severity.** While the window is open, every page of
[lusty.finance](https://lusty.finance) has a **report vulnerability** button above the
feedback button. Its fields are the five parts below; nothing in the report is shown
publicly, and you get a reference (`LSR-…`) to quote. This is the shortest path, Critical
and High included.

**Critical or High** (anything that takes collateral, breaks solvency, moves money wrongly,
or crosses an authorization boundary), if you would rather not use the form:

> Email the maintainer directly: **utkukaya.tr@gmail.com**, subject line
> `LUSTY SECURITY: <one line>`.

Do not open a public issue for these until we acknowledge; then publish whenever you like.
We ask for the head start, we do not demand it.

**Medium, Low, or anything already public**: open an issue at
[github.com/utkurock/Lusty/issues](https://github.com/utkurock/Lusty/issues) with the
**Security finding** template (the form below).

Critical and High are acknowledged **the same day** and get a fix branch; everything else
within three days.

---

## What a report needs

Five things. Without the first three we usually cannot triage, and will ask for them.

### 1. The reproduction

Exact steps, in order, that someone else can follow (a script beats prose): the account,
the book (XLM or BTC), any state that mattered (which expiry, how full it was, whether a
position already existed) and how to reach it. The shortest useful report points at one of
the runnable protocol-flow scripts in [`REPRODUCE.md`](./REPRODUCE.md) and says what you
changed.

### 2. Transaction hashes

Every transaction the attack submitted, in order, failed ones included (one finding we
already fixed turned on a failed transaction). Testnet hashes read back at
`https://stellar.expert/explorer/testnet/tx/<hash>`. For an HTTP API finding that never
touched the chain, give each request's method, path, body and response instead.

### 3. Expected versus actual

Two separate sentences, even when it feels obvious: what the system should have done, and
what it did. Establishing the correct behaviour is half of triage, and you likely know it.

### 4. The severity you are claiming

**Critical / High / Medium / Low / Informational**, with one line on why (see
[`ADVERSARIAL.md` §4](./ADVERSARIAL.md)). We assign our own level on receipt and tell you;
if it differs, we explain and discuss it rather than quietly downgrading you.

### 5. Which class it is, if you know

One of the nineteen in [`ADVERSARIAL.md` §3](./ADVERSARIAL.md), or "none of them" (a real
finding that fits none means the scope is wrong).

---

## The form

Copy this.

```
## Summary
One sentence: what an attacker achieves.

## Severity claimed
Critical | High | Medium | Low / Informational  —  because …

## Class
§3 class number, or "none of them".

## Affected
Book:        XLM | BTC | both | n/a
Contract:    C… (from DEPLOYMENTS.md), or n/a
Endpoint:    /api/… , or n/a

## Reproduction
1.
2.
3.

Starting state this needs, if any:

## Transactions
| # | Hash | What it did | Succeeded? |
|---|------|-------------|------------|
| 1 |      |             |            |

(or, for an API-only finding: the requests and responses)

## Expected
What should have happened.

## Actual
What happened.

## Impact
What this is worth to an attacker, and to a writer who is not the attacker.

## Notes
Anything you tried that did not work, anything you think is adjacent, anything you are
unsure about. Uncertainty is fine and useful — say so rather than leaving it out.
```

---

## What happens next

1. **Acknowledgement**: same day for Critical and High, three days otherwise, with the
   severity we assigned and whether the finding is already known (see
   [`ADVERSARIAL.md` §6 and §7](./ADVERSARIAL.md)).
2. **Reproduction**: we run it. If we cannot, we tell you what we tried instead of closing
   it.
3. **Fix**: root cause, fix, regression test in the same commit, redeploy if the fix touched
   Rust, and the original scenario retried. All five, or it is not closed.
4. **Retest**: we ask you to confirm it no longer reproduces, if you are willing.
5. **Publication**: every finding appears in the final adversarial report with its
   severity, remediation and retest evidence, credited to the name or handle you give us,
   or uncredited if you prefer.

Any Medium still open when the window closes is published with a mitigation and a
remediation deadline set before mainnet.

---

## XLM rewards

A valid finding may earn a reward in XLM, at our discretion and scaled to the severity we
assign; there is no fixed table. To qualify, a finding has to:

- be reported through one of the channels above while the window is open,
- be the first report of that issue, and not already listed in
  [`ADVERSARIAL.md` §6 or §7](./ADVERSARIAL.md),
- come with a reproduction we can run,
- stay inside the rules of engagement in [`ADVERSARIAL.md` §2](./ADVERSARIAL.md).

We confirm whether a finding qualifies when we assign its severity, and pay once it is
resolved. Put the Stellar address to pay in your report.

---

## This is a testnet

The collateral is unbacked test assets minted by this repository plus faucet testnet XLM,
so nobody's money is at risk in the vault. The system is meant to hold real collateral
later, so it is published in full first, every address, script and known weakness written
down: attacking it takes reading, not guessing. Findings get fixed and credited, and may
earn an XLM reward.
