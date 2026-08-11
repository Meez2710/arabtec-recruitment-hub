// InterviewService — scheduling, panel, assessment and rule-based recommendation.
//
// The calendar is behind a port (Document 2 §6): internal .ics in V1, Google and
// Microsoft 365 later as adapter swaps. `externalEventId` is stored from V1 so
// internally-created events can be bound to real calendar events afterwards.

import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import type { Clock, DomainEvent } from '../../shared/kernel/domain.js';
import { systemClock } from '../../shared/kernel/domain.js';
import type { EventBus } from '../../shared/kernel/ports.js';
import type {
  CalendarEventHandle, CalendarProvider, Recipient,
} from '../../shared/ports/notifications.js';
import type { InterviewMode, PanelMember, RecommendationSummary } from '../domain/interview.js';
import { Interview } from '../domain/interview.js';
import type { Score } from '../domain/assessment.js';
import type { InterviewRepository, InterviewUnitOfWork } from './ports.js';

export const INTERVIEW_PERMISSIONS = {
  SCHEDULE: 'interview.schedule',
  EDIT: 'interview.edit',
  FEEDBACK: 'interview.feedback',
  VIEW_ALL: 'interview.view_all',
  VIEW_ASSIGNED: 'interview.view_assigned',
} as const;

export interface InterviewServiceDeps {
  readonly uow: InterviewUnitOfWork;
  readonly events: EventBus;
  /** Optional: without it, invitations are simply not issued. Never a hard failure. */
  readonly calendar?: CalendarProvider;
  readonly clock?: Clock;
}

export interface ScheduleInterviewInput {
  readonly applicationId: number;
  readonly candidateId: number;
  readonly requisitionId: number;
  readonly mode: InterviewMode;
  readonly startsAt: Date;
  readonly durationMinutes: number;
  readonly panel: readonly PanelMember[];
  readonly locationOrLink?: string | null;
  readonly candidateEmail?: string;
  readonly title?: string;
}

export interface InterviewSummary {
  readonly id: number;
  readonly applicationId: number;
  readonly candidateId: number;
  readonly status: string;
  readonly startsAt: Date;
  readonly round: number;
  readonly panelUserIds: readonly number[];
  readonly rescheduleCount: number;
  readonly externalEventId: string | null;
  readonly version: number;
}

/** Panellists already booked in the proposed window. Advisory — never blocking. */
export interface ScheduleConflict {
  readonly userId: number;
  readonly interviewId: number;
  readonly startsAt: Date;
}

export interface ScheduleResult {
  readonly interview: InterviewSummary;
  readonly conflicts: readonly ScheduleConflict[];
  readonly calendarInvited: boolean;
}

export class InterviewService {
  private readonly uow: InterviewUnitOfWork;
  private readonly events: EventBus;
  private readonly calendar: CalendarProvider | undefined;
  private readonly clock: Clock;

  constructor(deps: InterviewServiceDeps) {
    this.uow = deps.uow;
    this.events = deps.events;
    this.calendar = deps.calendar;
    this.clock = deps.clock ?? systemClock;
  }

  /* -------------------------------- schedule -------------------------------- */

  /**
   * Book an interview.
   *
   * Round number is derived from how many sittings this application has already
   * had, so a coordinator cannot mis-key it. Panel conflicts are detected and
   * REPORTED, not blocked — a genuine double-booking is sometimes deliberate, and
   * silently refusing would send the coordinator hunting without explanation.
   */
  async schedule(input: ScheduleInterviewInput, ctx: AuthContext): Promise<ScheduleResult> {
    this.require(ctx, INTERVIEW_PERMISSIONS.SCHEDULE);
    const now = this.clock.now();

    const { interview, conflicts, events } = await this.uow.transaction(async (tx) => {
      const endsAt = new Date(input.startsAt.getTime() + input.durationMinutes * 60_000);
      const conflicts = await findConflicts(
        tx.interviews, input.panel.map((p) => p.userId), input.startsAt, endsAt, ctx,
      );

      const round = (await tx.interviews.countForApplication(input.applicationId, ctx)) + 1;
      const interviewNo = await tx.interviews.nextInterviewNo(ctx);
      const id = await tx.interviews.nextId(ctx);

      const created = Interview.schedule({
        id,
        tenantId: ctx.tenantId,
        interviewNo,
        applicationId: input.applicationId,
        candidateId: input.candidateId,
        requisitionId: input.requisitionId,
        round,
        mode: input.mode,
        startsAt: input.startsAt,
        durationMinutes: input.durationMinutes,
        locationOrLink: input.locationOrLink ?? null,
        panel: input.panel,
        actor: ctx.actor,
        now,
      });
      await tx.interviews.save(created);
      return { interview: created, conflicts, events: created.pullEvents() };
    });

    // Calendar work is OUTSIDE the transaction — a slow or unavailable provider
    // must never hold a database lock, and a failed invitation must never undo a
    // booked interview.
    const handle = await this.tryCreateCalendarEvent(interview, input, ctx);
    if (handle) {
      await this.uow.transaction(async (tx) => {
        const fresh = await tx.interviews.findByIdForUpdate(interview.id, ctx);
        if (fresh) {
          fresh.bindExternalEvent(handle.externalEventId);
          await tx.interviews.save(fresh);
        }
      });
    }

    await this.publish(events);
    return {
      interview: summarise(interview, handle?.externalEventId ?? null),
      conflicts,
      calendarInvited: handle !== null,
    };
  }

  /** Move the sitting. Status stays SCHEDULED — see BL-16 in the aggregate. */
  async reschedule(
    interviewId: number, startsAt: Date, ctx: AuthContext, expectedVersion?: number,
  ): Promise<InterviewSummary> {
    this.require(ctx, INTERVIEW_PERMISSIONS.EDIT);
    const now = this.clock.now();
    return this.mutate(interviewId, ctx, expectedVersion,
      (iv) => iv.reschedule(startsAt, ctx.actor, now));
  }

  async setPanel(
    interviewId: number, panel: readonly PanelMember[], ctx: AuthContext, expectedVersion?: number,
  ): Promise<InterviewSummary> {
    this.require(ctx, INTERVIEW_PERMISSIONS.EDIT);
    return this.mutate(interviewId, ctx, expectedVersion, (iv) => iv.setPanel(panel, ctx.actor));
  }

  async complete(
    interviewId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<InterviewSummary> {
    this.require(ctx, INTERVIEW_PERMISSIONS.EDIT);
    return this.mutate(interviewId, ctx, expectedVersion, (iv) => iv.complete(ctx.actor));
  }

  async markNoShow(
    interviewId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<InterviewSummary> {
    this.require(ctx, INTERVIEW_PERMISSIONS.EDIT);
    return this.mutate(interviewId, ctx, expectedVersion, (iv) => iv.markNoShow(ctx.actor));
  }

  async cancel(
    interviewId: number, reason: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<InterviewSummary> {
    this.require(ctx, INTERVIEW_PERMISSIONS.EDIT);
    const summary = await this.mutate(interviewId, ctx, expectedVersion,
      (iv) => iv.cancel(reason, ctx.actor));
    await this.tryCancelCalendarEvent(summary.externalEventId, reason);
    return summary;
  }

  /* ------------------------------- assessment ------------------------------- */

  /**
   * Record one panellist's assessment. The author is always `ctx.userId` — a
   * caller cannot submit feedback on someone else's behalf.
   */
  async recordAssessment(input: {
    interviewId: number;
    scores: Readonly<Record<string, Score>>;
    criticalFlags?: Readonly<Record<string, boolean>>;
    justification?: string;
    allowUpdate?: boolean;
    expectedVersion?: number;
  }, ctx: AuthContext): Promise<InterviewSummary> {
    this.require(ctx, INTERVIEW_PERMISSIONS.FEEDBACK);
    const now = this.clock.now();

    return this.mutate(input.interviewId, ctx, input.expectedVersion, (iv) =>
      iv.recordAssessment({
        evaluatorUserId: ctx.userId,
        evaluatorName: ctx.userName,
        scores: input.scores,
        criticalFlags: input.criticalFlags,
        justification: input.justification,
        allowUpdate: input.allowUpdate,
        now,
      }),
    );
  }

  /**
   * Aggregate the panel's assessments into a rule-based recommendation.
   *
   * Deterministic arithmetic over the assessment sheet's own thresholds. No model
   * is consulted and none will be — the AI equivalent, when it arrives, produces
   * a separate advisory output and does not replace this.
   *
   * Advisory in the strict sense: it moves no candidate and sets no flag any
   * process reads. A recruiter applies it, or does not.
   */
  async recommendation(interviewId: number, ctx: AuthContext): Promise<RecommendationSummary> {
    const interview = await this.uow.transaction(
      async (tx) => tx.interviews.findById(interviewId, ctx),
    );
    if (!interview) throw new NotFoundError('Interview', interviewId);

    // Panellists see their own interview; everyone else needs the org-wide view.
    if (!interview.isPanellist(ctx.userId) && !ctx.has(INTERVIEW_PERMISSIONS.VIEW_ALL)) {
      throw new ForbiddenError(INTERVIEW_PERMISSIONS.VIEW_ALL);
    }
    return interview.recommendation();
  }

  /* -------------------------------- internals ------------------------------- */

  private async mutate(
    interviewId: number,
    ctx: AuthContext,
    expectedVersion: number | undefined,
    apply: (iv: Interview) => void,
  ): Promise<InterviewSummary> {
    const { summary, events } = await this.uow.transaction(async (tx) => {
      const interview = await tx.interviews.findByIdForUpdate(interviewId, ctx);
      if (!interview) throw new NotFoundError('Interview', interviewId);
      if (expectedVersion !== undefined && expectedVersion !== interview.version) {
        throw new StaleAggregateError('Interview', interviewId, expectedVersion, interview.version);
      }
      apply(interview);
      await tx.interviews.save(interview);
      return {
        summary: summarise(interview, interview.externalEventId),
        events: interview.pullEvents(),
      };
    });
    await this.publish(events);
    return summary;
  }

  /** Never lets a calendar failure fail the booking. */
  private async tryCreateCalendarEvent(
    interview: Interview, input: ScheduleInterviewInput, ctx: AuthContext,
  ): Promise<CalendarEventHandle | null> {
    if (!this.calendar) return null;
    try {
      const attendees: Recipient[] = interview.panel.map((p) => ({ userId: p.userId }));
      if (input.candidateEmail) attendees.push({ email: input.candidateEmail });

      return await this.calendar.createEvent({
        title: input.title ?? `Interview — round ${interview.round}`,
        slot: {
          startsAt: input.startsAt,
          endsAt: new Date(input.startsAt.getTime() + input.durationMinutes * 60_000),
        },
        organiserUserId: ctx.userId,
        attendees,
        location: input.locationOrLink ?? undefined,
      });
    } catch {
      return null;
    }
  }

  private async tryCancelCalendarEvent(
    externalEventId: string | null, reason: string,
  ): Promise<void> {
    if (!this.calendar || !externalEventId) return;
    try { await this.calendar.cancelEvent(externalEventId, reason); } catch { /* non-fatal */ }
  }

  private require(ctx: AuthContext, permission: string): void {
    if (!ctx.has(permission)) throw new ForbiddenError(permission);
  }

  private async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length > 0) await this.events.publish(events);
  }
}

/* --------------------------------- helpers --------------------------------- */

async function findConflicts(
  repo: InterviewRepository,
  userIds: readonly number[],
  startsAt: Date,
  endsAt: Date,
  ctx: AuthContext,
): Promise<ScheduleConflict[]> {
  const booked = await repo.findBookedFor(userIds, { startsAt, endsAt }, ctx);
  const conflicts: ScheduleConflict[] = [];
  for (const iv of booked) {
    if (!iv.isUpcoming) continue;
    for (const member of iv.panel) {
      if (userIds.includes(member.userId)) {
        conflicts.push({ userId: member.userId, interviewId: iv.id, startsAt: iv.startsAt });
      }
    }
  }
  return conflicts;
}

function summarise(interview: Interview, externalEventId: string | null): InterviewSummary {
  return {
    id: interview.id,
    applicationId: interview.applicationId,
    candidateId: interview.candidateId,
    status: interview.status,
    startsAt: interview.startsAt,
    round: interview.round,
    panelUserIds: interview.panel.map((p) => p.userId),
    rescheduleCount: interview.rescheduleCount,
    externalEventId,
    version: interview.version,
  };
}
