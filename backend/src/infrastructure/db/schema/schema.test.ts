// Schema guard tests.
//
// Three jobs, all of them things that fail SILENTLY otherwise:
//
//   1. BOUNDARY  — the schema must not import from `modules/`.
//   2. DRIFT     — a pg enum must match its domain constant exactly. Adding a
//                  stage to the domain without a migration is a bug that only
//                  surfaces at runtime, on a write, in production.
//   3. EMISSION  — the generated SQL must actually contain the constraints.
//                  Drizzle silently DROPPED all 8 CHECK constraints when they
//                  were written as raw `sql` blocks in the table extras object;
//                  the schema typechecked and the migration generated cleanly
//                  with none of them present. This test is why that was caught.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import {
  applicationStageEnum, hiringApplication, hiringRequisition, hiringSeat,
  hiringStageHistory, requisitionStateEnum, seatStateEnum, transitionTriggerEnum,
} from './hiring';
import {
  evaluatorRoleEnum, interview, interviewAssessment, interviewModeEnum,
  interviewPanel, interviewStatusEnum,
} from './interview';
import { offer, offerCompensationLine, offerStatusEnum } from './offer';
import { outboxEvent, processedEvent, timelineEntry } from './platform';
import { SEQUENCES } from './index';

import { ALL_STAGES, REQUISITION_STATES } from '../../../modules/hiring/index.js';
import { INTERVIEW_MODES, INTERVIEW_STATUSES } from '../../../modules/interview/index.js';
import { OFFER_STATUSES } from '../../../modules/offer/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = HERE;
const MIGRATIONS_DIR = path.resolve(HERE, '../migrations');

const readSchemaFiles = (): Array<[string, string]> =>
  fs.readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8')]);

const migrationSql = (): string =>
  fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');

/* ------------------------------- 1. BOUNDARY ------------------------------- */

describe('schema boundary', () => {
  it('imports nothing from modules/ — storage never learns the rules', () => {
    for (const [file, source] of readSchemaFiles()) {
      const offenders = source
        .split('\n')
        .filter((l) => /^\s*import\s/.test(l) && /modules\//.test(l));
      expect(offenders, `${file} imports from modules/`).toEqual([]);
    }
  });

  it('contains no business logic — no triggers, functions or generated columns', () => {
    const sql = migrationSql();
    for (const forbidden of ['CREATE TRIGGER', 'CREATE FUNCTION', 'GENERATED ALWAYS AS (']) {
      expect(sql, `migration contains ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/* --------------------------------- 2. DRIFT -------------------------------- */
// The test file may import from modules/ — it is the only place both sides are
// allowed to meet, and its entire purpose is to compare them.

describe('vocabulary drift between enums and the domain', () => {
  it.each([
    ['requisition_state', requisitionStateEnum.enumValues, REQUISITION_STATES],
    ['application_stage', applicationStageEnum.enumValues, ALL_STAGES],
    ['interview_status', interviewStatusEnum.enumValues, INTERVIEW_STATUSES],
    ['interview_mode', interviewModeEnum.enumValues, INTERVIEW_MODES],
    ['offer_status', offerStatusEnum.enumValues, OFFER_STATUSES],
  ])('%s matches its domain constant exactly', (_name, enumValues, domainValues) => {
    expect([...enumValues].sort()).toEqual([...domainValues].sort());
  });

  it('has no RESCHEDULED interview status (BL-16)', () => {
    // Rescheduling bumps a counter; the interview stays SCHEDULED. Reintroducing
    // this value would make rescheduled interviews vanish from every KPI again.
    expect(interviewStatusEnum.enumValues).not.toContain('RESCHEDULED');
  });

  it('declares the seat and trigger vocabularies the aggregates use', () => {
    expect([...seatStateEnum.enumValues].sort()).toEqual(['CANCELLED', 'FILLED', 'OPEN']);
    expect([...transitionTriggerEnum.enumValues].sort()).toEqual(['MANUAL', 'SYSTEM']);
    expect([...evaluatorRoleEnum.enumValues].sort()).toEqual(['HIRING_MANAGER', 'RECRUITER']);
  });
});

/* ------------------------------- 3. EMISSION ------------------------------- */

describe('migration emits the invariant safety net', () => {
  const REQUIRED_CHECKS = [
    'ck_requisition_headcount',
    'ck_seat_filled_binding',      // H3 — FILLED <=> bound to an application
    'ck_interview_round',
    'ck_interview_duration',
    'ck_offer_approver',
    'ck_offer_template_pinned',
    'ck_comp_line_amount',
    'ck_outbox_attempts',
  ];

  const REQUIRED_PARTIAL_UNIQUES = [
    'ux_seat_one_per_application',        // H3 — one application, one seat
    'ux_application_one_live_per_pair',   // BL-26
    'ux_panel_one_lead',
    'ux_offer_one_live_per_application',
  ];

  it.each(REQUIRED_CHECKS)('emits CHECK %s', (name) => {
    expect(migrationSql()).toContain(`CONSTRAINT "${name}" CHECK`);
  });

  it.each(REQUIRED_PARTIAL_UNIQUES)('emits partial UNIQUE INDEX %s with a WHERE clause', (name) => {
    const sql = migrationSql();
    const line = sql.split('\n').find((l) => l.includes(`"${name}"`));
    expect(line, `${name} not found in migration`).toBeDefined();
    expect(line, `${name} is not partial`).toContain('WHERE');
  });

  it('emits every business-number sequence', () => {
    const sql = migrationSql();
    for (const seq of Object.values(SEQUENCES)) {
      expect(sql).toContain(`CREATE SEQUENCE IF NOT EXISTS "${seq}"`);
    }
  });

  it('emits the partial index the outbox dispatcher depends on', () => {
    expect(migrationSql()).toContain('"ix_outbox_pending"');
    expect(migrationSql()).toMatch(/ix_outbox_pending[\s\S]*?WHERE published_at IS NULL/);
  });

  it('seeds the compensation components without encoding any ratio', () => {
    const sql = migrationSql();
    for (const code of ['BASIC_SALARY', 'ACCOMMODATION', 'TRANSPORTATION', 'OTHERS', 'AREA_ALLOWANCE']) {
      expect(sql).toContain(`'${code}'`);
    }
    // No derivation may appear anywhere in the schema.
    expect(sql).not.toMatch(/0\.4|0\.3|\* *2\b/);
  });
});

/* -------------------------- 4. SHAPE / CASCADE RULES ----------------------- */

describe('table shape', () => {
  /** Drizzle's own accessor — reads the column metadata, not the object keys. */
  const columnNames = (t: PgTable): string[] =>
    Object.values(getTableColumns(t)).map((c) => c.name);

  it('gives every business table a tenant_id and a version', () => {
    for (const [label, table] of [
      ['hiring_requisition', hiringRequisition],
      ['hiring_application', hiringApplication],
      ['interview', interview],
      ['offer', offer],
    ] as const) {
      const cols = columnNames(table);
      expect(cols, `${label} missing tenant_id`).toContain('tenant_id');
      expect(cols, `${label} missing version`).toContain('version');
    }
  });

  it('carries every RequisitionProps and Seat field', () => {
    const req = columnNames(hiringRequisition);
    for (const c of ['ticket_no', 'title', 'project_id', 'department_id', 'requester_id',
      'recruiter_id', 'headcount', 'state', 'previous_state', 'created_by', 'close_reason']) {
      expect(req, `hiring_requisition missing ${c}`).toContain(c);
    }
    const seat = columnNames(hiringSeat);
    for (const c of ['requisition_id', 'seat_no', 'state', 'application_id',
      'filled_at', 'cancel_reason']) {
      expect(seat, `hiring_seat missing ${c}`).toContain(c);
    }
  });

  it('carries every ApplicationProps and StageChange field', () => {
    const app = columnNames(hiringApplication);
    for (const c of ['application_no', 'candidate_id', 'requisition_id', 'recruiter_id',
      'stage', 'previous_stage', 'reasons', 'next_action', 'next_action_due_at',
      'last_activity_at']) {
      expect(app, `hiring_application missing ${c}`).toContain(c);
    }
    const hist = columnNames(hiringStageHistory);
    for (const c of ['application_id', 'from_stage', 'to_stage', 'reason', 'trigger',
      'actor_id', 'actor_name', 'moved_at']) {
      expect(hist, `hiring_stage_history missing ${c}`).toContain(c);
    }
  });

  it('carries every InterviewProps, PanelMember and Assessment field', () => {
    const iv = columnNames(interview);
    for (const c of ['interview_no', 'application_id', 'candidate_id', 'requisition_id',
      'round', 'mode', 'starts_at', 'duration_minutes', 'location_or_link',
      'organiser_user_id', 'status', 'reschedule_count', 'last_rescheduled_at',
      'cancel_reason', 'external_event_id']) {
      expect(iv, `interview missing ${c}`).toContain(c);
    }
    for (const c of ['interview_id', 'user_id', 'role', 'is_lead']) {
      expect(columnNames(interviewPanel), `interview_panel missing ${c}`).toContain(c);
    }
    for (const c of ['interview_id', 'evaluator_user_id', 'evaluator_role', 'evaluator_name',
      'scores', 'critical_flags', 'justification', 'submitted_at']) {
      expect(columnNames(interviewAssessment), `interview_assessment missing ${c}`).toContain(c);
    }
  });

  it('carries every OfferProps and CompensationLine field', () => {
    const o = columnNames(offer);
    for (const c of ['offer_no', 'application_id', 'candidate_id', 'requisition_id',
      'position_title', 'currency', 'joining_date', 'status', 'prepared_by', 'approved_by',
      'requires_director_approval', 'sent_at', 'expires_at', 'decided_at', 'reason',
      'template_code', 'template_version', 'variable_snapshot']) {
      expect(o, `offer missing ${c}`).toContain(c);
    }
    for (const c of ['offer_id', 'component_code', 'amount']) {
      expect(columnNames(offerCompensationLine), `offer_compensation_line missing ${c}`).toContain(c);
    }
  });

  it('carries the platform tables the outbox and timeline need', () => {
    for (const c of ['aggregate_type', 'aggregate_id', 'event_type', 'payload',
      'occurred_at', 'published_at', 'attempts', 'next_attempt_at', 'last_error']) {
      expect(columnNames(outboxEvent), `outbox_event missing ${c}`).toContain(c);
    }
    expect(columnNames(processedEvent)).toEqual(
      expect.arrayContaining(['consumer', 'event_id', 'processed_at']),
    );
    // previous_value / new_value are NOT NULL by design — the audit guarantee.
    for (const c of ['entity_type', 'entity_id', 'event_type', 'previous_value', 'new_value']) {
      expect(columnNames(timelineEntry), `timeline_entry missing ${c}`).toContain(c);
    }
  });
});

describe('cascade rules', () => {
  it('CASCADEs only inside an aggregate boundary and RESTRICTs across it', () => {
    const sql = migrationSql();
    const fk = (table: string, column: string): string | undefined =>
      sql.split('\n').find((l) =>
        l.includes(`ALTER TABLE "${table}"`) && l.includes(`("${column}")`));

    // Inside the aggregate — the child has no meaning without its root.
    for (const [table, column] of [
      ['hiring_seat', 'requisition_id'],
      ['hiring_stage_history', 'application_id'],
      ['interview_panel', 'interview_id'],
      ['interview_assessment', 'interview_id'],
      ['offer_compensation_line', 'offer_id'],
    ] as const) {
      expect(fk(table, column), `${table}.${column}`).toContain('ON DELETE cascade');
    }

    // Across a boundary — a delete must never bypass a domain rule.
    for (const [table, column] of [
      ['hiring_seat', 'application_id'],
      ['hiring_application', 'requisition_id'],
      ['interview', 'application_id'],
      ['offer', 'application_id'],
    ] as const) {
      expect(fk(table, column), `${table}.${column}`).toContain('ON DELETE restrict');
    }
  });

  it('has no soft-delete column on any table', () => {
    // There is no delete operation in the business layer. Every removal is a
    // modelled state with a reason and an actor; a second, invisible deletion
    // concept would compete with it and be forgotten in filters.
    expect(migrationSql()).not.toMatch(/"deleted_at"|"is_deleted"/);
  });
});
