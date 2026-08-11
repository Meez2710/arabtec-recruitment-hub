// Platform tables — outbox, consumer bookkeeping, and the audit timeline.
//
// ⚠️ SCOPE NOTE (per instruction, Step 3):
// The outbox TABLE is defined here; the outbox MECHANISM is not implemented and
// no mechanism decision is taken. The two options still open for Step 8 —
// repository-drains vs `tx.collect(events)` — write byte-identical rows to this
// table. Defining the table now therefore pre-commits nothing; it only means
// Step 8 does not also need a migration.

import {
  bigint, bigserial, check, index, integer, jsonb, pgTable,
  text, timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* --------------------------------- outbox --------------------------------- */

export const outboxEvent = pgTable('outbox_event', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),

  aggregateType: varchar('aggregate_type', { length: 60 }).notNull(),
  aggregateId: bigint('aggregate_id', { mode: 'number' }).notNull(),

  /** Matches the event catalogues in each context's domain/events.ts. */
  eventType: varchar('event_type', { length: 80 }).notNull(),
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

  /** Null until delivered. The partial index below makes the backlog scan cheap. */
  publishedAt: timestamp('published_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),

  /** Ties an event back to the request that produced it, across contexts. */
  correlationId: varchar('correlation_id', { length: 80 }),
}, (t) => ({
  /**
   * The dispatcher's only hot query. PARTIAL on unpublished rows so the index
   * stays small no matter how large the table grows — a full index here would
   * be mostly dead weight within a week.
   */
  pending: index('ix_outbox_pending')
    .on(t.nextAttemptAt)
    .where(sql`published_at IS NULL`),

  byAggregate: index('ix_outbox_aggregate').on(t.aggregateType, t.aggregateId),

  attemptsNonNegative: check('ck_outbox_attempts', sql`${t.attempts} >= 0`),
}));

/* ---------------------------- consumer bookkeeping ------------------------- */
// Idempotency ledger. A subscriber INSERTs before acting; a conflict means the
// event was already handled and the work is skipped. This is what makes
// at-least-once delivery safe.

export const processedEvent = pgTable('processed_event', {
  consumer: varchar('consumer', { length: 80 }).notNull(),
  eventId: bigint('event_id', { mode: 'number' }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  once: uniqueIndex('ux_processed_consumer_event').on(t.consumer, t.eventId),
}));

/* -------------------------------- timeline -------------------------------- */
// APPEND-ONLY audit trail. Written by an EventBus subscriber (ADR-0008), never
// by service code.
//
// Immutability is enforced by DATABASE GRANTS, not application discipline: the
// application role holds INSERT and SELECT only. That is the difference between
// an audit trail and a log — the legacy writeAudit() swallowed its own failures,
// so the trail had holes nobody could see.

export const timelineEntry = pgTable('timeline_entry', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),

  entityType: varchar('entity_type', { length: 60 }).notNull(),
  entityId: bigint('entity_id', { mode: 'number' }).notNull(),
  eventType: varchar('event_type', { length: 80 }).notNull(),

  actorId: bigint('actor_id', { mode: 'number' }),
  actorName: varchar('actor_name', { length: 200 }),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

  /**
   * NOT NULL by design. "Records previous value and new value" becomes a schema
   * guarantee rather than a convention each developer has to remember; a change
   * with nothing to say records an empty object, not a missing column.
   */
  previousValue: jsonb('previous_value').notNull().default(sql`'{}'::jsonb`),
  newValue: jsonb('new_value').notNull().default(sql`'{}'::jsonb`),

  ip: varchar('ip', { length: 64 }),
  userAgent: text('user_agent'),
  requestId: varchar('request_id', { length: 80 }),
  correlationId: varchar('correlation_id', { length: 80 }),
}, (t) => ({
  /** The entity timeline read: one query renders any record's full history. */
  byEntity: index('ix_timeline_entity').on(t.tenantId, t.entityType, t.entityId, t.occurredAt),
  byActor: index('ix_timeline_actor').on(t.tenantId, t.actorId, t.occurredAt),
  byOccurred: index('ix_timeline_occurred').on(t.occurredAt),
}));
