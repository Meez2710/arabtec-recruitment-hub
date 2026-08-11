// PipelineService — candidate entry and stage movement.
//
// `transition` is the only manual mover in the system, and `applySystemTransition`
// is the only door other contexts use. Both funnel into Application.transitionTo,
// so there is exactly one enforcement point for the transition map (closes BL-14,
// where four offer call sites wrote stages directly past it).

import { Application } from '../domain/application.js';
import type { DomainEvent, Requisition } from '../domain/requisition.js';
import { PIPELINE_STAGES, type ApplicationStage } from '../domain/stages.js';
import { RequisitionNotOpenError } from '../domain/errors.js';
import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import type { EventBus } from '../../shared/kernel/ports.js';
import type { TransactionScope, UnitOfWork } from './ports/unit-of-work.js';

export const PIPELINE_PERMISSIONS = {
  ADD_CANDIDATE: 'candidate.link',
  MOVE_STAGE: 'candidate.move_stage',
  BULK_ACTION: 'application.bulk_action',
  ASSIGN_RECRUITER: 'requisition.assign_recruiter',
} as const;

export interface PipelineServiceDeps {
  readonly uow: UnitOfWork;
  readonly events: EventBus;
}

export interface AddCandidateInput {
  readonly requisitionId: number;
  readonly candidateId: number;
  /** SOURCED or MATCHED only. Anything else is rejected before the domain sees it. */
  readonly initialStage?: 'SOURCED' | 'MATCHED';
  readonly recruiterId?: number | null;
}

export interface TransitionInput {
  readonly applicationId: number;
  readonly toStage: ApplicationStage;
  readonly reason?: string;
  readonly expectedVersion?: number;
}

export interface ApplicationSummary {
  readonly id: number;
  readonly applicationNo: string;
  readonly candidateId: number;
  readonly requisitionId: number;
  readonly stage: ApplicationStage;
  readonly version: number;
}

/** Per-item outcome. A bulk action reports what it skipped and why — never silently. */
export interface BulkOutcome {
  readonly applicationId: number;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly message?: string;
}

export interface BulkResult {
  readonly affected: number;
  readonly skipped: readonly BulkOutcome[];
}

export class PipelineService {
  private readonly uow: UnitOfWork;
  private readonly events: EventBus;

  constructor(deps: PipelineServiceDeps) {
    this.uow = deps.uow;
    this.events = deps.events;
  }

  /* ------------------------------ candidate entry ---------------------------- */

  /**
   * Link a candidate to a requisition at an entry stage.
   *
   * Two guards the legacy endpoint lacked: the requisition must be OPEN, and the
   * stage must be an entry stage. The old route accepted any stage from the
   * client — including `joined` — producing a hired candidate with no seat
   * consumed and headcount untouched (BL-03).
   */
  async addCandidate(input: AddCandidateInput, ctx: AuthContext): Promise<ApplicationSummary> {
    this.require(ctx, PIPELINE_PERMISSIONS.ADD_CANDIDATE);

    const { summary, events } = await this.uow.transaction(async (tx) => {
      const requisition = await tx.requisitions.findById(input.requisitionId, ctx);
      if (!requisition) throw new NotFoundError('Requisition', input.requisitionId);
      if (requisition.state !== 'OPEN') {
        throw new RequisitionNotOpenError(requisition.state, 'add a candidate');
      }

      const applicationNo = await tx.applications.nextApplicationNo(ctx);
      const id = await tx.applications.nextId(ctx);
      const application = Application.create({
        id,
        tenantId: ctx.tenantId,
        applicationNo,
        candidateId: input.candidateId,
        requisitionId: input.requisitionId,
        recruiterId: input.recruiterId ?? requisition.recruiterId,
        stage: input.initialStage ?? 'SOURCED',
        actor: ctx.actor,
      });
      await tx.applications.save(application);
      return { summary: summarise(application), events: application.pullEvents() };
    });

    await this.publish(events);
    return summary;
  }

  /* ------------------------------- transitions ------------------------------ */

  /** The single manual mover. Board, list, table and drag-and-drop all land here. */
  async transition(input: TransitionInput, ctx: AuthContext): Promise<ApplicationSummary> {
    this.require(ctx, PIPELINE_PERMISSIONS.MOVE_STAGE);

    const { summary, events } = await this.uow.transaction(async (tx) => {
      const application = await this.load(tx, input.applicationId, ctx, input.expectedVersion);
      const requisition = await tx.requisitions.findById(application.requisitionId, ctx);
      if (!requisition) throw new NotFoundError('Requisition', application.requisitionId);

      assertRequisitionPermitsMove(requisition, application.stage, input.toStage);

      application.transitionTo(input.toStage, ctx.actor, {
        trigger: 'MANUAL',
        reason: input.reason ?? null,
      });
      await tx.applications.save(application);
      return { summary: summarise(application), events: application.pullEvents() };
    });

    await this.publish(events);
    return summary;
  }

  /**
   * The door other bounded contexts use. Offer drives OFFER_SENT / HIRED /
   * OFFER_DECLINED through here rather than writing a stage itself, so the
   * pipeline and the offer can never disagree about where a candidate is.
   *
   * Still validated by the same transition map — SYSTEM is a trigger, not a
   * bypass.
   */
  async applySystemTransition(
    input: TransitionInput, ctx: AuthContext,
  ): Promise<ApplicationSummary> {
    const { summary, events } = await this.uow.transaction(async (tx) => {
      const application = await this.load(tx, input.applicationId, ctx, input.expectedVersion);
      application.transitionTo(input.toStage, ctx.actor, {
        trigger: 'SYSTEM',
        reason: input.reason ?? null,
      });
      await tx.applications.save(application);
      return { summary: summarise(application), events: application.pullEvents() };
    });

    await this.publish(events);
    return summary;
  }

  /** Resume from ON_HOLD to the stage the hold interrupted. */
  async resume(
    applicationId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<ApplicationSummary> {
    this.require(ctx, PIPELINE_PERMISSIONS.MOVE_STAGE);

    const { summary, events } = await this.uow.transaction(async (tx) => {
      const application = await this.load(tx, applicationId, ctx, expectedVersion);
      application.resume(ctx.actor);
      await tx.applications.save(application);
      return { summary: summarise(application), events: application.pullEvents() };
    });

    await this.publish(events);
    return summary;
  }

  /**
   * Move many applications to one stage.
   *
   * Partial success is the contract: each item is attempted independently and
   * every skip is reported with a machine code. Silent truncation is not
   * acceptable — a recruiter who selects 40 candidates and moves 31 must be told
   * which 9 did not move and why.
   */
  async bulkTransition(
    applicationIds: readonly number[],
    toStage: ApplicationStage,
    ctx: AuthContext,
    opts: { reason?: string } = {},
  ): Promise<BulkResult> {
    this.require(ctx, PIPELINE_PERMISSIONS.BULK_ACTION);

    const skipped: BulkOutcome[] = [];
    let affected = 0;

    // One transaction per item. A single failure must not roll back the
    // successes, which is the whole point of reporting partial results.
    for (const applicationId of applicationIds) {
      try {
        await this.transition({ applicationId, toStage, reason: opts.reason }, ctx);
        affected += 1;
      } catch (err) {
        skipped.push({
          applicationId,
          ok: false,
          errorCode: codeOf(err),
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { affected, skipped };
  }

  /* --------------------------- recruiter workspace -------------------------- */

  async setNextAction(
    applicationId: number, action: string | null, dueAt: Date | null, ctx: AuthContext,
  ): Promise<ApplicationSummary> {
    this.require(ctx, PIPELINE_PERMISSIONS.MOVE_STAGE);
    return this.mutate(applicationId, ctx, (a) => a.setNextAction(action, dueAt, ctx.actor));
  }

  async assignRecruiter(
    applicationId: number, recruiterId: number, ctx: AuthContext,
  ): Promise<ApplicationSummary> {
    this.require(ctx, PIPELINE_PERMISSIONS.ASSIGN_RECRUITER);
    return this.mutate(applicationId, ctx, (a) => a.assignRecruiter(recruiterId, ctx.actor));
  }

  /* -------------------------------- internals ------------------------------- */

  private async mutate(
    applicationId: number, ctx: AuthContext, apply: (a: Application) => void,
  ): Promise<ApplicationSummary> {
    const { summary, events } = await this.uow.transaction(async (tx) => {
      const application = await this.load(tx, applicationId, ctx, undefined);
      apply(application);
      await tx.applications.save(application);
      return { summary: summarise(application), events: application.pullEvents() };
    });
    await this.publish(events);
    return summary;
  }

  private async load(
    tx: TransactionScope, id: number, ctx: AuthContext, expectedVersion: number | undefined,
  ): Promise<Application> {
    const application = await tx.applications.findByIdForUpdate(id, ctx);
    if (!application) throw new NotFoundError('Application', id);
    if (expectedVersion !== undefined && expectedVersion !== application.version) {
      throw new StaleAggregateError('Application', id, expectedVersion, application.version);
    }
    return application;
  }

  private require(ctx: AuthContext, permission: string): void {
    if (!ctx.has(permission)) throw new ForbiddenError(permission);
  }

  private async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length > 0) await this.events.publish(events);
  }
}

/**
 * The requisition-state guard matrix from Document 2 §5.
 *
 *   OPEN     — everything permitted
 *   ON_HOLD  — non-advancing moves only (rejections, withdrawals, backward steps)
 *   anything else — no pipeline work at all
 *
 * The legacy move endpoint checked nothing, so a candidate could be advanced —
 * and hired — on a requisition that had been deliberately frozen (BL-13).
 */
function assertRequisitionPermitsMove(
  requisition: Requisition, fromStage: ApplicationStage, toStage: ApplicationStage,
): void {
  if (requisition.state === 'OPEN') return;

  if (requisition.state === 'ON_HOLD') {
    if (isAdvancing(fromStage, toStage)) {
      throw new RequisitionNotOpenError(requisition.state, 'advance a candidate');
    }
    return;
  }
  throw new RequisitionNotOpenError(requisition.state, 'move a candidate');
}

/** A move is advancing when the target sits later in the forward pipeline. */
function isAdvancing(fromStage: ApplicationStage, toStage: ApplicationStage): boolean {
  const from = (PIPELINE_STAGES as readonly string[]).indexOf(fromStage);
  const to = (PIPELINE_STAGES as readonly string[]).indexOf(toStage);
  if (from === -1 || to === -1) return false; // exits and holds are never advancing
  return to > from;
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function summarise(a: Application): ApplicationSummary {
  const state = a.toState();
  return {
    id: a.id,
    applicationNo: state.applicationNo,
    candidateId: a.candidateId,
    requisitionId: a.requisitionId,
    stage: a.stage,
    version: a.version,
  };
}
