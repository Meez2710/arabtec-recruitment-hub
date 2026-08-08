# APPROVED and DRAFT are unreachable through supported API flows

**Status:** open lifecycle finding. Cross-references **BL-01** and **BL-22**.
**Not fixed here** — out of scope for BL-21/BL-23.

## Measured, via the real API only (no direct SQL status writes)

### A — default chain
| step | persisted status |
| --- | --- |
| `POST /requests` | **`pending_approval`** |
| `POST /:id/submit` (200) | `pending_approval` |
| approval chain | 1 level — `HR Director` |
| `POST /:id/approve` (200) | **`sourcing`** — pending steps remaining: 0 |
| `POST /:id/assign` (200) | `sourcing` |

### B — attempt at a multi-level chain
Raising `salaryBandMax` to 999999 produced the **same single-level chain**
(`1: HR Director`), and approval again landed on `sourcing`. No supported input
produced a second approval level.

## Consequences

1. **`APPROVED` is never persisted.** `approve` assigns `STATUS.APPROVED` and the
   request immediately advances to `sourcing`; the observable resting state is
   always `sourcing`.
2. **`DRAFT` is never persisted.** Creation lands directly on `pending_approval`.
3. `assign`'s `if (r.status === STATUS.APPROVED)` branch is **unreachable**.
4. `PUT /:id`'s `materialChange = r.status === STATUS.APPROVED` is **unreachable**,
   so the re-approval path — `Approvals.resetChain`, the transition back to
   PENDING, and the `reapproval_required` activity — appears to be dead code.
5. The `PUT /:id` editable allowlist is `DRAFT, PENDING, APPROVED, REOPENED`;
   two of those four cannot occur, so the route is effectively editable only
   from `pending_approval` and `reopened`.

Point 4 matters beyond testing: a material change to an approved requisition is
**not** currently forcing re-approval, because the condition that would trigger
it cannot be true.

## Effect on BL-21/BL-23

- `mkApprovedReq()` and `mkDraftReq()` are **dropped**; those acceptance cases
  cannot be constructed through supported flows.
- The matrix runs against reachable states only: `pending_approval`, `sourcing`,
  `reopened`, and `closed` (expected 409).
- Reconciliation still resolves the final persisted status generically, so it
  stays correct if the lifecycle is repaired later.

Do not repair the lifecycle here. Re-approval on material change is a BL-01/BL-22
concern and is a release blocker in its own right.
