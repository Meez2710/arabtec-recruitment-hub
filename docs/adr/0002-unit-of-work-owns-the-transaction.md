# ADR-0002 — Unit of Work owns the transaction; repositories come from the scope

**Status:** Accepted · **Context:** Hiring module, Phase 1 · **Closes:** Audit #1 F-01

## Context

The legacy `tx()` helper ran `BEGIN`, the writes, and `COMMIT` as three separate
`pool.query()` calls. `Pool.query()` checks out an **arbitrary** connection per
call, so `BEGIN` landed on one connection, the `UPDATE` on another, and `COMMIT`
on a third. The `BEGIN` was orphaned and every write executed in autocommit.

`fillSeatAndCount()` — the only `tx()` caller in the codebase, and the one place
with overfill protection — therefore had **no atomicity at all in production**.
It was atomic in local SQLite, which is why the test suite never noticed.

## Decision

A `UnitOfWork` port exposes exactly one method:

```ts
transaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T>
```

Repositories are obtained **from the scope**, never injected alongside it. Every
repository inside one `transaction()` call shares one pinned connection, because
there is no way to obtain one that doesn't.

One service method is exactly one transaction. Nesting is unsupported.

## Consequences

**Good**

- A connection-per-statement transaction is not expressible.
- The transaction boundary is visible at the call site — you can see where it
  opens and closes.
- Rollback is testable: the in-memory fake snapshots and restores, so "a rejected
  operation leaves no partial state" is verified, not assumed.

**Accepted costs**

- Services cannot hold a long-lived repository reference; they reach for the
  scope each time.
- A caller wanting two operations atomically needs a service method that does
  both. This is intentional — it forces the transactional unit to be a named
  business operation rather than an accident of call ordering.
