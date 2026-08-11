// Matching context — physical schema.

import {
  bigint, bigserial, check, index, integer, jsonb, numeric, pgEnum, pgTable,
  text, timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const matchStatusEnum = pgEnum('candidate_match_status', [
  'SUGGESTED', 'DISMISSED', 'LINKED',
]);

export const candidateMatch = pgTable('candidate_match', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),

  // No FKs across context boundaries — Requisition and Candidate belong to
  // other modules, and a suggestion must never be able to block their deletion.
  requisitionId: bigint('requisition_id', { mode: 'number' }).notNull(),
  candidateId: bigint('candidate_id', { mode: 'number' }).notNull(),

  /** 0..1, presentation only. numeric so it round-trips exactly. */
  score: numeric('score', { precision: 4, scale: 3 }).notNull(),
  evidence: jsonb('evidence').notNull().default(sql`'[]'::jsonb`),
  missingRequirements: jsonb('missing_requirements').notNull().default(sql`'[]'::jsonb`),

  /** Opaque: 'candidate.match', 'saved-search', … not an AI enum. */
  source: varchar('source', { length: 80 }).notNull(),
  generation: jsonb('generation'),

  status: matchStatusEnum('status').notNull().default('SUGGESTED'),
  /** Set when a human acts on it — the application the link produced. */
  applicationId: bigint('application_id', { mode: 'number' }),
  resolvedBy: bigint('resolved_by', { mode: 'number' }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  reason: text('reason'),

  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /** One suggestion per pairing. A re-run refreshes rather than duplicates. */
  onePerPair: uniqueIndex('ux_candidate_match_pair').on(t.requisitionId, t.candidateId),
  /** The list query: suggestions for a requisition, best first. */
  byRequisition: index('ix_candidate_match_requisition')
    .on(t.requisitionId, t.status, t.score),
  byCandidate: index('ix_candidate_match_candidate').on(t.tenantId, t.candidateId),

  scoreInRange: check('ck_candidate_match_score', sql`${t.score} >= 0 AND ${t.score} <= 1`),
  /** Only a LINKED suggestion names an application. */
  linkBinding: check(
    'ck_candidate_match_link',
    sql`(${t.status} = 'LINKED') = (${t.applicationId} IS NOT NULL)`,
  ),
}));
