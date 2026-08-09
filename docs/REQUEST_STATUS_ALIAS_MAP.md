# Request status alias map

**Supersedes the conclusion of `c48aa4b`**, which claimed APPROVED and DRAFT were
unreachable lifecycle states. **That conclusion was incorrect.** They are not
states at all — they are aliases in a local map. The measurements in that commit
were accurate; the interpretation was not. `c48aa4b` is left in history
unamended; this document corrects it.

## The map

[`requests.js:33-39`](backend/src/routes/requests.js:33) defines a **local**
`STATUS` object, distinct from the canonical vocabulary in `stages.js`:

| local name | canonical persisted value |
| --- | --- |
| `STATUS.DRAFT` | `pending_approval` |
| `STATUS.PENDING` | `pending_approval` |
| `STATUS.APPROVED` | `sourcing` |
| `STATUS.SOURCING` | `sourcing` |

`REQ.DRAFT` and `REQ.APPROVED` do not exist in `stages.js` — both are
`undefined`. So two pairs of local names collapse onto two persisted values.

## What follows

1. **Effective editable statuses** are `pending_approval`, `sourcing` and
   `reopened`. The allowlist reads as four entries but resolves to three.
2. **`materialChange` is reachable.** `r.status === STATUS.APPROVED` means
   `r.status === 'sourcing'`, so a headcount, salary-band or grade change on a
   *sourcing* requisition does reset the approval chain, move it to
   `pending_approval`, and record `reapproval_required`. That branch is live and
   must be tested — it is not dead code.
3. **Assign's condition is a sourcing condition.** `if (r.status ===
   STATUS.APPROVED)` reads as `=== 'sourcing'`; it is reachable, not unreachable.
4. There is no "auto-advance past APPROVED". Approval sets `sourcing` directly,
   because `STATUS.APPROVED` *is* `sourcing`.

## Why this was easy to get wrong

The alias map lets a reader see `STATUS.APPROVED` in a guard and reasonably
assume a distinct `approved` state exists. Nothing at the call site reveals that
two names share one value, or that two other names share another. That is a
readability defect with real consequences: it produced a wrong finding, a wrong
test matrix and a wrong claim that a control was dead.

**Replacing the alias map with canonical vocabulary belongs to BL-22.** It is not
done here, and **no lifecycle behaviour is changed by this commit** — it is
documentation only.
