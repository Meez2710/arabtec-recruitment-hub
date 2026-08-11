# ADR-0004 — Seat acquisition is serialised by a row lock on the requisition

**Status:** Accepted · **Context:** Hiring module, Phase 1

## Context

Two recruiters can mark the last candidate joined at the same moment. Without
serialisation, both read "1 seat open", both fill it, and headcount overruns
approved budget silently.

Three options were considered:

1. **`SELECT … FOR UPDATE SKIP LOCKED` on the seat row.** Highest concurrency,
   but seat selection then lives in SQL, not in the aggregate — the domain would
   no longer own its own invariant, and `fillSeat()` would become a thin wrapper
   over a query.
2. **Optimistic concurrency on the requisition version.** No locks, but the loser
   gets a retryable error on a business action a human just performed. Retrying
   a hire is not something to ask a recruiter to do.
3. **Pessimistic row lock on the requisition.** Serialises hires per requisition.

## Decision

`RequisitionRepository.findByIdForUpdate()` takes `SELECT … FOR UPDATE` on the
requisition row. Concurrent hires against the same requisition queue behind it;
in-memory seat selection inside the aggregate is then safe by construction.

Hires against *different* requisitions do not contend at all.

## Consequences

**Good**

- The aggregate keeps ownership of H2/H3. Seat choice stays in the domain.
- Correctness does not depend on isolation level, which is the trap the previous
  implementation fell into.
- Contention granularity matches reality — nobody runs 50 concurrent hires
  against one requisition.

**Accepted costs**

- A long transaction holding the lock blocks other hires on that requisition.
  Mitigated by keeping the transaction short: no I/O, no AI call, no email
  inside it. Events publish **after** commit (ADR-0006), which is partly why.
- The lock is invisible in the in-memory test fake, so lock behaviour is
  unproven until the Postgres integration slice. **A concurrency test — 10
  parallel hires against a 3-seat requisition, expecting exactly 3 successes —
  is a blocking CI test in that slice.** Tracked as a risk, not as done.
