// CandidateProposal aggregate — suggested field values awaiting a human.
//
// This is what makes AI advisory in practice rather than in principle. An
// extraction never writes to a candidate; it raises a proposal, and a person
// accepts or rejects it field by field. The Candidate aggregate then applies the
// accepted subset through its ordinary `applyApprovedFields`, under its ordinary
// validation.
//
// NOT AI-SPECIFIC, deliberately. `origin` is an opaque string: a proposal can
// come from a résumé extraction, a bulk CSV import, or a recruiter pasting a
// LinkedIn profile. The review workflow is the same, so it is modelled once.
//
// Per-field decisions, not one accept button: an extraction is usually right
// about the name and wrong about the phone number, and forcing all-or-nothing
// means people accept bad data to get the good data.

import type { Actor, DomainEvent } from '../../shared/kernel/domain.js';
import { TALENT_EVENTS } from './events.js';
import { ProposalAlreadyResolvedError, UnknownProposalFieldError } from './errors.js';
import { isProposableField } from './candidate.js';

export const PROPOSAL_STATUSES = ['PENDING', 'APPLIED', 'REJECTED', 'SUPERSEDED'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const FIELD_DECISIONS = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;
export type FieldDecision = (typeof FIELD_DECISIONS)[number];

export interface ProposedField {
  readonly field: string;
  readonly value: unknown;
  /** 0..1, for presentation only. Never gates anything. */
  readonly confidence: number;
  /** Where in the source this came from, e.g. "page 1". Shown next to the value. */
  readonly evidence: string | null;
  readonly decision: FieldDecision;
}

/**
 * How this proposal was produced, in enough detail to reproduce it.
 *
 * Deliberately structural and provider-neutral: `capability` and `modelId` are
 * opaque strings the domain never interprets. When a model is upgraded, this is
 * what identifies which pending proposals came from the old one.
 *
 * Null for proposals a human or an import produced — there is nothing to
 * reproduce.
 */
export interface ProposalGeneration {
  readonly capability: string;
  readonly modelId: string;
  readonly promptVersionId: string;
  readonly documentHash: string | null;
  readonly parserVersion: string | null;
  readonly extractorVersion: string | null;
  readonly generatedAt: Date;
}

export interface CandidateProposalProps {
  id: number;
  tenantId: number;
  candidateId: number;
  /** Free-form: 'resume.extract', 'bulk.import', … Not an AI enum. */
  origin: string;
  /** Opaque correlation to whatever produced this. Empty for manual origins. */
  taskId: string;
  /** Opaque producer identity. Empty when no model was involved. */
  modelId: string;
  /** The document this was derived from, when there was one. */
  documentId: string | null;
  status: ProposalStatus;
  /** Null when no machine produced this. */
  generation: ProposalGeneration | null;
  fields: ProposedField[];
  reviewedBy: number | null;
  reviewedAt: Date | null;
  createdAt: Date;
  version: number;
}

export class CandidateProposal {
  private readonly props: CandidateProposalProps;
  private readonly events: DomainEvent[] = [];

  private constructor(props: CandidateProposalProps) {
    this.props = props;
  }

  static raise(input: {
    id: number;
    tenantId: number;
    candidateId: number;
    origin: string;
    taskId?: string;
    modelId?: string;
    documentId?: string | null;
    generation?: ProposalGeneration | null;
    fields: readonly { field: string; value: unknown; confidence?: number; evidence?: string | null }[];
    now: Date;
  }): CandidateProposal {
    // Filter to the whitelist HERE, at the boundary. A producer that offers
    // `state` or `ownerRecruiterId` gets those silently dropped rather than
    // stored and then rejected later — the proposal should only ever contain
    // things a reviewer is actually allowed to accept.
    const fields: ProposedField[] = input.fields
      .filter((f) => isProposableField(f.field))
      .map((f) => ({
        field: f.field,
        value: f.value,
        confidence: clamp(f.confidence ?? 0),
        evidence: f.evidence ?? null,
        decision: 'PENDING' as const,
      }));

    const proposal = new CandidateProposal({
      id: input.id,
      tenantId: input.tenantId,
      candidateId: input.candidateId,
      origin: input.origin,
      taskId: input.taskId ?? '',
      modelId: input.modelId ?? '',
      documentId: input.documentId ?? null,
      generation: input.generation ?? null,
      status: 'PENDING',
      fields,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: input.now,
      version: 0,
    });

    proposal.record(TALENT_EVENTS.PROPOSAL_RAISED, {
      candidateId: input.candidateId,
      origin: input.origin,
      fieldCount: fields.length,
      fields: fields.map((f) => f.field),
      modelId: input.modelId ?? null,
      taskId: input.taskId ?? null,
    });
    return proposal;
  }

  static fromState(props: CandidateProposalProps): CandidateProposal {
    return new CandidateProposal(props);
  }

  get id(): number { return this.props.id; }
  get tenantId(): number { return this.props.tenantId; }
  get candidateId(): number { return this.props.candidateId; }
  get status(): ProposalStatus { return this.props.status; }
  get taskId(): string { return this.props.taskId; }
  get modelId(): string { return this.props.modelId; }
  get version(): number { return this.props.version; }
  get fields(): readonly ProposedField[] { return this.props.fields; }
  get generation(): ProposalGeneration | null { return this.props.generation; }

  toState(): CandidateProposalProps {
    return { ...this.props, fields: this.props.fields.map((f) => ({ ...f })) };
  }

  pullEvents(): DomainEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /**
   * Record the reviewer's per-field decisions and close the proposal.
   *
   * Fields left out are REJECTED, not left pending: a review either happened or
   * it did not, and a half-reviewed proposal sitting in a queue forever is the
   * state that makes people stop trusting the queue.
   */
  review(
    decisions: Readonly<Record<string, boolean>>,
    actor: Actor,
    now: Date,
  ): void {
    if (this.props.status !== 'PENDING') {
      throw new ProposalAlreadyResolvedError(this.props.status);
    }
    for (const field of Object.keys(decisions)) {
      if (!this.props.fields.some((f) => f.field === field)) {
        throw new UnknownProposalFieldError(field);
      }
    }

    this.props.fields = this.props.fields.map((f) => ({
      ...f,
      decision: decisions[f.field] === true ? 'ACCEPTED' : 'REJECTED',
    }));

    const accepted = this.acceptedFields();
    this.props.status = accepted.length > 0 ? 'APPLIED' : 'REJECTED';
    this.props.reviewedBy = actor.id;
    this.props.reviewedAt = now;
    this.props.version += 1;

    this.record(TALENT_EVENTS.PROPOSAL_RESOLVED, {
      candidateId: this.props.candidateId,
      status: this.props.status,
      accepted: accepted.map((f) => f.field),
      rejected: this.props.fields.filter((f) => f.decision === 'REJECTED').map((f) => f.field),
      by: actor.id, actorName: actor.name,
    });
  }

  /**
   * Retire an unreviewed proposal because a newer one replaced it.
   *
   * Re-parsing a CV must not leave two live proposals for the same candidate:
   * a reviewer would have no way to know which one reflects the current file.
   */
  supersede(): void {
    if (this.props.status !== 'PENDING') return;
    this.props.status = 'SUPERSEDED';
    this.props.version += 1;
  }

  acceptedFields(): readonly ProposedField[] {
    return this.props.fields.filter((f) => f.decision === 'ACCEPTED');
  }

  /**
   * The accepted values as a patch for the Candidate aggregate.
   *
   * Returns a plain object. The candidate validates every value itself — an
   * accepted proposal is not a licence to bypass a rule, so a reviewer who
   * accepts `yearsExperience: 200` still gets an InvalidCandidateFieldError.
   */
  acceptedPatch(): Record<string, unknown> {
    return Object.fromEntries(this.acceptedFields().map((f) => [f.field, f.value]));
  }

  private record(type: string, payload: Record<string, unknown>): void {
    this.events.push({ type, at: new Date(), payload: { proposalId: this.props.id, ...payload } });
  }
}

const clamp = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
