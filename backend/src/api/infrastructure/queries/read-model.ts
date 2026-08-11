// Drizzle read model.
//
// PERFORMANCE NOTES, because this is the layer that decides whether the UI feels
// fast:
//
//   * One round trip per list. `count(*) OVER()` rides along with the page, so
//     there is no separate COUNT query — and no window where the count and the
//     rows disagree.
//   * Aggregated child data (seat counts, panel ids, offer totals) comes from
//     correlated sub-selects, not from loading children. A list of 50
//     requisitions is 1 query, not 51.
//   * Detail endpoints are 2 queries: the row, and its children batched.
//   * Sorting is a whitelist. Anything else is a SQL injection surface or an
//     unindexed sort that quietly table-scans in production.
//
// ⚠️ CORRELATED SUB-SELECTS ARE WRITTEN WITH EXPLICIT ALIASES, DELIBERATELY.
//
// Drizzle renders a column reference inside a `sql` template UNQUALIFIED — it
// emits `"requisition_id"`, not `"hiring_seat"."requisition_id"`. In a
// correlated sub-select that is silently wrong: `where "requisition_id" = "id"`
// binds `"id"` to the INNER table, so the subquery counts rows joined to
// themselves and returns 1 instead of 3. It typechecks, it runs, and every
// count on every list is quietly incorrect.
//
// So each sub-select below aliases its inner table (`hs`, `ha`, `ip`, ...) and
// writes the OUTER reference fully qualified. Never shorten these.

import {
  and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, ne, notInArray, or, sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  hiringApplication, hiringRequisition, hiringSeat, hiringStageHistory,
  interview, interviewAssessment, interviewPanel,
  offer, offerCompensationLine, timelineEntry,
} from '../../../infrastructure/db/schema/index.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { executorFor } from '../../../infrastructure/db/current-transaction.js';
import { scopedByProjectColumn, scopedViaRequisition } from '../../../infrastructure/db/scope.js';
import type { AuthContext } from '../../../modules/shared/kernel/auth-context.js';
import { TERMINAL_STAGES } from '../../../modules/hiring/index.js';
import type * as Q from '../../queries/ports.js';

const LIVE_OFFER = ['SENT', 'ACCEPTED'] as const;
const AWAITING_APPROVAL = ['PENDING_APPROVAL'] as const;

/** `count(*) OVER()` — total rows before LIMIT, on every row of the page. */
const TOTAL = sql<number>`count(*) over()`.mapWith(Number);

const pageOf = <T>(
  rows: readonly (T & { total?: number })[],
  p: Q.PageRequest,
): Q.Page<T> => ({
  items: rows.map(({ total: _total, ...rest }) => rest as unknown as T),
  total: rows[0]?.total ?? 0,
  limit: p.limit,
  offset: p.offset,
});

/**
 * Resolve a sort key against a whitelist.
 *
 * Never interpolates the caller's string. An unknown key falls back to the
 * default rather than erroring: a stale bookmark should render a list, not a 400.
 */
const orderBy = (
  allowed: Readonly<Record<string, PgColumn>>,
  fallback: PgColumn,
  p: Q.PageRequest,
): SQL => {
  const column = (p.sort !== undefined && allowed[p.sort]) || fallback;
  return p.direction === 'asc' ? asc(column) : desc(column);
};

const like = (value: string): string => `%${value.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

export class DrizzleReadModel implements Q.ReadModel {
  constructor(private readonly root: Executor) {}

  /** Join an ambient transaction when there is one — see current-transaction.ts. */
  private get db(): Executor { return executorFor(this.root); }

  /* ---------------------------- requisitions ----------------------------- */

  private static readonly REQ_SORT: Readonly<Record<string, PgColumn>> = {
    createdAt: hiringRequisition.createdAt,
    updatedAt: hiringRequisition.updatedAt,
    ticketNo: hiringRequisition.ticketNo,
    title: hiringRequisition.title,
    headcount: hiringRequisition.headcount,
    state: hiringRequisition.state,
  };

  /** Seat rollups as sub-selects: a list of N costs 1 query, not N + 1. */
  private static seatCount(state: 'FILLED' | 'OPEN'): SQL<number> {
    return sql<number>`(
      select count(*) from "hiring_seat" hs
      where hs."requisition_id" = "hiring_requisition"."id" and hs."state" = ${state}
    )`.mapWith(Number);
  }

  private static readonly APPLICATION_COUNT = sql<number>`(
    select count(*) from "hiring_application" ha
    where ha."requisition_id" = "hiring_requisition"."id"
  )`.mapWith(Number);

  private requisitionScope(ctx: AuthContext): SQL {
    return scopedByProjectColumn(hiringRequisition.tenantId, hiringRequisition.projectId, ctx);
  }

  async requisitions(
    f: Q.RequisitionFilters, p: Q.PageRequest, ctx: AuthContext,
  ): Promise<Q.Page<Q.RequisitionListItem>> {
    const where: SQL[] = [this.requisitionScope(ctx)];
    if (f.state?.length) where.push(inArray(hiringRequisition.state, [...f.state] as never));
    if (f.projectId !== undefined) where.push(eq(hiringRequisition.projectId, f.projectId));
    if (f.departmentId !== undefined) where.push(eq(hiringRequisition.departmentId, f.departmentId));
    if (f.recruiterId !== undefined) where.push(eq(hiringRequisition.recruiterId, f.recruiterId));
    if (f.requesterId !== undefined) where.push(eq(hiringRequisition.requesterId, f.requesterId));
    if (f.q !== undefined && f.q !== '') {
      const pattern = like(f.q);
      const match = or(
        ilike(hiringRequisition.ticketNo, pattern),
        ilike(hiringRequisition.title, pattern),
      );
      if (match) where.push(match);
    }
    if (f.hasOpenSeats === true) {
      where.push(sql`(
        select count(*) from "hiring_seat" hs
        where hs."requisition_id" = "hiring_requisition"."id" and hs."state" = 'OPEN'
      ) > 0`);
    }

    const rows = await this.db
      .select({
        id: hiringRequisition.id,
        ticketNo: hiringRequisition.ticketNo,
        title: hiringRequisition.title,
        projectId: hiringRequisition.projectId,
        departmentId: hiringRequisition.departmentId,
        requesterId: hiringRequisition.requesterId,
        recruiterId: hiringRequisition.recruiterId,
        state: hiringRequisition.state,
        headcount: hiringRequisition.headcount,
        filledSeats: DrizzleReadModel.seatCount('FILLED'),
        openSeats: DrizzleReadModel.seatCount('OPEN'),
        applicationCount: DrizzleReadModel.APPLICATION_COUNT,
        createdAt: hiringRequisition.createdAt,
        updatedAt: hiringRequisition.updatedAt,
        version: hiringRequisition.version,
        total: TOTAL,
      })
      .from(hiringRequisition)
      .where(and(...where))
      .orderBy(orderBy(DrizzleReadModel.REQ_SORT, hiringRequisition.createdAt, p))
      .limit(p.limit)
      .offset(p.offset);

    return pageOf(rows, p);
  }

  async requisition(id: number, ctx: AuthContext): Promise<Q.RequisitionDetail | null> {
    const rows = await this.db
      .select({
          id: hiringRequisition.id,
          ticketNo: hiringRequisition.ticketNo,
          title: hiringRequisition.title,
          projectId: hiringRequisition.projectId,
          departmentId: hiringRequisition.departmentId,
          requesterId: hiringRequisition.requesterId,
          recruiterId: hiringRequisition.recruiterId,
          state: hiringRequisition.state,
          previousState: hiringRequisition.previousState,
          closeReason: hiringRequisition.closeReason,
          createdBy: hiringRequisition.createdBy,
          headcount: hiringRequisition.headcount,
          filledSeats: DrizzleReadModel.seatCount('FILLED'),
          openSeats: DrizzleReadModel.seatCount('OPEN'),
          applicationCount: DrizzleReadModel.APPLICATION_COUNT,
          createdAt: hiringRequisition.createdAt,
          updatedAt: hiringRequisition.updatedAt,
          version: hiringRequisition.version,
        })
      .from(hiringRequisition)
      .where(and(eq(hiringRequisition.id, id), this.requisitionScope(ctx)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    const seats = await this.db
      .select({
        seatNo: hiringSeat.seatNo, state: hiringSeat.state,
        applicationId: hiringSeat.applicationId, filledAt: hiringSeat.filledAt,
        cancelReason: hiringSeat.cancelReason,
      })
      .from(hiringSeat)
      .where(eq(hiringSeat.requisitionId, id))
      .orderBy(asc(hiringSeat.seatNo));

    return { ...row, seats };
  }

  /* ----------------------------- applications ---------------------------- */

  private static readonly APP_SORT: Readonly<Record<string, PgColumn>> = {
    createdAt: hiringApplication.createdAt,
    lastActivityAt: hiringApplication.lastActivityAt,
    nextActionDueAt: hiringApplication.nextActionDueAt,
    stage: hiringApplication.stage,
    applicationNo: hiringApplication.applicationNo,
  };

  private applicationScope(ctx: AuthContext): SQL {
    return scopedViaRequisition(
      this.db, hiringApplication.tenantId, hiringApplication.requisitionId, ctx,
    );
  }

  private applicationWhere(f: Q.ApplicationFilters, ctx: AuthContext): SQL[] {
    const where: SQL[] = [this.applicationScope(ctx)];
    if (f.requisitionId !== undefined) {
      where.push(eq(hiringApplication.requisitionId, f.requisitionId));
    }
    if (f.candidateId !== undefined) where.push(eq(hiringApplication.candidateId, f.candidateId));
    if (f.stage?.length) where.push(inArray(hiringApplication.stage, [...f.stage] as never));
    if (f.recruiterId !== undefined) where.push(eq(hiringApplication.recruiterId, f.recruiterId));
    if (f.liveOnly === true) {
      where.push(notInArray(hiringApplication.stage, [...TERMINAL_STAGES]));
    }
    if (f.dueBefore !== undefined) {
      where.push(isNotNull(hiringApplication.nextActionDueAt));
      where.push(lte(hiringApplication.nextActionDueAt, f.dueBefore));
    }
    if (f.inactiveSince !== undefined) {
      where.push(lte(hiringApplication.lastActivityAt, f.inactiveSince));
    }
    if (f.q !== undefined && f.q !== '') {
      const pattern = like(f.q);
      const match = or(
        ilike(hiringApplication.applicationNo, pattern),
        ilike(hiringRequisition.ticketNo, pattern),
        ilike(hiringRequisition.title, pattern),
      );
      if (match) where.push(match);
    }
    return where;
  }

  async applications(
    f: Q.ApplicationFilters, p: Q.PageRequest, ctx: AuthContext,
  ): Promise<Q.Page<Q.ApplicationListItem>> {
    // The requisition join is not optional: the list shows the ticket number and
    // title, and fetching them per row would be the classic N+1.
    const rows = await this.db
      .select({
        id: hiringApplication.id,
        applicationNo: hiringApplication.applicationNo,
        candidateId: hiringApplication.candidateId,
        requisitionId: hiringApplication.requisitionId,
        requisitionTicketNo: hiringRequisition.ticketNo,
        requisitionTitle: hiringRequisition.title,
        recruiterId: hiringApplication.recruiterId,
        stage: hiringApplication.stage,
        previousStage: hiringApplication.previousStage,
        nextAction: hiringApplication.nextAction,
        nextActionDueAt: hiringApplication.nextActionDueAt,
        lastActivityAt: hiringApplication.lastActivityAt,
        createdAt: hiringApplication.createdAt,
        version: hiringApplication.version,
        total: TOTAL,
      })
      .from(hiringApplication)
      .innerJoin(hiringRequisition, eq(hiringRequisition.id, hiringApplication.requisitionId))
      .where(and(...this.applicationWhere(f, ctx)))
      .orderBy(orderBy(DrizzleReadModel.APP_SORT, hiringApplication.lastActivityAt, p))
      .limit(p.limit)
      .offset(p.offset);

    return pageOf(rows, p);
  }

  async application(id: number, ctx: AuthContext): Promise<Q.ApplicationDetail | null> {
    const rows = await this.db
      .select({
        id: hiringApplication.id,
        applicationNo: hiringApplication.applicationNo,
        candidateId: hiringApplication.candidateId,
        requisitionId: hiringApplication.requisitionId,
        requisitionTicketNo: hiringRequisition.ticketNo,
        requisitionTitle: hiringRequisition.title,
        recruiterId: hiringApplication.recruiterId,
        stage: hiringApplication.stage,
        previousStage: hiringApplication.previousStage,
        nextAction: hiringApplication.nextAction,
        nextActionDueAt: hiringApplication.nextActionDueAt,
        lastActivityAt: hiringApplication.lastActivityAt,
        createdAt: hiringApplication.createdAt,
        version: hiringApplication.version,
        reasons: hiringApplication.reasons,
      })
      .from(hiringApplication)
      .innerJoin(hiringRequisition, eq(hiringRequisition.id, hiringApplication.requisitionId))
      .where(and(eq(hiringApplication.id, id), this.applicationScope(ctx)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    const history = await this.db
      .select({
        fromStage: hiringStageHistory.fromStage, toStage: hiringStageHistory.toStage,
        reason: hiringStageHistory.reason, trigger: hiringStageHistory.trigger,
        actorId: hiringStageHistory.actorId, actorName: hiringStageHistory.actorName,
        movedAt: hiringStageHistory.movedAt,
      })
      .from(hiringStageHistory)
      .where(eq(hiringStageHistory.applicationId, id))
      .orderBy(asc(hiringStageHistory.movedAt), asc(hiringStageHistory.id));

    const { reasons, ...rest } = row;
    return { ...rest, reasons: (reasons ?? {}) as Record<string, string>, history };
  }

  /* ------------------------------ interviews ----------------------------- */

  private static readonly IV_SORT: Readonly<Record<string, PgColumn>> = {
    startsAt: interview.startsAt,
    createdAt: interview.createdAt,
    round: interview.round,
    status: interview.status,
  };

  private static readonly PANEL_IDS = sql<number[]>`coalesce((
    select array_agg(ip."user_id" order by ip."user_id")
    from "interview_panel" ip where ip."interview_id" = "interview"."id"
  ), '{}')`;

  private static readonly ASSESSMENT_COUNT = sql<number>`(
    select count(*) from "interview_assessment" ia
    where ia."interview_id" = "interview"."id"
  )`.mapWith(Number);

  private interviewScope(ctx: AuthContext): SQL {
    return scopedViaRequisition(this.db, interview.tenantId, interview.requisitionId, ctx);
  }

  async interviews(
    f: Q.InterviewFilters, p: Q.PageRequest, ctx: AuthContext,
  ): Promise<Q.Page<Q.InterviewListItem>> {
    const where: SQL[] = [this.interviewScope(ctx)];
    if (f.status?.length) where.push(inArray(interview.status, [...f.status] as never));
    if (f.applicationId !== undefined) where.push(eq(interview.applicationId, f.applicationId));
    if (f.candidateId !== undefined) where.push(eq(interview.candidateId, f.candidateId));
    if (f.requisitionId !== undefined) where.push(eq(interview.requisitionId, f.requisitionId));
    if (f.from !== undefined) where.push(gte(interview.startsAt, f.from));
    if (f.to !== undefined) where.push(lte(interview.startsAt, f.to));
    if (f.panellistId !== undefined) {
      // EXISTS, not a join: a join would duplicate the interview row per
      // matching panel member and corrupt both the page and the total.
      where.push(sql`exists (
        select 1 from "interview_panel" ip
        where ip."interview_id" = "interview"."id" and ip."user_id" = ${f.panellistId}
      )`);
    }

    const rows = await this.db
      .select({
        id: interview.id, interviewNo: interview.interviewNo,
        applicationId: interview.applicationId, candidateId: interview.candidateId,
        requisitionId: interview.requisitionId, round: interview.round,
        mode: interview.mode, startsAt: interview.startsAt,
        durationMinutes: interview.durationMinutes, locationOrLink: interview.locationOrLink,
        status: interview.status, rescheduleCount: interview.rescheduleCount,
        organiserUserId: interview.organiserUserId,
        panelUserIds: DrizzleReadModel.PANEL_IDS,
        assessmentCount: DrizzleReadModel.ASSESSMENT_COUNT,
        version: interview.version,
        total: TOTAL,
      })
      .from(interview)
      .where(and(...where))
      .orderBy(orderBy(DrizzleReadModel.IV_SORT, interview.startsAt, p))
      .limit(p.limit)
      .offset(p.offset);

    return pageOf(rows, p);
  }

  async interview(id: number, ctx: AuthContext): Promise<Q.InterviewDetail | null> {
    const rows = await this.db
      .select({
        id: interview.id, interviewNo: interview.interviewNo,
        applicationId: interview.applicationId, candidateId: interview.candidateId,
        requisitionId: interview.requisitionId, round: interview.round,
        mode: interview.mode, startsAt: interview.startsAt,
        durationMinutes: interview.durationMinutes, locationOrLink: interview.locationOrLink,
        status: interview.status, rescheduleCount: interview.rescheduleCount,
        organiserUserId: interview.organiserUserId,
        cancelReason: interview.cancelReason, externalEventId: interview.externalEventId,
        panelUserIds: DrizzleReadModel.PANEL_IDS,
        assessmentCount: DrizzleReadModel.ASSESSMENT_COUNT,
        version: interview.version,
      })
      .from(interview)
      .where(and(eq(interview.id, id), this.interviewScope(ctx)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    const [panel, assessments] = await Promise.all([
      this.db.select({
        userId: interviewPanel.userId, role: interviewPanel.role, isLead: interviewPanel.isLead,
      }).from(interviewPanel).where(eq(interviewPanel.interviewId, id)),
      this.db.select({
        evaluatorUserId: interviewAssessment.evaluatorUserId,
        evaluatorName: interviewAssessment.evaluatorName,
        evaluatorRole: interviewAssessment.evaluatorRole,
        scores: interviewAssessment.scores,
        criticalFlags: interviewAssessment.criticalFlags,
        justification: interviewAssessment.justification,
        submittedAt: interviewAssessment.submittedAt,
      }).from(interviewAssessment).where(eq(interviewAssessment.interviewId, id)),
    ]);

    return {
      ...row,
      panel,
      assessments: assessments.map((a) => ({
        ...a,
        scores: (a.scores ?? {}) as Record<string, number | 'NA'>,
        criticalFlags: (a.criticalFlags ?? {}) as Record<string, boolean>,
      })),
    };
  }

  /* -------------------------------- offers ------------------------------- */

  private static readonly OFFER_SORT: Readonly<Record<string, PgColumn>> = {
    createdAt: offer.createdAt,
    sentAt: offer.sentAt,
    expiresAt: offer.expiresAt,
    status: offer.status,
    offerNo: offer.offerNo,
  };

  /**
   * The total, summed in SQL.
   *
   * A plain sum of the lines — the same arithmetic the aggregate performs. No
   * ratio, no derivation: the 40/30/30 pattern was rejected as policy and does
   * not exist here either.
   */
  private static readonly TOTAL_NET = sql<number>`coalesce((
    select sum(ocl."amount") from "offer_compensation_line" ocl
    where ocl."offer_id" = "offer"."id"
  ), 0)`.mapWith(Number);

  private offerScope(ctx: AuthContext): SQL {
    return scopedViaRequisition(this.db, offer.tenantId, offer.requisitionId, ctx);
  }

  async offers(
    f: Q.OfferFilters, p: Q.PageRequest, ctx: AuthContext,
  ): Promise<Q.Page<Q.OfferListItem>> {
    const where: SQL[] = [this.offerScope(ctx)];
    if (f.status?.length) where.push(inArray(offer.status, [...f.status] as never));
    if (f.applicationId !== undefined) where.push(eq(offer.applicationId, f.applicationId));
    if (f.candidateId !== undefined) where.push(eq(offer.candidateId, f.candidateId));
    if (f.requisitionId !== undefined) where.push(eq(offer.requisitionId, f.requisitionId));
    if (f.preparedBy !== undefined) where.push(eq(offer.preparedBy, f.preparedBy));
    if (f.awaitingApproval === true) {
      where.push(inArray(offer.status, [...AWAITING_APPROVAL] as never));
    }
    if (f.expiringBefore !== undefined) {
      where.push(eq(offer.status, 'SENT'));
      where.push(isNotNull(offer.expiresAt));
      where.push(lte(offer.expiresAt, f.expiringBefore));
    }

    const rows = await this.db
      .select({
        id: offer.id, offerNo: offer.offerNo, applicationId: offer.applicationId,
        candidateId: offer.candidateId, requisitionId: offer.requisitionId,
        positionTitle: offer.positionTitle, currency: offer.currency, status: offer.status,
        totalNet: DrizzleReadModel.TOTAL_NET,
        joiningDate: offer.joiningDate, sentAt: offer.sentAt, expiresAt: offer.expiresAt,
        preparedBy: offer.preparedBy, approvedBy: offer.approvedBy,
        requiresDirectorApproval: offer.requiresDirectorApproval,
        version: offer.version,
        total: TOTAL,
      })
      .from(offer)
      .where(and(...where))
      .orderBy(orderBy(DrizzleReadModel.OFFER_SORT, offer.createdAt, p))
      .limit(p.limit)
      .offset(p.offset);

    return pageOf(rows, p);
  }

  async offer(id: number, ctx: AuthContext): Promise<Q.OfferDetail | null> {
    const rows = await this.db
      .select({
        id: offer.id, offerNo: offer.offerNo, applicationId: offer.applicationId,
        candidateId: offer.candidateId, requisitionId: offer.requisitionId,
        positionTitle: offer.positionTitle, currency: offer.currency, status: offer.status,
        totalNet: DrizzleReadModel.TOTAL_NET,
        joiningDate: offer.joiningDate, sentAt: offer.sentAt, expiresAt: offer.expiresAt,
        decidedAt: offer.decidedAt, reason: offer.reason,
        templateCode: offer.templateCode, templateVersion: offer.templateVersion,
        preparedBy: offer.preparedBy, approvedBy: offer.approvedBy,
        requiresDirectorApproval: offer.requiresDirectorApproval,
        version: offer.version,
      })
      .from(offer)
      .where(and(eq(offer.id, id), this.offerScope(ctx)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    const lines = await this.db
      .select({
        componentCode: offerCompensationLine.componentCode,
        // numeric arrives as a string; convert here or the UI sums text.
        amount: sql<number>`${offerCompensationLine.amount}`.mapWith(Number),
      })
      .from(offerCompensationLine)
      .where(eq(offerCompensationLine.offerId, id))
      .orderBy(asc(offerCompensationLine.componentCode));

    return { ...row, lines };
  }

  /* ------------------------------- timeline ------------------------------ */

  /**
   * Scope for the audit trail.
   *
   * `timeline_entry` carries no project, so reachability is proven through the
   * entity it describes. An unrecognised entity type is refused rather than
   * allowed — an audit reader must not become the one endpoint that leaks.
   */
  private timelineScope(ctx: AuthContext): SQL {
    if (ctx.isGlobalScope) return eq(timelineEntry.tenantId, ctx.tenantId);
    if (ctx.projectScopes.length === 0) return sql`false`;
    const projects = [...ctx.projectScopes];

    return and(
      eq(timelineEntry.tenantId, ctx.tenantId),
      sql`(
        ("timeline_entry"."entity_type" = 'Requisition' and exists (
           select 1 from "hiring_requisition" r
           where r."id" = "timeline_entry"."entity_id" and r."tenant_id" = ${ctx.tenantId}
             and r."project_id" in ${projects}))
        or ("timeline_entry"."entity_type" in ('Application','Interview','Offer') and exists (
           select 1 from "hiring_requisition" r
           where r."tenant_id" = ${ctx.tenantId} and r."project_id" in ${projects}
             and r."id" = (
               case "timeline_entry"."entity_type"
                 when 'Application' then (select a."requisition_id" from "hiring_application" a
                                          where a."id" = "timeline_entry"."entity_id")
                 when 'Interview'   then (select i."requisition_id" from "interview" i
                                          where i."id" = "timeline_entry"."entity_id")
                 else                    (select o."requisition_id" from "offer" o
                                          where o."id" = "timeline_entry"."entity_id")
               end)))
      )`,
    ) ?? sql`false`;
  }

  async timeline(
    f: Q.TimelineFilters, p: Q.PageRequest, ctx: AuthContext,
  ): Promise<Q.Page<Q.TimelineItem>> {
    const where: SQL[] = [this.timelineScope(ctx)];
    if (f.entityType !== undefined) where.push(eq(timelineEntry.entityType, f.entityType));
    if (f.entityId !== undefined) where.push(eq(timelineEntry.entityId, f.entityId));
    if (f.actorId !== undefined) where.push(eq(timelineEntry.actorId, f.actorId));
    if (f.eventType?.length) where.push(inArray(timelineEntry.eventType, [...f.eventType]));
    if (f.from !== undefined) where.push(gte(timelineEntry.occurredAt, f.from));
    if (f.to !== undefined) where.push(lte(timelineEntry.occurredAt, f.to));

    const rows = await this.db
      .select({
        id: timelineEntry.id, entityType: timelineEntry.entityType,
        entityId: timelineEntry.entityId, eventType: timelineEntry.eventType,
        actorId: timelineEntry.actorId, actorName: timelineEntry.actorName,
        occurredAt: timelineEntry.occurredAt,
        previousValue: timelineEntry.previousValue, newValue: timelineEntry.newValue,
        correlationId: timelineEntry.correlationId,
        total: TOTAL,
      })
      .from(timelineEntry)
      .where(and(...where))
      .orderBy(desc(timelineEntry.occurredAt), desc(timelineEntry.id))
      .limit(p.limit)
      .offset(p.offset);

    return pageOf(
      rows.map((r) => ({
        ...r,
        previousValue: (r.previousValue ?? {}) as Record<string, unknown>,
        newValue: (r.newValue ?? {}) as Record<string, unknown>,
      })),
      p,
    );
  }

  /* ------------------------------ dashboard ------------------------------ */

  /**
   * Six grouped queries, run concurrently.
   *
   * Grouping in SQL rather than counting in JavaScript: the alternative is
   * loading every row to `reduce` over it, which is fine at 100 records and
   * fatal at 100,000.
   */
  async dashboard(ctx: AuthContext, now: Date): Promise<Q.DashboardSummary> {
    const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay); endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
    const stalledBefore = new Date(now.getTime() - 14 * 86_400_000);
    const soon = new Date(now.getTime() + 3 * 86_400_000);

    const [reqStates, seatTotals, appStages, ivCounts, offerStates, myWork] = await Promise.all([
      this.db.select({ key: hiringRequisition.state, n: sql<number>`count(*)`.mapWith(Number) })
        .from(hiringRequisition).where(this.requisitionScope(ctx))
        .groupBy(hiringRequisition.state),

      this.db.select({
        open: sql<number>`count(*) filter (where ${hiringSeat.state} = 'OPEN')`.mapWith(Number),
        filled: sql<number>`count(*) filter (where ${hiringSeat.state} = 'FILLED')`.mapWith(Number),
      }).from(hiringSeat)
        .innerJoin(hiringRequisition, eq(hiringRequisition.id, hiringSeat.requisitionId))
        .where(this.requisitionScope(ctx)),

      this.db.select({ key: hiringApplication.stage, n: sql<number>`count(*)`.mapWith(Number) })
        .from(hiringApplication).where(this.applicationScope(ctx))
        .groupBy(hiringApplication.stage),

      this.db.select({
        upcoming: sql<number>`count(*) filter (
          where ${interview.status} = 'SCHEDULED' and ${interview.startsAt} >= ${now})`.mapWith(Number),
        awaitingFeedback: sql<number>`count(*) filter (
          where "interview"."status" = 'COMPLETED'
            and not exists (select 1 from "interview_assessment" ia
                            where ia."interview_id" = "interview"."id"))`.mapWith(Number),
      }).from(interview).where(this.interviewScope(ctx)),

      this.db.select({ key: offer.status, n: sql<number>`count(*)`.mapWith(Number) })
        .from(offer).where(this.offerScope(ctx)).groupBy(offer.status),

      this.myWorkCounts(ctx, { now, startOfDay, endOfDay, stalledBefore, soon }),
    ]);

    const tally = (rows: readonly { key: string; n: number }[]): Record<string, number> =>
      Object.fromEntries(rows.map((r) => [r.key, r.n]));

    const stages = tally(appStages);
    const live = Object.entries(stages)
      .filter(([stage]) => !(TERMINAL_STAGES as readonly string[]).includes(stage))
      .reduce((sum, [, n]) => sum + n, 0);

    const offerCounts = tally(offerStates);
    const expiringSoon = await this.offers(
      { expiringBefore: soon }, { limit: 1, offset: 0 }, ctx,
    ).then((page) => page.total);

    return {
      requisitions: {
        byState: tally(reqStates),
        openSeats: seatTotals[0]?.open ?? 0,
        filledSeats: seatTotals[0]?.filled ?? 0,
      },
      applications: { byStage: stages, live },
      interviews: {
        upcoming: ivCounts[0]?.upcoming ?? 0,
        awaitingFeedback: ivCounts[0]?.awaitingFeedback ?? 0,
      },
      offers: { byStatus: offerCounts, expiringSoon },
      myWork,
    };
  }

  private async myWorkCounts(
    ctx: AuthContext,
    at: { now: Date; startOfDay: Date; endOfDay: Date; stalledBefore: Date; soon: Date },
  ): Promise<Q.DashboardSummary['myWork']> {
    const mine = eq(hiringApplication.recruiterId, ctx.userId);
    const notTerminal = notInArray(hiringApplication.stage, [...TERMINAL_STAGES]);

    const [actions, reqs, ivs, approvals] = await Promise.all([
      this.db.select({
        dueToday: sql<number>`count(*) filter (
          where ${hiringApplication.nextActionDueAt} >= ${at.startOfDay}
            and ${hiringApplication.nextActionDueAt} < ${at.endOfDay})`.mapWith(Number),
        overdue: sql<number>`count(*) filter (
          where ${hiringApplication.nextActionDueAt} < ${at.startOfDay})`.mapWith(Number),
        stalled: sql<number>`count(*) filter (
          where ${hiringApplication.lastActivityAt} < ${at.stalledBefore})`.mapWith(Number),
      }).from(hiringApplication)
        .where(and(this.applicationScope(ctx), mine, notTerminal)),

      this.db.select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(hiringRequisition)
        .where(and(
          this.requisitionScope(ctx),
          eq(hiringRequisition.recruiterId, ctx.userId),
          inArray(hiringRequisition.state, ['OPEN', 'APPROVED', 'ON_HOLD'] as never),
        )),

      this.db.select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(interview)
        .where(and(
          this.interviewScope(ctx),
          eq(interview.status, 'SCHEDULED'),
          gte(interview.startsAt, at.now),
          sql`exists (select 1 from "interview_panel" ip
                      where ip."interview_id" = "interview"."id"
                        and ip."user_id" = ${ctx.userId})`,
        )),

      this.db.select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(offer)
        .where(and(
          this.offerScope(ctx),
          inArray(offer.status, [...AWAITING_APPROVAL] as never),
          // BL-12: you cannot approve what you prepared, so it is not "yours to
          // approve" and must not appear in your queue.
          ne(offer.preparedBy, ctx.userId),
        )),
    ]);

    return {
      dueToday: actions[0]?.dueToday ?? 0,
      overdue: actions[0]?.overdue ?? 0,
      stalled: actions[0]?.stalled ?? 0,
      myRequisitions: reqs[0]?.n ?? 0,
      myUpcomingInterviews: ivs[0]?.n ?? 0,
      offersAwaitingMyApproval: approvals[0]?.n ?? 0,
    };
  }
}

export const LIVE_OFFER_STATUSES = LIVE_OFFER;
