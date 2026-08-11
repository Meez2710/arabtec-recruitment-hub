// Interview context — physical schema.
//
// Panel and assessments live inside the Interview aggregate boundary, so both
// CASCADE from their root. Application/candidate/requisition are referenced by
// id only; interview status is deliberately independent of pipeline stage.

import {
  bigint, bigserial, boolean, check, index, integer, jsonb, pgEnum, pgTable,
  text, timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { hiringApplication } from './hiring';

/* ------------------------------- vocabulary ------------------------------- */
// Mirrors modules/interview/domain/{interview,assessment}.ts.
//
// NOTE the absence of 'RESCHEDULED'. Rescheduling bumps a counter and the
// interview stays SCHEDULED (BL-16) — a rescheduled interview must never drop
// out of "upcoming" and leave a panel unprepared. The drift test asserts this
// enum matches INTERVIEW_STATUSES exactly, so reintroducing it fails loudly.

export const interviewStatusEnum = pgEnum('interview_status', [
  'SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED',
]);

export const interviewModeEnum = pgEnum('interview_mode', ['ONSITE', 'VIDEO', 'PHONE']);

/** The sheet's two signature blocks: HR Interviewer and Technical Interviewer. */
export const evaluatorRoleEnum = pgEnum('evaluator_role', ['RECRUITER', 'HIRING_MANAGER']);

/* -------------------------------- interview ------------------------------- */

export const interview = pgTable('interview', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),

  interviewNo: varchar('interview_no', { length: 40 }).notNull(),

  applicationId: bigint('application_id', { mode: 'number' })
    .notNull()
    .references(() => hiringApplication.id, { onDelete: 'restrict' }),
  candidateId: bigint('candidate_id', { mode: 'number' }).notNull(),
  requisitionId: bigint('requisition_id', { mode: 'number' }).notNull(),

  round: integer('round').notNull(),
  mode: interviewModeEnum('mode').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  locationOrLink: text('location_or_link'),
  organiserUserId: bigint('organiser_user_id', { mode: 'number' }).notNull(),

  status: interviewStatusEnum('status').notNull(),

  /** BL-16 — rescheduling is a counter, never a status. */
  rescheduleCount: integer('reschedule_count').notNull().default(0),
  lastRescheduledAt: timestamp('last_rescheduled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),

  /**
   * Stored from V1 even for internal-only `.ics` invitations, so events created
   * before Google/M365 integration can be bound to real calendar events later.
   */
  externalEventId: varchar('external_event_id', { length: 255 }),

  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  interviewNoUnique: uniqueIndex('ux_interview_no').on(t.tenantId, t.interviewNo),

  // Upcoming interviews, dashboards, and the expiry-style sweeps.
  byStatusStart: index('ix_interview_tenant_status_starts').on(t.tenantId, t.status, t.startsAt),
  // countForApplication — derives the next round number.
  byApplication: index('ix_interview_application').on(t.applicationId),
  byCandidate: index('ix_interview_tenant_candidate').on(t.tenantId, t.candidateId),
  byRequisition: index('ix_interview_tenant_requisition').on(t.tenantId, t.requisitionId),

  roundPositive: check('ck_interview_round', sql`${t.round} >= 1`),
  durationPositive: check('ck_interview_duration', sql`${t.durationMinutes} > 0`),
}));

/* ---------------------------------- panel --------------------------------- */

export const interviewPanel = pgTable('interview_panel', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  interviewId: bigint('interview_id', { mode: 'number' })
    .notNull()
    .references(() => interview.id, { onDelete: 'cascade' }),

  userId: bigint('user_id', { mode: 'number' }).notNull(),
  role: evaluatorRoleEnum('role').notNull(),
  isLead: boolean('is_lead').notNull().default(false),
}, (t) => ({
  memberUnique: uniqueIndex('ux_panel_interview_user').on(t.interviewId, t.userId),

  // findBookedFor — conflict detection joins from the panel side.
  byUser: index('ix_panel_user').on(t.userId),

  /** The aggregate normalises to exactly one lead; this stops storage disagreeing. */
  oneLead: uniqueIndex('ux_panel_one_lead').on(t.interviewId).where(sql`${t.isLead}`),
}));

/* ------------------------------- assessment ------------------------------- */
// One row per evaluator per interview — upserted, not appended, because an
// evaluator may revise their own feedback.

export const interviewAssessment = pgTable('interview_assessment', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  interviewId: bigint('interview_id', { mode: 'number' })
    .notNull()
    .references(() => interview.id, { onDelete: 'cascade' }),

  evaluatorUserId: bigint('evaluator_user_id', { mode: 'number' }).notNull(),
  evaluatorRole: evaluatorRoleEnum('evaluator_role').notNull(),
  /** Denormalised — history must not change when a user is renamed or deactivated. */
  evaluatorName: varchar('evaluator_name', { length: 200 }).notNull(),

  /**
   * criterionKey -> 1..5 | 'NA'. jsonb because the criteria set is configuration
   * (it comes from the assessment sheet) and a column per criterion would make
   * every sheet revision a migration.
   */
  scores: jsonb('scores').notNull().default(sql`'{}'::jsonb`),
  criticalFlags: jsonb('critical_flags').notNull().default(sql`'{}'::jsonb`),

  justification: text('justification').notNull().default(''),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
}, (t) => ({
  oneAssessmentPerEvaluator:
    uniqueIndex('ux_assessment_interview_evaluator').on(t.interviewId, t.evaluatorUserId),
}));
