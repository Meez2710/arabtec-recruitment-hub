// Hiring UnitOfWork — Drizzle/PostgreSQL adapter (ADR-0002).
//
// THE ONE RULE: repositories are constructed INSIDE `transaction()`, from the
// transaction handle. They are never injected alongside it and never cached on
// the instance.
//
// Two consequences follow, and both are the point:
//
//   1. Every repository inside one `transaction()` call runs on the SAME pinned
//      connection, so `SELECT … FOR UPDATE` in one repository and an UPDATE in
//      another are genuinely part of the same transaction.
//
//   2. The loaded-version registry inside each repository lives exactly as long
//      as the transaction. It cannot leak a stale baseline into the next
//      request, because the object it lives on is discarded at commit.
//
// Attempting to reuse a repository across transactions would silently break
// both. Making them unreachable from outside is what prevents it.

import type { TransactionScope, UnitOfWork } from '../application/ports/unit-of-work.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { runTransactionWithOutbox } from '../../../infrastructure/db/transactional-outbox.js';
import type { OutboxAwareOptions } from '../../../infrastructure/db/transactional-outbox.js';
import { DrizzleRequisitionRepository } from './requisition-repository.js';
import type { RequisitionRepositoryOptions } from './requisition-repository.js';
import { DrizzleApplicationRepository } from './application-repository.js';
import type { ApplicationRepositoryOptions } from './application-repository.js';

export interface HiringUnitOfWorkOptions
  extends OutboxAwareOptions, RequisitionRepositoryOptions, ApplicationRepositoryOptions {}

export class DrizzleHiringUnitOfWork implements UnitOfWork {
  constructor(
    private readonly db: Executor,
    private readonly opts: HiringUnitOfWorkOptions = {},
  ) {}

  async transaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    return runTransactionWithOutbox(
      this.db,
      this.opts,
      (tx, collector) => ({
        requisitions: new DrizzleRequisitionRepository(tx, { ...this.opts, collector }),
        applications: new DrizzleApplicationRepository(tx, { ...this.opts, collector }),
      }),
      fn,
    );
  }
}
