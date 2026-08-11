// Transactional outbox — the write side (Step 8, Option A).
//
// WHY AN OUTBOX AT ALL
//
// Without one there are exactly two orderings and both are wrong:
//
//   commit, then publish  -> the process can die in between, and the event is
//                            lost forever. Audit rows and notifications silently
//                            never happen.
//   publish, then commit  -> the transaction can roll back after publishing, and
//                            subscribers act on a state that does not exist.
//
// The outbox removes the choice. Events are written to `outbox_event` INSIDE the
// same transaction as the state change, so they commit or vanish together. A
// relay then delivers them. Delivery is at-least-once; subscribers deduplicate
// through the `processed_event` ledger, which is what turns at-least-once
// delivery into exactly-once PROCESSING.
//
// HOW EVENTS GET HERE WITHOUT TOUCHING THE BUSINESS LAYER
//
// `pullEvents()` is destructive (`splice`) and it is the ONLY accessor — the
// `events` array is private. Services call it AFTER `save()`. So a repository
// that pulls during `save()` necessarily takes the events away from the service,
// and the service's own post-commit `publish([])` becomes a harmless no-op.
//
// That is not a regression, it is the point: publishing both in-process AND from
// the relay would deliver everything twice. The Unit of Work publishes after
// commit in the service's place, through the same EventBus, so the observable
// behaviour is unchanged and nothing in `domain/` or `application/` was edited.
// `outbox.test.ts` and `event-flow.test.ts` assert exactly that end to end.

import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { outboxEvent } from './schema/index.js';
import type { Executor } from './types.js';
import type { DomainEvent } from '../../modules/shared/kernel/domain.js';

/**
 * An event plus the routing facts only the repository knows.
 *
 * `aggregateType` and `aggregateId` are NOT derived from the payload. A
 * repository knows which aggregate it just wrote; inferring it from payload keys
 * would be a guess that breaks the first time an event carries two ids.
 */
export interface OutboxRecord {
  readonly tenantId: number;
  readonly aggregateType: string;
  readonly aggregateId: number;
  readonly event: DomainEvent;
}

/** A stored event, with the identity the idempotency ledger keys on. */
export interface EventEnvelope {
  /** `outbox_event.id`. Null only for events that were never written (see below). */
  readonly id: number | null;
  readonly tenantId: number;
  readonly aggregateType: string;
  readonly aggregateId: number;
  readonly event: DomainEvent;
  readonly correlationId: string | null;
}

/**
 * Per-transaction buffer.
 *
 * Repositories append here as they save; the Unit of Work flushes once, just
 * before commit. Buffering rather than writing per-save gives one INSERT instead
 * of N, and — more importantly — preserves a single deterministic order across
 * every aggregate touched by the transaction.
 *
 * Lifetime is one transaction. A retried transaction gets a fresh collector, so
 * a rolled-back attempt cannot leak its events into the next one.
 */
export class TransactionEventCollector {
  private readonly buffer: OutboxRecord[] = [];

  collect(
    aggregateType: string,
    aggregateId: number,
    tenantId: number,
    events: readonly DomainEvent[],
  ): void {
    for (const event of events) {
      this.buffer.push({ tenantId, aggregateType, aggregateId, event });
    }
  }

  get records(): readonly OutboxRecord[] {
    return this.buffer;
  }

  get isEmpty(): boolean {
    return this.buffer.length === 0;
  }
}

/**
 * Write the buffered events, in order, and return them with their assigned ids.
 *
 * MUST be called on the transaction handle. Called on the root handle it would
 * commit independently of the state change and reintroduce the very split this
 * whole mechanism exists to close.
 */
export const writeOutbox = async (
  tx: Executor,
  records: readonly OutboxRecord[],
  correlationId: string | null = null,
): Promise<readonly EventEnvelope[]> => {
  if (records.length === 0) return [];

  const inserted = await tx
    .insert(outboxEvent)
    .values(records.map((r) => ({
      tenantId: r.tenantId,
      aggregateType: r.aggregateType,
      aggregateId: r.aggregateId,
      eventType: r.event.type,
      payload: r.event.payload,
      occurredAt: r.event.at,
      correlationId,
    })))
    .returning({ id: outboxEvent.id });

  // `RETURNING` preserves VALUES order in PostgreSQL for a single INSERT, so the
  // zip below is positional and safe. Asserting the length makes that assumption
  // fail loudly rather than misattribute an id if it ever stops holding.
  if (inserted.length !== records.length) {
    throw new Error(
      `Outbox write returned ${inserted.length} ids for ${records.length} events.`,
    );
  }

  return records.map((r, i) => ({
    id: inserted[i]!.id,
    tenantId: r.tenantId,
    aggregateType: r.aggregateType,
    aggregateId: r.aggregateId,
    event: r.event,
    correlationId,
  }));
};

/** Mark rows delivered. Idempotent — re-marking a published row is a no-op. */
export const markPublished = async (
  db: Executor,
  ids: readonly number[],
  now: Date,
): Promise<number> => {
  if (ids.length === 0) return 0;
  const updated = await db
    .update(outboxEvent)
    .set({ publishedAt: now })
    .where(and(inArray(outboxEvent.id, [...ids]), isNull(outboxEvent.publishedAt)))
    .returning({ id: outboxEvent.id });
  return updated.length;
};

/**
 * Claim a batch of undelivered events for this worker.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes more than one dispatcher safe: a row
 * already claimed by another worker is skipped rather than waited on, so two
 * dispatchers share the backlog instead of serialising behind each other — and
 * neither can deliver the same row twice inside its claim.
 *
 * `ORDER BY id` is the total order. `outbox_event.id` is a bigserial assigned in
 * the INSERT's VALUES order, which is the collection order, which is the order
 * the aggregates recorded the events in.
 */
export const claimPending = async (
  tx: Executor,
  opts: { limit: number; now: Date },
): Promise<readonly EventEnvelope[]> => {
  const rows = await tx
    .select()
    .from(outboxEvent)
    .where(and(
      isNull(outboxEvent.publishedAt),
      lte(outboxEvent.nextAttemptAt, opts.now),
    ))
    .orderBy(asc(outboxEvent.id))
    .limit(opts.limit)
    .for('update', { skipLocked: true });

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    correlationId: row.correlationId,
    event: {
      type: row.eventType,
      at: row.occurredAt,
      payload: (row.payload ?? {}) as Record<string, unknown>,
    },
  }));
};

/**
 * Record a delivery failure and schedule the retry.
 *
 * The row stays unpublished, so it is retried — forever, by design. An event
 * that cannot be delivered is a visible backlog with a `last_error` on it, not a
 * silently dropped audit record. The legacy `notify.js` swallowed every failure
 * with `.catch(() => {})`, which is how email could be broken for every user
 * indefinitely with no signal at all.
 */
export const recordFailure = async (
  db: Executor,
  id: number,
  error: unknown,
  opts: { now: Date; baseDelayMs: number; maxDelayMs: number },
): Promise<void> => {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(outboxEvent)
    .set({
      attempts: sql`${outboxEvent.attempts} + 1`,
      lastError: message.slice(0, 2_000),
      // Exponential in the attempt count already stored, capped. Computed in SQL
      // so it reads the authoritative value rather than a possibly stale one.
      nextAttemptAt: sql`${opts.now}::timestamptz + least(
        ${opts.baseDelayMs} * power(2, ${outboxEvent.attempts}),
        ${opts.maxDelayMs}
      ) * interval '1 millisecond'`,
    })
    .where(eq(outboxEvent.id, id));
};

/** Operational counters. Used by the health check and the Step-12 benchmarks. */
export const outboxBacklog = async (
  db: Executor,
  now: Date,
): Promise<{ pending: number; due: number; failing: number }> => {
  const rows = await db
    .select({
      pending: sql<number>`count(*) filter (where ${outboxEvent.publishedAt} is null)::int`,
      due: sql<number>`count(*) filter (
        where ${outboxEvent.publishedAt} is null and ${outboxEvent.nextAttemptAt} <= ${now}
      )::int`,
      failing: sql<number>`count(*) filter (
        where ${outboxEvent.publishedAt} is null and ${outboxEvent.attempts} > 0
      )::int`,
    })
    .from(outboxEvent);

  return rows[0] ?? { pending: 0, due: 0, failing: 0 };
};
