// OfferService — draft, approval, issue and outcome.
//
// This is the context that DRIVES the pipeline: sending an offer moves the
// application to OFFER_SENT, and acceptance is what allows a hire. It does that
// through the Hiring context's published operation, never by writing a stage
// itself (BL-14).

import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import type { Clock, DomainEvent } from '../../shared/kernel/domain.js';
import { systemClock } from '../../shared/kernel/domain.js';
import type { EventBus } from '../../shared/kernel/ports.js';
import type { PipelineGateway } from '../../hiring/index.js';
import { Offer } from '../domain/offer.js';
import type { ApprovalRequirement, CompensationLine } from '../domain/offer.js';
import { LiveOfferExistsError } from '../domain/errors.js';

export const OFFER_PERMISSIONS = {
  CREATE: 'offer.create',
  EDIT: 'offer.edit',
  APPROVE: 'offer.approve',
  APPROVE_DIRECTOR: 'offer.approve_director',
  SEND: 'offer.send',
  RESULT_UPDATE: 'offer.result_update',
} as const;

export interface OfferRepository {
  findById(id: number, ctx: AuthContext): Promise<Offer | null>;
  findByIdForUpdate(id: number, ctx: AuthContext): Promise<Offer | null>;
  save(offer: Offer): Promise<void>;
  nextOfferNo(ctx: AuthContext): Promise<string>;
  nextId(ctx: AuthContext): Promise<number>;
  /** Sent offers past their expiry — the sweep's input. */
  findExpirable(now: Date, ctx: AuthContext): Promise<readonly Offer[]>;
  /** One live offer per application. */
  findLiveForApplication(applicationId: number, ctx: AuthContext): Promise<Offer | null>;
}

export interface OfferTransactionScope { readonly offers: OfferRepository; }

export interface OfferUnitOfWork {
  transaction<T>(fn: (tx: OfferTransactionScope) => Promise<T>): Promise<T>;
}

/** Configuration, resolved by the service and handed to the aggregate. */
export interface OfferSettings {
  /**
   * Returns `directorThreshold: null` when the configured value is missing or
   * unparseable, which makes the aggregate fail CLOSED (BL-11).
   */
  approvalRequirement(ctx: AuthContext): Promise<ApprovalRequirement>;
  /** "This Offer of Employment is valid for 5 days from the document date." */
  validityDays(ctx: AuthContext): Promise<number>;
  /** Configurable component codes. No ratios, no derivation. */
  compensationComponents(ctx: AuthContext): Promise<readonly string[]>;
}

export interface OfferTemplateResolver {
  resolve(offer: Offer, ctx: AuthContext): Promise<{
    templateCode: string;
    templateVersion: number;
    variables: Readonly<Record<string, unknown>>;
  }>;
}

export interface OfferServiceDeps {
  readonly uow: OfferUnitOfWork;
  readonly events: EventBus;
  readonly settings: OfferSettings;
  readonly pipeline: PipelineGateway;
  readonly templates?: OfferTemplateResolver;
  readonly clock?: Clock;
}

export interface OfferSummary {
  readonly id: number;
  readonly offerNo: string;
  readonly applicationId: number;
  readonly candidateId: number;
  readonly status: string;
  readonly totalNet: number;
  readonly currency: string;
  readonly requiresDirectorApproval: boolean;
  readonly expiresAt: Date | null;
  readonly version: number;
}

export class OfferService {
  private readonly uow: OfferUnitOfWork;
  private readonly events: EventBus;
  private readonly settings: OfferSettings;
  private readonly pipeline: PipelineGateway;
  private readonly templates: OfferTemplateResolver | undefined;
  private readonly clock: Clock;

  constructor(deps: OfferServiceDeps) {
    this.uow = deps.uow;
    this.events = deps.events;
    this.settings = deps.settings;
    this.pipeline = deps.pipeline;
    this.templates = deps.templates;
    this.clock = deps.clock ?? systemClock;
  }

  /* ---------------------------------- draft --------------------------------- */

  async draft(input: {
    applicationId: number; candidateId: number; requisitionId: number;
    positionTitle: string; currency: string;
    lines: readonly CompensationLine[];
    joiningDate?: Date | null;
  }, ctx: AuthContext): Promise<OfferSummary> {
    this.require(ctx, OFFER_PERMISSIONS.CREATE);
    const components = await this.settings.compensationComponents(ctx);

    const { summary, events } = await this.uow.transaction(async (tx) => {
      const live = await tx.offers.findLiveForApplication(input.applicationId, ctx);
      if (live) throw new LiveOfferExistsError(input.applicationId, live.id);
      const offerNo = await tx.offers.nextOfferNo(ctx);
      const id = await tx.offers.nextId(ctx);
      const offer = Offer.draft({
        id, tenantId: ctx.tenantId, offerNo,
        applicationId: input.applicationId,
        candidateId: input.candidateId,
        requisitionId: input.requisitionId,
        positionTitle: input.positionTitle,
        currency: input.currency,
        lines: input.lines,
        joiningDate: input.joiningDate ?? null,
        knownComponents: components,
        actor: ctx.actor,
      });
      await tx.offers.save(offer);
      return { summary: summarise(offer), events: offer.pullEvents() };
    });

    // Drafting an offer moves the application to OFFER_PREPARATION through the
    // Hiring context's door, so the two can never disagree.
    await this.pipeline.applySystemTransition(
      { applicationId: input.applicationId, toStage: 'OFFER_PREPARATION' }, ctx,
    );

    await this.publish(events);
    return summary;
  }

  /** Replace compensation. Locked once sent; returns to DRAFT if already approved. */
  async setCompensation(
    offerId: number, lines: readonly CompensationLine[], ctx: AuthContext, expectedVersion?: number,
  ): Promise<OfferSummary> {
    this.require(ctx, OFFER_PERMISSIONS.EDIT);
    const components = await this.settings.compensationComponents(ctx);
    return this.mutate(offerId, ctx, expectedVersion,
      (o) => o.setCompensation(lines, components, ctx.actor));
  }

  /* -------------------------------- approval -------------------------------- */

  async submit(
    offerId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<OfferSummary> {
    this.require(ctx, OFFER_PERMISSIONS.CREATE);
    const requirement = await this.settings.approvalRequirement(ctx);
    return this.mutate(offerId, ctx, expectedVersion, (o) => o.submit(requirement, ctx.actor));
  }

  async recall(
    offerId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<OfferSummary> {
    this.require(ctx, OFFER_PERMISSIONS.EDIT);
    return this.mutate(offerId, ctx, expectedVersion, (o) => o.recall(ctx.actor));
  }

  /** The aggregate refuses self-approval; the service supplies director authority. */
  async approve(
    offerId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<OfferSummary> {
    this.require(ctx, OFFER_PERMISSIONS.APPROVE);
    const hasDirectorAuthority = ctx.has(OFFER_PERMISSIONS.APPROVE_DIRECTOR);
    return this.mutate(offerId, ctx, expectedVersion,
      (o) => o.approve(ctx.actor, { hasDirectorAuthority }));
  }

  async rejectApproval(
    offerId: number, reason: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<OfferSummary> {
    this.require(ctx, OFFER_PERMISSIONS.APPROVE);
    return this.mutate(offerId, ctx, expectedVersion, (o) => o.rejectApproval(reason, ctx.actor));
  }

  /* ---------------------------------- send ---------------------------------- */

  /**
   * Issue an approved offer: pin the template, snapshot the variables, start the
   * validity clock, then move the application to OFFER_SENT.
   */
  async send(
    offerId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<OfferSummary> {
    this.require(ctx, OFFER_PERMISSIONS.SEND);
    const validityDays = await this.settings.validityDays(ctx);
    const now = this.clock.now();

    const { summary, applicationId, events } = await this.uow.transaction(async (tx) => {
      const offer = await this.load(tx, offerId, ctx, expectedVersion);
      const template = this.templates
        ? await this.templates.resolve(offer, ctx)
        : { templateCode: 'DEFAULT', templateVersion: 1, variables: {} };

      offer.send({
        templateCode: template.templateCode,
        templateVersion: template.templateVersion,
        variableSnapshot: template.variables,
        validityDays,
        now,
        actor: ctx.actor,
      });
      await tx.offers.save(offer);
      return {
        summary: summarise(offer),
        applicationId: offer.applicationId,
        events: offer.pullEvents(),
      };
    });

    await this.pipeline.applySystemTransition(
      { applicationId, toStage: 'OFFER_SENT', reason: 'Offer sent' }, ctx,
    );
    await this.publish(events);
    return summary;
  }

  /* --------------------------------- outcome -------------------------------- */

  async accept(
    offerId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<OfferSummary> {
    this.require(ctx, OFFER_PERMISSIONS.RESULT_UPDATE);
    const now = this.clock.now();
    // Acceptance does NOT move the pipeline. The candidate stays at OFFER_SENT
    // until the hire is recorded, which is what consumes a seat.
    return this.mutate(offerId, ctx, expectedVersion, (o) => o.accept(now, ctx.actor));
  }

  async decline(
    offerId: number, reason: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<OfferSummary> {
    this.require(ctx, OFFER_PERMISSIONS.RESULT_UPDATE);
    const now = this.clock.now();
    const summary = await this.mutate(offerId, ctx, expectedVersion,
      (o) => o.decline(reason, now, ctx.actor));
    await this.movePipeline(summary.applicationId, 'OFFER_DECLINED', reason, ctx);
    return summary;
  }

  async withdraw(
    offerId: number, reason: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<OfferSummary> {
    this.require(ctx, OFFER_PERMISSIONS.RESULT_UPDATE);
    const now = this.clock.now();
    return this.mutate(offerId, ctx, expectedVersion, (o) => o.withdraw(reason, now, ctx.actor));
  }

  /**
   * Expire one sent offer past its validity window. Driven by a scheduled sweep
   * once the job queue exists; callable directly meanwhile.
   *
   * The aggregate refuses to expire an offer that is still valid, so a clock or
   * query mistake cannot retire a live offer early.
   */
  async expire(
    offerId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<OfferSummary> {
    const now = this.clock.now();
    const summary = await this.mutate(offerId, ctx, expectedVersion, (o) => o.expire(now, ctx.actor));
    await this.movePipeline(summary.applicationId, 'OFFER_DECLINED', 'Offer expired', ctx);
    return summary;
  }

  /** Sweep every expirable offer. Reports per-offer outcomes; never silent. */
  async expireDue(ctx: AuthContext): Promise<{ expired: number[]; failed: number[] }> {
    const now = this.clock.now();
    const due = await this.uow.transaction(async (tx) => tx.offers.findExpirable(now, ctx));

    const expired: number[] = [];
    const failed: number[] = [];
    for (const offer of due) {
      try { await this.expire(offer.id, ctx); expired.push(offer.id); }
      catch { failed.push(offer.id); }
    }
    return { expired, failed };
  }

  /* -------------------------------- internals ------------------------------- */

  private async movePipeline(
    applicationId: number, toStage: string, reason: string, ctx: AuthContext,
  ): Promise<void> {
    await this.pipeline.applySystemTransition({ applicationId, toStage, reason }, ctx);
  }

  private async mutate(
    offerId: number, ctx: AuthContext, expectedVersion: number | undefined,
    apply: (o: Offer) => void,
  ): Promise<OfferSummary & { applicationId: number }> {
    const { summary, events } = await this.uow.transaction(async (tx) => {
      const offer = await this.load(tx, offerId, ctx, expectedVersion);
      apply(offer);
      await tx.offers.save(offer);
      return { summary: summarise(offer), events: offer.pullEvents() };
    });
    await this.publish(events);
    return summary;
  }

  private async load(
    tx: OfferTransactionScope, id: number, ctx: AuthContext, expectedVersion: number | undefined,
  ): Promise<Offer> {
    const offer = await tx.offers.findByIdForUpdate(id, ctx);
    if (!offer) throw new NotFoundError('Offer', id);
    if (expectedVersion !== undefined && expectedVersion !== offer.version) {
      throw new StaleAggregateError('Offer', id, expectedVersion, offer.version);
    }
    return offer;
  }

  private require(ctx: AuthContext, permission: string): void {
    if (!ctx.has(permission)) throw new ForbiddenError(permission);
  }

  private async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length > 0) await this.events.publish(events);
  }
}

function summarise(offer: Offer): OfferSummary & { applicationId: number } {
  return {
    id: offer.id,
    offerNo: offer.offerNo,
    applicationId: offer.applicationId,
    candidateId: offer.candidateId,
    status: offer.status,
    totalNet: offer.totalNet,
    currency: offer.currency,
    requiresDirectorApproval: offer.requiresDirectorApproval,
    expiresAt: offer.expiresAt,
    version: offer.version,
  };
}
