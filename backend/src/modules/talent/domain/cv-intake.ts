// CvIntakeBatch aggregate — staging for bulk CV upload.
//
// WHY THIS EXISTS: a Candidate requires a name and a contact channel, and that
// invariant is not negotiable — an unreachable personal record is a GDPR
// liability with no business value. But a bulk upload is fifty PDFs with no
// names attached. So the files land HERE, are parsed here, and become
// Candidates only when a human has seen enough to satisfy the invariant.
//
//   upload -> parse task -> extracted fields on the item -> human review
//          -> Candidate.create (+ applyApprovedFields) -> item CONVERTED
//
// The extracted fields live on the ITEM rather than in a CandidateProposal
// because a proposal is bound to a candidate id, and at this stage there is no
// candidate to bind to. Once converted, the ordinary proposal workflow takes
// over for anything parsed later.

import type { Actor, DomainEvent } from '../../shared/kernel/domain.js';
import { TALENT_EVENTS } from './events.js';
import {
  IntakeBatchClosedError, IntakeItemNotFoundError, IntakeItemNotConvertibleError,
} from './errors.js';
import { isProposableField } from './candidate.js';
import type { ProposalGeneration } from './proposal.js';

export const INTAKE_BATCH_STATUSES = ['OPEN', 'COMPLETED', 'CANCELLED'] as const;
export type IntakeBatchStatus = (typeof INTAKE_BATCH_STATUSES)[number];

export const INTAKE_ITEM_STATUSES = [
  'PENDING_PARSE', 'PARSED', 'PARSE_FAILED', 'CONVERTED', 'DISCARDED',
] as const;
export type IntakeItemStatus = (typeof INTAKE_ITEM_STATUSES)[number];

/** A field the parser suggested. Same shape as a proposal's, deliberately. */
export interface IntakeField {
  readonly field: string;
  readonly value: unknown;
  readonly confidence: number;
  readonly evidence: string | null;
}

export interface IntakeItem {
  readonly itemId: string;
  readonly fileName: string;
  /** Content hash: the storage key, and the dedup key across the whole batch. */
  readonly fileHash: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly status: IntakeItemStatus;
  /** Populated once parsing succeeds. Empty until then. */
  readonly extracted: readonly IntakeField[];
  readonly generation: ProposalGeneration | null;
  /** Set once converted — the candidate this file became. */
  readonly candidateId: number | null;
  /** Why parsing failed, or why a human discarded it. */
  readonly note: string | null;
}

export interface CvIntakeBatchProps {
  id: number;
  tenantId: number;
  label: string;
  status: IntakeBatchStatus;
  uploadedBy: number;
  items: IntakeItem[];
  createdAt: Date;
  version: number;
}

export class CvIntakeBatch {
  private readonly props: CvIntakeBatchProps;
  private readonly events: DomainEvent[] = [];

  private constructor(props: CvIntakeBatchProps) {
    this.props = props;
  }

  static open(input: {
    id: number;
    tenantId: number;
    label: string;
    files: readonly {
      fileName: string; fileHash: string; mimeType: string; fileSize: number;
    }[];
    actor: Actor;
    now: Date;
  }): CvIntakeBatch {
    // Dedup WITHIN the batch by content hash: dragging a folder in twice, or a
    // file appearing under two names, must not create two intake items and two
    // parse tasks for the same bytes.
    const seen = new Set<string>();
    const items: IntakeItem[] = [];
    for (const file of input.files) {
      if (seen.has(file.fileHash)) continue;
      seen.add(file.fileHash);
      items.push({
        itemId: `${file.fileHash.slice(0, 16)}`,
        fileName: file.fileName,
        fileHash: file.fileHash,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        status: 'PENDING_PARSE',
        extracted: [],
        generation: null,
        candidateId: null,
        note: null,
      });
    }

    const batch = new CvIntakeBatch({
      id: input.id,
      tenantId: input.tenantId,
      label: input.label,
      status: 'OPEN',
      uploadedBy: input.actor.id,
      items,
      createdAt: input.now,
      version: 0,
    });

    batch.record(TALENT_EVENTS.INTAKE_BATCH_OPENED, {
      label: input.label,
      fileCount: items.length,
      duplicatesSkipped: input.files.length - items.length,
      by: input.actor.id, actorName: input.actor.name,
    });
    return batch;
  }

  static fromState(props: CvIntakeBatchProps): CvIntakeBatch {
    return new CvIntakeBatch(props);
  }

  get id(): number { return this.props.id; }
  get tenantId(): number { return this.props.tenantId; }
  get status(): IntakeBatchStatus { return this.props.status; }
  get version(): number { return this.props.version; }
  get items(): readonly IntakeItem[] { return this.props.items; }

  toState(): CvIntakeBatchProps {
    return { ...this.props, items: this.props.items.map((i) => ({ ...i })) };
  }

  pullEvents(): DomainEvent[] {
    return this.events.splice(0, this.events.length);
  }

  item(itemId: string): IntakeItem {
    const found = this.props.items.find((i) => i.itemId === itemId);
    if (found === undefined) throw new IntakeItemNotFoundError(itemId);
    return found;
  }

  /**
   * Record what the parser extracted.
   *
   * Filtered to proposable fields at this boundary, exactly as a proposal is —
   * a parser must not be able to suggest `state` or `ownerRecruiterId` however
   * confident it is.
   */
  recordExtraction(input: {
    itemId: string;
    fields: readonly IntakeField[];
    generation: ProposalGeneration;
    actor: Actor;
  }): void {
    this.assertOpen();
    const item = this.item(input.itemId);
    // Late results for an item a human already dealt with are ignored, not an
    // error: a slow worker finishing after a discard is normal.
    if (item.status !== 'PENDING_PARSE') return;

    this.replace(input.itemId, {
      status: 'PARSED',
      extracted: input.fields.filter((f) => isProposableField(f.field)),
      generation: input.generation,
    });
    this.touch();
    this.record(TALENT_EVENTS.INTAKE_ITEM_PARSED, {
      itemId: input.itemId, fieldCount: input.fields.length,
      modelId: input.generation.modelId,
    });
  }

  recordParseFailure(itemId: string, reason: string): void {
    const item = this.item(itemId);
    if (item.status !== 'PENDING_PARSE') return;
    this.replace(itemId, { status: 'PARSE_FAILED', note: reason });
    this.touch();
    this.record(TALENT_EVENTS.INTAKE_ITEM_PARSE_FAILED, { itemId, reason });
  }

  /**
   * Check convertibility BEFORE any candidate work begins.
   *
   * Without this, a closed batch or an already-converted item is only noticed
   * after validation has run, so the caller sees "no name" when the real answer
   * is "this batch is finished" — a confusing error for a confusing reason.
   */
  ensureConvertible(itemId: string): IntakeItem {
    this.assertOpen();
    const item = this.item(itemId);
    if (item.status !== 'PARSED' && item.status !== 'PENDING_PARSE') {
      throw new IntakeItemNotConvertibleError(itemId, item.status);
    }
    return item;
  }

  /**
   * Mark an item converted.
   *
   * The Candidate is created by the SERVICE, through the ordinary aggregate,
   * under the ordinary invariants. This records the outcome; it does not
   * perform the creation, because an intake batch has no business knowing how
   * a candidate is built.
   */
  markConverted(itemId: string, candidateId: number, actor: Actor): void {
    this.assertOpen();
    const item = this.item(itemId);
    // A file may be converted from PARSED or straight from PENDING_PARSE — a
    // recruiter who recognises the name should not have to wait for a model.
    if (item.status !== 'PARSED' && item.status !== 'PENDING_PARSE') {
      throw new IntakeItemNotConvertibleError(itemId, item.status);
    }

    this.replace(itemId, { status: 'CONVERTED', candidateId });
    this.touch();
    this.record(TALENT_EVENTS.INTAKE_ITEM_CONVERTED, {
      itemId, candidateId, by: actor.id, actorName: actor.name,
    });
    this.completeIfSettled();
  }

  discard(itemId: string, reason: string, actor: Actor): void {
    this.assertOpen();
    const item = this.item(itemId);
    if (item.status === 'CONVERTED') {
      // Undoing a conversion would orphan a real candidate record.
      throw new IntakeItemNotConvertibleError(itemId, item.status);
    }
    if (item.status === 'DISCARDED') return;

    this.replace(itemId, { status: 'DISCARDED', note: reason });
    this.touch();
    this.record(TALENT_EVENTS.INTAKE_ITEM_DISCARDED, {
      itemId, reason, by: actor.id, actorName: actor.name,
    });
    this.completeIfSettled();
  }

  /** Close a batch with items still outstanding. Those become DISCARDED. */
  cancel(reason: string, actor: Actor): void {
    if (this.props.status !== 'OPEN') return;
    for (const item of this.props.items) {
      if (item.status === 'PENDING_PARSE' || item.status === 'PARSED'
        || item.status === 'PARSE_FAILED') {
        this.replace(item.itemId, { status: 'DISCARDED', note: reason });
      }
    }
    this.props.status = 'CANCELLED';
    this.touch();
    this.record(TALENT_EVENTS.INTAKE_BATCH_CLOSED, {
      status: 'CANCELLED', reason, by: actor.id, actorName: actor.name,
    });
  }

  get outstandingCount(): number {
    return this.props.items.filter(
      (i) => i.status === 'PENDING_PARSE' || i.status === 'PARSED'
        || i.status === 'PARSE_FAILED',
    ).length;
  }

  /* -------------------------------- internals ------------------------------ */

  /** Auto-complete once nothing is left to review — no "close" ceremony. */
  private completeIfSettled(): void {
    if (this.props.status !== 'OPEN' || this.outstandingCount > 0) return;
    this.props.status = 'COMPLETED';
    this.record(TALENT_EVENTS.INTAKE_BATCH_CLOSED, {
      status: 'COMPLETED',
      converted: this.props.items.filter((i) => i.status === 'CONVERTED').length,
    });
  }

  private replace(itemId: string, patch: Partial<IntakeItem>): void {
    this.props.items = this.props.items.map(
      (i) => (i.itemId === itemId ? { ...i, ...patch } : i),
    );
  }

  private assertOpen(): void {
    if (this.props.status !== 'OPEN') throw new IntakeBatchClosedError(this.props.status);
  }

  private touch(): void {
    this.props.version += 1;
  }

  private record(type: string, payload: Record<string, unknown>): void {
    this.events.push({ type, at: new Date(), payload: { batchId: this.props.id, ...payload } });
  }
}
