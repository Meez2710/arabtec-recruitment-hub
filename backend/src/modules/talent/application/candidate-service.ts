// CandidateService — manual candidate management.
//
// Every operation here works with no AI provider configured. That is not a
// fallback mode; it is the only mode that exists today, and the AI phase adds a
// second way to PROPOSE values, never a second way to write them.

import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { NotFoundError, ForbiddenError, StaleAggregateError } from '../../shared/kernel/errors.js';
import type { Clock, DomainEvent } from '../../shared/kernel/domain.js';
import { systemClock } from '../../shared/kernel/domain.js';
import type { EventBus } from '../../shared/kernel/ports.js';
import { Candidate } from '../domain/candidate.js';
import type { CandidatePatch, CandidateState, DocumentType } from '../domain/candidate.js';
import { sourceOf } from '../domain/provenance.js';
import type { FieldSource } from '../domain/provenance.js';
import type { DocumentStore, TalentUnitOfWork } from './ports.js';
import type { AITaskDispatcher } from '../../shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../shared/kernel/ai/index.js';

export const TALENT_PERMISSIONS = {
  CREATE: 'candidate.create',
  EDIT: 'candidate.edit',
  VIEW_ALL: 'candidate.view_all',
  VIEW_OWN: 'candidate.view_own',
  UPLOAD_DOCUMENT: 'candidate.upload_document',
  DELETE_DOCUMENT: 'candidate.delete_document',
  CHANGE_STATE: 'candidate.change_state',
  ASSIGN_OWNER: 'candidate.assign_owner',
  REVIEW_PROPOSAL: 'candidate.review_proposal',
} as const;

export interface CandidateSummary {
  readonly id: number;
  readonly candidateNo: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly state: CandidateState;
  readonly ownerRecruiterId: number | null;
  readonly documentCount: number;
  readonly version: number;
  /** field -> USER | AI_APPROVED | IMPORT. The UI badges from this. */
  readonly fieldSources: Readonly<Record<string, FieldSource>>;
}

export interface DuplicateWarning {
  readonly candidateId: number;
  readonly matchedOn: readonly string[];
}

export interface CreateCandidateResult {
  readonly candidate: CandidateSummary;
  /**
   * Possible duplicates, reported not enforced.
   *
   * Creation is never blocked: two people genuinely do share a family email
   * address, and a recruiter with the person on the phone must not be stopped
   * by a heuristic. The UI shows this and lets them decide.
   */
  readonly possibleDuplicates: readonly DuplicateWarning[];
}

export interface CandidateServiceDeps {
  readonly uow: TalentUnitOfWork;
  readonly events: EventBus;
  readonly documents: DocumentStore;
  readonly clock?: Clock;
  /**
   * OPTIONAL. Absent means no parse task is ever submitted and everything here
   * behaves exactly as it did before AI existed — which is the required
   * behaviour, not a degraded mode.
   */
  readonly ai?: AITaskDispatcher;
}

export class CandidateService {
  private readonly uow: TalentUnitOfWork;
  private readonly events: EventBus;
  private readonly documents: DocumentStore;
  private readonly clock: Clock;
  private readonly ai: AITaskDispatcher | null;

  constructor(deps: CandidateServiceDeps) {
    this.uow = deps.uow;
    this.events = deps.events;
    this.documents = deps.documents;
    this.clock = deps.clock ?? systemClock;
    this.ai = deps.ai ?? null;
  }

  async create(
    input: { fullName: string; ownerRecruiterId?: number | null } & CandidatePatch,
    ctx: AuthContext,
  ): Promise<CreateCandidateResult> {
    this.require(ctx, TALENT_PERMISSIONS.CREATE);
    const now = this.clock.now();

    const { result, events } = await this.uow.transaction(async (tx) => {
      const id = await tx.candidates.nextId(ctx);
      const candidateNo = await tx.candidates.nextCandidateNo(ctx);

      const candidate = Candidate.create({
        ...input, id, tenantId: ctx.tenantId, candidateNo,
        ownerRecruiterId: input.ownerRecruiterId ?? ctx.userId,
        actor: ctx.actor, now,
      });
      await tx.candidates.save(candidate);

      const duplicates = await tx.candidates.findPotentialDuplicates({
        email: input.email ?? null,
        phone: input.phone ?? null,
        linkedinUrl: input.linkedinUrl ?? null,
      }, ctx, { excludeCandidateId: id });

      return {
        result: {
          candidate: summarise(candidate),
          possibleDuplicates: duplicates.map((d) => ({
            candidateId: d.candidateId, matchedOn: d.matchedOn,
          })),
        },
        events: candidate.pullEvents(),
      };
    });

    await this.publish(events);
    return result;
  }

  async update(
    id: number, patch: CandidatePatch, ctx: AuthContext, expectedVersion?: number,
  ): Promise<CandidateSummary> {
    this.require(ctx, TALENT_PERMISSIONS.EDIT);
    const now = this.clock.now();
    return this.mutate(id, ctx, expectedVersion, (c) => { c.update(patch, ctx.actor, now); });
  }

  async assignOwner(
    id: number, recruiterId: number | null, ctx: AuthContext, expectedVersion?: number,
  ): Promise<CandidateSummary> {
    this.require(ctx, TALENT_PERMISSIONS.ASSIGN_OWNER);
    return this.mutate(id, ctx, expectedVersion, (c) => { c.assignOwner(recruiterId, ctx.actor); });
  }

  async changeState(
    id: number, to: CandidateState, reason: string | null,
    ctx: AuthContext, expectedVersion?: number,
  ): Promise<CandidateSummary> {
    this.require(ctx, TALENT_PERMISSIONS.CHANGE_STATE);
    return this.mutate(id, ctx, expectedVersion, (c) => { c.changeState(to, reason, ctx.actor); });
  }

  /**
   * Attach a document.
   *
   * Bytes go to the store FIRST, keyed by content hash. If the transaction then
   * fails, the store holds an unreferenced blob — which a sweep can clean up.
   * The opposite order loses the file while claiming to hold it, and a lost CV
   * is not recoverable.
   */
  async attachDocument(
    id: number,
    input: {
      docType: DocumentType; fileName: string; mimeType: string;
      bytes: Uint8Array; fileHash: string; note?: string | null;
    },
    ctx: AuthContext,
    expectedVersion?: number,
  ): Promise<CandidateSummary> {
    this.require(ctx, TALENT_PERMISSIONS.UPLOAD_DOCUMENT);
    const now = this.clock.now();

    await this.documents.put({
      fileHash: input.fileHash, bytes: input.bytes,
      mimeType: input.mimeType, fileName: input.fileName,
    });

    const documentId = `${input.fileHash.slice(0, 16)}-${input.docType.toLowerCase()}`;

    // ONE TRANSACTION for the document AND its parse task.
    //
    // Submitting after commit left a window in which a process crash produced a
    // committed CV with no task queued — a silently unparsed document that only
    // a re-upload would fix. The dispatcher writes a row, so it joins this
    // transaction like any other write; the WORKER stays fully asynchronous.
    const { result, events } = await this.uow.transaction(async (tx) => {
      const candidate = await tx.candidates.findByIdForUpdate(id, ctx);
      if (!candidate) throw new NotFoundError('Candidate', id);
      if (expectedVersion !== undefined && candidate.version !== expectedVersion) {
        throw new StaleAggregateError('Candidate', id, expectedVersion, candidate.version);
      }

      candidate.attachDocument({
        documentId,
        docType: input.docType,
        fileName: input.fileName,
        fileHash: input.fileHash,
        fileSize: input.bytes.byteLength,
        mimeType: input.mimeType,
        note: input.note ?? null,
        uploadedBy: ctx.userId,
      }, ctx.actor, now);
      await tx.candidates.save(candidate);

      if (this.ai !== null && input.docType === 'CV') {
        await this.ai.submit({
          capability: AI_CAPABILITIES.RESUME_EXTRACT,
          input: {
            candidateId: id,
            documentId,
            fileHash: input.fileHash,
            fileName: input.fileName,
            mimeType: input.mimeType,
          },
          entityRef: { entityType: 'Candidate', entityId: id },
          // Same document, same task — a retried upload must not re-run a model.
          idempotencyKey: `resume.extract:${id}:${input.fileHash}`,
          tenantId: ctx.tenantId,
          priority: 'STANDARD',
        });
      }

      return { result: summarise(candidate), events: candidate.pullEvents() };
    });

    await this.publish(events);
    return result;
  }

  async removeDocument(
    id: number, documentId: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<CandidateSummary> {
    this.require(ctx, TALENT_PERMISSIONS.DELETE_DOCUMENT);
    // The blob is deliberately NOT deleted: the same hash may be attached to
    // another candidate, and a shared CV is normal when two recruiters source
    // the same person. Orphans are a sweep's problem.
    return this.mutate(id, ctx, expectedVersion, (c) => { c.removeDocument(documentId, ctx.actor); });
  }

  async findDuplicates(
    probe: { email?: string | null; phone?: string | null; linkedinUrl?: string | null },
    ctx: AuthContext,
  ): Promise<readonly DuplicateWarning[]> {
    this.require(ctx, TALENT_PERMISSIONS.VIEW_ALL, TALENT_PERMISSIONS.VIEW_OWN);
    return this.uow.transaction(async (tx) =>
      (await tx.candidates.findPotentialDuplicates(probe, ctx))
        .map((d) => ({ candidateId: d.candidateId, matchedOn: d.matchedOn })));
  }

  /* ------------------------------- internals ------------------------------- */

  private async mutate(
    id: number,
    ctx: AuthContext,
    expectedVersion: number | undefined,
    change: (candidate: Candidate) => void,
  ): Promise<CandidateSummary> {
    const { result, events } = await this.uow.transaction(async (tx) => {
      const candidate = await tx.candidates.findByIdForUpdate(id, ctx);
      if (!candidate) throw new NotFoundError('Candidate', id);
      if (expectedVersion !== undefined && candidate.version !== expectedVersion) {
        throw new StaleAggregateError('Candidate', id, expectedVersion, candidate.version);
      }

      change(candidate);
      await tx.candidates.save(candidate);
      return { result: summarise(candidate), events: candidate.pullEvents() };
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

export const summarise = (candidate: Candidate): CandidateSummary => {
  const state = candidate.toState();
  const fieldSources: Record<string, FieldSource> = {};
  for (const field of Object.keys(state.provenance)) {
    fieldSources[field] = sourceOf(state.provenance, field);
  }
  return {
    id: state.id,
    candidateNo: state.candidateNo,
    fullName: state.fullName,
    email: state.email,
    phone: state.phone,
    state: state.state,
    ownerRecruiterId: state.ownerRecruiterId,
    documentCount: state.documents.length,
    version: state.version,
    fieldSources,
  };
};
