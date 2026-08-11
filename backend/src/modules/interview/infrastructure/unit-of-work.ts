// Interview UnitOfWork — Drizzle/PostgreSQL adapter (ADR-0002).
//
// Same contract as Hiring's: the repository is built from the transaction
// handle, inside the transaction, and is unreachable afterwards.

import type { InterviewTransactionScope, InterviewUnitOfWork } from '../application/ports.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { runTransactionWithOutbox } from '../../../infrastructure/db/transactional-outbox.js';
import type { OutboxAwareOptions } from '../../../infrastructure/db/transactional-outbox.js';
import { DrizzleInterviewRepository } from './interview-repository.js';
import type { InterviewRepositoryOptions } from './interview-repository.js';

export interface InterviewUnitOfWorkOptions
  extends OutboxAwareOptions, InterviewRepositoryOptions {}

export class DrizzleInterviewUnitOfWork implements InterviewUnitOfWork {
  constructor(
    private readonly db: Executor,
    private readonly opts: InterviewUnitOfWorkOptions = {},
  ) {}

  async transaction<T>(fn: (tx: InterviewTransactionScope) => Promise<T>): Promise<T> {
    return runTransactionWithOutbox(
      this.db,
      this.opts,
      (tx, collector) => ({ interviews: new DrizzleInterviewRepository(tx, { ...this.opts, collector }) }),
      fn,
    );
  }
}
