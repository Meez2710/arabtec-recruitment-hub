// Hiring context — physical schema.
//
// TABLE DEFINITIONS ONLY. No business logic, no triggers, no computed columns.
// This file imports NOTHING from `modules/` (enforced by boundary.test.ts), so
// the vocabulary below is duplicated from the domain by necessity — and
// `vocabulary.test.ts` asserts the two never drift.
//
// Every column here traces to a field on RequisitionProps / Seat /
// ApplicationProps / StageChange. `schema-shape.test.ts` proves the mapping is
// total in both directions.

import {
  bigint, bigserial, check, index, integer, jsonb, pgEnum, pgTable,
  text, timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* ------------------------------- vocabulary ------------------------------- */
// Mirrors modules/hiring/domain/{requisition-states,stages}.ts.
// Adding a value here without adding it there (or vice versa) fails the drift test.

export const requisitionStateEnum = pgEnum('requisition_state', [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'OPEN',
  'ON_HOLD', 'CLOSED', 'CANCELLED', 'REJECTED',
]);

export const seatStateEnum = pgEnum('seat_state', ['OPEN', 'FILLED', 'CANCELLED']);

export const applicationStageEnum = pgEnum('application_stage', [
  // pipeline
  'SOURCED', 'MATCHED', 'INTERVIEWING', 'OFFER_PREPARATION', 'OFFER_SENT', 'HIRED',
  // non-pipeline
  'NOT_SUITABLE', 'ON_HOLD', 'REJECTED', 'WITHDRAWN', 'OFFER_DECLINED',
]);

export const transitionTriggerEnum = pgEnum('transition_trigger', ['MANUAL', 'SYSTEM']);

/* ------------------------------- requisition ------------------------------ */

export const hiringRequisition = pgTable('hiring_requisition', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  // Present from day one, single-valued until customer #2. RLS policies are
  // written in the migration but NOT enabled (ADR-0005, Document 2 §3).
  tenantId: integer('tenant_id').notNull().default(1),

  ticketNo: varchar('ticket_no', { length: 40 }).notNull(),
  title: varchar('title', { length: 200 }).notNull(),

  // Cross-context references. No FK — Project and Department live in the
  // Organization context, which does not exist yet. Adding the FK later is a
  // migration, not a redesign.
  projectId: bigint('project_id', { mode: 'number' }).notNull(),
  departmentId: bigint('department_id', { mode: 'number' }).notNull(),

  requesterId: bigint('requester_id', { mode: 'number' }).notNull(),
  recruiterId: bigint('recruiter_id', { mode: 'number' }),
  createdBy: bigint('created_by', { mode: 'number' }).notNull(),

  headcount: integer('headcount').notNull(),
  state: requisitionStateEnum('state').notNull(),
  /** Restored verbatim by resume() — the state the hold interrupted. */
  previousState: requisitionStateEnum('previous_state'),
  closeReason: varchar('close_reason', { length: 40 }),

  /** Optimistic concurrency. Bumped by the aggregate, checked in the UPDATE. */
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ticketNoUnique: uniqueIndex('ux_requisition_ticket_no').on(t.tenantId, t.ticketNo),

  // Serves the requisitions list and the status counts.
  byState: index('ix_requisition_tenant_state').on(t.tenantId, t.state),
  // My Work: "requisitions at risk" and the recruiter's own board.
  byRecruiter: index('ix_requisition_tenant_recruiter_state')
    .on(t.tenantId, t.recruiterId, t.state),
  // Project scoping predicate (AuthContext.canAccessProject).
  byProject: index('ix_requisition_tenant_project').on(t.tenantId, t.projectId),
  byRequester: index('ix_requisition_tenant_requester').on(t.tenantId, t.requesterId),

  headcountPositive: check('ck_requisition_headcount', sql`${t.headcount} >= 1`),
}));

/* ---------------------------------- seat ---------------------------------- */
// Seats live INSIDE the Requisition aggregate boundary. There is no seat
// repository and there will not be one; they are loaded and saved with their
// root. CASCADE is safe precisely because of that (ADR: cascade only inside an
// aggregate).

export const hiringSeat = pgTable('hiring_seat', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  requisitionId: bigint('requisition_id', { mode: 'number' })
    .notNull()
    .references(() => hiringRequisition.id, { onDelete: 'cascade' }),

  seatNo: integer('seat_no').notNull(),
  state: seatStateEnum('state').notNull(),

  // RESTRICT: a filled seat must be released through the domain, never orphaned
  // by deleting the application out from under it.
  applicationId: bigint('application_id', { mode: 'number' })
    .references(() => hiringApplication.id, { onDelete: 'restrict' }),

  filledAt: timestamp('filled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  seatNoUnique: uniqueIndex('ux_seat_requisition_seat_no').on(t.requisitionId, t.seatNo),

  // Fill counts and the open-seat probe.
  byRequisitionState: index('ix_seat_requisition_state').on(t.requisitionId, t.state),

  // H3, half one: FILLED <=> bound to an application.
  filledBinding: check(
    'ck_seat_filled_binding',
    sql`(${t.state} = 'FILLED') = (${t.applicationId} IS NOT NULL)`,
  ),
  // H3, half two: one application cannot occupy two seats. PARTIAL unique index
  // (not a constraint) — a released seat sets application_id back to NULL, and
  // partial excludes those rows entirely rather than relying on NULL semantics.
  oneSeatPerApplication: uniqueIndex('ux_seat_one_per_application')
    .on(t.applicationId)
    .where(sql`${t.applicationId} IS NOT NULL`),
}));

/* ------------------------------- application ------------------------------ */

export const hiringApplication = pgTable('hiring_application', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),

  applicationNo: varchar('application_no', { length: 40 }).notNull(),

  // Candidate lives in the Talent context, which does not exist yet. No FK.
  candidateId: bigint('candidate_id', { mode: 'number' }).notNull(),

  // RESTRICT across the aggregate boundary — never orphan a pipeline.
  requisitionId: bigint('requisition_id', { mode: 'number' })
    .notNull()
    .references(() => hiringRequisition.id, { onDelete: 'restrict' }),

  recruiterId: bigint('recruiter_id', { mode: 'number' }),

  stage: applicationStageEnum('stage').notNull(),
  /** Restored by resume() — the stage the hold interrupted. */
  previousStage: applicationStageEnum('previous_stage'),

  /**
   * Keyed bag of reasons (rejectionReason, withdrawalReason, …). jsonb because
   * it is written and read whole and never queried by key. If a key ever needs
   * an index, it gets promoted to a column.
   */
  reasons: jsonb('reasons').notNull().default(sql`'{}'::jsonb`),

  nextAction: text('next_action'),
  nextActionDueAt: timestamp('next_action_due_at', { withTimezone: true }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),

  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  applicationNoUnique: uniqueIndex('ux_application_no').on(t.tenantId, t.applicationNo),

  // The board: applications for one requisition, grouped by stage.
  byRequisitionStage: index('ix_application_tenant_requisition_stage')
    .on(t.tenantId, t.requisitionId, t.stage),

  // H5 — findActiveHireForCandidate. The hottest correctness query in the system.
  byCandidateStage: index('ix_application_candidate_stage').on(t.candidateId, t.stage),

  // My Work: due & overdue.
  byRecruiterDue: index('ix_application_tenant_recruiter_due')
    .on(t.tenantId, t.recruiterId, t.nextActionDueAt),

  // My Work: stalled candidates.
  byStageActivity: index('ix_application_tenant_stage_activity')
    .on(t.tenantId, t.stage, t.lastActivityAt),

  /**
   * BL-26 — one LIVE application per (candidate, requisition). A candidate may
   * re-apply after a terminal outcome, which is why this is partial.
   */
  oneLivePerPair: uniqueIndex('ux_application_one_live_per_pair')
    .on(t.tenantId, t.candidateId, t.requisitionId)
    .where(sql`${t.stage} NOT IN ('HIRED','REJECTED','WITHDRAWN','OFFER_DECLINED')`),
}));

/* ------------------------------ stage history ----------------------------- */
// APPEND-ONLY. The repository inserts the tail; nothing updates or deletes a row.
// Application-level grants withhold UPDATE and DELETE on this table.

export const hiringStageHistory = pgTable('hiring_stage_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  applicationId: bigint('application_id', { mode: 'number' })
    .notNull()
    .references(() => hiringApplication.id, { onDelete: 'cascade' }),

  /** Null on the opening entry — the application was created, not moved. */
  fromStage: applicationStageEnum('from_stage'),
  toStage: applicationStageEnum('to_stage').notNull(),
  reason: text('reason'),
  trigger: transitionTriggerEnum('trigger').notNull(),

  /** Denormalised name: the actor may be deactivated later; history must not change. */
  actorId: bigint('actor_id', { mode: 'number' }),
  actorName: varchar('actor_name', { length: 200 }),

  movedAt: timestamp('moved_at', { withTimezone: true }).notNull(),
}, (t) => ({
  // Timeline read, and the tail-insert count.
  byApplication: index('ix_stage_history_application_moved').on(t.applicationId, t.movedAt),
}));
