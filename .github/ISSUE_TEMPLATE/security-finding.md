---
name: Security finding
about: A finding from the adversarial testnet window (Medium/Low/Informational, or already public)
title: 'SECURITY: '
labels: security
---

<!--
Critical or High — anything that takes collateral, breaks solvency, moves money wrongly,
or crosses an authorization boundary — goes to utkukaya.tr@gmail.com first, not here.
Report, get an acknowledgement, then publish whenever you like.

Scope and severity: docs/ADVERSARIAL.md
Addresses in scope: docs/DEPLOYMENTS.md
What a report needs, in full: docs/REPORTING.md
-->

## Summary

<!-- One sentence: what an attacker achieves. -->

## Severity claimed

<!-- Critical | High | Medium | Low / Informational — and one line on why. -->

## Class

<!-- One of the nineteen in ADVERSARIAL.md §3, or "none of them" — which is useful too. -->

## Affected

- Book: <!-- XLM | BTC | both | n/a -->
- Contract: <!-- C… from DEPLOYMENTS.md, or n/a -->
- Endpoint: <!-- /api/… , or n/a -->

## Reproduction

<!-- Exact steps someone else can follow. A script beats prose. Say what starting state
     it needs, if any. scripts/reproduce/ has one per protocol flow to start from. -->

1.
2.
3.

## Transactions

<!-- Every transaction the attack submitted, including the ones that FAILED — a failed
     transaction is evidence, and one already-fixed finding turned on exactly that.
     For an API-only finding, give the requests and responses instead. -->

| # | Hash | What it did | Succeeded? |
|---|------|-------------|------------|
| 1 |      |             |            |

## Expected

<!-- What should have happened. -->

## Actual

<!-- What happened. -->

## Impact

<!-- What this is worth to an attacker, and to a writer who is not the attacker. -->

## Notes

<!-- What you tried that did not work, what you think is adjacent, what you are unsure
     about. Uncertainty is useful — say so rather than leaving it out. -->
