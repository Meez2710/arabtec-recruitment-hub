// ProposalService — raise, review, apply.
//
// The complete AI-to-candidate path, and it contains no AI. `raise` takes values
// somebody already produced; whether that was a model, a CSV importer or a
// person pasting a profile is not this service's concern.
//
// `review` is the only way a proposed value reaches a candidate, and it runs the
// candidate's ordinary validation. Accepting `yearsExperience: 200` still fails.

import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import type { Clock, DomainEvent } from '../../shared/kernel/domain.js';
import { systemClock } from '../../shared/kernel/domain.js';
import type { EventBus } from '../../shared/kernel/ports.js';
import { CandidateProposal } from '../domain/proposal.js';
import type { ProposalGeneration, ProposalStatus } from '../domain/proposal.js';
import type { CandidatePatch } from '../domain/candidate.js';
import { TALENT_PERMISSIONS } from './candidate-service.js';
import type { TalentUnitOfWork } from './ports.js';

export interface ProposalSummary {
  readonly id: number;
  readonly candidateId: number;
  readonly origin: string;
  readonly status: ProposalStatus;
  readonly documentId: string | null;
  readonly generation: ProposalGeneration | null;
  readonly fields: readonly {
    readonly field: string;
    readonly value: unknown;
    readonly confidence: number;
    readonly evidence: string | null;
    readonly decision: string;
  }[];
  readonly version: number;
}

export interface ReviewResult {
  readonly proposal: ProposalSummary;
  readonly appliedFields: readonly string[];
  readonly candidateVersion: number;
}

export interface ProposalServiceDeps {
  readonly uow: TalentUnitOfWork;
  readonly events: EventBus;
  readonly clock?: Clock;
}

export class ProposalService {
  private readonly uow: TalentUnitOfWork;
  private readonly events: EventBus;
  private readonly clock: Clock;

  constructor(deps: ProposalServiceDeps) {
    this.uow = deps.uow;
    this.events = deps.events;
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Record suggested values for a candidate.
   *
   * Supersedes any pending proposal for the same candidate: two live proposals
   * would leave a reviewer unable to tell which reflects the current document.
   */
  async raise(input: {
    candidateId: number;
    origin: string;
    taskId?: string;
    modelId?: string;
    documentId?: string | null;
    /** Full reproduction metadata. Null for human and import origins. */
    generation?: ProposalGeneration | null;
    fields: readonly {
      field: string; value: unknown; confidence?: number; evidence?: string | null;
    }[];
  }, ctx: AuthContext): Promise<ProposalSummary> {
    const now = this.clock.now();

    const { result, events } = await this.uow.transaction(async (tx) => {
      const candidate = await tx.candidates.findById(input.candidateId, ctx);
      if (!candidate) throw new NotFoundError('Candidate', input.candidateId);

      const pending = await tx.proposals.findPendingForCandidate(input.candidateId, ctx);
      for (const stale of pending) {
        stale.supersede();
        await tx.proposals.save(stale);
      }

      const proposal = CandidateProposal.raise({
        ...input,
        id: await tx.proposals.nextId(ctx),
        tenantId: ctx.tenantId,
        now,
      });
      await tx.proposals.save(proposal);

      return { result: summariseProposal(proposal), events: proposal.pullEvents() };
    });

    await this.publish(events);
    return result;
  }

  /**
   * Apply the reviewer's decisions.
   *
   * Proposal and candidate move in ONE transaction: a proposal marked applied
   * whose values never reached the candidate is worse than either failing, and
   * it is unrecoverable without reading the audit trail.
   */
  async review(
    proposalId: number,
    decisions: Readonly<Record<string, boolean>>,
    ctx: AuthContext,
    expectedVersion?: number,
  ): Promise<ReviewResult> {
    this.require(ctx, TALENT_PERMISSIONS.REVIEW_PROPOSAL, TALENT_PERMISSIONS.EDIT);
    const now = this.clock.now();

    const { result, events } = await this.uow.transaction(async (tx) => {
      const proposal = await tx.proposals.findByIdForUpdate(proposalId, ctx);
      if (!proposal) throw new NotFoundError('CandidateProposal', proposalId);
      if (expectedVersion !== undefined && proposal.version !== expectedVersion) {
        throw new StaleAggregateError(
          'CandidateProposal', proposalId, expectedVersion, proposal.version,
        );
      }

      const candidate = await tx.candidates.findByIdForUpdate(proposal.candidateId, ctx);
      if (!candidate) throw new NotFoundError('Candidate', proposal.candidateId);

      proposal.review(decisions, ctx.actor, now);
      const accepted = proposal.acceptedFields().map((f) => f.field);

      if (accepted.length > 0) {
        candidate.applyApprovedFields({
          patch: proposal.acceptedPatch() as CandidatePatch,
          taskId: proposal.taskId,
          modelId: proposal.modelId,
          actor: ctx.actor,
          now,
        });
        await tx.candidates.save(candidate);
      }
      await tx.proposals.save(proposal);

      return {
        result: {
          proposal: summariseProposal(proposal),
          appliedFields: accepted,
          candidateVersion: candidate.version,
        },
        events: [...proposal.pullEvents(), ...candidate.pullEvents()],
      };
    });

    await this.publish(events);
    return result;
  }

  async get(proposalId: number, ctx: AuthContext): Promise<ProposalSummary> {
    this.require(ctx, TALENT_PERMISSIONS.VIEW_ALL, TALENT_PERMISSIONS.VIEW_OWN);
    const proposal = await this.uow.transaction(async (tx) =>
      tx.proposals.findById(proposalId, ctx));
    if (!proposal) throw new NotFoundError('CandidateProposal', proposalId);
    return summariseProposal(proposal);
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

export const summariseProposal = (proposal: CandidateProposal): ProposalSummary => {
  const state = proposal.toState();
  return {
    id: state.id,
    candidateId: state.candidateId,
    origin: state.origin,
    status: state.status,
    documentId: state.documentId,
    generation: state.generation,
    fields: state.fields.map((f) => ({
      field: f.field, value: f.value, confidence: f.confidence,
      evidence: f.evidence, decision: f.decision,
    })),
    version: state.version,
  };
};
