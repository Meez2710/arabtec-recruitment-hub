# ADR-0010 — The repository records the version it loaded

**Status:** Accepted · Phase 3, Step 4–7

## Context

Aggregates bump their own `version` in memory, once per mutating method. A
service may call two of them inside one transaction, so by the time `save()`
runs, `aggregate.version` can be `loaded + 2`.

That rules out the obvious optimistic-locking guard:

```sql
UPDATE ... SET version = :new WHERE id = :id AND version = :new - 1
```

It is wrong in exactly the case that matters, and wrong in the dangerous
direction: it *widens* the guard rather than failing, so a lost update passes
silently.

A second problem shares the same root. `save()` has no `insert` / `update` flag —
the port is `save(aggregate): Promise<void>` — so the repository must decide for
itself which one to issue.

## Decision

Each repository keeps a **loaded-version registry**: a map from aggregate id to
the version the row had when *this* repository read it, plus row counts for
append-only child collections.

* `findById` / `findByIdForUpdate` / every collection query records a baseline.
* `save()` with **no baseline** ⇒ the aggregate was never read here ⇒ INSERT.
* `save()` with a baseline ⇒ `UPDATE … WHERE id = :id AND version = :baseline`.
  Zero rows affected ⇒ `StaleAggregateError`.
* After any successful save the baseline advances, so a second `save()` in the
  same transaction updates rather than re-inserting.
* Append-only children (stage history) insert only `history.slice(baseline)`.

The registry lives on the repository instance, and repositories are constructed
**inside** `UnitOfWork.transaction()` (ADR-0002). Its lifetime is therefore
exactly one transaction.

## Consequences

**It is not an identity map and must never become one.** A process-wide cache
would reintroduce staleness across requests and leak one user's reads into
another's writes. Per-transaction lifetime is the whole safety argument.

**A query that returns aggregates the caller will save must register baselines.**
`findNonTerminalByRequisition` and `findExpirable` do. `findBookedFor` does
*not* — it loads interviews without their assessments for conflict reporting
only, so an accidental `save()` fails loudly on a duplicate key instead of
writing a partially-loaded aggregate. Both behaviours have a regression test.

**Two repository instances on one executor model two concurrent transactions.**
That is how the lost-update tests are written, and it is faithful: independent
registries are exactly what two concurrent transactions have.

**Cost:** one extra `SELECT version` on the failure path, to tell "stale" from
"deleted" in the log. The user-facing message is the same either way.

## Alternatives rejected

* **`version - 1` as the baseline** — wrong after two mutations, and silently so.
* **A separate `insert()` / `update()` on the port** — pushes a persistence
  detail into the application layer; the service would have to track novelty.
* **`xmin` as the version** — invisible to the domain, and the aggregates already
  carry an explicit `version` that tests and the reconciliation tool read.
