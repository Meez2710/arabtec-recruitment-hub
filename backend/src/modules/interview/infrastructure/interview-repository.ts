// InterviewRepository — Drizzle/PostgreSQL adapter. Persistence only.

import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { Interview } from '../domain/interview.js';
import type { InterviewProps, PanelMember } from '../domain/interview.js';
import type { Assessment } from '../domain/assessment.js';
import type { InterviewRepository } from '../application/ports.js';
import {
  ID_SEQUENCES, SEQUENCES, interview, interviewAssessment, interviewPanel,
} from '../../../infrastructure/db/schema/index.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { scopedViaRequisition } from '../../../infrastructure/db/scope.js';
import { LoadRegistry, assertUpdated } from '../../../infrastructure/db/version-guard.js';
import { NUMBER_PREFIXES, formatFlatNumber, nextval } from '../../../infrastructure/db/sequences.js';
import { ConstraintViolationError, isUniqueViolation } from '../../../infrastructure/db/errors.js';
import { TransactionEventCollector } from '../../../infrastructure/db/outbox.js';
import {
  assessmentToRow, interviewToProps, interviewToRow, panelToRow,
} from './mappers.js';
import type { AssessmentRow, PanelRow } from './mappers.js';

export interface InterviewRepositoryOptions {
  /** Legacy-compatible prefix, configurable exactly as `interview_prefix` was. */
  readonly interviewPrefix?: string;
  /** Supplied by the Unit of Work. Absent means a standalone repository. */
  readonly collector?: TransactionEventCollector;
}

export class DrizzleInterviewRepository implements InterviewRepository {
  private readonly registry = new LoadRegistry();
  private readonly interviewPrefix: string;
  private readonly collector: TransactionEventCollector;

  constructor(
    private readonly db: Executor,
    opts: InterviewRepositoryOptions = {},
  ) {
    this.interviewPrefix = opts.interviewPrefix ?? NUMBER_PREFIXES.interview;
    this.collector = opts.collector ?? new TransactionEventCollector();
  }

  async findById(id: number, ctx: AuthContext): Promise<Interview | null> {
    return this.load(id, ctx, false);
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<Interview | null> {
    return this.load(id, ctx, true);
  }

  private async load(id: number, ctx: AuthContext, lock: boolean): Promise<Interview | null> {
    const base = this.db
      .select()
      .from(interview)
      .where(and(eq(interview.id, id), this.scope(ctx)))
      .limit(1);
    const rows = lock ? await base.for('update') : await base;

    const row = rows[0];
    if (row === undefined) return null;

    const [panel, assessments] = await Promise.all([
      this.db.select().from(interviewPanel).where(eq(interviewPanel.interviewId, id)),
      this.db.select().from(interviewAssessment)
        .where(eq(interviewAssessment.interviewId, id)),
    ]);

    this.registry.record(row.id, row.version);
    return Interview.fromState(interviewToProps(row, panel, assessments));
  }

  async save(aggregate: Interview): Promise<void> {
    const state = aggregate.toState();
    const baseline = this.registry.baselineOf(state.id);

    try {
      if (baseline === undefined) {
        await this.db.insert(interview).values(interviewToRow(state));
        await this.writePanel(state.id, state.panel, []);
        await this.writeAssessments(state.id, state.assessments, []);
      } else {
        const result = await this.db
          .update(interview)
          .set({ ...interviewToRow(state), updatedAt: sql`now()` })
          .where(and(
            eq(interview.id, state.id),
            eq(interview.version, baseline.version),
          ))
          .returning({ id: interview.id });

        await assertUpdated(
          result.length, 'Interview', state.id, baseline.version,
          () => this.readVersion(state.id),
        );

        const [panel, assessments] = await Promise.all([
          this.db.select().from(interviewPanel).where(eq(interviewPanel.interviewId, state.id)),
          this.db.select().from(interviewAssessment)
            .where(eq(interviewAssessment.interviewId, state.id)),
        ]);
        await this.writePanel(state.id, state.panel, panel);
        await this.writeAssessments(state.id, state.assessments, assessments);
      }
    } catch (err) {
      throw this.translate(err);
    }

    this.registry.record(state.id, state.version);
    this.collector.collect('Interview', state.id, state.tenantId, aggregate.pullEvents());
  }

  /**
   * Reconcile panel membership, keyed on `userId`.
   *
   * ORDER IS LOAD-BEARING, for the same reason as the seat diff:
   * `ux_panel_one_lead` is a partial UNIQUE index checked per statement. Moving
   * the lead from A to B must clear A first, or the write collides on a
   * constraint the aggregate has already satisfied.
   */
  private async writePanel(
    interviewId: number,
    desired: readonly PanelMember[],
    stored: readonly PanelRow[],
  ): Promise<void> {
    const desiredIds = new Set(desired.map((m) => m.userId));
    const storedByUser = new Map(stored.map((m) => [m.userId, m]));

    const removed = stored.filter((m) => !desiredIds.has(m.userId)).map((m) => m.userId);
    if (removed.length > 0) {
      await this.db.delete(interviewPanel).where(and(
        eq(interviewPanel.interviewId, interviewId),
        inArray(interviewPanel.userId, removed),
      ));
    }

    // Demote anyone who is stored as lead but is not the desired lead.
    const desiredLead = desired.find((m) => m.isLead)?.userId ?? null;
    const staleLeads = stored
      .filter((m) => m.isLead && m.userId !== desiredLead && desiredIds.has(m.userId))
      .map((m) => m.userId);
    if (staleLeads.length > 0) {
      await this.db.update(interviewPanel).set({ isLead: false }).where(and(
        eq(interviewPanel.interviewId, interviewId),
        inArray(interviewPanel.userId, staleLeads),
      ));
    }

    // One INSERT for every new member. Panels are small, but a per-member
    // statement is the same shape of mistake as a per-seat one and there is no
    // reason to leave it in place.
    const added = desired.filter((m) => !storedByUser.has(m.userId));
    if (added.length > 0) {
      await this.db
        .insert(interviewPanel)
        .values(added.map((m) => panelToRow(interviewId, m)));
    }

    for (const member of desired) {
      const before = storedByUser.get(member.userId);
      if (before === undefined) continue;
      if (before.role === member.role && before.isLead === member.isLead) continue;
      await this.db
        .update(interviewPanel)
        .set({ role: member.role, isLead: member.isLead })
        .where(and(
          eq(interviewPanel.interviewId, interviewId),
          eq(interviewPanel.userId, member.userId),
        ));
    }
  }

  /**
   * One row per evaluator per interview — upserted, not appended, because an
   * evaluator may revise their own feedback before the interview closes.
   */
  private async writeAssessments(
    interviewId: number,
    desired: readonly Assessment[],
    stored: readonly AssessmentRow[],
  ): Promise<void> {
    const desiredIds = new Set(desired.map((a) => a.evaluatorUserId));
    const removed = stored
      .filter((a) => !desiredIds.has(a.evaluatorUserId))
      .map((a) => a.evaluatorUserId);
    if (removed.length > 0) {
      await this.db.delete(interviewAssessment).where(and(
        eq(interviewAssessment.interviewId, interviewId),
        inArray(interviewAssessment.evaluatorUserId, removed),
      ));
    }
    if (desired.length === 0) return;

    await this.db
      .insert(interviewAssessment)
      .values(desired.map((a) => assessmentToRow(interviewId, a)))
      .onConflictDoUpdate({
        target: [interviewAssessment.interviewId, interviewAssessment.evaluatorUserId],
        set: {
          evaluatorRole: sql`excluded.evaluator_role`,
          evaluatorName: sql`excluded.evaluator_name`,
          scores: sql`excluded.scores`,
          criticalFlags: sql`excluded.critical_flags`,
          justification: sql`excluded.justification`,
          submittedAt: sql`excluded.submitted_at`,
        },
      });
  }

  async nextInterviewNo(_ctx: AuthContext): Promise<string> {
    const counter = await nextval(this.db, SEQUENCES.interviewNo);
    return formatFlatNumber(this.interviewPrefix, counter);
  }

  async nextId(_ctx: AuthContext): Promise<number> {
    return nextval(this.db, ID_SEQUENCES.interview);
  }

  /**
   * Interviews already booked for these users in a window.
   *
   * The window predicate matches the service's own contract exactly:
   * `startsAt >= window.startsAt && startsAt < window.endsAt`. Status is
   * narrowed to SCHEDULED, which cannot change the result — the service filters
   * on `isUpcoming`, and `isUpcoming` IS `status === 'SCHEDULED'` — but lets the
   * query use `ix_interview_tenant_status_starts` instead of scanning.
   */
  async findBookedFor(
    userIds: readonly number[],
    window: { startsAt: Date; endsAt: Date },
    ctx: AuthContext,
  ): Promise<readonly Interview[]> {
    if (userIds.length === 0) return [];

    const rows = await this.db
      .selectDistinct({ iv: interview })
      .from(interview)
      .innerJoin(interviewPanel, eq(interviewPanel.interviewId, interview.id))
      .where(and(
        eq(interview.status, 'SCHEDULED'),
        gte(interview.startsAt, window.startsAt),
        lt(interview.startsAt, window.endsAt),
        inArray(interviewPanel.userId, [...userIds]),
        this.scope(ctx),
      ))
      .orderBy(interview.id);

    if (rows.length === 0) return [];

    // Conflict reporting reads `iv.panel`, so the FULL panel is required — not
    // just the members that matched the join. One batched follow-up query.
    const ids = rows.map((r) => r.iv.id);
    const panel = await this.db
      .select()
      .from(interviewPanel)
      .where(inArray(interviewPanel.interviewId, ids));

    const byInterview = new Map<number, PanelRow[]>();
    for (const m of panel) {
      const bucket = byInterview.get(m.interviewId);
      if (bucket === undefined) byInterview.set(m.interviewId, [m]);
      else bucket.push(m);
    }

    // Assessments are irrelevant to conflict detection and deliberately not
    // loaded. These aggregates are read-only projections for that one question;
    // no baseline is registered, so an accidental save() would insert and fail
    // loudly rather than silently write a partially-loaded aggregate.
    return rows.map((r) => {
      const props: InterviewProps = interviewToProps(r.iv, byInterview.get(r.iv.id) ?? [], []);
      return Interview.fromState(props);
    });
  }

  async countForApplication(applicationId: number, ctx: AuthContext): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(interview)
      .where(and(eq(interview.applicationId, applicationId), this.scope(ctx)));
    return rows[0]?.n ?? 0;
  }

  private scope(ctx: AuthContext): ReturnType<typeof scopedViaRequisition> {
    return scopedViaRequisition(this.db, interview.tenantId, interview.requisitionId, ctx);
  }

  private async readVersion(id: number): Promise<number | null> {
    const rows = await this.db
      .select({ version: interview.version })
      .from(interview)
      .where(eq(interview.id, id))
      .limit(1);
    return rows[0]?.version ?? null;
  }

  private translate(err: unknown): unknown {
    if (isUniqueViolation(err, 'ux_panel_one_lead')) {
      return new ConstraintViolationError(err, 'panel write (more than one lead)');
    }
    if (isUniqueViolation(err, 'ux_interview_no')) {
      return new ConstraintViolationError(err, 'interview write (duplicate interview number)');
    }
    return err;
  }
}
