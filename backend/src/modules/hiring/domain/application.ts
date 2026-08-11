// The Application aggregate — one candidate's journey through one requisition.
//
// `transitionTo` is the ONLY way a stage changes. There is no setStage, and the
// repository exposes no stage write. That single fact closes the divergence class
// where offer routes wrote stages directly past the transition map (BL-14), and
// where a board menu and a table dropdown offered contradictory move rules.

import {
  IllegalTransitionError,
  InvalidEntryStageError,
  MissingReasonError,
} from './errors.js';
import {
  type ApplicationStage,
  type TransitionTrigger,
  ENTRY_STAGES,
  REASON_FIELD,
  findTransition,
  isEntryStage,
  isTerminal,
} from './stages.js';
import { HIRING_EVENTS } from './events.js';
import type { Actor, DomainEvent } from '../../shared/kernel/domain.js';

export interface StageChange {
  fromStage: ApplicationStage | null;
  toStage: ApplicationStage;
  reason: string | null;
  trigger: TransitionTrigger;
  actorId: number | null;
  actorName: string | null;
  movedAt: Date;
}

export interface ApplicationProps {
  id: number;
  tenantId: number;
  applicationNo: string;
  candidateId: number;
  requisitionId: number;
  recruiterId: number | null;
  stage: ApplicationStage;
  /** Stage to restore on resume from ON_HOLD. */
  previousStage: ApplicationStage | null;
  reasons: Partial<Record<string, string>>;
  nextAction: string | null;
  nextActionDueAt: Date | null;
  lastActivityAt: Date;
  history: StageChange[];
  /** Optimistic concurrency — two recruiters dragging the same card is normal. */
  version: number;
}

export interface TransitionOptions {
  readonly trigger?: TransitionTrigger;
  readonly reason?: string | null;
}

export class Application {
  private readonly props: ApplicationProps;
  private readonly events: DomainEvent[] = [];

  private constructor(props: ApplicationProps) {
    this.props = props;
  }

  /* ------------------------------ construction ----------------------------- */

  /**
   * Create at an entry stage only. The legacy endpoint accepted any value from
   * the client — including `joined` — which created a hired candidate with no
   * seat filled and no headcount consumed (BL-03).
   */
  static create(input: {
    id: number;
    tenantId: number;
    applicationNo: string;
    candidateId: number;
    requisitionId: number;
    recruiterId: number | null;
    stage: string;
    actor: Actor;
  }): Application {
    if (!isEntryStage(input.stage)) {
      throw new InvalidEntryStageError(input.stage, ENTRY_STAGES);
    }
    const now = new Date();
    const app = new Application({
      id: input.id,
      tenantId: input.tenantId,
      applicationNo: input.applicationNo,
      candidateId: input.candidateId,
      requisitionId: input.requisitionId,
      recruiterId: input.recruiterId,
      stage: input.stage,
      previousStage: null,
      reasons: {},
      nextAction: null,
      nextActionDueAt: null,
      lastActivityAt: now,
      history: [{
        fromStage: null,
        toStage: input.stage,
        reason: null,
        trigger: 'MANUAL',
        actorId: input.actor.id,
        actorName: input.actor.name,
        movedAt: now,
      }],
      version: 0,
    });
    app.record(HIRING_EVENTS.APPLICATION_CREATED, {
      applicationNo: input.applicationNo,
      candidateId: input.candidateId,
      requisitionId: input.requisitionId,
      stage: input.stage,
    });
    return app;
  }

  static fromState(props: ApplicationProps): Application {
    return new Application(props);
  }

  /* -------------------------------- readers -------------------------------- */

  get id(): number { return this.props.id; }
  get tenantId(): number { return this.props.tenantId; }
  get candidateId(): number { return this.props.candidateId; }
  get requisitionId(): number { return this.props.requisitionId; }
  get stage(): ApplicationStage { return this.props.stage; }
  get version(): number { return this.props.version; }
  get history(): readonly StageChange[] { return this.props.history; }
  get isTerminal(): boolean { return isTerminal(this.props.stage); }
  get isHired(): boolean { return this.props.stage === 'HIRED'; }

  reason(field: string): string | null {
    return this.props.reasons[field] ?? null;
  }

  toState(): ApplicationProps {
    return {
      ...this.props,
      reasons: { ...this.props.reasons },
      history: this.props.history.map((h) => ({ ...h })),
    };
  }

  pullEvents(): DomainEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /* ------------------------------- transitions ------------------------------ */

  /**
   * Move to `to`. Validates against the transition map, the trigger, and the
   * reason requirement — in that order — before any state is touched.
   *
   * A MANUAL caller may not perform a SYSTEM transition: OFFER_SENT, HIRED and
   * OFFER_DECLINED are reachable only through the offer module, so the pipeline
   * and the offer can never disagree about where a candidate is.
   */
  transitionTo(to: ApplicationStage, actor: Actor, opts: TransitionOptions = {}): void {
    const trigger: TransitionTrigger = opts.trigger ?? 'MANUAL';
    const from = this.props.stage;

    if (isTerminal(from)) throw new IllegalTransitionError(from, to, 'application');

    const t = findTransition(from, to);
    if (!t) throw new IllegalTransitionError(from, to, 'application');

    // A SYSTEM-only edge cannot be driven by a user action.
    if (t.trigger === 'SYSTEM' && trigger !== 'SYSTEM') {
      throw new IllegalTransitionError(from, to, 'application (system-driven stage)');
    }

    const reasonField = REASON_FIELD[to];
    const reason = opts.reason?.trim() || null;
    if (reasonField && !reason) throw new MissingReasonError(to, reasonField);

    if (to === 'ON_HOLD') this.props.previousStage = from;
    if (reasonField && reason) this.props.reasons[reasonField] = reason;

    this.props.stage = to;
    this.props.lastActivityAt = new Date();
    this.props.version += 1;
    this.props.history.push({
      fromStage: from,
      toStage: to,
      reason,
      trigger,
      actorId: actor.id,
      actorName: actor.name,
      movedAt: this.props.lastActivityAt,
    });

    this.record(HIRING_EVENTS.APPLICATION_STAGE_CHANGED, {
      applicationId: this.props.id,
      candidateId: this.props.candidateId,
      requisitionId: this.props.requisitionId,
      from, to, trigger, reason,
      isIrreversible: t.isIrreversible,
      by: actor.id,
    });
  }

  /** Resume from ON_HOLD to the stage the hold interrupted. */
  resume(actor: Actor): void {
    if (this.props.stage !== 'ON_HOLD') {
      throw new IllegalTransitionError(this.props.stage, 'PREVIOUS', 'application');
    }
    const target = this.props.previousStage;
    if (!target) throw new IllegalTransitionError('ON_HOLD', 'PREVIOUS', 'application');

    const from = this.props.stage;
    this.props.stage = target;
    this.props.previousStage = null;
    this.props.lastActivityAt = new Date();
    this.props.version += 1;
    this.props.history.push({
      fromStage: from,
      toStage: target,
      reason: null,
      trigger: 'MANUAL',
      actorId: actor.id,
      actorName: actor.name,
      movedAt: this.props.lastActivityAt,
    });
    this.record(HIRING_EVENTS.APPLICATION_RESUMED, { from, to: target, by: actor.id });
  }

  /**
   * Reverse a hire. SYSTEM-triggered, permissioned at the service, and paired in
   * one transaction with Requisition.releaseSeat so the H3/H4 bijection holds.
   */
  reverseHire(actor: Actor, reason: string): void {
    if (this.props.stage !== 'HIRED') {
      throw new IllegalTransitionError(this.props.stage, 'OFFER_SENT', 'application (reverse hire)');
    }
    if (!reason.trim()) throw new MissingReasonError('OFFER_SENT', 'reason');

    const from = this.props.stage;
    this.props.stage = 'OFFER_SENT';
    this.props.lastActivityAt = new Date();
    this.props.version += 1;
    this.props.history.push({
      fromStage: from,
      toStage: 'OFFER_SENT',
      reason,
      trigger: 'SYSTEM',
      actorId: actor.id,
      actorName: actor.name,
      movedAt: this.props.lastActivityAt,
    });
    this.record(HIRING_EVENTS.HIRE_REVERSED, {
      applicationId: this.props.id,
      candidateId: this.props.candidateId,
      requisitionId: this.props.requisitionId,
      reason,
      by: actor.id,
    });
  }

  /* --------------------------------- details -------------------------------- */

  setNextAction(action: string | null, dueAt: Date | null, actor: Actor): void {
    this.props.nextAction = action;
    this.props.nextActionDueAt = dueAt;
    this.props.lastActivityAt = new Date();
    this.props.version += 1;
    this.record(HIRING_EVENTS.NEXT_ACTION_SET, { action, dueAt, by: actor.id });
  }

  assignRecruiter(recruiterId: number, actor: Actor): void {
    this.props.recruiterId = recruiterId;
    this.props.lastActivityAt = new Date();
    this.props.version += 1;
    this.record(HIRING_EVENTS.APPLICATION_RECRUITER_ASSIGNED, { recruiterId, by: actor.id });
  }

  private record(type: string, payload: Record<string, unknown>): void {
    this.events.push({
      type,
      at: new Date(),
      payload: { applicationId: this.props.id, ...payload },
    });
  }
}
