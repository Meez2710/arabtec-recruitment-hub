# ADR-0011 — Repositories drain events into the outbox; the Unit of Work relays after commit

**Status:** Accepted · Phase 3, Step 8 · decided by the product owner

## Context

Events must become durable in the same transaction as the state they describe.
Without that there are two orderings and both are wrong: commit-then-publish
loses the event if the process dies in between; publish-then-commit lets
subscribers act on a state that then rolls back.

Two implementations were put to the product owner:

* **Option A** — repositories drain events during `save()`; no business-layer change.
* **Option B** — services hand events to the transaction scope via `tx.collect(events)`.

**Option A was chosen**, with the business layer to remain frozen.

## The constraint that shapes the implementation

`DomainEvent[]` is `private` on every aggregate and `pullEvents()` — the only
accessor — is destructive (`splice`). Services call it **after** `save()`:

```ts
await tx.applications.save(application);
await tx.requisitions.save(requisition);
return { result, events: [...application.pullEvents(), ...requisition.pullEvents()] };
```

So a repository that pulls during `save()` necessarily takes the events away from
the service. There is no non-destructive read, and adding one would be a
business-layer change.

## Decision

1. `save()` drains the aggregate into a per-transaction `TransactionEventCollector`.
2. The Unit of Work flushes the collector to `outbox_event` **inside** the
   transaction, as the last statement before commit.
3. **After** commit, the Unit of Work relays the events to the `EventDispatcher`
   and marks the delivered rows published.
4. The service's own `publish(events)` is therefore called with `[]` and is a
   no-op.

Step 4 is not a regression, it is required: publishing in-process *and* from the
relay would deliver everything twice.

## Consequences

**The Unit of Work publishes in the service's place.** Net observable behaviour
is unchanged — the same events reach the same `EventBus` after the same commit —
and `outbox.test.ts` asserts that end to end through a real `HiringService` on
the real Unit of Work, because the composed path is the only place this can be
verified.

**The service's `EventBus` is not dead.** It carries the one case the outbox
cannot: an aggregate that recorded events and was never saved. Those have no
outbox row, so no id, so no idempotency and no retry — best effort, and the
`InProcessEventBus` says so.

**The in-memory test doubles do not drain.** So the business layer's own tests
still observe the service publishing. That divergence is deliberate — changing
the doubles would edit the frozen layer's test suite — and it is closed by the
end-to-end test above rather than left implicit.

**Delivery is at-least-once; processing is exactly-once per subscriber.** The
`processed_event` ledger is claimed with `INSERT … ON CONFLICT DO NOTHING`
before the handler runs, so two racing relays cannot both run it. The residual
window — a handler that completes its side effect then dies before its ledger
row commits — is real and is documented at `EventDispatcher`.

**A failed relay never fails the caller.** The transaction is already committed;
throwing would report a failure that did not happen. Rows stay unpublished and
`OutboxDispatcher` picks them up.

## Revisit criteria

Option B becomes worth its cost if cross-aggregate event ordering ever needs to
be occurrence-order rather than save-order, or if a service needs to record an
event without saving an aggregate as a normal case rather than an edge one.
