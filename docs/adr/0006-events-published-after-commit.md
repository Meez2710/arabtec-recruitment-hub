# ADR-0006 — Events are collected on aggregates and published after commit

**Status:** Accepted · **Context:** Hiring module, Phase 1

## Context

Every state-changing action must publish a domain event, even where no
subscriber exists yet (Phase 1 rule 7). Two questions follow: who creates the
event, and when is it published?

The legacy code inlined side effects into route handlers — audit writes,
notification sends, thread posts, activity rows, all interleaved with business
logic. That is why Audit #2 found actions with no audit record, and why
`notify.js` could swallow every email failure indefinitely with no signal.

## Decision

1. **Aggregates create their own events.** The aggregate knows what changed and
   what the previous value was; a service reconstructing that is guesswork.
   Events accumulate on the instance and are drained once via `pullEvents()`.
2. **Services publish after the transaction commits.** A subscriber must never
   observe a state that was rolled back.
3. **Services never inline side effects.** No audit call, no notification call,
   no email. Those are subscribers (ADR-0008).

## Consequences

**Good**

- Side effects are added without touching business logic.
- Events carry enough payload for a subscriber to act without a lookup —
  `SeatFilled` includes `filled`, `headcount` and `fillState`, so a notification
  or read-model invalidation needs no second query.
- A failed transaction publishes nothing. Verified by test.

**Accepted costs and the known gap**

- **There is a window between commit and publish.** If the process dies in it,
  the state change is durable and the event is lost.
- This is accepted for now and closed later by the **transactional outbox**:
  events are written inside the same transaction and relayed by a worker. The
  `EventBus` port is exactly the seam that makes that swap invisible — no service
  changes when it lands.
- Until then, a subscriber must be idempotent. Recorded as a risk against the
  BullMQ slice, not as solved.
