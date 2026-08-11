// AI task table.
//
// The DURABLE side of `AITaskDispatcher`. Submitting is a row insert inside the
// caller's transaction, so a task is as durable as the state change that asked
// for it — the same guarantee the outbox gives events, for the same reason.
//
// No model, provider or prompt is named here. `capability` is the routing key
// and `model_id` is whatever the adapter reports after the fact.

import {
  bigint, bigserial, check, index, integer, jsonb, pgEnum, pgTable,
  text, timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const aiTaskStateEnum = pgEnum('ai_task_state', [
  'QUEUED', 'RUNNING', 'SUCCEEDED', 'ABSTAINED', 'FAILED',
]);

export const aiTask = pgTable('ai_task', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),

  /** e.g. 'resume.extract'. Matches AI_CAPABILITIES. */
  capability: varchar('capability', { length: 60 }).notNull(),
  /**
   * Makes submission safe to retry.
   *
   * The outbox delivers at least once and inference is expensive, so a
   * redelivered submit must return the SAME task rather than run a model again.
   */
  idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),

  entityType: varchar('entity_type', { length: 60 }),
  entityId: bigint('entity_id', { mode: 'number' }),

  input: jsonb('input').notNull().default(sql`'{}'::jsonb`),
  state: aiTaskStateEnum('state').notNull().default('QUEUED'),
  priority: varchar('priority', { length: 20 }).notNull().default('STANDARD'),

  /** Reported by the adapter after the fact — never chosen by a caller. */
  modelId: varchar('model_id', { length: 120 }),
  promptVersionId: varchar('prompt_version_id', { length: 120 }),
  /** The proposal it produced, when it produced one. */
  proposalId: bigint('proposal_id', { mode: 'number' }),

  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  /** Why the capability declined. An abstention is a normal outcome, not a failure. */
  abstainReason: text('abstain_reason'),

  correlationId: varchar('correlation_id', { length: 80 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  oncePerKey: uniqueIndex('ux_ai_task_idempotency').on(t.tenantId, t.idempotencyKey),
  /** The worker's only hot query. Partial, so it stays small forever. */
  claimable: index('ix_ai_task_claimable')
    .on(t.nextAttemptAt)
    .where(sql`state = 'QUEUED'`),
  byEntity: index('ix_ai_task_entity').on(t.tenantId, t.entityType, t.entityId, t.createdAt),
  attemptsNonNegative: check('ck_ai_task_attempts', sql`${t.attempts} >= 0`),
}));
