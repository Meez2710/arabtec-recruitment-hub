// Talent context — physical schema. Table definitions only.

import {
  bigint, bigserial, check, index, integer, jsonb, numeric, pgEnum, pgTable,
  text, timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* ------------------------------- vocabulary ------------------------------- */

export const candidateStateEnum = pgEnum('candidate_state', [
  'ACTIVE', 'DO_NOT_CONTACT', 'BLACKLISTED', 'MERGED', 'ERASED',
]);

export const documentTypeEnum = pgEnum('candidate_document_type', [
  'CV', 'CERTIFICATE', 'PORTFOLIO', 'ATTACHMENT',
]);

export const proposalStatusEnum = pgEnum('candidate_proposal_status', [
  'PENDING', 'APPLIED', 'REJECTED', 'SUPERSEDED',
]);

export const intakeBatchStatusEnum = pgEnum('cv_intake_batch_status', [
  'OPEN', 'COMPLETED', 'CANCELLED',
]);

export const intakeItemStatusEnum = pgEnum('cv_intake_item_status', [
  'PENDING_PARSE', 'PARSED', 'PARSE_FAILED', 'CONVERTED', 'DISCARDED',
]);

/* -------------------------------- candidate -------------------------------- */

export const candidate = pgTable('candidate', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),

  candidateNo: varchar('candidate_no', { length: 40 }).notNull(),

  fullName: varchar('full_name', { length: 200 }).notNull(),
  email: varchar('email', { length: 320 }),
  phone: varchar('phone', { length: 40 }),
  nationality: varchar('nationality', { length: 100 }),
  location: varchar('location', { length: 200 }),
  linkedinUrl: varchar('linkedin_url', { length: 500 }),

  currentCompany: varchar('current_company', { length: 200 }),
  currentPosition: varchar('current_position', { length: 200 }),
  /** numeric, not float: "3.5 years" must round-trip exactly. */
  yearsExperience: numeric('years_experience', { precision: 4, scale: 1 }),
  noticePeriod: varchar('notice_period', { length: 100 }),

  university: varchar('university', { length: 200 }),
  major: varchar('major', { length: 200 }),
  graduationYear: integer('graduation_year'),

  skills: jsonb('skills').notNull().default(sql`'[]'::jsonb`),
  languages: jsonb('languages').notNull().default(sql`'[]'::jsonb`),
  certifications: jsonb('certifications').notNull().default(sql`'[]'::jsonb`),
  tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`),

  source: varchar('source', { length: 100 }),
  ownerRecruiterId: bigint('owner_recruiter_id', { mode: 'number' }),
  state: candidateStateEnum('state').notNull().default('ACTIVE'),

  /**
   * field -> { source, at, actorId, taskId?, modelId? }.
   *
   * jsonb because the key set is the candidate's field set, which changes with
   * the product. A column per field would double the table and still need a
   * migration for every new attribute.
   */
  provenance: jsonb('provenance').notNull().default(sql`'{}'::jsonb`),

  /**
   * Normalised copies for duplicate DETECTION. Never used for identity, and
   * deliberately not unique — two people share a family email more often than
   * anyone expects, and blocking the second one loses a real candidate.
   */
  dedupEmail: varchar('dedup_email', { length: 320 }),
  dedupPhone: varchar('dedup_phone', { length: 40 }),
  dedupLinkedin: varchar('dedup_linkedin', { length: 500 }),

  /**
   * Denormalised text for full-text search, maintained by the MAPPER.
   *
   * Not a generated column: those are database-side computation, and this
   * codebase keeps derivation in one place. Writing it in the mapper also means
   * the recipe (which fields, what order) is visible in TypeScript next to the
   * fields it draws on, rather than buried in a migration nobody re-reads.
   */
  searchText: text('search_text').notNull().default(''),

  createdBy: bigint('created_by', { mode: 'number' }).notNull(),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  candidateNoUnique: uniqueIndex('ux_candidate_no').on(t.tenantId, t.candidateNo),

  byState: index('ix_candidate_tenant_state').on(t.tenantId, t.state),
  byOwner: index('ix_candidate_tenant_owner').on(t.tenantId, t.ownerRecruiterId),
  // The three duplicate probes.
  byDedupEmail: index('ix_candidate_dedup_email').on(t.tenantId, t.dedupEmail),
  byDedupPhone: index('ix_candidate_dedup_phone').on(t.tenantId, t.dedupPhone),
  byDedupLinkedin: index('ix_candidate_dedup_linkedin').on(t.tenantId, t.dedupLinkedin),
  byCreated: index('ix_candidate_tenant_created').on(t.tenantId, t.createdAt),

  /** A working record must be reachable. An erased one has been redacted. */
  contactPresent: check(
    'ck_candidate_contact',
    sql`${t.state} = 'ERASED' OR ${t.email} IS NOT NULL OR ${t.phone} IS NOT NULL`,
  ),
  experienceSane: check(
    'ck_candidate_experience',
    sql`${t.yearsExperience} IS NULL OR (${t.yearsExperience} >= 0 AND ${t.yearsExperience} <= 70)`,
  ),
}));

/* ---------------------------- candidate document --------------------------- */
// Inside the Candidate aggregate boundary, so CASCADE is correct. Metadata only
// — bytes live in the DocumentStore, keyed by `file_hash`.

export const candidateDocument = pgTable('candidate_document', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  candidateId: bigint('candidate_id', { mode: 'number' })
    .notNull()
    .references(() => candidate.id, { onDelete: 'cascade' }),

  documentId: varchar('document_id', { length: 80 }).notNull(),
  docType: documentTypeEnum('doc_type').notNull(),
  fileName: varchar('file_name', { length: 300 }).notNull(),
  /** Content hash — the dedup key AND the storage key. */
  fileHash: varchar('file_hash', { length: 128 }).notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull(),
  mimeType: varchar('mime_type', { length: 200 }).notNull(),
  note: text('note'),

  uploadedBy: bigint('uploaded_by', { mode: 'number' }),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull(),
}, (t) => ({
  /** Dedup by CONTENT: `cv.pdf` and `cv (1).pdf` with the same bytes are one. */
  oneHashPerCandidate: uniqueIndex('ux_candidate_document_hash')
    .on(t.candidateId, t.fileHash),
  idPerCandidate: uniqueIndex('ux_candidate_document_id').on(t.candidateId, t.documentId),
  /** "Who else has this exact CV?" — the cross-candidate duplicate probe. */
  byHash: index('ix_candidate_document_hash').on(t.fileHash),
  byCandidateType: index('ix_candidate_document_type').on(t.candidateId, t.docType),
  sizePositive: check('ck_candidate_document_size', sql`${t.fileSize} >= 0`),
}));

/* ---------------------------- candidate proposal --------------------------- */
// Suggested values awaiting a human. NOT AI-specific: `origin` is free text, so
// a bulk import raises proposals through the same review workflow.

export const candidateProposal = pgTable('candidate_proposal', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),

  candidateId: bigint('candidate_id', { mode: 'number' })
    .notNull()
    .references(() => candidate.id, { onDelete: 'cascade' }),

  origin: varchar('origin', { length: 80 }).notNull(),
  /** Opaque producer correlation. Empty string when a human produced it. */
  taskId: varchar('task_id', { length: 120 }).notNull().default(''),
  modelId: varchar('model_id', { length: 120 }).notNull().default(''),
  documentId: varchar('document_id', { length: 80 }),

  status: proposalStatusEnum('status').notNull().default('PENDING'),
  /**
   * Reproduction metadata: capability, model, prompt version, document hash,
   * parser and extractor versions, generation time.
   *
   * jsonb rather than seven columns — it is read and written whole, never
   * queried by key, and a model upgrade should not need a migration. Null for
   * proposals a human or an import produced.
   */
  generation: jsonb('generation'),
  /** [{ field, value, confidence, evidence, decision }] — read and written whole. */
  fields: jsonb('fields').notNull().default(sql`'[]'::jsonb`),

  reviewedBy: bigint('reviewed_by', { mode: 'number' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /**
   * At most one PENDING proposal per candidate.
   *
   * Two live proposals would leave a reviewer unable to tell which reflects the
   * current document. The service supersedes the old one; this makes that a
   * guarantee rather than a convention.
   */
  onePendingPerCandidate: uniqueIndex('ux_candidate_proposal_pending')
    .on(t.candidateId)
    .where(sql`${t.status} = 'PENDING'`),

  byCandidate: index('ix_candidate_proposal_candidate').on(t.candidateId, t.createdAt),
  byStatus: index('ix_candidate_proposal_tenant_status').on(t.tenantId, t.status),
  reviewerPresent: check(
    'ck_candidate_proposal_reviewer',
    sql`${t.status} IN ('PENDING','SUPERSEDED') OR ${t.reviewedBy} IS NOT NULL`,
  ),
}));

/* ------------------------------- CV intake -------------------------------- */
// Staging for bulk upload. Files land here with NO candidate, because a
// Candidate needs a name and a contact channel and a PDF supplies neither until
// it has been parsed and read by a person.

export const cvIntakeBatch = pgTable('cv_intake_batch', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: integer('tenant_id').notNull().default(1),

  label: varchar('label', { length: 200 }).notNull(),
  status: intakeBatchStatusEnum('status').notNull().default('OPEN'),
  uploadedBy: bigint('uploaded_by', { mode: 'number' }).notNull(),

  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byStatus: index('ix_cv_intake_batch_tenant_status').on(t.tenantId, t.status, t.createdAt),
  byUploader: index('ix_cv_intake_batch_uploader').on(t.tenantId, t.uploadedBy),
}));

export const cvIntakeItem = pgTable('cv_intake_item', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  batchId: bigint('batch_id', { mode: 'number' })
    .notNull()
    .references(() => cvIntakeBatch.id, { onDelete: 'cascade' }),

  itemId: varchar('item_id', { length: 80 }).notNull(),
  fileName: varchar('file_name', { length: 300 }).notNull(),
  fileHash: varchar('file_hash', { length: 128 }).notNull(),
  mimeType: varchar('mime_type', { length: 200 }).notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull(),

  status: intakeItemStatusEnum('status').notNull().default('PENDING_PARSE'),
  /** [{ field, value, confidence, evidence }] — what the parser suggested. */
  extracted: jsonb('extracted').notNull().default(sql`'[]'::jsonb`),
  /** Same reproduction metadata a proposal carries. Null until parsed. */
  generation: jsonb('generation'),

  /**
   * RESTRICT, not CASCADE: deleting a batch must never take a real candidate
   * with it. The intake record is scaffolding; the candidate is the product.
   */
  candidateId: bigint('candidate_id', { mode: 'number' })
    .references(() => candidate.id, { onDelete: 'restrict' }),
  note: text('note'),
}, (t) => ({
  /** One item per file, per batch. Dedup within a batch is by content. */
  oneItemPerHash: uniqueIndex('ux_cv_intake_item_hash').on(t.batchId, t.fileHash),
  idPerBatch: uniqueIndex('ux_cv_intake_item_id').on(t.batchId, t.itemId),
  byBatchStatus: index('ix_cv_intake_item_batch_status').on(t.batchId, t.status),
  /** Cross-batch: "has this exact CV been uploaded before?" */
  byHash: index('ix_cv_intake_item_hash').on(t.fileHash),
  sizePositive: check('ck_cv_intake_item_size', sql`${t.fileSize} >= 0`),
  /** A converted item must name its candidate; nothing else may. */
  convertedBinding: check(
    'ck_cv_intake_item_converted',
    sql`(${t.status} = 'CONVERTED') = (${t.candidateId} IS NOT NULL)`,
  ),
}));
