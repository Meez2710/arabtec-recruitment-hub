// MatchingService — request suggestions, record them, act on them.
//
// AI IS ADVISORY HERE TOO. `requestMatching` submits a task; the worker records
// suggestions; a human dismisses or links. Linking calls the Hiring context's
// PUBLISHED operation through a gateway — this module never writes a pipeline
// stage and never constructs an Application.

import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import type { Clock, DomainEvent } from '../../shared/kernel/domain.js';
import { systemClock } from '../../shared/kernel/domain.js';
import type { EventBus } from '../../shared/kernel/ports.js';
import type { AITaskDispatcher } from '../../shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../shared/kernel/ai/index.js';
import { CandidateMatch } from '../domain/match.js';
import type { MatchEvidenceItem, MatchGeneration } from '../domain/match.js';
import type { MatchingUnitOfWork, PipelineLinkGateway } from './ports.js';

export const MATCHING_PERMISSIONS = {
  VIEW: 'matching.view',
  REQUEST: 'matching.request',
  RESOLVE: 'matching.resolve',
} as const;

export interface SuggestionInput {
  readonly candidateId: number;
  readonly score: number;
  readonly evidence?: readonly MatchEvidenceItem[];
  readonly missingRequirements?: readonly string[];
}

export interface MatchSummary {
  readonly id: number;
  readonly requisitionId: number;
  readonly candidateId: number;
  readonly score: number;
  readonly status: string;
  readonly applicationId: number | null;
  readonly version: number;
}

export interface MatchingServiceDeps {
  readonly uow: MatchingUnitOfWork;
  readonly events: EventBus;
  readonly pipeline: PipelineLinkGateway;
  readonly clock?: Clock;
  /** Optional. Without it no matching task is ever submitted. */
  readonly ai?: AITaskDispatcher;
}

export class MatchingService {
  private readonly uow: MatchingUnitOfWork;
  private readonly events: EventBus;
  private readonly pipeline: PipelineLinkGateway;
  private readonly clock: Clock;
  private readonly ai: AITaskDispatcher | null;

  constructor(deps: MatchingServiceDeps) {
    this.uow = deps.uow;
    this.events = deps.events;
    this.pipeline = deps.pipeline;
    this.clock = deps.clock ?? systemClock;
    this.ai = deps.ai ?? null;
  }

  /**
   * Queue a matching run for a requisition.
   *
   * `refreshToken` makes a deliberate re-run possible without defeating
   * idempotency: the same requisition asked for twice in a row is one task, but
   * a recruiter who edited the requisition and wants fresh suggestions passes a
   * new token and gets a new run.
   */
  async requestMatching(
    input: { requisitionId: number; limit?: number; refreshToken?: string },
    ctx: AuthContext,
  ): Promise<{ queued: boolean; taskId: string | null }> {
    this.require(ctx, MATCHING_PERMISSIONS.REQUEST);
    if (this.ai === null) return { queued: false, taskId: null };

    const handle = await this.uow.transaction(async () => this.ai!.submit({
      capability: AI_CAPABILITIES.CANDIDATE_MATCH,
      input: { requisitionId: input.requisitionId, limit: input.limit ?? 25 },
      entityRef: { entityType: 'Requisition', entityId: input.requisitionId },
      idempotencyKey:
        `candidate.match:${input.requisitionId}:${input.refreshToken ?? 'default'}`,
      tenantId: ctx.tenantId,
      priority: 'BATCH',
    }));

    return { queued: !handle.deduplicated, taskId: handle.taskId };
  }

  /**
   * Record what a matching run produced. Called by the worker, system context.
   *
   * Upserts: an existing SUGGESTED row is refreshed, a DISMISSED or LINKED one
   * is left alone. Re-running must never resurrect something a human settled.
   */
  async recordSuggestions(
    input: {
      requisitionId: number;
      source: string;
      generation?: MatchGeneration | null;
      suggestions: readonly SuggestionInput[];
    },
    ctx: AuthContext,
  ): Promise<{ created: number; refreshed: number; skipped: number }> {
    const now = this.clock.now();

    const { result, events } = await this.uow.transaction(async (tx) => {
      const existing = await tx.matches.findByRequisition(input.requisitionId, ctx);
      const byCandidate = new Map(existing.map((m) => [m.candidateId, m]));
      const drained: DomainEvent[] = [];
      let created = 0; let refreshed = 0; let skipped = 0;

      for (const suggestion of input.suggestions) {
        const current = byCandidate.get(suggestion.candidateId);
        if (current === undefined) {
          const match = CandidateMatch.suggest({
            id: await tx.matches.nextId(ctx),
            tenantId: ctx.tenantId,
            requisitionId: input.requisitionId,
            candidateId: suggestion.candidateId,
            score: suggestion.score,
            ...(suggestion.evidence !== undefined ? { evidence: suggestion.evidence } : {}),
            ...(suggestion.missingRequirements !== undefined
              ? { missingRequirements: suggestion.missingRequirements } : {}),
            source: input.source,
            generation: input.generation ?? null,
            now,
          });
          await tx.matches.save(match);
          drained.push(...match.pullEvents());
          created += 1;
          continue;
        }

        if (current.status !== 'SUGGESTED') { skipped += 1; continue; }
        current.refresh({
          score: suggestion.score,
          ...(suggestion.evidence !== undefined ? { evidence: suggestion.evidence } : {}),
          ...(suggestion.missingRequirements !== undefined
            ? { missingRequirements: suggestion.missingRequirements } : {}),
          generation: input.generation ?? null,
        });
        await tx.matches.save(current);
        drained.push(...current.pullEvents());
        refreshed += 1;
      }

      return { result: { created, refreshed, skipped }, events: drained };
    });

    await this.publish(events);
    return result;
  }

  async dismiss(
    matchId: number, reason: string, ctx: AuthContext, expectedVersion?: number,
  ): Promise<MatchSummary> {
    this.require(ctx, MATCHING_PERMISSIONS.RESOLVE);
    const now = this.clock.now();
    return this.mutate(matchId, ctx, expectedVersion, (m) => { m.dismiss(reason, ctx.actor, now); });
  }

  /**
   * Act on a suggestion: add the candidate to the pipeline.
   *
   * The application is created by the HIRING context through its published
   * operation, with that context's permissions and rules. This service only
   * records that the suggestion was taken up.
   */
  async link(
    matchId: number, ctx: AuthContext, expectedVersion?: number,
  ): Promise<MatchSummary> {
    this.require(ctx, MATCHING_PERMISSIONS.RESOLVE);
    const now = this.clock.now();

    const { result, events } = await this.uow.transaction(async (tx) => {
      const match = await tx.matches.findByIdForUpdate(matchId, ctx);
      if (!match) throw new NotFoundError('CandidateMatch', matchId);
      if (expectedVersion !== undefined && match.version !== expectedVersion) {
        throw new StaleAggregateError('CandidateMatch', matchId, expectedVersion, match.version);
      }

      const applicationId = await this.pipeline.addCandidate({
        requisitionId: match.requisitionId,
        candidateId: match.candidateId,
      }, ctx);

      match.markLinked(applicationId, ctx.actor, now);
      await tx.matches.save(match);
      return { result: summarise(match), events: match.pullEvents() };
    });

    await this.publish(events);
    return result;
  }

  private async mutate(
    matchId: number,
    ctx: AuthContext,
    expectedVersion: number | undefined,
    change: (match: CandidateMatch) => void,
  ): Promise<MatchSummary> {
    const { result, events } = await this.uow.transaction(async (tx) => {
      const match = await tx.matches.findByIdForUpdate(matchId, ctx);
      if (!match) throw new NotFoundError('CandidateMatch', matchId);
      if (expectedVersion !== undefined && match.version !== expectedVersion) {
        throw new StaleAggregateError('CandidateMatch', matchId, expectedVersion, match.version);
      }
      change(match);
      await tx.matches.save(match);
      return { result: summarise(match), events: match.pullEvents() };
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

export const summarise = (match: CandidateMatch): MatchSummary => {
  const s = match.toState();
  return {
    id: s.id, requisitionId: s.requisitionId, candidateId: s.candidateId,
    score: s.score, status: s.status, applicationId: s.applicationId, version: s.version,
  };
};
