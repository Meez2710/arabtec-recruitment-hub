// CandidateMatch — an advisory suggestion that a person may suit a requisition.
//
// ADVISORY, PERMANENTLY. Nothing here links a candidate to a requisition; that
// is `PipelineService.addCandidate`, performed by a human through the ordinary
// command under the ordinary rules. A match records "somebody thought this was
// worth looking at" and the outcome of a person looking.
//
// It carries no AI vocabulary. `source` is an opaque string, so a saved-search
// or a manual shortlist produces the same shape and the same review workflow.

import type { Actor, DomainEvent } from '../../shared/kernel/domain.js';
import { MATCHING_EVENTS } from './events.js';
import { MatchAlreadyResolvedError } from './errors.js';

export const MATCH_STATUSES = ['SUGGESTED', 'DISMISSED', 'LINKED'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** Why this person surfaced. Shown verbatim; never parsed. */
export interface MatchEvidenceItem {
  readonly kind: string;
  readonly detail: string;
  readonly weight: number;
}

export interface MatchGeneration {
  readonly capability: string;
  readonly modelId: string;
  readonly promptVersionId: string;
  readonly generatedAt: Date;
}

export interface CandidateMatchProps {
  id: number;
  tenantId: number;
  requisitionId: number;
  candidateId: number;
  /** 0..1. PRESENTATION ONLY — it never gates anything. */
  score: number;
  evidence: MatchEvidenceItem[];
  missingRequirements: string[];
  source: string;
  generation: MatchGeneration | null;
  status: MatchStatus;
  /** Set when a human links it: the application the link produced. */
  applicationId: number | null;
  resolvedBy: number | null;
  resolvedAt: Date | null;
  reason: string | null;
  createdAt: Date;
  version: number;
}

const clamp = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export class CandidateMatch {
  private readonly props: CandidateMatchProps;
  private readonly events: DomainEvent[] = [];

  private constructor(props: CandidateMatchProps) {
    this.props = props;
  }

  static suggest(input: {
    id: number;
    tenantId: number;
    requisitionId: number;
    candidateId: number;
    score: number;
    evidence?: readonly MatchEvidenceItem[];
    missingRequirements?: readonly string[];
    source: string;
    generation?: MatchGeneration | null;
    now: Date;
  }): CandidateMatch {
    const match = new CandidateMatch({
      id: input.id,
      tenantId: input.tenantId,
      requisitionId: input.requisitionId,
      candidateId: input.candidateId,
      score: clamp(input.score),
      evidence: [...(input.evidence ?? [])],
      missingRequirements: [...(input.missingRequirements ?? [])],
      source: input.source,
      generation: input.generation ?? null,
      status: 'SUGGESTED',
      applicationId: null,
      resolvedBy: null,
      resolvedAt: null,
      reason: null,
      createdAt: input.now,
      version: 0,
    });
    match.record(MATCHING_EVENTS.MATCH_SUGGESTED, {
      requisitionId: input.requisitionId,
      candidateId: input.candidateId,
      score: match.props.score,
      source: input.source,
    });
    return match;
  }

  static fromState(props: CandidateMatchProps): CandidateMatch {
    return new CandidateMatch(props);
  }

  get id(): number { return this.props.id; }
  get tenantId(): number { return this.props.tenantId; }
  get requisitionId(): number { return this.props.requisitionId; }
  get candidateId(): number { return this.props.candidateId; }
  get status(): MatchStatus { return this.props.status; }
  get version(): number { return this.props.version; }

  toState(): CandidateMatchProps {
    return {
      ...this.props,
      evidence: this.props.evidence.map((e) => ({ ...e })),
      missingRequirements: [...this.props.missingRequirements],
    };
  }

  pullEvents(): DomainEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /**
   * Refresh a suggestion that has not been acted on.
   *
   * A re-run must not resurrect something a human already dismissed — that is
   * how a "smart" feature becomes one people stop trusting.
   */
  refresh(input: {
    score: number;
    evidence?: readonly MatchEvidenceItem[];
    missingRequirements?: readonly string[];
    generation?: MatchGeneration | null;
  }): void {
    if (this.props.status !== 'SUGGESTED') return;
    this.props.score = clamp(input.score);
    this.props.evidence = [...(input.evidence ?? [])];
    this.props.missingRequirements = [...(input.missingRequirements ?? [])];
    if (input.generation !== undefined) this.props.generation = input.generation;
    this.props.version += 1;
  }

  dismiss(reason: string, actor: Actor, now: Date): void {
    if (this.props.status !== 'SUGGESTED') {
      throw new MatchAlreadyResolvedError(this.props.status);
    }
    this.props.status = 'DISMISSED';
    this.props.reason = reason;
    this.props.resolvedBy = actor.id;
    this.props.resolvedAt = now;
    this.props.version += 1;
    this.record(MATCHING_EVENTS.MATCH_DISMISSED, {
      requisitionId: this.props.requisitionId,
      candidateId: this.props.candidateId,
      reason, by: actor.id, actorName: actor.name,
    });
  }

  /**
   * Record that a human acted on this suggestion.
   *
   * Called AFTER the pipeline command succeeded. This aggregate does not create
   * the application — it only remembers that the suggestion led somewhere,
   * which is the only way to tell later whether matching was any use.
   */
  markLinked(applicationId: number, actor: Actor, now: Date): void {
    if (this.props.status !== 'SUGGESTED') {
      throw new MatchAlreadyResolvedError(this.props.status);
    }
    this.props.status = 'LINKED';
    this.props.applicationId = applicationId;
    this.props.resolvedBy = actor.id;
    this.props.resolvedAt = now;
    this.props.version += 1;
    this.record(MATCHING_EVENTS.MATCH_LINKED, {
      requisitionId: this.props.requisitionId,
      candidateId: this.props.candidateId,
      applicationId, by: actor.id, actorName: actor.name,
    });
  }

  private record(type: string, payload: Record<string, unknown>): void {
    this.events.push({ type, at: new Date(), payload: { matchId: this.props.id, ...payload } });
  }
}
