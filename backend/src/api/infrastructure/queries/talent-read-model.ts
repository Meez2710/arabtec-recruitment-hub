// Talent read model.
//
// Same rules as the ATS read model: no aggregates, scope inside the SQL,
// `count(*) OVER()` for a single-round-trip page, correlated sub-selects for
// rollups — and every sub-select ALIASED with a fully-qualified outer reference,
// because drizzle renders columns unqualified inside `sql` templates and the
// unaliased form silently self-joins. See read-model.ts for the full note.
//
// Candidates are TENANT-scoped; their applications are still project-scoped, so
// the activity summary applies the requisition predicate to what it counts. A
// scoped recruiter therefore sees the person but only the pipeline activity
// their projects cover.

import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  aiTask, candidate, candidateDocument, candidateProposal, cvIntakeBatch, cvIntakeItem,
  hiringApplication, hiringRequisition, interview, offer,
} from '../../../infrastructure/db/schema/index.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { executorFor } from '../../../infrastructure/db/current-transaction.js';
import { scopedViaRequisition } from '../../../infrastructure/db/scope.js';
import { toNumber } from '../../../infrastructure/db/numeric.js';
import type { AuthContext } from '../../../modules/shared/kernel/auth-context.js';
import { TERMINAL_STAGES } from '../../../modules/hiring/index.js';
import type { FieldProvenance, FieldSource } from '../../../modules/talent/index.js';
import type { Page, PageRequest } from '../../queries/ports.js';
import type * as T from '../../queries/talent-ports.js';

const TOTAL = sql<number>`count(*) over()`.mapWith(Number);

const pageOf = <R>(rows: readonly (R & { total?: number })[], p: PageRequest): Page<R> => ({
  items: rows.map(({ total: _t, ...rest }) => rest as unknown as R),
  total: rows[0]?.total ?? 0,
  limit: p.limit,
  offset: p.offset,
});

const like = (value: string): string => `%${value.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];

/**
 * Placeholders with no source yet.
 *
 * Matching and embeddings do not exist, so these stay null. The parsing fields
 * BELOW are now real — filled from `ai_task` — and the response contract did
 * not change when they became so, which is exactly what designing the shape
 * first bought.
 */
const NO_AI: Pick<T.CandidateAIState,
  'lastMatchingTaskId' | 'lastMatchingAt'
  | 'embeddingModelId' | 'embeddingDimensions' | 'embeddingUpdatedAt'> = {
  lastMatchingTaskId: null,
  lastMatchingAt: null,
  embeddingModelId: null,
  embeddingDimensions: null,
  embeddingUpdatedAt: null,
};

interface ProvenanceRaw {
  source?: string; at?: string; actorId?: number | null;
  taskId?: string; modelId?: string;
}

const readProvenance = (raw: unknown): Record<string, ProvenanceRaw> =>
  typeof raw === 'object' && raw !== null ? raw as Record<string, ProvenanceRaw> : {};

const fieldSources = (raw: unknown): Record<string, FieldSource> => {
  const out: Record<string, FieldSource> = {};
  for (const [field, entry] of Object.entries(readProvenance(raw))) {
    out[field] = (entry.source ?? 'USER') as FieldSource;
  }
  return out;
};

const approvedFields = (raw: unknown): string[] =>
  Object.entries(readProvenance(raw))
    .filter(([, entry]) => entry.source === 'AI_APPROVED')
    .map(([field]) => field);

export class DrizzleTalentReadModel implements T.TalentReadModel {
  constructor(private readonly root: Executor) {}

  private get db(): Executor { return executorFor(this.root); }

  private scope(ctx: AuthContext): SQL {
    // Tenant only: a talent-pool record predates and outlives every requisition.
    return eq(candidate.tenantId, ctx.tenantId);
  }

  private static readonly SORT: Readonly<Record<string, PgColumn>> = {
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    fullName: candidate.fullName,
    candidateNo: candidate.candidateNo,
    yearsExperience: candidate.yearsExperience,
  };

  private static readonly DOCUMENT_COUNT = sql<number>`(
    select count(*) from "candidate_document" cd where cd."candidate_id" = "candidate"."id"
  )`.mapWith(Number);

  private static readonly HAS_CV = sql<boolean>`exists (
    select 1 from "candidate_document" cd
    where cd."candidate_id" = "candidate"."id" and cd."doc_type" = 'CV'
  )`;

  private static readonly APPLICATION_COUNT = sql<number>`(
    select count(*) from "hiring_application" ha where ha."candidate_id" = "candidate"."id"
  )`.mapWith(Number);

  private static readonly PENDING_PROPOSAL_ID = sql<number | null>`(
    select cp."id" from "candidate_proposal" cp
    where cp."candidate_id" = "candidate"."id" and cp."status" = 'PENDING' limit 1
  )`;

  private static readonly PENDING_PROPOSAL_FIELDS = sql<number>`coalesce((
    select jsonb_array_length(cp."fields") from "candidate_proposal" cp
    where cp."candidate_id" = "candidate"."id" and cp."status" = 'PENDING' limit 1
  ), 0)`.mapWith(Number);

  /** Most recent proposal of any status — the "last parsed" signal. */
  private static readonly LAST_PROPOSAL = {
    at: sql<Date | null>`(
      select cp."created_at" from "candidate_proposal" cp
      where cp."candidate_id" = "candidate"."id"
      order by cp."id" desc limit 1)`,
    origin: sql<string | null>`(
      select cp."origin" from "candidate_proposal" cp
      where cp."candidate_id" = "candidate"."id"
      order by cp."id" desc limit 1)`,
    modelId: sql<string | null>`(
      select nullif(cp."model_id", '') from "candidate_proposal" cp
      where cp."candidate_id" = "candidate"."id"
      order by cp."id" desc limit 1)`,
  };

  /**
   * The most recent résumé-parse task for this candidate.
   *
   * `state` is the processing chip the UI shows: QUEUED means a CV is waiting,
   * FAILED means an operator should look. Ordered by id desc, so a re-upload
   * supersedes the previous attempt in the display exactly as it does in fact.
   */
  private static readonly LAST_PARSE = {
    state: sql<string | null>`(
      select t."state" from "ai_task" t
      where t."entity_type" = 'Candidate' and t."entity_id" = "candidate"."id"
        and t."capability" = 'resume.extract'
      order by t."id" desc limit 1)`,
    taskId: sql<string | null>`(
      select t."id"::text from "ai_task" t
      where t."entity_type" = 'Candidate' and t."entity_id" = "candidate"."id"
        and t."capability" = 'resume.extract'
      order by t."id" desc limit 1)`,
    at: sql<Date | null>`(
      select coalesce(t."finished_at", t."created_at") from "ai_task" t
      where t."entity_type" = 'Candidate' and t."entity_id" = "candidate"."id"
        and t."capability" = 'resume.extract'
      order by t."id" desc limit 1)`,
  };

  private listColumns(): Record<string, unknown> {
    return {
      id: candidate.id,
      candidateNo: candidate.candidateNo,
      fullName: candidate.fullName,
      email: candidate.email,
      phone: candidate.phone,
      location: candidate.location,
      currentCompany: candidate.currentCompany,
      currentPosition: candidate.currentPosition,
      yearsExperienceRaw: candidate.yearsExperience,
      skills: candidate.skills,
      tags: candidate.tags,
      state: candidate.state,
      source: candidate.source,
      ownerRecruiterId: candidate.ownerRecruiterId,
      documentCount: DrizzleTalentReadModel.DOCUMENT_COUNT,
      hasCv: DrizzleTalentReadModel.HAS_CV,
      applicationCount: DrizzleTalentReadModel.APPLICATION_COUNT,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      version: candidate.version,
      provenanceRaw: candidate.provenance,
      pendingProposalId: DrizzleTalentReadModel.PENDING_PROPOSAL_ID,
      pendingProposalFieldCount: DrizzleTalentReadModel.PENDING_PROPOSAL_FIELDS,
      lastProposalAt: DrizzleTalentReadModel.LAST_PROPOSAL.at,
      lastProposalOrigin: DrizzleTalentReadModel.LAST_PROPOSAL.origin,
      lastProposalModelId: DrizzleTalentReadModel.LAST_PROPOSAL.modelId,
      parseState: DrizzleTalentReadModel.LAST_PARSE.state,
      parseTaskId: DrizzleTalentReadModel.LAST_PARSE.taskId,
      parseAt: DrizzleTalentReadModel.LAST_PARSE.at,
    };
  }

  private toListItem(row: Record<string, unknown>): T.CandidateListItem {
    const provenanceRaw = row['provenanceRaw'];
    const years = row['yearsExperienceRaw'];
    return {
      id: row['id'] as number,
      candidateNo: row['candidateNo'] as string,
      fullName: row['fullName'] as string,
      email: (row['email'] ?? null) as string | null,
      phone: (row['phone'] ?? null) as string | null,
      location: (row['location'] ?? null) as string | null,
      currentCompany: (row['currentCompany'] ?? null) as string | null,
      currentPosition: (row['currentPosition'] ?? null) as string | null,
      // numeric arrives as a string; the UI must not sort text as numbers.
      yearsExperience: years === null || years === undefined ? null : toNumber(years as string),
      skills: strings(row['skills']),
      tags: strings(row['tags']),
      state: row['state'] as string,
      source: (row['source'] ?? null) as string | null,
      ownerRecruiterId: (row['ownerRecruiterId'] ?? null) as number | null,
      documentCount: row['documentCount'] as number,
      hasCv: row['hasCv'] === true,
      applicationCount: row['applicationCount'] as number,
      createdAt: row['createdAt'] as Date,
      updatedAt: row['updatedAt'] as Date,
      version: row['version'] as number,
      fieldSources: fieldSources(provenanceRaw),
      ai: {
        pendingProposalId: (row['pendingProposalId'] ?? null) as number | null,
        pendingProposalFieldCount: row['pendingProposalFieldCount'] as number,
        lastProposalAt: (row['lastProposalAt'] ?? null) as Date | null,
        lastProposalOrigin: (row['lastProposalOrigin'] ?? null) as string | null,
        lastProposalModelId: (row['lastProposalModelId'] ?? null) as string | null,
        aiApprovedFields: approvedFields(provenanceRaw),
        processingStatus: (row['parseState'] ?? null) as string | null,
        lastParsingTaskId: (row['parseTaskId'] ?? null) as string | null,
        lastParsingAt: (row['parseAt'] ?? null) as Date | null,
        ...NO_AI,
      },
    };
  }

  async candidates(
    f: T.CandidateFilters, p: PageRequest, ctx: AuthContext,
  ): Promise<Page<T.CandidateListItem>> {
    const where: SQL[] = [this.scope(ctx)];

    if (f.state?.length) where.push(inArray(candidate.state, [...f.state] as never));
    else where.push(ne(candidate.state, 'ERASED'));   // erased records are gone by default

    if (f.ownerRecruiterId !== undefined) {
      where.push(eq(candidate.ownerRecruiterId, f.ownerRecruiterId));
    }
    if (f.source !== undefined) where.push(eq(candidate.source, f.source));
    if (f.minYearsExperience !== undefined) {
      where.push(gte(candidate.yearsExperience, String(f.minYearsExperience)));
    }
    if (f.maxYearsExperience !== undefined) {
      where.push(lte(candidate.yearsExperience, String(f.maxYearsExperience)));
    }
    if (f.createdFrom !== undefined) where.push(gte(candidate.createdAt, f.createdFrom));
    if (f.createdTo !== undefined) where.push(lte(candidate.createdAt, f.createdTo));

    if (f.q !== undefined && f.q !== '') {
      const pattern = like(f.q);
      const match = or(
        ilike(candidate.fullName, pattern),
        ilike(candidate.candidateNo, pattern),
        ilike(candidate.email, pattern),
        ilike(candidate.currentCompany, pattern),
        ilike(candidate.currentPosition, pattern),
      );
      if (match) where.push(match);
    }

    // jsonb containment: ALL listed values must be present. `@>` is exact and
    // case-sensitive, which is why the aggregate canonicalises on write.
    if (f.skills?.length) {
      where.push(sql`"candidate"."skills" @> ${JSON.stringify([...f.skills])}::jsonb`);
    }
    if (f.tags?.length) {
      where.push(sql`"candidate"."tags" @> ${JSON.stringify([...f.tags])}::jsonb`);
    }

    if (f.hasCv === true) {
      where.push(sql`exists (select 1 from "candidate_document" cd
        where cd."candidate_id" = "candidate"."id" and cd."doc_type" = 'CV')`);
    } else if (f.hasCv === false) {
      where.push(sql`not exists (select 1 from "candidate_document" cd
        where cd."candidate_id" = "candidate"."id" and cd."doc_type" = 'CV')`);
    }

    if (f.hasPendingProposal === true) {
      where.push(sql`exists (select 1 from "candidate_proposal" cp
        where cp."candidate_id" = "candidate"."id" and cp."status" = 'PENDING')`);
    }

    const column = (p.sort !== undefined && DrizzleTalentReadModel.SORT[p.sort])
      || candidate.createdAt;

    const rows = await this.db
      .select({ ...this.listColumns(), total: TOTAL } as never)
      .from(candidate)
      .where(and(...where))
      .orderBy(p.direction === 'asc' ? asc(column) : desc(column))
      .limit(p.limit)
      .offset(p.offset) as unknown as Record<string, unknown>[];

    return pageOf(rows.map((r) => ({ ...this.toListItem(r), total: r['total'] as number })), p);
  }

  async candidate(id: number, ctx: AuthContext): Promise<T.CandidateDetail | null> {
    const rows = await this.db
      .select({
        ...this.listColumns(),
        nationality: candidate.nationality,
        linkedinUrl: candidate.linkedinUrl,
        noticePeriod: candidate.noticePeriod,
        university: candidate.university,
        major: candidate.major,
        graduationYear: candidate.graduationYear,
        languages: candidate.languages,
        certifications: candidate.certifications,
        createdBy: candidate.createdBy,
      } as never)
      .from(candidate)
      .where(and(eq(candidate.id, id), this.scope(ctx)))
      .limit(1) as unknown as Record<string, unknown>[];

    const row = rows[0];
    if (row === undefined) return null;

    const [documents, pendingProposal, duplicateWarnings, activity] = await Promise.all([
      this.documentsFor(id),
      this.pendingProposalFor(id, row),
      this.duplicates(id, ctx),
      this.activityFor(id, ctx),
    ]);

    return {
      ...this.toListItem(row),
      nationality: (row['nationality'] ?? null) as string | null,
      linkedinUrl: (row['linkedinUrl'] ?? null) as string | null,
      noticePeriod: (row['noticePeriod'] ?? null) as string | null,
      university: (row['university'] ?? null) as string | null,
      major: (row['major'] ?? null) as string | null,
      graduationYear: (row['graduationYear'] ?? null) as number | null,
      languages: strings(row['languages']),
      certifications: strings(row['certifications']),
      createdBy: row['createdBy'] as number,
      documents,
      provenance: toBadges(row['provenanceRaw']),
      pendingProposal,
      duplicateWarnings,
      activity,
    };
  }

  /**
   * Documents plus who else holds the same bytes.
   *
   * Two queries regardless of document count: the shared-candidate lookup is one
   * batched query over every hash, not one per document.
   */
  private async documentsFor(candidateId: number): Promise<readonly T.CandidateDocumentView[]> {
    const docs = await this.db
      .select().from(candidateDocument)
      .where(eq(candidateDocument.candidateId, candidateId))
      .orderBy(desc(candidateDocument.uploadedAt), desc(candidateDocument.id));
    if (docs.length === 0) return [];

    const shared = await this.db
      .select({ fileHash: candidateDocument.fileHash, candidateId: candidateDocument.candidateId })
      .from(candidateDocument)
      .where(and(
        inArray(candidateDocument.fileHash, docs.map((d) => d.fileHash)),
        ne(candidateDocument.candidateId, candidateId),
      ));

    const byHash = new Map<string, number[]>();
    for (const row of shared) {
      const bucket = byHash.get(row.fileHash);
      if (bucket === undefined) byHash.set(row.fileHash, [row.candidateId]);
      else bucket.push(row.candidateId);
    }

    return docs.map((d) => ({
      documentId: d.documentId, docType: d.docType, fileName: d.fileName,
      fileHash: d.fileHash, fileSize: d.fileSize, mimeType: d.mimeType, note: d.note,
      uploadedBy: d.uploadedBy, uploadedAt: d.uploadedAt,
      sharedWithCandidateIds: byHash.get(d.fileHash) ?? [],
    }));
  }

  private async pendingProposalFor(
    candidateId: number, candidateRow: Record<string, unknown>,
  ): Promise<T.ProposalView | null> {
    const rows = await this.db
      .select().from(candidateProposal)
      .where(and(
        eq(candidateProposal.candidateId, candidateId),
        eq(candidateProposal.status, 'PENDING'),
      ))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toProposalView(row, candidateRow);
  }

  async proposals(
    candidateId: number, p: PageRequest, ctx: AuthContext,
  ): Promise<Page<T.ProposalView>> {
    const reachable = await this.db.select({ id: candidate.id }).from(candidate)
      .where(and(eq(candidate.id, candidateId), this.scope(ctx))).limit(1);
    if (reachable.length === 0) return { items: [], total: 0, limit: p.limit, offset: p.offset };

    const current = await this.db
      .select({ row: candidate }).from(candidate).where(eq(candidate.id, candidateId)).limit(1);

    const rows = await this.db
      .select({ proposal: candidateProposal, total: TOTAL })
      .from(candidateProposal)
      .where(eq(candidateProposal.candidateId, candidateId))
      .orderBy(desc(candidateProposal.id))
      .limit(p.limit)
      .offset(p.offset);

    const candidateRow = (current[0]?.row ?? {}) as unknown as Record<string, unknown>;
    return pageOf(
      rows.map((r) => ({ ...toProposalView(r.proposal, candidateRow), total: r.total })),
      p,
    );
  }

  /**
   * Duplicate signals for one candidate, including a shared CV.
   *
   * Reports only. Merging two people's histories is a judgement with legal
   * consequences and is never something a query gets to decide.
   */
  async duplicates(
    candidateId: number, ctx: AuthContext,
  ): Promise<readonly T.DuplicateWarningView[]> {
    const rows = await this.db
      .select({
        id: candidate.id, candidateNo: candidate.candidateNo,
        fullName: candidate.fullName, state: candidate.state,
        byEmail: sql<boolean>`c2."dedup_email" is not null
          and c2."dedup_email" = "candidate"."dedup_email"`,
        byPhone: sql<boolean>`c2."dedup_phone" is not null
          and c2."dedup_phone" = "candidate"."dedup_phone"`,
        byLinkedin: sql<boolean>`c2."dedup_linkedin" is not null
          and c2."dedup_linkedin" = "candidate"."dedup_linkedin"`,
        byDocument: sql<boolean>`exists (
          select 1 from "candidate_document" d1
          join "candidate_document" d2 on d2."file_hash" = d1."file_hash"
          where d1."candidate_id" = c2."id" and d2."candidate_id" = "candidate"."id")`,
      })
      .from(candidate)
      .innerJoin(sql`"candidate" c2`, sql`c2."id" = ${candidateId}`)
      .where(and(
        this.scope(ctx),
        ne(candidate.id, candidateId),
        // Erased records must not resurface — that would leak that they existed.
        ne(candidate.state, 'ERASED'),
        sql`(
          (c2."dedup_email" is not null and c2."dedup_email" = "candidate"."dedup_email")
          or (c2."dedup_phone" is not null and c2."dedup_phone" = "candidate"."dedup_phone")
          or (c2."dedup_linkedin" is not null
              and c2."dedup_linkedin" = "candidate"."dedup_linkedin")
          or exists (select 1 from "candidate_document" d1
                     join "candidate_document" d2 on d2."file_hash" = d1."file_hash"
                     where d1."candidate_id" = c2."id"
                       and d2."candidate_id" = "candidate"."id")
        )`,
      ))
      .orderBy(candidate.id)
      .limit(20);

    return rows.map((r) => {
      const matchedOn: string[] = [];
      if (r.byEmail) matchedOn.push('email');
      if (r.byPhone) matchedOn.push('phone');
      if (r.byLinkedin) matchedOn.push('linkedin');
      if (r.byDocument) matchedOn.push('document');
      return {
        candidateId: r.id, candidateNo: r.candidateNo,
        fullName: r.fullName, state: r.state, matchedOn,
      };
    });
  }

  private static readonly INTAKE_SORT: Readonly<Record<string, PgColumn>> = {
    createdAt: cvIntakeBatch.createdAt,
    label: cvIntakeBatch.label,
    status: cvIntakeBatch.status,
  };

  async intakeBatches(
    f: T.IntakeFilters, p: PageRequest, ctx: AuthContext,
  ): Promise<Page<T.IntakeBatchListItem>> {
    const where: SQL[] = [eq(cvIntakeBatch.tenantId, ctx.tenantId)];
    if (f.status?.length) where.push(inArray(cvIntakeBatch.status, [...f.status] as never));
    if (f.uploadedBy !== undefined) where.push(eq(cvIntakeBatch.uploadedBy, f.uploadedBy));
    if (f.createdFrom !== undefined) where.push(gte(cvIntakeBatch.createdAt, f.createdFrom));
    if (f.createdTo !== undefined) where.push(lte(cvIntakeBatch.createdAt, f.createdTo));
    if (f.q !== undefined && f.q !== '') where.push(ilike(cvIntakeBatch.label, like(f.q)));
    if (f.hasOutstanding === true) {
      where.push(sql`exists (
        select 1 from "cv_intake_item" ci
        where ci."batch_id" = "cv_intake_batch"."id"
          and ci."status" in ('PENDING_PARSE','PARSED','PARSE_FAILED')
      )`);
    }

    const column = (p.sort !== undefined && DrizzleTalentReadModel.INTAKE_SORT[p.sort])
      || cvIntakeBatch.createdAt;

    const rows = await this.db
      .select({
        id: cvIntakeBatch.id,
        label: cvIntakeBatch.label,
        status: cvIntakeBatch.status,
        uploadedBy: cvIntakeBatch.uploadedBy,
        createdAt: cvIntakeBatch.createdAt,
        version: cvIntakeBatch.version,
        ...INTAKE_TOTALS,
        total_: TOTAL,
      } as never)
      .from(cvIntakeBatch)
      .where(and(...where))
      .orderBy(p.direction === 'asc' ? asc(column) : desc(column))
      .limit(p.limit)
      .offset(p.offset) as unknown as Record<string, unknown>[];

    return pageOf(
      rows.map((r) => ({ ...toBatchListItem(r), total: r['total_'] as number })),
      p,
    );
  }

  async intakeBatch(id: number, ctx: AuthContext): Promise<T.IntakeBatchDetail | null> {
    const rows = await this.db
      .select({
        id: cvIntakeBatch.id,
        label: cvIntakeBatch.label,
        status: cvIntakeBatch.status,
        uploadedBy: cvIntakeBatch.uploadedBy,
        createdAt: cvIntakeBatch.createdAt,
        version: cvIntakeBatch.version,
        ...INTAKE_TOTALS,
      } as never)
      .from(cvIntakeBatch)
      .where(and(eq(cvIntakeBatch.id, id), eq(cvIntakeBatch.tenantId, ctx.tenantId)))
      .limit(1) as unknown as Record<string, unknown>[];

    const row = rows[0];
    if (row === undefined) return null;

    // Items joined to their parse task in ONE query — the live task state is
    // what tells a reviewer "still working" versus "nothing came back".
    const items = await this.db
      .select({
        item: cvIntakeItem,
        parsingStatus: sql<string | null>`(
          select t."state" from "ai_task" t
          where t."entity_type" = 'CvIntakeBatch' and t."entity_id" = ${id}
            and t."input"->>'itemId' = "cv_intake_item"."item_id"
          order by t."id" desc limit 1)`,
        parsingTaskId: sql<string | null>`(
          select t."id"::text from "ai_task" t
          where t."entity_type" = 'CvIntakeBatch' and t."entity_id" = ${id}
            and t."input"->>'itemId' = "cv_intake_item"."item_id"
          order by t."id" desc limit 1)`,
        parsingError: sql<string | null>`(
          select coalesce(t."last_error", t."abstain_reason") from "ai_task" t
          where t."entity_type" = 'CvIntakeBatch' and t."entity_id" = ${id}
            and t."input"->>'itemId' = "cv_intake_item"."item_id"
          order by t."id" desc limit 1)`,
      })
      .from(cvIntakeItem)
      .where(eq(cvIntakeItem.batchId, id))
      .orderBy(asc(cvIntakeItem.id));

    return {
      ...toBatchListItem(row),
      items: items.map((r) => ({
        itemId: r.item.itemId,
        fileName: r.item.fileName,
        fileHash: r.item.fileHash,
        mimeType: r.item.mimeType,
        fileSize: r.item.fileSize,
        status: r.item.status,
        note: r.item.note,
        candidateId: r.item.candidateId,
        extracted: (Array.isArray(r.item.extracted) ? r.item.extracted : []) as never,
        generation: (r.item.generation ?? null) as Record<string, unknown> | null,
        parsingStatus: r.parsingStatus,
        parsingTaskId: r.parsingTaskId,
        parsingError: r.parsingError,
      })),
    };
  }

  async activity(
    candidateId: number, ctx: AuthContext,
  ): Promise<T.CandidateActivitySummary | null> {
    const reachable = await this.db.select({ id: candidate.id }).from(candidate)
      .where(and(eq(candidate.id, candidateId), this.scope(ctx))).limit(1);
    if (reachable.length === 0) return null;
    return this.activityFor(candidateId, ctx);
  }

  /**
   * Pipeline activity, PROJECT-scoped.
   *
   * The candidate is visible tenant-wide, but their applications are not: a
   * scoped recruiter sees the person and only the activity their projects cover.
   */
  private async activityFor(
    candidateId: number, ctx: AuthContext,
  ): Promise<T.CandidateActivitySummary> {
    const appScope = scopedViaRequisition(
      this.db, hiringApplication.tenantId, hiringApplication.requisitionId, ctx,
    );
    const now = new Date();

    const [apps, ivs, offers, stages] = await Promise.all([
      this.db.select({
        total: sql<number>`count(*)`.mapWith(Number),
        live: sql<number>`count(*) filter (
          where "hiring_application"."stage" not in ${[...TERMINAL_STAGES]})`.mapWith(Number),
        hired: sql<number>`count(*) filter (
          where "hiring_application"."stage" = 'HIRED')`.mapWith(Number),
        lastActivityAt: sql<Date | null>`max("hiring_application"."last_activity_at")`,
      }).from(hiringApplication)
        .where(and(eq(hiringApplication.candidateId, candidateId), appScope)),

      this.db.select({
        total: sql<number>`count(*)`.mapWith(Number),
        upcoming: sql<number>`count(*) filter (
          where "interview"."status" = 'SCHEDULED'
            and "interview"."starts_at" >= ${now})`.mapWith(Number),
      }).from(interview)
        .where(and(
          eq(interview.candidateId, candidateId),
          scopedViaRequisition(this.db, interview.tenantId, interview.requisitionId, ctx),
        )),

      this.db.select({
        total: sql<number>`count(*)`.mapWith(Number),
        live: sql<number>`count(*) filter (
          where "offer"."status" in ('SENT','ACCEPTED'))`.mapWith(Number),
      }).from(offer)
        .where(and(
          eq(offer.candidateId, candidateId),
          scopedViaRequisition(this.db, offer.tenantId, offer.requisitionId, ctx),
        )),

      this.db.select({
        applicationId: hiringApplication.id,
        requisitionId: hiringApplication.requisitionId,
        requisitionTicketNo: hiringRequisition.ticketNo,
        requisitionTitle: hiringRequisition.title,
        stage: hiringApplication.stage,
      }).from(hiringApplication)
        .innerJoin(hiringRequisition, eq(hiringRequisition.id, hiringApplication.requisitionId))
        .where(and(eq(hiringApplication.candidateId, candidateId), appScope))
        .orderBy(desc(hiringApplication.lastActivityAt))
        .limit(20),
    ]);

    return {
      applicationCount: apps[0]?.total ?? 0,
      liveApplicationCount: apps[0]?.live ?? 0,
      interviewCount: ivs[0]?.total ?? 0,
      upcomingInterviewCount: ivs[0]?.upcoming ?? 0,
      offerCount: offers[0]?.total ?? 0,
      liveOfferCount: offers[0]?.live ?? 0,
      isHired: (apps[0]?.hired ?? 0) > 0,
      lastActivityAt: apps[0]?.lastActivityAt ?? null,
      currentStages: stages,
    };
  }
}

/* ------------------------------- CV intake --------------------------------- */

/**
 * Item-status rollups as ONE correlated sub-select per counter.
 *
 * A list of batches is one query including every progress bar. Loading items to
 * count them in JavaScript would be N+1 with the N hidden inside a `.reduce`.
 */
const itemCount = (status: string): SQL<number> => sql<number>`(
  select count(*) from "cv_intake_item" ci
  where ci."batch_id" = "cv_intake_batch"."id" and ci."status" = ${status}
)`.mapWith(Number);

const INTAKE_TOTALS = {
  total: sql<number>`(
    select count(*) from "cv_intake_item" ci where ci."batch_id" = "cv_intake_batch"."id"
  )`.mapWith(Number),
  pendingParse: itemCount('PENDING_PARSE'),
  parsed: itemCount('PARSED'),
  parseFailed: itemCount('PARSE_FAILED'),
  converted: itemCount('CONVERTED'),
  discarded: itemCount('DISCARDED'),
  suggestedFields: sql<number>`coalesce((
    select sum(jsonb_array_length(ci."extracted")) from "cv_intake_item" ci
    where ci."batch_id" = "cv_intake_batch"."id"
  ), 0)`.mapWith(Number),
  lastParsedAt: sql<Date | null>`(
    select max(t."finished_at") from "ai_task" t
    where t."entity_type" = 'CvIntakeBatch' and t."entity_id" = "cv_intake_batch"."id"
  )`,
  modelIds: sql<string[]>`coalesce((
    select array_agg(distinct ci."generation"->>'modelId')
      filter (where ci."generation"->>'modelId' is not null)
    from "cv_intake_item" ci where ci."batch_id" = "cv_intake_batch"."id"
  ), '{}')`,
};

const toProgress = (row: Record<string, unknown>): T.IntakeProgress => {
  const total = row['total'] as number;
  const outstanding = (row['pendingParse'] as number) + (row['parsed'] as number)
    + (row['parseFailed'] as number);
  return {
    total,
    pendingParse: row['pendingParse'] as number,
    parsed: row['parsed'] as number,
    parseFailed: row['parseFailed'] as number,
    converted: row['converted'] as number,
    discarded: row['discarded'] as number,
    outstanding,
    completion: total === 0 ? 1 : (total - outstanding) / total,
  };
};

const toBatchListItem = (row: Record<string, unknown>): T.IntakeBatchListItem => ({
  id: row['id'] as number,
  label: row['label'] as string,
  status: row['status'] as string,
  uploadedBy: row['uploadedBy'] as number,
  createdAt: row['createdAt'] as Date,
  version: row['version'] as number,
  progress: toProgress(row),
  proposalSummary: {
    // "Ready for review" is PARSED specifically: pending has nothing to show
    // and failed has nothing to accept.
    readyForReview: row['parsed'] as number,
    totalSuggestedFields: row['suggestedFields'] as number,
    lastParsedAt: (row['lastParsedAt'] ?? null) as Date | null,
    modelIds: (Array.isArray(row['modelIds']) ? row['modelIds'] : []) as string[],
  },
});

/* --------------------------------- helpers --------------------------------- */

const toBadges = (raw: unknown): readonly T.ProvenanceBadge[] =>
  Object.entries(readProvenance(raw)).map(([field, entry]) => ({
    field,
    source: (entry.source ?? 'USER') as FieldSource,
    at: entry.at === undefined ? new Date(0) : new Date(entry.at),
    actorId: entry.actorId ?? null,
    taskId: entry.taskId ?? null,
    modelId: entry.modelId ?? null,
  })).sort((a, b) => a.field.localeCompare(b.field));

interface RawProposalRow {
  id: number; origin: string; status: string; taskId: string; modelId: string;
  documentId: string | null; createdAt: Date; reviewedBy: number | null;
  reviewedAt: Date | null; fields: unknown; generation: unknown;
}

/**
 * Proposal plus the candidate's CURRENT value per field.
 *
 * A reviewer needs the diff, not the suggestion alone — "Site Engineer" means
 * something different when the record says nothing than when it says
 * "Senior Site Engineer".
 */
const toProposalView = (
  row: RawProposalRow, candidateRow: Record<string, unknown>,
): T.ProposalView => ({
  id: row.id,
  origin: row.origin,
  status: row.status,
  taskId: row.taskId === '' ? null : row.taskId,
  modelId: row.modelId === '' ? null : row.modelId,
  documentId: row.documentId,
  generation: (row.generation ?? null) as Record<string, unknown> | null,
  createdAt: row.createdAt,
  reviewedBy: row.reviewedBy,
  reviewedAt: row.reviewedAt,
  fields: (Array.isArray(row.fields) ? row.fields : [])
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      field: String(f['field'] ?? ''),
      value: f['value'],
      confidence: typeof f['confidence'] === 'number' ? f['confidence'] : 0,
      evidence: typeof f['evidence'] === 'string' ? f['evidence'] : null,
      decision: String(f['decision'] ?? 'PENDING'),
      currentValue: candidateRow[String(f['field'] ?? '')] ?? null,
    })),
});

export type { FieldProvenance };
