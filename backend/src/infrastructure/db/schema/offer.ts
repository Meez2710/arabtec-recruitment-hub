// Offer context — physical schema.
//
// Compensation is manual entry over CONFIGURABLE components. There is no
// derivation, no ratio, and no computed total — `totalNet` is a sum the
// aggregate performs. The 40/30/30 pattern observed in three sample letters was
// explicitly rejected as company policy, so nothing here encodes it.

import {
  bigint, bigserial, boolean, check, index, integer, jsonb, numeric, pgEnum, pgTable,
  text, timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { hiringApplication } from './hiring';

/* ------------------------------- vocabulary ------------------------------- */

export const offerStatusEnum = pgEnum('offer_status', [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT',
  'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN', 'REJECTED_BY_APPROVER',
]);

/* ---------------------------------- offer --------------------------------- */

export const offer = pgTable('offer', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),

  offerNo: varchar('offer_no', { length: 40 }).notNull(),

  applicationId: bigint('application_id', { mode: 'number' })
    .notNull()
    .references(() => hiringApplication.id, { onDelete: 'restrict' }),
  candidateId: bigint('candidate_id', { mode: 'number' }).notNull(),
  requisitionId: bigint('requisition_id', { mode: 'number' }).notNull(),

  positionTitle: varchar('position_title', { length: 200 }).notNull(),
  /** ISO 4217. The letters are EGP; the field is not assumed to be. */
  currency: varchar('currency', { length: 3 }).notNull(),
  joiningDate: timestamp('joining_date', { withTimezone: true }),

  status: offerStatusEnum('status').notNull(),

  preparedBy: bigint('prepared_by', { mode: 'number' }).notNull(),
  /** BL-12 — never equal to preparedBy; the aggregate refuses self-approval. */
  approvedBy: bigint('approved_by', { mode: 'number' }),
  /**
   * BL-11 — computed at submit and FROZEN. If the configured threshold could not
   * be parsed the aggregate sets this true (fails closed), and storing the
   * decision means a later config change cannot retroactively weaken an
   * approval that already happened.
   */
  requiresDirectorApproval: boolean('requires_director_approval').notNull().default(false),

  sentAt: timestamp('sent_at', { withTimezone: true }),
  /** sentAt + validity days. The letters state "valid for 5 days". */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  reason: text('reason'),

  /**
   * Pinned at issue. A 2026 offer reprinted in 2028 must reproduce the 2026
   * document, which is impossible if variables are re-resolved at render time.
   */
  templateCode: varchar('template_code', { length: 60 }),
  templateVersion: integer('template_version'),
  variableSnapshot: jsonb('variable_snapshot'),

  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  offerNoUnique: uniqueIndex('ux_offer_no').on(t.tenantId, t.offerNo),

  // findExpirable — the sweep's driving query.
  byStatusExpiry: index('ix_offer_tenant_status_expires').on(t.tenantId, t.status, t.expiresAt),
  // findLiveForApplication, and the close-block gateway.
  byApplicationStatus: index('ix_offer_application_status').on(t.applicationId, t.status),
  byCandidate: index('ix_offer_tenant_candidate').on(t.tenantId, t.candidateId),
  byRequisition: index('ix_offer_tenant_requisition').on(t.tenantId, t.requisitionId),

  /** One live offer per application — replaces a read-then-write race. */
  oneLivePerApplication: uniqueIndex('ux_offer_one_live_per_application')
    .on(t.applicationId)
    .where(sql`${t.status} IN ('SENT','ACCEPTED')`),

  /** An approved offer must name its approver. */
  approverPresent: check(
    'ck_offer_approver',
    sql`${t.status} <> 'APPROVED' OR ${t.approvedBy} IS NOT NULL`,
  ),
  /** Template pinning is all-or-nothing — a half-pinned offer cannot be reprinted. */
  templatePinned: check(
    'ck_offer_template_pinned',
    sql`(${t.templateCode} IS NULL) = (${t.templateVersion} IS NULL)`,
  ),
}));

/* --------------------------- compensation line ---------------------------- */

export const offerCompensationLine = pgTable('offer_compensation_line', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  offerId: bigint('offer_id', { mode: 'number' })
    .notNull()
    .references(() => offer.id, { onDelete: 'cascade' }),

  /** Soft reference to the component catalogue — see the note on that table. */
  componentCode: varchar('component_code', { length: 60 }).notNull(),
  /** numeric, never float. Money is exact. Mapper converts string <-> number. */
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
}, (t) => ({
  oneLinePerComponent: uniqueIndex('ux_comp_line_offer_component').on(t.offerId, t.componentCode),
  amountNonNegative: check('ck_comp_line_amount', sql`${t.amount} >= 0`),
}));

/* -------------------- compensation component (config) --------------------- */
// CONFIGURATION, not an aggregate. Admin-editable, seeded from the real letters.
//
// Deliberately NOT a foreign key from offer_compensation_line: deactivating or
// renaming a component must never rewrite a historical offer. `active` governs
// what may be used going forward; issued offers keep the code they were issued
// with. This is the one place the "no soft delete" rule has an exception, and
// this is why.

export const offerCompensationComponent = pgTable('offer_compensation_component', {
  code: varchar('code', { length: 60 }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),
  labelEn: varchar('label_en', { length: 120 }).notNull(),
  labelAr: varchar('label_ar', { length: 120 }),
  displayOrder: integer('display_order').notNull().default(0),
  /** Binds a conditional footnote in the letter template (e.g. Area Allowance). */
  footnoteKey: varchar('footnote_key', { length: 60 }),
  active: boolean('active').notNull().default(true),
}, (t) => ({
  byTenantOrder: index('ix_comp_component_tenant_order')
    .on(t.tenantId, t.active, t.displayOrder),
}));
