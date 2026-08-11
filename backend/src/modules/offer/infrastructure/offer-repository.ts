// OfferRepository — Drizzle/PostgreSQL adapter. Persistence only.

import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { Offer } from '../domain/offer.js';
import type { CompensationLine, OfferProps } from '../domain/offer.js';
import type { OfferRepository } from '../application/offer-service.js';
import {
  ID_SEQUENCES, SEQUENCES, offer, offerCompensationLine,
} from '../../../infrastructure/db/schema/index.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { scopedViaRequisition } from '../../../infrastructure/db/scope.js';
import { LoadRegistry, assertUpdated } from '../../../infrastructure/db/version-guard.js';
import { NUMBER_PREFIXES, formatYearlyNumber, nextval } from '../../../infrastructure/db/sequences.js';
import { ConstraintViolationError, isCheckViolation, isUniqueViolation } from '../../../infrastructure/db/errors.js';
import { TransactionEventCollector } from '../../../infrastructure/db/outbox.js';
import { compensationLineToRow, offerToProps, offerToRow } from './mappers.js';
import type { CompensationLineRow } from './mappers.js';

/** `isLive` on the aggregate. Duplicated as a query predicate, not as a rule. */
const LIVE_STATUSES = ['SENT', 'ACCEPTED'] as const;

export interface OfferRepositoryOptions {
  /** Legacy-compatible prefix, configurable exactly as `offer_prefix` was. */
  readonly offerPrefix?: string;
  readonly year?: () => number;
  /** Supplied by the Unit of Work. Absent means a standalone repository. */
  readonly collector?: TransactionEventCollector;
}

export class DrizzleOfferRepository implements OfferRepository {
  private readonly registry = new LoadRegistry();
  private readonly offerPrefix: string;
  private readonly year: () => number;
  private readonly collector: TransactionEventCollector;

  constructor(
    private readonly db: Executor,
    opts: OfferRepositoryOptions = {},
  ) {
    this.offerPrefix = opts.offerPrefix ?? NUMBER_PREFIXES.offer;
    this.year = opts.year ?? ((): number => new Date().getFullYear());
    this.collector = opts.collector ?? new TransactionEventCollector();
  }

  async findById(id: number, ctx: AuthContext): Promise<Offer | null> {
    return this.load(id, ctx, false);
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<Offer | null> {
    return this.load(id, ctx, true);
  }

  private async load(id: number, ctx: AuthContext, lock: boolean): Promise<Offer | null> {
    const base = this.db
      .select()
      .from(offer)
      .where(and(eq(offer.id, id), this.scope(ctx)))
      .limit(1);
    const rows = lock ? await base.for('update') : await base;

    const row = rows[0];
    if (row === undefined) return null;

    const lines = await this.db
      .select()
      .from(offerCompensationLine)
      .where(eq(offerCompensationLine.offerId, id));

    this.registry.record(row.id, row.version);
    return Offer.fromState(offerToProps(row, lines));
  }

  async save(aggregate: Offer): Promise<void> {
    const state = aggregate.toState();
    const baseline = this.registry.baselineOf(state.id);

    try {
      if (baseline === undefined) {
        await this.db.insert(offer).values(offerToRow(state));
        await this.writeLines(state.id, state.lines, []);
      } else {
        const result = await this.db
          .update(offer)
          .set({ ...offerToRow(state), updatedAt: sql`now()` })
          .where(and(eq(offer.id, state.id), eq(offer.version, baseline.version)))
          .returning({ id: offer.id });

        await assertUpdated(
          result.length, 'Offer', state.id, baseline.version,
          () => this.readVersion(state.id),
        );

        const stored = await this.db
          .select()
          .from(offerCompensationLine)
          .where(eq(offerCompensationLine.offerId, state.id));
        await this.writeLines(state.id, state.lines, stored);
      }
    } catch (err) {
      throw this.translate(err);
    }

    this.registry.record(state.id, state.version);
    this.collector.collect('Offer', state.id, state.tenantId, aggregate.pullEvents());
  }

  /**
   * Reconcile compensation lines, keyed on `componentCode`.
   *
   * No ordering hazard here — `ux_comp_line_offer_component` is scoped to one
   * offer and codes are not swapped between rows the way an application moves
   * between seats.
   */
  private async writeLines(
    offerId: number,
    desired: readonly CompensationLine[],
    stored: readonly CompensationLineRow[],
  ): Promise<void> {
    const desiredCodes = new Set(desired.map((l) => l.componentCode));
    const removed = stored
      .filter((l) => !desiredCodes.has(l.componentCode))
      .map((l) => l.componentCode);
    if (removed.length > 0) {
      await this.db.delete(offerCompensationLine).where(and(
        eq(offerCompensationLine.offerId, offerId),
        inArray(offerCompensationLine.componentCode, removed),
      ));
    }
    if (desired.length === 0) return;

    await this.db
      .insert(offerCompensationLine)
      .values(desired.map((l) => compensationLineToRow(offerId, l)))
      .onConflictDoUpdate({
        target: [offerCompensationLine.offerId, offerCompensationLine.componentCode],
        set: { amount: sql`excluded.amount` },
      });
  }

  async nextOfferNo(_ctx: AuthContext): Promise<string> {
    const counter = await nextval(this.db, SEQUENCES.offerNo);
    return formatYearlyNumber(this.offerPrefix, this.year(), counter);
  }

  async nextId(_ctx: AuthContext): Promise<number> {
    return nextval(this.db, ID_SEQUENCES.offer);
  }

  /** SENT offers whose expiry has passed — the sweep's input. */
  async findExpirable(now: Date, ctx: AuthContext): Promise<readonly Offer[]> {
    const rows = await this.db
      .select()
      .from(offer)
      .where(and(
        eq(offer.status, 'SENT'),
        isNotNull(offer.expiresAt),
        lte(offer.expiresAt, now),
        this.scope(ctx),
      ))
      .orderBy(offer.id);
    return this.hydrate(rows);
  }

  /** One live offer per application — `isLive` is SENT or ACCEPTED. */
  async findLiveForApplication(applicationId: number, ctx: AuthContext): Promise<Offer | null> {
    const rows = await this.db
      .select()
      .from(offer)
      .where(and(
        eq(offer.applicationId, applicationId),
        inArray(offer.status, [...LIVE_STATUSES]),
        this.scope(ctx),
      ))
      .orderBy(offer.id)
      .limit(1);

    const hydrated = await this.hydrate(rows);
    return hydrated[0] ?? null;
  }

  /**
   * Attach compensation lines in one batched query rather than one per offer.
   *
   * Baselines ARE registered: the expiry sweep loads offers here and saves them
   * straight back, so without a baseline every save would attempt an insert.
   */
  private async hydrate(
    rows: readonly (typeof offer.$inferSelect)[],
  ): Promise<readonly Offer[]> {
    if (rows.length === 0) return [];

    const lines = await this.db
      .select()
      .from(offerCompensationLine)
      .where(inArray(offerCompensationLine.offerId, rows.map((r) => r.id)));

    const byOffer = new Map<number, CompensationLineRow[]>();
    for (const l of lines) {
      const bucket = byOffer.get(l.offerId);
      if (bucket === undefined) byOffer.set(l.offerId, [l]);
      else bucket.push(l);
    }

    return rows.map((row) => {
      this.registry.record(row.id, row.version);
      const props: OfferProps = offerToProps(row, byOffer.get(row.id) ?? []);
      return Offer.fromState(props);
    });
  }

  private scope(ctx: AuthContext): ReturnType<typeof scopedViaRequisition> {
    return scopedViaRequisition(this.db, offer.tenantId, offer.requisitionId, ctx);
  }

  private async readVersion(id: number): Promise<number | null> {
    const rows = await this.db
      .select({ version: offer.version })
      .from(offer)
      .where(eq(offer.id, id))
      .limit(1);
    return rows[0]?.version ?? null;
  }

  private translate(err: unknown): unknown {
    if (isUniqueViolation(err, 'ux_offer_one_live_per_application')) {
      return new ConstraintViolationError(err, 'offer write (more than one live offer)');
    }
    if (isUniqueViolation(err, 'ux_offer_no')) {
      return new ConstraintViolationError(err, 'offer write (duplicate offer number)');
    }
    if (isCheckViolation(err, 'ck_offer_approver')) {
      return new ConstraintViolationError(err, 'offer write (BL-12: approved without an approver)');
    }
    if (isCheckViolation(err, 'ck_offer_template_pinned')) {
      return new ConstraintViolationError(err, 'offer write (half-pinned template)');
    }
    return err;
  }
}
