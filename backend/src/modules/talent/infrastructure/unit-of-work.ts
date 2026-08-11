// Talent UnitOfWork — same contract as the other three (ADR-0002, ADR-0011).

import type { TalentTransactionScope, TalentUnitOfWork } from '../application/ports.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { runTransactionWithOutbox } from '../../../infrastructure/db/transactional-outbox.js';
import type { OutboxAwareOptions } from '../../../infrastructure/db/transactional-outbox.js';
import {
  DrizzleCandidateProposalRepository, DrizzleCandidateRepository, DrizzleCvIntakeRepository,
} from './repositories.js';
import type { TalentRepositoryOptions } from './repositories.js';

export interface TalentUnitOfWorkOptions
  extends OutboxAwareOptions, TalentRepositoryOptions {}

export class DrizzleTalentUnitOfWork implements TalentUnitOfWork {
  constructor(
    private readonly db: Executor,
    private readonly opts: TalentUnitOfWorkOptions = {},
  ) {}

  async transaction<T>(fn: (tx: TalentTransactionScope) => Promise<T>): Promise<T> {
    return runTransactionWithOutbox(
      this.db,
      this.opts,
      (tx, collector) => ({
        candidates: new DrizzleCandidateRepository(tx, { ...this.opts, collector }),
        proposals: new DrizzleCandidateProposalRepository(tx, { ...this.opts, collector }),
        intake: new DrizzleCvIntakeRepository(tx, { ...this.opts, collector }),
      }),
      fn,
    );
  }
}
