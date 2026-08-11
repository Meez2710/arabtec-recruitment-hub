// RequisitionRepository — Drizzle/PostgreSQL adapter.
//
// PERSISTENCE ONLY. This file maps data, writes rows and reconstructs
// aggregates. It contains no rule about when a seat may be filled, what
// headcount is legal, or which state may follow which — all of that lives in
// `Requisition`, and the repository never inspects it to decide anything.
//
// The two things it DOES own, because they are storage concerns:
//
//   * The row lock. `findByIdForUpdate` takes `SELECT … FOR UPDATE` on the
//     requisition row, which is what serialises concurrent seat acquisition and
//     makes the aggregate's in-memory seat selection safe (ADR-0004).
//
//   * The seat diff. Seats live inside the aggregate boundary, so there is no
//     seat repository and never will be. `save()` reconciles the in-memory seat
//     list against the stored rows.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { Requisition } from '../domain/requisition.js';
import type { Seat } from '../domain/requisition.js';
import type { RequisitionRepository } from '../application/ports/repositories.js';
import { hiringRequisition, hiringSeat, ID_SEQUENCES, SEQUENCES } from '../../../infrastructure/db/schema/index.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { scopedByProjectColumn } from '../../../infrastructure/db/scope.js';
import { LoadRegistry, assertUpdated } from '../../../infrastructure/db/version-guard.js';
import { NUMBER_PREFIXES, formatYearlyNumber, nextval } from '../../../infrastructure/db/sequences.js';
import { ConstraintViolationError, isCheckViolation, isUniqueViolation } from '../../../infrastructure/db/errors.js';
import { TransactionEventCollector } from '../../../infrastructure/db/outbox.js';
import { requisitionToProps, requisitionToRow, seatToRow } from './mappers.js';
import type { SeatRow } from './mappers.js';

export interface RequisitionRepositoryOptions {
  /** Legacy-compatible prefix, configurable exactly as `ticket_prefix` was. */
  readonly ticketPrefix?: string;
  /** Injected so ticket numbers are deterministic under test. */
  readonly year?: () => number;
  /** Supplied by the Unit of Work. Absent means a standalone repository. */
  readonly collector?: TransactionEventCollector;
}

export class DrizzleRequisitionRepository implements RequisitionRepository {
  private readonly registry = new LoadRegistry();
  private readonly ticketPrefix: string;
  private readonly year: () => number;
  private readonly collector: TransactionEventCollector;

  constructor(
    private readonly db: Executor,
    opts: RequisitionRepositoryOptions = {},
  ) {
    this.ticketPrefix = opts.ticketPrefix ?? NUMBER_PREFIXES.requisition;
    this.year = opts.year ?? ((): number => new Date().getFullYear());
    this.collector = opts.collector ?? new TransactionEventCollector();
  }

  async findById(id: number, ctx: AuthContext): Promise<Requisition | null> {
    return this.load(id, ctx, false);
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<Requisition | null> {
    return this.load(id, ctx, true);
  }

  private async load(id: number, ctx: AuthContext, lock: boolean): Promise<Requisition | null> {
    const where = and(
      eq(hiringRequisition.id, id),
      scopedByProjectColumn(hiringRequisition.tenantId, hiringRequisition.projectId, ctx),
    );

    const base = this.db.select().from(hiringRequisition).where(where).limit(1);
    // FOR UPDATE on the ROOT ONLY. Seats are read without a lock because the
    // root lock already excludes every other writer of this aggregate — locking
    // them too would add rows to the lock set for no additional protection.
    const rows = lock ? await base.for('update') : await base;

    const row = rows[0];
    if (row === undefined) return null;

    const seats = await this.db
      .select()
      .from(hiringSeat)
      .where(eq(hiringSeat.requisitionId, id))
      .orderBy(hiringSeat.seatNo);

    this.registry.record(row.id, row.version);
    return Requisition.fromState(requisitionToProps(row, seats));
  }

  async save(requisition: Requisition): Promise<void> {
    const state = requisition.toState();
    const baseline = this.registry.baselineOf(state.id);

    try {
      if (baseline === undefined) {
        await this.db.insert(hiringRequisition).values(requisitionToRow(state));
        await this.writeSeats(state.id, state.seats, []);
      } else {
        const result = await this.db
          .update(hiringRequisition)
          .set({
            ...requisitionToRow(state),
            updatedAt: sql`now()`,
          })
          .where(and(
            eq(hiringRequisition.id, state.id),
            eq(hiringRequisition.version, baseline.version),
          ))
          .returning({ id: hiringRequisition.id });

        await assertUpdated(
          result.length,
          'Requisition',
          state.id,
          baseline.version,
          () => this.readVersion(state.id),
        );

        const stored = await this.db
          .select()
          .from(hiringSeat)
          .where(eq(hiringSeat.requisitionId, state.id));
        await this.writeSeats(state.id, state.seats, stored);
      }
    } catch (err) {
      throw this.translate(err);
    }

    // The saved version becomes the baseline for any further save in this same
    // transaction, so a second save() updates rather than attempting an insert.
    this.registry.record(state.id, state.version);
    this.collectEvents(requisition, state.tenantId, state.id);
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
  private collectEvents(requisition: Requisition, tenantId: number, id: number): void {
    this.collector.collect('Requisition', id, tenantId, requisition.pullEvents());
  }

  /**
   * Reconcile the aggregate's seat list against stored rows.
   *
   * Seats have no surrogate identity in the domain — `seatNo` is the natural key
   * and `ux_seat_requisition_seat_no` enforces it — so the diff is keyed on it.
   *
   * ORDER IS LOAD-BEARING. `ux_seat_one_per_application` is a partial UNIQUE
   * index, checked per statement, not at commit. If one seat releases an
   * application and another acquires it in the same save, applying them in the
   * wrong order collides on an index the domain has already satisfied. So:
   * delete, then release, then write.
   *
   * STATEMENT COUNT IS BOUNDED, NOT PROPORTIONAL. Every phase batches:
   * one DELETE, one release UPDATE, one INSERT for all new seats, and one UPDATE
   * per DISTINCT target value. That last grouping is what makes the two
   * bulk operations cheap — opening a 50-headcount requisition is one INSERT,
   * and cancelling all its open seats on close is one UPDATE. Per-seat
   * statements would mean 50 round trips inside a transaction holding a row
   * lock, which is contention nobody would see until production.
   * `performance.test.ts` measures this rather than trusting it.
   */
  private async writeSeats(
    requisitionId: number,
    desired: readonly Seat[],
    stored: readonly SeatRow[],
  ): Promise<void> {
    const storedByNo = new Map(stored.map((s) => [s.seatNo, s]));
    const desiredNos = new Set(desired.map((s) => s.seatNo));

    // 1. Remove seats the aggregate dropped (only ever OPEN ones — the
    //    aggregate refuses to shrink below filled + cancelled).
    const removed = stored.filter((s) => !desiredNos.has(s.seatNo)).map((s) => s.seatNo);
    if (removed.length > 0) {
      await this.db.delete(hiringSeat).where(and(
        eq(hiringSeat.requisitionId, requisitionId),
        inArray(hiringSeat.seatNo, removed),
      ));
    }

    // 2. Release every seat whose application binding is changing away from a
    //    non-null value. `state: 'OPEN'` keeps `ck_seat_filled_binding`
    //    satisfied in the intermediate row — the check is immediate, not
    //    deferred, so the halfway state must itself be legal.
    const releasing = desired.filter((s) => {
      const before = storedByNo.get(s.seatNo);
      return before !== undefined
        && before.applicationId !== null
        && before.applicationId !== s.applicationId;
    });
    if (releasing.length > 0) {
      await this.db
        .update(hiringSeat)
        .set({ applicationId: null, state: 'OPEN' })
        .where(and(
          eq(hiringSeat.requisitionId, requisitionId),
          inArray(hiringSeat.seatNo, releasing.map((s) => s.seatNo)),
        ));
    }

    // 3a. Insert every new seat in ONE statement.
    const added = desired.filter((s) => !storedByNo.has(s.seatNo));
    if (added.length > 0) {
      await this.db
        .insert(hiringSeat)
        .values(added.map((s) => seatToRow(requisitionId, s)));
    }

    // 3b. Update changed seats, grouped by the value they are changing TO.
    //     Mass operations move many seats to the same target — cancelling every
    //     open seat on close is one group, so one statement.
    const changed = desired.filter((s) => {
      const before = storedByNo.get(s.seatNo);
      return before !== undefined && seatChanged(before, s);
    });

    const groups = new Map<string, { seat: Seat; seatNos: number[] }>();
    for (const seat of changed) {
      const key = JSON.stringify([
        seat.state, seat.applicationId, seat.filledAt?.getTime() ?? null, seat.cancelReason,
      ]);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { seat, seatNos: [seat.seatNo] });
      else group.seatNos.push(seat.seatNo);
    }

    for (const { seat, seatNos } of groups.values()) {
      await this.db
        .update(hiringSeat)
        .set({
          state: seat.state,
          applicationId: seat.applicationId,
          filledAt: seat.filledAt,
          cancelReason: seat.cancelReason,
        })
        .where(and(
          eq(hiringSeat.requisitionId, requisitionId),
          inArray(hiringSeat.seatNo, seatNos),
        ));
    }
  }

  private async readVersion(id: number): Promise<number | null> {
    const rows = await this.db
      .select({ version: hiringRequisition.version })
      .from(hiringRequisition)
      .where(eq(hiringRequisition.id, id))
      .limit(1);
    return rows[0]?.version ?? null;
  }

  /**
   * A constraint firing here means an aggregate was bypassed or two transactions
   * raced past the row lock. Neither is a business outcome, so it must not
   * surface as a domain error a caller could catch and treat as one.
   */
  private translate(err: unknown): unknown {
    if (isUniqueViolation(err, 'ux_seat_one_per_application')) {
      return new ConstraintViolationError(err, 'seat write (H3: one application, one seat)');
    }
    if (isUniqueViolation(err, 'ux_requisition_ticket_no')) {
      return new ConstraintViolationError(err, 'requisition write (duplicate ticket number)');
    }
    if (isCheckViolation(err, 'ck_seat_filled_binding')) {
      return new ConstraintViolationError(err, 'seat write (H3: FILLED <=> bound)');
    }
    if (isCheckViolation(err, 'ck_requisition_headcount')) {
      return new ConstraintViolationError(err, 'requisition write (H1: headcount >= 1)');
    }
    return err;
  }

  async nextTicketNo(_ctx: AuthContext): Promise<string> {
    const counter = await nextval(this.db, SEQUENCES.requisitionTicketNo);
    return formatYearlyNumber(this.ticketPrefix, this.year(), counter);
  }

  async nextId(_ctx: AuthContext): Promise<number> {
    return nextval(this.db, ID_SEQUENCES.hiringRequisition);
  }
}

const seatChanged = (before: SeatRow, after: Seat): boolean =>
  before.state !== after.state
  || before.applicationId !== after.applicationId
  || before.filledAt?.getTime() !== after.filledAt?.getTime()
  || before.cancelReason !== after.cancelReason;
