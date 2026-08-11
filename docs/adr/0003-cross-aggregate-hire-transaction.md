# ADR-0003 — Hire spans two aggregates in one transaction

**Status:** Accepted · **Context:** Hiring module, Phase 1
**Closes:** BL-03, BL-23, BL-27

## Context

Invariants H3 and H4 form a bijection:

> every `FILLED` seat references exactly one `HIRED` application, and every
> `HIRED` application occupies exactly one `FILLED` seat

Seats belong to the **Requisition** aggregate. Stage belongs to the
**Application** aggregate. The invariant straddles the boundary.

Classic DDD says one transaction per aggregate, reconciled eventually. Applying
that rule here reproduces the exact corruption the audit found: an application
showing `HIRED` with no seat consumed, `headcount_filled` at zero, and the
requisition still open — with the dashboard reporting 100% fill from the seat
table while the application table showed three hires against two seats.

Eventual consistency is the wrong tool for an invariant that must hold at every
observable moment. Nobody will accept "the headcount will be right shortly."

## Decision

`HiringService.recordHire()` and `reverseHire()` load and mutate **both**
aggregates inside a single transaction. They are the only place in the context
that does so.

This is a deliberate, documented deviation — not an oversight — justified by:

1. The invariant is genuinely cross-aggregate and must hold immediately.
2. Both aggregates live in one relational database, so one transaction is
   available and cheap.
3. The deviation is confined to **two methods** on **one service**, with no
   alternative path. There is no other way to reach `HIRED`.

## Consequences

**Good**

- A hire without a seat, or a seat without a hire, is not reachable.
- The lock scope is small and predictable: one requisition row, one application
  row, for the duration of one short transaction.

**Accepted costs**

- If Requisition and Application are ever split across databases or services,
  these two methods need a saga. That is a known, bounded, two-method cost, and
  the seam is documented here for whoever pays it.
- The rule "one aggregate per transaction" is now a convention with a named
  exception rather than an absolute. Any further exception requires its own ADR.
