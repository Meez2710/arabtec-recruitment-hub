// RequisitionService — the complete requisition lifecycle.
//
// Every method is one transaction. Every rule lives in the aggregate; this layer
// does authorization, loads, cross-aggregate coordination and event publication.
// There is no status write here and no business condition evaluated here.

import type { Application } from '../domain/application.js';
import type { DomainEvent } from '../domain/requisition.js';
import { Requisition } from '../domain/requisition.js';
import type { FillState, RequisitionState } from '../domain/requisition-states.js';
import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import type { EventBus } from '../../shared/kernel/ports.js';
import type { OfferGateway } from './ports/offer-gateway.js';
import type { TransactionScope, UnitOfWork } from './ports/unit-of-work.js';

/** Permissions this service enforces. Mirrors the seeded permission catalogue. */
export const REQUISITION_PERMISSIONS = {
  CREATE: 'requisition.create',
  EDIT: 'requisition.edit',
  SUBMIT: 'requisition.submit',
  APPROVE: 'requisition.approve',
  ASSIGN_RECRUITER: 'requisition.assign_recruiter',
  HOLD: 'requisition.hold',
  CLOSE: 'requisition.close',
  CANCEL: 'requisition.cancel',
  REOPEN: 'requisition.reopen',
} as const;

/**
 * Whether approval is required. Read from configuration, not hardcoded — the two
 * modes agreed in Document 2 §2 (approval disabled: DRAFT -> APPROVED directly;
 * approval enabled: HR Director and System Admin both notified, first to act wins).
 */
export interface ApprovalSettings {
  approvalRequired(ctx: AuthContext): Promise<boolean>;
}

export interface RequisitionServiceDeps {
  readonly uow: UnitOfWork;
  readonly events: EventBus;
  readonly settings: ApprovalSettings;
  readonly offers: OfferGateway;
}

export interface CreateRequisitionInput {
  readonly title: string;
  readonly projectId: number;
  readonly departmentId: number;
  readonly headcount: number;
}

export interface RequisitionSummary {
  readonly id: number;
  readonly ticketNo: string;
  readonly state: RequisitionState;
  readonly displayStatus: string;
  readonly headcount: number;
  readonly filledSeats: number;
  readonly openSeats: number;
  readonly fillState: FillState;
  readonly recruiterId: number | null;
  readonly version: number;
}

/** Applications withdrawn by a close/cancel cascade. */
export interface CascadeResult {
  readonly withdrawnApplicationIds: readonly number[];
}

export class RequisitionService {
  private readonly uow: UnitOfWork;
  private readonly events: EventBus;
  private readonly settings: ApprovalSettings;
  private readonly offers: OfferGateway;

  constructor(deps: RequisitionServiceDeps) {
    this.uow = deps.uow;
    this.events = deps.events;
    this.settings = deps.settings;
    this.offers = deps.offers;
  }

  /* --------------------------------- create --------------------------------- */

  /**
   * Create a DRAFT with `headcount` open seats.
   *
   * DRAFT is a real state, distinct from PENDING_APPROVAL. The legacy create
   * produced a requisition already showing "Pending Approval" with no approval
   * chain and no approver notified — visible on every dashboard, invisible to
   * approvers, and permanently un-approvable (BL-05).
   */
  async create(input: CreateRequisitionInput, ctx: AuthContext): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.CREATE);

    const { summary, events } = await this.uow.transaction(async (tx) => {
      const ticketNo = await tx.requisitions.nextTicketNo(ctx);
      const id = await tx.requisitions.nextId(ctx);
      const requisition = Requisition.create({
        id,
        tenantId: ctx.tenantId,
        ticketNo,
        title: input.title,
        projectId: input.projectId,
        departmentId: input.departmentId,
        requesterId: ctx.userId,
        headcount: input.headcount,
        createdBy: ctx.userId,
      });
      await tx.requisitions.save(requisition);
      return { summary: summarise(requisition), events: requisition.pullEvents() };
    });

    await this.publish(events);
    return summary;
  }

  /* -------------------------------- lifecycle ------------------------------- */

  /**
   * Edit the descriptive fields. DRAFT and REJECTED only — see the aggregate.
   * Headcount is not editable here; it moves through adjustHeadcount(), which
   * reconciles seats.
   */
  async update(
    id: number,
    patch: { title?: string; projectId?: number; departmentId?: number },
    ctx: AuthContext,
    expectedVersion?: number,
  ): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.EDIT);
    return this.mutate(id, ctx, expectedVersion, (r) => r.updateDetails(patch, ctx.actor));
  }

  /** Submit for approval, or straight to APPROVED when approval is disabled. */
  async submit(id: number, ctx: AuthContext, expectedVersion?: number): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.SUBMIT);
    const approvalRequired = await this.settings.approvalRequired(ctx);
    return this.mutate(id, ctx, expectedVersion, (r) => r.submit(ctx.actor, { approvalRequired }));
  }

  /** Withdraw a submission back to DRAFT. Only the requester may recall. */
  async recall(id: number, ctx: AuthContext, expectedVersion?: number): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.SUBMIT);
    return this.mutate(id, ctx, expectedVersion, (r) => {
      if (r.requesterId !== ctx.userId) throw new ForbiddenError(REQUISITION_PERMISSIONS.SUBMIT);
      r.recall(ctx.actor);
    });
  }

  /**
   * Approve. First approver to act completes it — no chain, no levels.
   * The aggregate refuses if the actor is the requester or creator (BL-02).
   */
  async approve(id: number, ctx: AuthContext, expectedVersion?: number): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.APPROVE);
    return this.mutate(id, ctx, expectedVersion, (r) => r.approve(ctx.actor));
  }

  async reject(
    id: number, reason: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.APPROVE);
    return this.mutate(id, ctx, expectedVersion, (r) => r.reject(ctx.actor, reason));
  }

  /** Revise a rejected requisition back to DRAFT for resubmission. */
  async revise(id: number, ctx: AuthContext, expectedVersion?: number): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.EDIT);
    return this.mutate(id, ctx, expectedVersion, (r) => r.revise(ctx.actor));
  }

  /**
   * Assign a recruiter. From APPROVED this OPENS the requisition — that is the
   * only path to OPEN, so an unowned requisition can never accept pipeline work.
   */
  async assignRecruiter(
    id: number, recruiterId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.ASSIGN_RECRUITER);
    return this.mutate(id, ctx, expectedVersion, (r) => r.assignRecruiter(recruiterId, ctx.actor));
  }

  async hold(
    id: number, reason: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.HOLD);
    return this.mutate(id, ctx, expectedVersion, (r) => r.hold(ctx.actor, reason));
  }

  /** Resume to exactly the state the hold interrupted. */
  async resume(id: number, ctx: AuthContext, expectedVersion?: number): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.HOLD);
    return this.mutate(id, ctx, expectedVersion, (r) => r.resume(ctx.actor));
  }

  /**
   * Adjust headcount, reconciling seats in the same operation (H1).
   * The legacy edit changed headcount and never touched the seat table (BL-21).
   */
  async adjustHeadcount(
    id: number, newCount: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.EDIT);
    return this.mutate(id, ctx, expectedVersion, (r) => r.adjustHeadcount(newCount, ctx.actor));
  }

  /* ---------------------------- close and cancel ---------------------------- */

  /**
   * Close, cascading non-terminal applications to WITHDRAWN.
   *
   * Two rules from Document 2 §5, both closing audit findings:
   *   • A live (sent, unresolved) offer BLOCKS the close. Closing under a
   *     candidate holding a signed letter is a business error, not cleanup.
   *   • Every other non-terminal application is withdrawn with an attributed
   *     reason. The legacy close left candidates at INTERVIEWING on a dead
   *     requisition, counted in every funnel forever (BL-22).
   */
  async close(
    id: number, reason: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<RequisitionSummary & CascadeResult> {
    this.require(ctx, REQUISITION_PERMISSIONS.CLOSE);
    return this.terminate(id, reason, ctx, expectedVersion, 'close');
  }

  async cancel(
    id: number, reason: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<RequisitionSummary & CascadeResult> {
    this.require(ctx, REQUISITION_PERMISSIONS.CANCEL);
    return this.terminate(id, reason, ctx, expectedVersion, 'cancel');
  }

  /**
   * Reopen with additional headcount, creating that many open seats.
   *
   * `additionalHeadcount` is mandatory. Without new seats every seat is FILLED or
   * CANCELLED, so a reopened requisition could be worked but never filled — the
   * failure surfaced only at the final click, after a candidate had accepted (BL-04).
   */
  async reopen(
    id: number, reason: string, additionalHeadcount: number,
    ctx: AuthContext, expectedVersion?: number,
  ): Promise<RequisitionSummary> {
    this.require(ctx, REQUISITION_PERMISSIONS.REOPEN);
    return this.mutate(id, ctx, expectedVersion,
      (r) => r.reopen(ctx.actor, reason, additionalHeadcount));
  }

  /* -------------------------------- internals ------------------------------- */

  /** Load under lock, apply one aggregate operation, save, publish. */
  private async mutate(
    id: number,
    ctx: AuthContext,
    expectedVersion: number | undefined,
    apply: (r: Requisition) => void,
  ): Promise<RequisitionSummary> {
    const { summary, events } = await this.uow.transaction(async (tx) => {
      const requisition = await this.load(tx, id, ctx, expectedVersion);
      apply(requisition);
      await tx.requisitions.save(requisition);
      return { summary: summarise(requisition), events: requisition.pullEvents() };
    });
    await this.publish(events);
    return summary;
  }

  private async terminate(
    id: number,
    reason: string,
    ctx: AuthContext,
    expectedVersion: number | undefined,
    action: 'close' | 'cancel',
  ): Promise<RequisitionSummary & CascadeResult> {
    const { summary, withdrawn, events } = await this.uow.transaction(async (tx) => {
      const requisition = await this.load(tx, id, ctx, expectedVersion);

      // Ask the Offer context through its gateway (ADR-0007). Hiring never reads
      // an offer table and never learns what an offer is.
      const liveOffers = action === 'close'
        ? await this.offers.applicationsWithLiveOffers(id, ctx)
        : [];

      if (action === 'close') {
        requisition.close(ctx.actor, reason, { applicationsWithLiveOffers: liveOffers });
      } else {
        requisition.cancel(ctx.actor, reason);
      }

      const survivors = await tx.applications.findNonTerminalByRequisition(id, ctx);
      const collected: DomainEvent[] = [];
      const withdrawnIds: number[] = [];

      for (const application of survivors) {
        withdrawApplication(application, requisition.ticketNo, reason, ctx);
        await tx.applications.save(application);
        collected.push(...application.pullEvents());
        withdrawnIds.push(application.id);
      }

      await tx.requisitions.save(requisition);
      return {
        summary: summarise(requisition),
        withdrawn: withdrawnIds,
        events: [...requisition.pullEvents(), ...collected],
      };
    });

    await this.publish(events);
    return { ...summary, withdrawnApplicationIds: withdrawn };
  }

  private async load(
    tx: TransactionScope, id: number, ctx: AuthContext, expectedVersion: number | undefined,
  ): Promise<Requisition> {
    const requisition = await tx.requisitions.findByIdForUpdate(id, ctx);
    if (!requisition) throw new NotFoundError('Requisition', id);
    if (expectedVersion !== undefined && expectedVersion !== requisition.version) {
      throw new StaleAggregateError('Requisition', id, expectedVersion, requisition.version);
    }
    return requisition;
  }

  private require(ctx: AuthContext, permission: string): void {
    if (!ctx.has(permission)) throw new ForbiddenError(permission);
  }

  private async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length > 0) await this.events.publish(events);
  }
}

/**
 * Withdraw one application as part of a cascade.
 *
 * ON_HOLD must resume first: the transition map allows ON_HOLD -> WITHDRAWN, but
 * routing through the remembered stage keeps the history honest about where the
 * candidate actually was when the requisition died.
 */
function withdrawApplication(
  application: Application, ticketNo: string, reason: string, ctx: AuthContext,
): void {
  if (application.stage === 'ON_HOLD') application.resume(ctx.actor);
  application.transitionTo('WITHDRAWN', ctx.actor, {
    trigger: 'SYSTEM',
    reason: `Requisition ${ticketNo} closed: ${reason}`,
  });
}

function summarise(r: Requisition): RequisitionSummary {
  return {
    id: r.id,
    ticketNo: r.ticketNo,
    state: r.state,
    displayStatus: r.displayStatus,
    headcount: r.headcount,
    filledSeats: r.filledCount,
    openSeats: r.openCount,
    fillState: r.fillState,
    recruiterId: r.recruiterId,
    version: r.version,
  };
}
