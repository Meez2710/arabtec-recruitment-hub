# ADR-0005 — Scope lives in the query; out-of-scope is indistinguishable from missing

**Status:** Accepted · **Context:** Hiring module, Phase 1
**Closes:** Audit #1 F-25, BL-08, BL-30

## Context

Two findings drove this.

**Scoping was theatre.** `user_scope` rows were assignable in User Management,
loaded into every session by `userContext()`, and read by **nothing**. An
administrator restricting a contractor to one project had documented evidence in
the UI that access was limited, while that user could see every candidate in the
organisation.

**Scoping that did exist was applied in JavaScript.** `candidates.js` fetched all
interviews and filtered them after the fact. That leaks row counts, breaks
pagination, and is one forgotten `.filter()` from a disclosure.

## Decision

1. Every repository method takes an `AuthContext`. There is no unscoped read —
   the interface does not offer one.
2. Scope is a `WHERE` fragment **inside** the query. Never a post-filter.
3. An out-of-scope row returns `null` / empty, which the service turns into
   `NotFoundError`. It is **indistinguishable** from a record that does not
   exist.
4. `tenantId` is on `AuthContext` and injected from day one, single-valued until
   customer #2.

Point 3 is the non-obvious one. Returning `403` for out-of-scope and `404` for
missing turns the status code into an existence oracle: a caller can enumerate
which records exist by walking ids.

## Consequences

**Good**

- IDOR is not expressible. There is no repository method that ignores scope.
- Project scoping becomes real, enforced in the one place all data flows through.
- Multi-tenancy later is `tenantId` joining the same object at the same injection
  point, backed by Postgres RLS as the fail-closed net — a ~2-week change instead
  of a 6–10-week retrofit.

**Accepted costs**

- Debugging is slightly harder: "not found" no longer distinguishes a typo from a
  permission gap. Mitigated by logging the real reason server-side under the
  request id, while the client sees only `NOT_FOUND`.
- Every repository signature carries a context parameter. Verbose, and
  deliberately so — it is hard to forget something the type system demands.
