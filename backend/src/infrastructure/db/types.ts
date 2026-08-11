// The executor type every repository is written against.
//
// Repositories NEVER hold a pool or a connection. They hold an `Executor`, which
// is either the root database handle or a transaction handle — the two are
// interchangeable at the type level, which is exactly what lets a repository be
// constructed from inside `UnitOfWork.transaction()` and be guaranteed to run on
// that transaction's pinned connection (ADR-0002).
//
// It is deliberately driver-agnostic. Production uses node-postgres; the
// integration tests use PGlite (real PostgreSQL compiled to WASM). Both satisfy
// this type, so the tests exercise the SAME repository code that ships.

import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * A drizzle handle that can run statements.
 *
 * Schema-less on purpose: the repositories use the explicit query builder
 * (`select().from()`), never the relational `db.query.*` API, so they do not
 * need the schema threaded through the type. Keeping it out means the type is
 * identical for the root handle and for a transaction handle.
 */
export type Executor = PgDatabase<PgQueryResultHKT, Record<string, never>>;

/** A handle known to be inside a transaction. Structurally identical; named for intent. */
export type TxExecutor = Executor;
