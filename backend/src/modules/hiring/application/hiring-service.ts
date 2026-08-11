// HiringService — the only place where a hire is recorded or reversed.
//
// This is the one service in the context that spans two aggregates in a single
// transaction (ADR-0003). It is a deliberate deviation from one-aggregate-per-
// transaction, justified by invariants H3/H4: an application at HIRED and a
// FILLED seat are two halves of one fact, and writing one without the other is
// exactly the corruption Audit #2 found (BL-03, BL-23, BL-27).
//
// Every dependency is injected (Phase 1 rule 3). Nothing here knows about
// Postgres, Express, or the legacy models.js.

import type { Application } from '../domain/application.js';
import type { DomainEvent, Requisition } from '../domain/requisition.js';
import type { FillState } from '../domain/requisition-states.js';
import { CandidateAlreadyHiredError } from '../domain/errors.js';
import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { HIRING_PERMISSIONS } from './auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import type { EventBus } from '../../shared/kernel/ports.js';
import type { UnitOfWork } from './ports/unit-of-work.js';

export interface HiringServiceDeps {
  readonly uow: UnitOfWork;
  readonly events: EventBus;
}

export interface RecordHireInput {
  readonly applicationId: number;
  /** Optimistic concurrency. Omit to skip the check (server-initiated flows). */
  readonly expectedApplicationVersion?: number;
}

export interface ReverseHireInput {
  readonly applicationId: number;
  readonly reason: string;
  readonly expectedApplicationVersion?: number;
}

export interface HireResult {
  readonly applicationId: number;
  readonly candidateId: number;
  readonly requisitionId: number;
  readonly stage: string;
  readonly filledSeats: number;
  readonly headcount: number;
  readonly fillState: FillState;
  readonly requisitionState: string;
}

export class HiringService {
  private readonly uow: UnitOfWork;
  private readonly events: EventBus;

  constructor(deps: HiringServiceDeps) {
    this.uow = deps.uow;
    this.events = deps.events;
  }

  /**
   * Record a hire: move the application to HIRED and fill one seat, atomically.
   *
   * Order of operations is deliberate — every cheap validation runs before the
   * scarce resource is touched, so a rejected hire never consumes a seat:
   *   1. permission
   *   2. load both aggregates under row locks
   *   3. H5 — this candidate holds no other active hire
   *   4. application stage transition (validates OFFER_SENT -> HIRED, SYSTEM-only)
   *   5. seat acquisition (validates requisition is OPEN, H2, H3)
   */
  async recordHire(input: RecordHireInput, ctx: AuthContext): Promise<HireResult> {
    this.require(ctx, HIRING_PERMISSIONS.RECORD_HIRE);

    const { result, events } = await this.uow.transaction(async (tx) => {
      const application = await tx.applications.findByIdForUpdate(input.applicationId, ctx);
      if (!application) throw new NotFoundError('Application', input.applicationId);
      assertVersion('Application', application.id, application.version, input.expectedApplicationVersion);

      // The requisition row lock is what serialises concurrent hires against the
      // same requisition, making in-memory seat selection safe (ADR-0004).
      const requisition = await tx.requisitions.findByIdForUpdate(application.requisitionId, ctx);
      if (!requisition) throw new NotFoundError('Requisition', application.requisitionId);

      // H5 spans aggregates, so neither can enforce it alone.
      const conflicting = await tx.applications.findActiveHireForCandidate(
        application.candidateId,
        ctx,
        { excludeApplicationId: application.id },
      );
      if (conflicting !== null) throw new CandidateAlreadyHiredError(application.candidateId);

      application.transitionTo('HIRED', ctx.actor, { trigger: 'SYSTEM' });
      requisition.fillSeat(application.id, ctx.actor);

      await tx.applications.save(application);
      await tx.requisitions.save(requisition);

      return {
        result: summarise(application, requisition),
        events: [...application.pullEvents(), ...requisition.pullEvents()],
      };
    });

    await this.publish(events);
    return result;
  }

  /**
   * Reverse a hire: release the seat and return the application to OFFER_SENT.
   *
   * The legacy model had no release path at all, so a reversed hire left the seat
   * filled forever and the requisition permanently un-fillable (BL-23). It is
   * also the path the talent module calls before erasing a hired candidate, so
   * erasure can never orphan a seat.
   */
  async reverseHire(input: ReverseHireInput, ctx: AuthContext): Promise<HireResult> {
    this.require(ctx, HIRING_PERMISSIONS.REVERSE_HIRE);

    const { result, events } = await this.uow.transaction(async (tx) => {
      const application = await tx.applications.findByIdForUpdate(input.applicationId, ctx);
      if (!application) throw new NotFoundError('Application', input.applicationId);
      assertVersion('Application', application.id, application.version, input.expectedApplicationVersion);

      const requisition = await tx.requisitions.findByIdForUpdate(application.requisitionId, ctx);
      if (!requisition) throw new NotFoundError('Requisition', application.requisitionId);

      // Release first: it validates that a seat is actually held, so a mistaken
      // reversal fails before the application is touched.
      requisition.releaseSeat(application.id, input.reason, ctx.actor);
      application.reverseHire(ctx.actor, input.reason);

      await tx.applications.save(application);
      await tx.requisitions.save(requisition);

      return {
        result: summarise(application, requisition),
        events: [...application.pullEvents(), ...requisition.pullEvents()],
      };
    });

    await this.publish(events);
    return result;
  }

  /* -------------------------------- internals ------------------------------- */

  private require(ctx: AuthContext, permission: string): void {
    if (!ctx.has(permission)) throw new ForbiddenError(permission);
  }

  /**
   * Published after commit (ADR-0006) so a subscriber can never observe state
   * that was rolled back. Publication failure must not undo a committed hire —
   * the production EventBus is a transactional outbox, which removes the gap
   * entirely without changing this call site.
   */
  private async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.events.publish(events);
  }
}

function summarise(application: Application, requisition: Requisition): HireResult {
  return {
    applicationId: application.id,
    candidateId: application.candidateId,
    requisitionId: requisition.id,
    stage: application.stage,
    filledSeats: requisition.filledCount,
    headcount: requisition.headcount,
    fillState: requisition.fillState,
    requisitionState: requisition.state,
  };
}

function assertVersion(
  entityType: string,
  id: number,
  actual: number,
  expected: number | undefined,
): void {
  if (expected !== undefined && expected !== actual) {
    throw new StaleAggregateError(entityType, id, expected, actual);
  }
}
