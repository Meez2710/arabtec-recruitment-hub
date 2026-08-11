# Architecture Decision Records

One file per decision. Each records the context, the decision, and the
consequences we accepted — including the ones we did not like.

Format is deliberately short. An ADR that takes more than a page to read will
not be read.

| # | Decision | Status |
|---|---|---|
| [0001](0001-pure-domain-layer.md) | The domain layer performs no I/O | Accepted |
| [0002](0002-unit-of-work-owns-the-transaction.md) | Unit of Work owns the transaction; repositories come from the scope | Accepted |
| [0003](0003-cross-aggregate-hire-transaction.md) | Hire spans two aggregates in one transaction | Accepted |
| [0004](0004-seat-acquisition-row-lock.md) | Seat acquisition is serialised by a row lock on the requisition | Accepted |
| [0005](0005-scoping-and-not-found.md) | Scope lives in the query; out-of-scope is indistinguishable from missing | Accepted |
| [0006](0006-events-published-after-commit.md) | Events are collected on aggregates and published after commit | Accepted |
| [0007](0007-cross-context-gateways.md) | Cross-context reads go through gateway ports | Accepted |
| [0008](0008-audit-and-notifications-are-subscribers.md) | Audit and notifications subscribe to events; services do not call them | Accepted |
| [0009](0009-incremental-migration.md) | Migration is incremental via adapters over the legacy data layer | Accepted |
| [0010](0010-loaded-version-registry.md) | The repository records the version it loaded; no baseline means insert | Accepted |
| [0011](0011-outbox-drained-by-repositories.md) | Repositories drain events into the outbox; the Unit of Work relays after commit | Accepted |

## Status values

- **Accepted** — in force.
- **Superseded by NNNN** — replaced; kept for the reasoning.
- **Proposed** — under review, not yet built against.
