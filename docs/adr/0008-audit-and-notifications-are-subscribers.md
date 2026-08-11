# ADR-0008 — Audit and notifications subscribe to events; services do not call them

**Status:** Accepted · **Context:** Hiring module, Phase 1
**Closes:** BL-34, BL-36, and the swallowed-email defect

## Context

In the legacy code every route handler called `writeAudit()` itself, and every
notification was dispatched inline. The consequences the audits found:

- Actions that changed business state with **no audit record at all**, because
  someone forgot the call on one path.
- `audit.js` swallowed its own write failures with a `console.error`, so an
  action could succeed with no audit entry and no alert — an audit trail with
  unknown holes is not an audit trail.
- `notify.js` called `sendMail(...).catch(() => {})`. Email could be 100% broken
  for every user, indefinitely, with zero signal.

The root cause is the same in all three: a cross-cutting concern implemented as a
per-call-site responsibility.

## Decision

`AuditTimeline` and `NotificationHub` are declared as ports because Hiring owns
the **shape** of what it emits. They are **not called by services**.

The wiring is: service → publishes domain events → EventBus → subscribers, of
which audit and notifications are two.

`HiringService` therefore has no audit dependency and no notification dependency.
Its constructor takes `{ uow, events, clock }` and nothing else.

## Consequences

**Good**

- A new state-changing action cannot ship without an audit entry, because the
  entry derives from the event the aggregate emits, not from a call the developer
  remembered to write.
- Audit coverage becomes a property of the event catalogue — testable by
  asserting every event type has a timeline mapping.
- Notification delivery becomes a queued job with retry and a dead-letter queue.
  Failures are visible.

**Accepted costs**

- Indirection: reading `HiringService` does not tell you an email gets sent. The
  event catalogue and subscriber registry are where that lives, and both need to
  stay discoverable.
- A subscriber failing must not fail the business operation, which means audit
  writes are asynchronous relative to the action. Combined with the
  commit-to-publish window in ADR-0006, an audit entry can in principle be lost —
  closed by the same transactional outbox.
