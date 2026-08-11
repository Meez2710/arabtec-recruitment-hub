# ADR-0009 — Migration is incremental via adapters over the legacy data layer

**Status:** Accepted · **Context:** Hiring module, Phase 1

## Context

The existing ATS is live with Arabtec HR. A big-bang replacement would mean a
long branch, a risky cutover, and no user-visible progress in between. The
instruction is explicit: the new architecture must plug into existing
repositories and APIs later **without rewriting the domain**.

## Decision

Four commitments:

1. **Repository ports are shaped for the existing relational schema**, not for an
   idealised one. `RequisitionRepository` and `ApplicationRepository` map onto
   `recruitment_request`, `requisition_seat`, `application` and
   `application_stage_history` as they exist today.

2. **Two adapters, one interface.** A Drizzle/Postgres adapter is the target. An
   adapter over the legacy `models.js` is buildable *now* — the legacy layer is
   synchronous, and the ports are `Promise`-returning, so the adapter wraps calls
   in `Promise.resolve()`. Async ports over a sync implementation is trivially
   valid; the reverse is not, which is why the ports are async from the start.

3. **Strangler-fig routing.** New services mount at `/api/v1/...` beside the
   untouched legacy `/api/...`. The frontend switches per screen. Rollback is a
   route swap, not a revert.

4. **Vocabulary is translated at the boundary, once.** `LEGACY_STAGE_ALIASES` and
   `LEGACY_STATE_ALIASES` are exported for the migration and as a read-time
   safety net. Application code never consults them — that was the whole failure
   of the previous translation layer, which translated in the *write* direction
   and produced stages the board could never reach.

## Consequences

**Good**

- The domain can be finished and fully tested before any persistence decision is
  executed.
- A vertical slice can ship against the legacy tables, proving the design under
  real data before the Drizzle migration.
- Legacy routes keep running untouched, so production is unaffected by Phase 1.

**Accepted costs**

- Two data paths coexist during migration. A record written by a legacy route and
  read by a new service must produce identical behaviour — the migration test
  fixture (a database containing every legacy vocabulary value) is the gate.
- The legacy adapter is throwaway work. Accepted deliberately: it buys the
  ability to validate the domain against production data months before the
  persistence rewrite is finished.
- Invariant H1 (`seats.length === headcount`) is **not currently true of
  production data**. The reconciliation report must run, and its exceptions be
  resolved, before any legacy adapter goes live — otherwise rehydration will
  throw `InvariantViolationError` on load. This is a feature, not a bug: it
  surfaces existing corruption instead of perpetuating it.
