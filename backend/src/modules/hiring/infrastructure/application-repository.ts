// ApplicationRepository — Drizzle/PostgreSQL adapter.
//
// PERSISTENCE ONLY. The two query methods that look like they encode rules —
// `findActiveHireForCandidate` and `findNonTerminalByRequisition` — do not.
// They answer questions the SERVICE asks; the service decides what the answer
// means. The vocabulary they filter on (`HIRED`, `TERMINAL_STAGES`) is imported
// from the domain rather than retyped, so it cannot drift into a second,
// competing definition of "terminal".

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { Application } from '../domain/application.js';
import type { ApplicationProps, StageChange } from '../domain/application.js';
import { TERMINAL_STAGES } from '../domain/stages.js';
import type { ApplicationRepository } from '../application/ports/repositories.js';
import { hiringApplication, hiringStageHistory, ID_SEQUENCES, SEQUENCES } from '../../../infrastructure/db/schema/index.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { scopedViaRequisition } from '../../../infrastructure/db/scope.js';
import { LoadRegistry, assertUpdated } from '../../../infrastructure/db/version-guard.js';
import { NUMBER_PREFIXES, formatFlatNumber, nextval } from '../../../infrastructure/db/sequences.js';
import { ConstraintViolationError, isUniqueViolation } from '../../../infrastructure/db/errors.js';
import { TransactionEventCollector } from '../../../infrastructure/db/outbox.js';
import { applicationToProps, applicationToRow, stageChangeToRow } from './mappers.js';
import type { StageHistoryRow } from './mappers.js';

/** Registry key for the append-only child collection. */
const HISTORY = 'history';

export interface ApplicationRepositoryOptions {
  /** Legacy-compatible prefix, configurable exactly as `application_prefix` was. */
  readonly applicationPrefix?: string;
  /** Supplied by the Unit of Work. Absent means a standalone repository. */
  readonly collector?: TransactionEventCollector;
}

export class DrizzleApplicationRepository implements ApplicationRepository {
  private readonly registry = new LoadRegistry();
  private readonly applicationPrefix: string;
  private readonly collector: TransactionEventCollector;

  constructor(
    private readonly db: Executor,
    opts: ApplicationRepositoryOptions = {},
  ) {
    this.applicationPrefix = opts.applicationPrefix ?? NUMBER_PREFIXES.application;
    this.collector = opts.collector ?? new TransactionEventCollector();
  }

  async findById(id: number, ctx: AuthContext): Promise<Application | null> {
    return this.load(id, ctx, false);
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<Application | null> {
    return this.load(id, ctx, true);
  }

  private async load(id: number, ctx: AuthContext, lock: boolean): Promise<Application | null> {
    const where = and(
      eq(hiringApplication.id, id),
      this.scope(ctx),
    );

    const base = this.db.select().from(hiringApplication).where(where).limit(1);
    const rows = lock ? await base.for('update') : await base;

    const row = rows[0];
    if (row === undefined) return null;

    const history = await this.db
      .select()
      .from(hiringStageHistory)
      .where(eq(hiringStageHistory.applicationId, id))
      .orderBy(hiringStageHistory.movedAt, hiringStageHistory.id);

    this.registry.record(row.id, row.version, { [HISTORY]: history.length });
    return Application.fromState(applicationToProps(row, history));
  }

  async save(application: Application): Promise<void> {
    const state = application.toState();
    const baseline = this.registry.baselineOf(state.id);

    try {
      if (baseline === undefined) {
        await this.db.insert(hiringApplication).values(applicationToRow(state));
        await this.appendHistory(state.id, state.history, 0);
      } else {
        const result = await this.db
          .update(hiringApplication)
          .set({ ...applicationToRow(state), updatedAt: sql`now()` })
          .where(and(
            eq(hiringApplication.id, state.id),
            eq(hiringApplication.version, baseline.version),
          ))
          .returning({ id: hiringApplication.id });

        await assertUpdated(
          result.length,
          'Application',
          state.id,
          baseline.version,
          () => this.readVersion(state.id),
        );

        await this.appendHistory(
          state.id,
          state.history,
          baseline.appendedCounts[HISTORY] ?? 0,
        );
      }
    } catch (err) {
      throw this.translate(err);
    }

    this.registry.record(state.id, state.version, { [HISTORY]: state.history.length });
    this.collectEvents(application, state.tenantId, state.id);
  }

  /**
   * Drain the aggregate's events into the transaction's collector.
   *
   * `pullEvents()` is destructive and services call it AFTER `save()`, so doing
   * this here takes the events away from the service — deliberately. Publishing
   * both in-process and from the outbox relay would deliver everything twice.
   * The Unit of Work publishes after commit in the service's place; the
   * service's own `publish([])` becomes a harmless no-op. See outbox.ts.
   */
  private collectEvents(application: Application, tenantId: number, id: number): void {
    this.collector.collect('Application', id, tenantId, application.pullEvents());
  }

  /**
   * Insert only the entries appended since load.
   *
   * `hiring_stage_history` is append-only: nothing updates or deletes a row, and
   * the application role holds no UPDATE or DELETE grant on it. Re-inserting the
   * whole list on every save would duplicate the trail, which is the difference
   * between an audit record and a log with extra rows in it.
   */
  private async appendHistory(
    applicationId: number,
    history: readonly StageChange[],
    alreadyStored: number,
  ): Promise<void> {
    const tail = history.slice(alreadyStored);
    if (tail.length === 0) return;
    await this.db
      .insert(hiringStageHistory)
      .values(tail.map((c) => stageChangeToRow(applicationId, c)));
  }

  async nextApplicationNo(_ctx: AuthContext): Promise<string> {
    const counter = await nextval(this.db, SEQUENCES.applicationNo);
    return formatFlatNumber(this.applicationPrefix, counter);
  }

  async nextId(_ctx: AuthContext): Promise<number> {
    return nextval(this.db, ID_SEQUENCES.hiringApplication);
  }

  /**
   * Invariant H5 — one active hire per candidate across requisitions.
   *
   * Returns the offending application id, or null. The service decides what to
   * do with it; the repository only reports what is stored. Served by
   * `ix_application_candidate_stage`.
   */
  async findActiveHireForCandidate(
    candidateId: number,
    ctx: AuthContext,
    opts: { excludeApplicationId?: number } = {},
  ): Promise<number | null> {
    const predicates = [
      eq(hiringApplication.candidateId, candidateId),
      eq(hiringApplication.stage, 'HIRED'),
      this.scope(ctx),
    ];
    if (opts.excludeApplicationId !== undefined) {
      predicates.push(sql`${hiringApplication.id} <> ${opts.excludeApplicationId}`);
    }

    const rows = await this.db
      .select({ id: hiringApplication.id })
      .from(hiringApplication)
      .where(and(...predicates))
      .orderBy(hiringApplication.id)
      .limit(1);

    return rows[0]?.id ?? null;
  }

  /**
   * Non-terminal applications on a requisition — the close/cancel cascade's
   * input (BL-22), so candidates are not left sitting at INTERVIEWING on a dead
   * requisition.
   *
   * History is fetched in ONE follow-up query rather than per application. These
   * aggregates are usually saved right back by the cascade, so their baselines
   * are registered here too — otherwise `save()` would treat each one as new and
   * attempt an insert.
   */
  async findNonTerminalByRequisition(
    requisitionId: number,
    ctx: AuthContext,
  ): Promise<Application[]> {
    const rows = await this.db
      .select()
      .from(hiringApplication)
      .where(and(
        eq(hiringApplication.requisitionId, requisitionId),
        notInArray(hiringApplication.stage, [...TERMINAL_STAGES]),
        this.scope(ctx),
      ))
      .orderBy(hiringApplication.id);

    if (rows.length === 0) return [];

    const history = await this.db
      .select()
      .from(hiringStageHistory)
      .where(inArray(hiringStageHistory.applicationId, rows.map((r) => r.id)))
      .orderBy(hiringStageHistory.movedAt, hiringStageHistory.id);

    const byApplication = new Map<number, StageHistoryRow[]>();
    for (const h of history) {
      const bucket = byApplication.get(h.applicationId);
      if (bucket === undefined) byApplication.set(h.applicationId, [h]);
      else bucket.push(h);
    }

    return rows.map((row) => {
      const own = byApplication.get(row.id) ?? [];
      this.registry.record(row.id, row.version, { [HISTORY]: own.length });
      const props: ApplicationProps = applicationToProps(row, own);
      return Application.fromState(props);
    });
  }

  /** Applications carry no `project_id`; scope reaches through the requisition. */
  private scope(ctx: AuthContext): ReturnType<typeof scopedViaRequisition> {
    return scopedViaRequisition(
      this.db,
      hiringApplication.tenantId,
      hiringApplication.requisitionId,
      ctx,
    );
  }

  private async readVersion(id: number): Promise<number | null> {
    const rows = await this.db
      .select({ version: hiringApplication.version })
      .from(hiringApplication)
      .where(eq(hiringApplication.id, id))
      .limit(1);
    return rows[0]?.version ?? null;
  }

  private translate(err: unknown): unknown {
    if (isUniqueViolation(err, 'ux_application_one_live_per_pair')) {
      return new ConstraintViolationError(
        err,
        'application write (BL-26: one live application per candidate and requisition)',
      );
    }
    if (isUniqueViolation(err, 'ux_application_no')) {
      return new ConstraintViolationError(err, 'application write (duplicate application number)');
    }
    return err;
  }
}
