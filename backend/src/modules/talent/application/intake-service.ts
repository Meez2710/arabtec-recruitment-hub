// CvIntakeService — bulk CV upload as an intake workflow.
//
// Reuses everything: the same parse pipeline (an `AITaskDispatcher` task per
// file), the same generation provenance, the same `Candidate` aggregate with
// its unchanged invariants. The only new idea is a staging area to hold files
// that are not yet anybody.
//
// CONVERSION IS THE REVIEW. There is no separate proposal step for an intake
// item: a proposal is bound to a candidate id and at this point no candidate
// exists. The reviewer sees the extracted fields, accepts a subset, supplies
// whatever is missing, and the Candidate is created from the union — with
// USER provenance on what they typed and AI_APPROVED on what they accepted.

import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import type { Clock, DomainEvent } from '../../shared/kernel/domain.js';
import { systemClock } from '../../shared/kernel/domain.js';
import type { EventBus } from '../../shared/kernel/ports.js';
import type { AITaskDispatcher } from '../../shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../shared/kernel/ai/index.js';
import { Candidate } from '../domain/candidate.js';
import type { CandidatePatch } from '../domain/candidate.js';
import { CvIntakeBatch } from '../domain/cv-intake.js';
import type { IntakeBatchStatus, IntakeField } from '../domain/cv-intake.js';
import type { ProposalGeneration } from '../domain/proposal.js';
import { TALENT_PERMISSIONS } from './candidate-service.js';
import type { DocumentStore, TalentUnitOfWork } from './ports.js';

export interface IntakeItemSummary {
  readonly itemId: string;
  readonly fileName: string;
  readonly fileHash: string;
  readonly status: string;
  readonly extracted: readonly IntakeField[];
  readonly candidateId: number | null;
  readonly note: string | null;
}

export interface IntakeBatchSummary {
  readonly id: number;
  readonly label: string;
  readonly status: IntakeBatchStatus;
  readonly uploadedBy: number;
  readonly itemCount: number;
  readonly outstandingCount: number;
  readonly items: readonly IntakeItemSummary[];
  readonly version: number;
}

export interface ConvertResult {
  readonly candidateId: number;
  readonly appliedAiFields: readonly string[];
  readonly batch: IntakeBatchSummary;
  /** Reported, never blocking — same rule as manual creation. */
  readonly possibleDuplicates: readonly { candidateId: number; matchedOn: readonly string[] }[];
}

export interface UploadedFile {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly fileHash: string;
}

export interface CvIntakeServiceDeps {
  readonly uow: TalentUnitOfWork;
  readonly events: EventBus;
  readonly documents: DocumentStore;
  readonly clock?: Clock;
  /** Optional, as everywhere. Without it files are staged but never parsed. */
  readonly ai?: AITaskDispatcher;
}

export class CvIntakeService {
  private readonly uow: TalentUnitOfWork;
  private readonly events: EventBus;
  private readonly documents: DocumentStore;
  private readonly clock: Clock;
  private readonly ai: AITaskDispatcher | null;

  constructor(deps: CvIntakeServiceDeps) {
    this.uow = deps.uow;
    this.events = deps.events;
    this.documents = deps.documents;
    this.clock = deps.clock ?? systemClock;
    this.ai = deps.ai ?? null;
  }

  /**
   * Stage a batch of files and queue a parse task for each.
   *
   * Bytes go to the store FIRST, outside the transaction — a failed transaction
   * leaves unreferenced blobs a sweep can collect, whereas the opposite order
   * loses files while claiming to hold them.
   *
   * Batch, items and tasks then commit TOGETHER, so a crash cannot produce a
   * staged file with no task queued.
   */
  async upload(
    input: { label: string; files: readonly UploadedFile[] },
    ctx: AuthContext,
  ): Promise<IntakeBatchSummary> {
    this.require(ctx, TALENT_PERMISSIONS.UPLOAD_DOCUMENT, TALENT_PERMISSIONS.CREATE);
    const now = this.clock.now();

    for (const file of input.files) {
      await this.documents.put({
        fileHash: file.fileHash, bytes: file.bytes,
        mimeType: file.mimeType, fileName: file.fileName,
      });
    }

    const { result, events } = await this.uow.transaction(async (tx) => {
      const batch = CvIntakeBatch.open({
        id: await tx.intake.nextId(ctx),
        tenantId: ctx.tenantId,
        label: input.label,
        files: input.files.map((f) => ({
          fileName: f.fileName, fileHash: f.fileHash,
          mimeType: f.mimeType, fileSize: f.bytes.byteLength,
        })),
        actor: ctx.actor,
        now,
      });
      await tx.intake.save(batch);

      if (this.ai !== null) {
        for (const item of batch.items) {
          await this.ai.submit({
            capability: AI_CAPABILITIES.RESUME_EXTRACT,
            input: {
              batchId: batch.id,
              itemId: item.itemId,
              documentId: item.itemId,
              fileHash: item.fileHash,
              fileName: item.fileName,
              mimeType: item.mimeType,
            },
            entityRef: { entityType: 'CvIntakeBatch', entityId: batch.id },
            idempotencyKey: `resume.extract:intake:${batch.id}:${item.fileHash}`,
            tenantId: ctx.tenantId,
            // BATCH: fifty CVs must not starve an interactive request.
            priority: 'BATCH',
          });
        }
      }

      return { result: summariseBatch(batch), events: batch.pullEvents() };
    });

    await this.publish(events);
    return result;
  }

  /** Called by the parse worker. System context; records what was extracted. */
  async recordExtraction(
    input: {
      batchId: number; itemId: string;
      fields: readonly IntakeField[]; generation: ProposalGeneration;
    },
    ctx: AuthContext,
  ): Promise<void> {
    await this.mutate(input.batchId, ctx, undefined, (batch) => {
      batch.recordExtraction({ ...input, actor: ctx.actor });
    });
  }

  async recordParseFailure(
    input: { batchId: number; itemId: string; reason: string },
    ctx: AuthContext,
  ): Promise<void> {
    await this.mutate(input.batchId, ctx, undefined, (batch) => {
      batch.recordParseFailure(input.itemId, input.reason);
    });
  }

  /**
   * Turn one staged file into a real Candidate.
   *
   * The candidate is built by `Candidate.create` under its ordinary invariants —
   * a name and a contact channel are still required, and a batch that cannot
   * supply them cannot produce a candidate. That is the whole reason staging
   * exists rather than relaxing the rule.
   */
  async convert(
    input: {
      batchId: number;
      itemId: string;
      /** Fields the reviewer typed or corrected. Recorded as USER. */
      manual: CandidatePatch & { fullName?: string };
      /** Extracted fields the reviewer accepted. Recorded as AI_APPROVED. */
      acceptedFields: readonly string[];
      ownerRecruiterId?: number | null;
      expectedVersion?: number;
    },
    ctx: AuthContext,
  ): Promise<ConvertResult> {
    this.require(ctx, TALENT_PERMISSIONS.CREATE);
    const now = this.clock.now();

    const { result, events } = await this.uow.transaction(async (tx) => {
      const batch = await tx.intake.findByIdForUpdate(input.batchId, ctx);
      if (!batch) throw new NotFoundError('CvIntakeBatch', input.batchId);
      if (input.expectedVersion !== undefined && batch.version !== input.expectedVersion) {
        throw new StaleAggregateError(
          'CvIntakeBatch', input.batchId, input.expectedVersion, batch.version,
        );
      }

      const item = batch.ensureConvertible(input.itemId);
      const accepted = new Set(input.acceptedFields);
      const aiPatch: Record<string, unknown> = {};
      for (const field of item.extracted) {
        if (accepted.has(field.field)) aiPatch[field.field] = field.value;
      }

      // The reviewer's own input wins over an accepted suggestion for the same
      // field — they were looking at both and chose.
      const seed = { ...aiPatch, ...stripUndefined(input.manual) } as CandidatePatch & {
        fullName?: string;
      };
      const fullName = seed.fullName;
      if (typeof fullName !== 'string' || fullName.trim() === '') {
        // Deliberately the aggregate's own error, so the API maps it exactly as
        // it maps a manual creation with no name.
        throw new (await import('../domain/errors.js')).InvalidCandidateFieldError(
          'fullName', 'it is required',
        );
      }

      // AI fields the reviewer did NOT override. Those they typed are theirs.
      const manualFields = stripUndefined(input.manual);
      const appliedAiFields = Object.keys(aiPatch).filter((f) => !(f in manualFields));

      const candidateId = await tx.candidates.nextId(ctx);
      const candidate = Candidate.create({
        ...seed,
        fullName,
        id: candidateId,
        tenantId: ctx.tenantId,
        candidateNo: await tx.candidates.nextCandidateNo(ctx),
        ownerRecruiterId: input.ownerRecruiterId ?? ctx.userId,
        source: seed.source ?? 'cv-intake',
        // Everything the reviewer typed is theirs, and is labelled as such —
        // a record built from a mix must answer "who supplied this?" per field.
        userFields: Object.keys(manualFields),
        // Stamped at creation: `applyApprovedFields` only marks fields it
        // CHANGES, and here the accepted value is already the seed value.
        ...(appliedAiFields.length > 0 && item.generation !== null
          ? {
            approvedFrom: {
              fields: appliedAiFields,
              taskId: `intake:${input.batchId}:${input.itemId}`,
              modelId: item.generation.modelId,
            },
          }
          : {}),
        actor: ctx.actor,
        now,
      });

      // The CV follows the candidate. No parse task — it is already parsed.
      candidate.attachDocument({
        documentId: item.itemId,
        docType: 'CV',
        fileName: item.fileName,
        fileHash: item.fileHash,
        fileSize: item.fileSize,
        mimeType: item.mimeType,
        note: null,
        uploadedBy: ctx.userId,
      }, ctx.actor, now);

      await tx.candidates.save(candidate);

      batch.markConverted(input.itemId, candidateId, ctx.actor);
      await tx.intake.save(batch);

      const duplicates = await tx.candidates.findPotentialDuplicates({
        email: candidate.toState().email,
        phone: candidate.toState().phone,
        linkedinUrl: candidate.toState().linkedinUrl,
      }, ctx, { excludeCandidateId: candidateId });

      return {
        result: {
          candidateId,
          appliedAiFields,
          batch: summariseBatch(batch),
          possibleDuplicates: duplicates.map((d) => ({
            candidateId: d.candidateId, matchedOn: d.matchedOn,
          })),
        },
        events: [...candidate.pullEvents(), ...batch.pullEvents()],
      };
    });

    await this.publish(events);
    return result;
  }

  async discard(
    input: { batchId: number; itemId: string; reason: string; expectedVersion?: number },
    ctx: AuthContext,
  ): Promise<IntakeBatchSummary> {
    this.require(ctx, TALENT_PERMISSIONS.CREATE);
    return this.mutate(input.batchId, ctx, input.expectedVersion, (batch) => {
      batch.discard(input.itemId, input.reason, ctx.actor);
    });
  }

  async cancel(
    batchId: number, reason: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<IntakeBatchSummary> {
    this.require(ctx, TALENT_PERMISSIONS.CREATE);
    return this.mutate(batchId, ctx, expectedVersion, (batch) => {
      batch.cancel(reason, ctx.actor);
    });
  }

  async get(batchId: number, ctx: AuthContext): Promise<IntakeBatchSummary> {
    this.require(ctx, TALENT_PERMISSIONS.VIEW_ALL, TALENT_PERMISSIONS.VIEW_OWN);
    const batch = await this.uow.transaction(async (tx) => tx.intake.findById(batchId, ctx));
    if (!batch) throw new NotFoundError('CvIntakeBatch', batchId);
    return summariseBatch(batch);
  }

  /* ------------------------------- internals ------------------------------- */

  private async mutate(
    batchId: number,
    ctx: AuthContext,
    expectedVersion: number | undefined,
    change: (batch: CvIntakeBatch) => void,
  ): Promise<IntakeBatchSummary> {
    const { result, events } = await this.uow.transaction(async (tx) => {
      const batch = await tx.intake.findByIdForUpdate(batchId, ctx);
      if (!batch) throw new NotFoundError('CvIntakeBatch', batchId);
      if (expectedVersion !== undefined && batch.version !== expectedVersion) {
        throw new StaleAggregateError('CvIntakeBatch', batchId, expectedVersion, batch.version);
      }
      change(batch);
      await tx.intake.save(batch);
      return { result: summariseBatch(batch), events: batch.pullEvents() };
    });

    await this.publish(events);
    return result;
  }

  private require(ctx: AuthContext, ...permissions: readonly string[]): void {
    if (!permissions.some((p) => ctx.has(p))) {
      throw new ForbiddenError(permissions[0] ?? 'unknown');
    }
  }

  private async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length > 0) await this.events.publish(events);
  }
}

const stripUndefined = <T extends object>(o: T): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export const summariseBatch = (batch: CvIntakeBatch): IntakeBatchSummary => {
  const state = batch.toState();
  return {
    id: state.id,
    label: state.label,
    status: state.status,
    uploadedBy: state.uploadedBy,
    itemCount: state.items.length,
    outstandingCount: batch.outstandingCount,
    items: state.items.map((i) => ({
      itemId: i.itemId, fileName: i.fileName, fileHash: i.fileHash,
      status: i.status, extracted: i.extracted,
      candidateId: i.candidateId, note: i.note,
    })),
    version: state.version,
  };
};
