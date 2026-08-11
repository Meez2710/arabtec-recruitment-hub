# Closed requisitions cannot have their headcount amended

**Status:** open workflow gap. Not a defect in BL-04 or BL-21/BL-23.
**Owner decision:** do NOT widen the `PUT /:id` editable-status guard.

## What happens today

`PUT /api/requests/:id` accepts only `DRAFT`, `PENDING`, `APPROVED`, `REOPENED`
([requests.js](backend/src/routes/requests.js)). Any other status returns
**409 `Cannot edit a request in '<status>' state.`** before any transaction opens,
so a closed requisition's headcount cannot be changed at all.

BL-04 independently refuses to reopen a requisition with no remaining capacity —
`headcount − filled ≤ 0` — because reopening one would produce a requisition that
can never accept a candidate.

Together these close a loop:

- a fully filled requisition is closed
- headcount cannot be raised, because the request is closed
- it cannot be reopened, because there is no spare capacity

Neither guard is wrong on its own. The gap is that no operation exists to amend
approved headcount after closure.

## Operational answer for now

**Raise a new requisition** for the additional positions. The closed one keeps
its filled seats and history intact.

The BL-04 conflict message says exactly that. It previously told HR to "increase
the headcount before reopening", which pointed at a route that would 409 — that
wording was corrected; BL-04 behaviour is unchanged.

## Why not just widen the guard

Editing a closed requisition would let approved headcount move with no approval
step, which is the control the close/approve workflow exists to enforce. The
right fix is a **dedicated amendment operation** — reopen-with-amendment, or an
amendment that re-enters the approval chain — not unrestricted editing.

Requirements for that future work:

- explicit permission, distinct from ordinary editing
- re-approval before the new capacity becomes usable
- seat reconciliation against the final persisted status, reusing
  `reconcileSeatsForHeadcount`
- audit recording the amendment as its own action, not a generic update

## Scope

- BL-21/BL-23 does **not** support headcount changes on closed requisitions.
- Closed-increase → reopen is **removed** from BL-21 acceptance.
- The BL-04 reopen regression stays where it is and is unaffected.
