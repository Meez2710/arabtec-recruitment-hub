// Offer UnitOfWork — Drizzle/PostgreSQL adapter (ADR-0002).

import type { OfferTransactionScope, OfferUnitOfWork } from '../application/offer-service.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { runTransactionWithOutbox } from '../../../infrastructure/db/transactional-outbox.js';
import type { OutboxAwareOptions } from '../../../infrastructure/db/transactional-outbox.js';
import { DrizzleOfferRepository } from './offer-repository.js';
import type { OfferRepositoryOptions } from './offer-repository.js';

export interface OfferUnitOfWorkOptions extends OutboxAwareOptions, OfferRepositoryOptions {}

export class DrizzleOfferUnitOfWork implements OfferUnitOfWork {
  constructor(
    private readonly db: Executor,
    private readonly opts: OfferUnitOfWorkOptions = {},
  ) {}

  async transaction<T>(fn: (tx: OfferTransactionScope) => Promise<T>): Promise<T> {
    return runTransactionWithOutbox(
      this.db,
      this.opts,
      (tx, collector) => ({ offers: new DrizzleOfferRepository(tx, { ...this.opts, collector }) }),
      fn,
    );
  }
}
