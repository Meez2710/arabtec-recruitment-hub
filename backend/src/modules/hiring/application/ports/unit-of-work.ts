// Unit of Work — the transaction boundary (ADR-0002).
//
// Repositories are obtained FROM the scope, never injected alongside it. That is
// the whole point: every repository inside one `transaction()` call shares one
// pinned database connection.
//
// The defect this exists to prevent (Audit #1 F-01): the legacy tx() helper ran
// BEGIN, the writes, and COMMIT as three separate pool.query() calls, each of
// which checks out an arbitrary connection. The BEGIN was orphaned and the
// writes executed in autocommit — so seat filling, the one place with overfill
// protection, had no atomicity at all in production.

import type { ApplicationRepository, RequisitionRepository } from './repositories.js';

/** Repositories bound to a single pinned connection for the life of a transaction. */
export interface TransactionScope {
  readonly requisitions: RequisitionRepository;
  readonly applications: ApplicationRepository;
}

export interface UnitOfWork {
  /**
   * Run `fn` inside one transaction. Commits on resolve, rolls back on throw.
   * Nested calls are not supported — a service method is exactly one transaction.
   */
  transaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T>;
}
