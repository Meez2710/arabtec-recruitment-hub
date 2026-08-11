// Matching ports. Interfaces only.

import type { AuthContext } from '../../shared/kernel/auth-context.js';
import type { CandidateMatch } from '../domain/match.js';

export interface CandidateMatchRepository {
  findById(id: number, ctx: AuthContext): Promise<CandidateMatch | null>;
  findByIdForUpdate(id: number, ctx: AuthContext): Promise<CandidateMatch | null>;
  findByRequisition(requisitionId: number, ctx: AuthContext): Promise<CandidateMatch[]>;
  save(match: CandidateMatch): Promise<void>;
  nextId(ctx: AuthContext): Promise<number>;
}

export interface MatchingTransactionScope {
  readonly matches: CandidateMatchRepository;
}

export interface MatchingUnitOfWork {
  transaction<T>(fn: (tx: MatchingTransactionScope) => Promise<T>): Promise<T>;
}

/**
 * Matching -> Hiring (ADR-0007).
 *
 * The ONLY way this module reaches the pipeline. It cannot construct an
 * Application, set a stage, or bypass a hiring rule — it asks, and Hiring
 * decides.
 */
export interface PipelineLinkGateway {
  addCandidate(
    input: { requisitionId: number; candidateId: number },
    ctx: AuthContext,
  ): Promise<number>;
}
