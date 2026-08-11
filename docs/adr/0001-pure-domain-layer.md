# ADR-0001 — The domain layer performs no I/O

**Status:** Accepted · **Date:** 2026-08 · **Context:** Hiring module, Phase 1

## Context

The audits found business rules scattered across HTTP handlers. `stages.js`
declared a complete application transition map and a complete requisition
transition map; the application half was consulted by two routes, and the
requisition half had **zero call sites**. Every requisition status change was a
raw `UPDATE` guarded by one of four different hardcoded arrays.

The rules were not wrong. They were unenforced, because nothing owned them.

## Decision

`modules/hiring/domain/` contains aggregates, state machines and invariants and
**imports nothing** — no database, no framework, no clock, no logger. Its only
dependencies are its own sibling files.

State changes happen exclusively through methods on an aggregate. There is no
`setStatus`, no `setStage`, and repositories expose no field-level write.

## Consequences

**Good**

- Rules are enforced by construction. A new route cannot skip a check that has
  no bypass.
- The layer is testable at microsecond speed with no fixtures. 92 domain tests
  run in ~120 ms, which makes property-based testing over 200-operation
  sequences practical — that is how two real invariant violations were found
  before any persistence existed.
- Rehydration re-checks invariants, so corrupted storage surfaces at load rather
  than propagating.

**Accepted costs**

- Aggregates must be fully loaded to be mutated, including their seats. For a
  requisition (≤ ~50 seats) this is trivial; it would not be for an aggregate
  with thousands of children, which is why `Application` is a **separate**
  aggregate referenced by id.
- Cross-aggregate invariants (H4, H5) cannot live in the domain and must be
  enforced by a service. See ADR-0003.
