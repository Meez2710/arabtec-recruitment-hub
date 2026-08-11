// The Interview aggregate — one scheduled conversation about one application.
//
// Owns its panel and its assessments. References the application, candidate and
// requisition by id only; interview status is deliberately independent of
// pipeline stage, so completing an interview never moves a candidate.
//
// Two audit findings are closed structurally here:
//   BL-16  'RESCHEDULED' is NOT a status. Rescheduling bumps a counter and the
//          interview stays SCHEDULED, so it cannot vanish from "upcoming
//          interviews" and "my work" — which is what made panels miss sittings.
//   BL-17  There is a status machine, and feedback is refused on cancelled and
//          no-show interviews.

import {
  AssessmentNotAllowedError,
  DuplicateAssessmentError,
  IllegalInterviewTransitionError,
  InterviewReasonRequiredError,
  InvalidScoreError,
  NotAPanellistError,
  PanelRequiredError,
  SlotInPastError,
} from './errors.js';
import {
  type Assessment,
  type Decision,
  type EvaluatorRole,
  type FitBand,
  type Score,
  averageScore,
  criteriaFor,
  fitBandFor,
  hasAnyCriticalFlag,
} from './assessment.js';
import { INTERVIEW_EVENTS } from './events.js';
import type { Actor, DomainEvent } from '../../shared/kernel/domain.js';

export const INTERVIEW_STATUSES = ['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

const TRANSITIONS: Readonly<Record<InterviewStatus, readonly InterviewStatus[]>> = {
  SCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
  // A no-show can be re-booked; the reschedule path returns it to SCHEDULED.
  NO_SHOW: ['SCHEDULED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const INTERVIEW_MODES = ['ONSITE', 'VIDEO', 'PHONE'] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export type { Actor, DomainEvent };

export interface PanelMember {
  readonly userId: number;
  readonly role: EvaluatorRole;
  readonly isLead: boolean;
}

export interface InterviewProps {
  id: number;
  tenantId: number;
  interviewNo: string;
  applicationId: number;
  candidateId: number;
  requisitionId: number;
  round: number;
  mode: InterviewMode;
  startsAt: Date;
  durationMinutes: number;
  locationOrLink: string | null;
  organiserUserId: number;
  status: InterviewStatus;
  panel: PanelMember[];
  assessments: Assessment[];
  /** Rescheduling is a counter, never a status (BL-16). */
  rescheduleCount: number;
  lastRescheduledAt: Date | null;
  cancelReason: string | null;
  /** Set once the calendar provider confirms; null for internal-only invites. */
  externalEventId: string | null;
  version: number;
}

/** Non-AI recommendation, computed from the sheet's own thresholds. */
export interface RecommendationSummary {
  readonly behaviouralAverage: number | null;
  readonly behaviouralFit: FitBand | null;
  readonly technicalAverage: number | null;
  readonly technicalFit: FitBand | null;
  readonly criticalFlagsRaised: boolean;
  readonly assessmentsSubmitted: number;
  readonly panelSize: number;
  readonly complete: boolean;
  /** Advisory only. Never applied automatically to the pipeline. */
  readonly suggestedDecision: Decision | null;
}

export class Interview {
  private readonly props: InterviewProps;
  private readonly events: DomainEvent[] = [];

  private constructor(props: InterviewProps) {
    this.props = props;
  }

  static schedule(input: {
    id: number;
    tenantId: number;
    interviewNo: string;
    applicationId: number;
    candidateId: number;
    requisitionId: number;
    round: number;
    mode: InterviewMode;
    startsAt: Date;
    durationMinutes: number;
    locationOrLink?: string | null;
    panel: readonly PanelMember[];
    actor: Actor;
    now: Date;
  }): Interview {
    if (input.panel.length === 0) throw new PanelRequiredError();
    if (input.startsAt.getTime() < input.now.getTime()) throw new SlotInPastError(input.startsAt);

    const interview = new Interview({
      id: input.id,
      tenantId: input.tenantId,
      interviewNo: input.interviewNo,
      applicationId: input.applicationId,
      candidateId: input.candidateId,
      requisitionId: input.requisitionId,
      round: input.round,
      mode: input.mode,
      startsAt: input.startsAt,
      durationMinutes: input.durationMinutes,
      locationOrLink: input.locationOrLink ?? null,
      organiserUserId: input.actor.id,
      status: 'SCHEDULED',
      panel: normalisePanel(input.panel),
      assessments: [],
      rescheduleCount: 0,
      lastRescheduledAt: null,
      cancelReason: null,
      externalEventId: null,
      version: 0,
    });
    interview.record(INTERVIEW_EVENTS.INTERVIEW_SCHEDULED, {
      interviewNo: input.interviewNo,
      applicationId: input.applicationId,
      candidateId: input.candidateId,
      requisitionId: input.requisitionId,
      startsAt: input.startsAt.toISOString(),
      panel: input.panel.map((p) => p.userId),
    });
    return interview;
  }

  static fromState(props: InterviewProps): Interview {
    return new Interview(props);
  }

  /* -------------------------------- readers -------------------------------- */

  get id(): number { return this.props.id; }
  get tenantId(): number { return this.props.tenantId; }
  get applicationId(): number { return this.props.applicationId; }
  get candidateId(): number { return this.props.candidateId; }
  get requisitionId(): number { return this.props.requisitionId; }
  get status(): InterviewStatus { return this.props.status; }
  get round(): number { return this.props.round; }
  get startsAt(): Date { return this.props.startsAt; }
  get panel(): readonly PanelMember[] { return this.props.panel; }
  get assessments(): readonly Assessment[] { return this.props.assessments; }
  get rescheduleCount(): number { return this.props.rescheduleCount; }
  get externalEventId(): string | null { return this.props.externalEventId; }
  get version(): number { return this.props.version; }

  /** Still counts as upcoming — the whole point of not having a RESCHEDULED status. */
  get isUpcoming(): boolean { return this.props.status === 'SCHEDULED'; }

  isPanellist(userId: number): boolean {
    return this.props.panel.some((p) => p.userId === userId);
  }

  panelRoleOf(userId: number): EvaluatorRole | null {
    return this.props.panel.find((p) => p.userId === userId)?.role ?? null;
  }

  assessmentBy(userId: number): Assessment | undefined {
    return this.props.assessments.find((a) => a.evaluatorUserId === userId);
  }

  toState(): InterviewProps {
    return {
      ...this.props,
      panel: this.props.panel.map((p) => ({ ...p })),
      assessments: this.props.assessments.map((a) => ({
        ...a, scores: { ...a.scores }, criticalFlags: { ...a.criticalFlags },
      })),
    };
  }

  pullEvents(): DomainEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /* ------------------------------- scheduling ------------------------------- */

  /**
   * Move the sitting. Status stays SCHEDULED; only the counter moves — so the
   * interview never drops out of the upcoming list or the panel's work queue.
   */
  reschedule(startsAt: Date, actor: Actor, now: Date): void {
    if (this.props.status !== 'SCHEDULED' && this.props.status !== 'NO_SHOW') {
      throw new IllegalInterviewTransitionError(this.props.status, 'SCHEDULED');
    }
    if (startsAt.getTime() < now.getTime()) throw new SlotInPastError(startsAt);

    const from = this.props.startsAt;
    this.props.startsAt = startsAt;
    this.props.status = 'SCHEDULED';
    this.props.rescheduleCount += 1;
    this.props.lastRescheduledAt = now;
    this.props.version += 1;
    this.record(INTERVIEW_EVENTS.INTERVIEW_RESCHEDULED, {
      from: from.toISOString(), to: startsAt.toISOString(),
      rescheduleCount: this.props.rescheduleCount, by: actor.id,
    });
  }

  setPanel(panel: readonly PanelMember[], actor: Actor): void {
    if (panel.length === 0) throw new PanelRequiredError();
    if (this.props.status === 'CANCELLED') {
      throw new IllegalInterviewTransitionError(this.props.status, 'SCHEDULED');
    }
    const before = this.props.panel.map((p) => p.userId);
    this.props.panel = normalisePanel(panel);
    this.props.version += 1;
    this.record(INTERVIEW_EVENTS.PANEL_CHANGED, {
      before, after: this.props.panel.map((p) => p.userId), by: actor.id,
    });
  }

  /** Recorded once the calendar provider confirms, so events can be bound later. */
  bindExternalEvent(externalEventId: string): void {
    this.props.externalEventId = externalEventId;
    this.props.version += 1;
  }

  /* --------------------------------- status --------------------------------- */

  complete(actor: Actor): void { this.transition('COMPLETED', actor, null); }
  markNoShow(actor: Actor): void { this.transition('NO_SHOW', actor, null); }

  cancel(reason: string, actor: Actor): void {
    if (!reason.trim()) throw new InterviewReasonRequiredError('cancel');
    this.transition('CANCELLED', actor, reason);
    this.props.cancelReason = reason;
  }

  private transition(to: InterviewStatus, actor: Actor, reason: string | null): void {
    const from = this.props.status;
    if (!TRANSITIONS[from].includes(to)) throw new IllegalInterviewTransitionError(from, to);
    this.props.status = to;
    this.props.version += 1;
    this.record(INTERVIEW_EVENTS.INTERVIEW_STATUS_CHANGED, { from, to, reason, by: actor.id });
  }

  /* ------------------------------- assessment ------------------------------- */

  /**
   * Record or update one panellist's assessment.
   *
   * Three guards, all from audit findings: the author must be on the panel;
   * feedback is refused on cancelled and no-show interviews; and scores are
   * validated against the criteria for the author's own section.
   */
  recordAssessment(input: {
    evaluatorUserId: number;
    evaluatorName: string;
    scores: Readonly<Record<string, Score>>;
    criticalFlags?: Readonly<Record<string, boolean>>;
    justification?: string;
    allowUpdate?: boolean;
    now: Date;
  }): void {
    if (this.props.status === 'CANCELLED' || this.props.status === 'NO_SHOW') {
      throw new AssessmentNotAllowedError(this.props.status);
    }
    const role = this.panelRoleOf(input.evaluatorUserId);
    if (!role) throw new NotAPanellistError(input.evaluatorUserId);

    validateScores(role, input.scores);

    const existingIndex = this.props.assessments
      .findIndex((a) => a.evaluatorUserId === input.evaluatorUserId);
    if (existingIndex >= 0 && input.allowUpdate !== true) {
      throw new DuplicateAssessmentError(input.evaluatorUserId);
    }

    const assessment: Assessment = {
      evaluatorRole: role,
      evaluatorUserId: input.evaluatorUserId,
      evaluatorName: input.evaluatorName,
      scores: { ...input.scores },
      criticalFlags: { ...(input.criticalFlags ?? {}) },
      justification: input.justification ?? '',
      submittedAt: input.now,
    };

    if (existingIndex >= 0) this.props.assessments[existingIndex] = assessment;
    else this.props.assessments.push(assessment);

    this.props.version += 1;
    this.record(
      existingIndex >= 0 ? INTERVIEW_EVENTS.ASSESSMENT_UPDATED : INTERVIEW_EVENTS.ASSESSMENT_RECORDED,
      {
        evaluatorUserId: input.evaluatorUserId,
        evaluatorRole: role,
        average: averageScore(assessment.scores),
        criticalFlags: hasAnyCriticalFlag(assessment.criticalFlags),
      },
    );
  }

  /**
   * Aggregate the panel's assessments into a recommendation.
   *
   * Deterministic arithmetic over the sheet's own thresholds — no model, no
   * weighting the business has not defined. It is ADVISORY: it moves nothing,
   * sets no flag any process consumes, and a recruiter must act on it explicitly.
   */
  recommendation(): RecommendationSummary {
    const behavioural = this.props.assessments.filter((a) => a.evaluatorRole === 'RECRUITER');
    const technical = this.props.assessments.filter((a) => a.evaluatorRole === 'HIRING_MANAGER');

    const behaviouralAverage = meanOfAssessments(behavioural);
    const technicalAverage = meanOfAssessments(technical);
    const flagged = this.props.assessments.some((a) => hasAnyCriticalFlag(a.criticalFlags));
    const complete = this.props.assessments.length >= this.props.panel.length;

    return {
      behaviouralAverage,
      behaviouralFit: fitBandFor(behaviouralAverage),
      technicalAverage,
      technicalFit: fitBandFor(technicalAverage),
      criticalFlagsRaised: flagged,
      assessmentsSubmitted: this.props.assessments.length,
      panelSize: this.props.panel.length,
      complete,
      suggestedDecision: suggestDecision(behaviouralAverage, technicalAverage, flagged, complete),
    };
  }

  private record(type: string, payload: Record<string, unknown>): void {
    this.events.push({
      type,
      at: new Date(),
      payload: {
        interviewId: this.props.id,
        applicationId: this.props.applicationId,
        candidateId: this.props.candidateId,
        ...payload,
      },
    });
  }
}

/* --------------------------------- helpers --------------------------------- */

/** Exactly one lead: the first flagged, or the first member. */
function normalisePanel(panel: readonly PanelMember[]): PanelMember[] {
  const leadIndex = Math.max(0, panel.findIndex((p) => p.isLead));
  return panel.map((p, i) => ({ ...p, isLead: i === leadIndex }));
}

function validateScores(role: EvaluatorRole, scores: Readonly<Record<string, Score>>): void {
  const allowed = new Set(criteriaFor(role).map((c) => c.key));
  for (const [key, value] of Object.entries(scores)) {
    if (!allowed.has(key)) throw new InvalidScoreError(key, value);
    const ok = value === 'NA' || (Number.isInteger(value) && value >= 1 && value <= 5);
    if (!ok) throw new InvalidScoreError(key, value);
  }
}

function meanOfAssessments(assessments: readonly Assessment[]): number | null {
  const averages = assessments
    .map((a) => averageScore(a.scores))
    .filter((n): n is number => n !== null);
  if (averages.length === 0) return null;
  return averages.reduce((sum, n) => sum + n, 0) / averages.length;
}

/**
 * Suggest a decision from the sheet's own bands.
 *
 * Conservative by construction: it never suggests PROCEED while a critical flag
 * is raised or while the panel has not finished, because both are exactly the
 * cases where a human should look. The output is a suggestion on a form, not an
 * instruction to the pipeline.
 */
function suggestDecision(
  behavioural: number | null, technical: number | null, flagged: boolean, complete: boolean,
): Decision | null {
  const scored = [behavioural, technical].filter((n): n is number => n !== null);
  if (scored.length === 0) return null;

  const weakest = Math.min(...scored);
  if (!complete) return 'HOLD';
  if (flagged) return weakest >= 3.5 ? 'PROCEED_WITH_CONDITIONS' : 'HOLD';
  if (weakest >= 4.2) return 'PROCEED';
  if (weakest >= 3.5) return 'PROCEED_WITH_CONDITIONS';
  if (weakest >= 3.0) return 'CV_POOL';
  return 'REJECT';
}
