# Reporting a finding

For the adversarial testnet window. Scope and severity definitions are in
[`ADVERSARIAL.md`](./ADVERSARIAL.md); every address in scope is in
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

---

## Where

**Critical or High** — anything that takes collateral, breaks solvency, moves money
wrongly, or crosses an authorization boundary:

> Email the maintainer directly: **utkukaya.tr@gmail.com**, subject line
> `LUSTY SECURITY: <one line>`.

Do not open a public issue for these first. Report, get an acknowledgement, then publish
whenever you like — we ask for the head start, we do not demand it.

**Medium, Low, or anything already public** — open an issue at
[github.com/utkurock/Lusty/issues](https://github.com/utkurock/Lusty/issues) using the
**Security finding** template, which is the form below.

Either way you get an acknowledgement. Critical and High are acknowledged **the same day**
and get a fix branch opened against them; everything else within three days.

---

## What a report needs

Five things. A report missing the first three usually cannot be triaged, and we will come
back asking for them rather than guessing.

### 1. The reproduction

Exact steps, in order, that someone else can follow. A script beats prose. Include the
account you used, the book (XLM or BTC), and anything about the state that mattered —
which expiry, how full it was, whether a position already existed.

If the finding needs a particular starting state, say how to get there.
[`REPRODUCE.md`](./REPRODUCE.md) has a runnable script for every protocol flow; pointing at
one of those and saying what you changed is the shortest useful report there is.

### 2. Transaction hashes

Every transaction the attack submitted, in order, including the ones that failed — a
failed transaction is evidence too, and one of the findings we have already fixed turned
on exactly that.

Testnet hashes read back at `https://stellar.expert/explorer/testnet/tx/<hash>`.

If the finding is in the HTTP API and never touched the chain, give the requests instead:
method, path, body, and the response you got.

### 3. Expected versus actual

Two sentences. What the system should have done, and what it did.

State them separately even when it feels obvious. Half the work of triage is establishing
what the correct behaviour was supposed to be, and the reporter usually already knows.

### 4. The severity you are claiming

**Critical / High / Medium / Low / Informational**, with one line on why — see
[`ADVERSARIAL.md` §4](./ADVERSARIAL.md). Claim the level you think it is. We assign our own
on receipt and tell you what it is; if they differ we will say why, and we will argue about
it properly rather than quietly downgrading you.

### 5. Which class it is, if you know

One of the nineteen in [`ADVERSARIAL.md` §3](./ADVERSARIAL.md), or "none of them" — which is
itself useful, because a real finding that fits no class means the scope is wrong.

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

1. **Acknowledgement** — same day for Critical and High, three days otherwise. It names
   the severity we assigned and says whether it is already known (see
   [`ADVERSARIAL.md` §6 and §7](./ADVERSARIAL.md)).
2. **Reproduction** — we run it. If we cannot, we come back with what we tried rather than
   closing it.
3. **Fix** — root cause, fix, regression test in the same commit, redeploy if the fix
   touched Rust, and the original scenario retried. All five, or it is not closed.
4. **Retest** — we ask you to confirm it no longer reproduces, if you are willing.
5. **Publication** — every finding appears in the final adversarial report with its
   severity, its remediation and its retest evidence. You are credited by whatever name or
   handle you give us, or not at all if you prefer.

Anything Medium still open when the window closes is published with a mitigation and a
remediation deadline set before mainnet. Nothing is quietly carried.

---

## This is a testnet

The collateral is unbacked test assets minted by this repository and testnet XLM from a
faucet. **There is no bounty and no money at risk**, and we are not going to pretend
otherwise to make the exercise sound bigger than it is.

What there is: a system that intends to hold real collateral later, published in full
before it does, with every address, every script and every known weakness written down so
that attacking it takes reading rather than guessing. If you find something, it gets fixed
and you are credited for it.
