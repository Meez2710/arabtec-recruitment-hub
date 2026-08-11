// Matching read-side port. Drizzle-free.

import type { AuthContext } from '../../modules/shared/kernel/auth-context.js';
import type { Page, PageRequest } from './ports.js';

export interface MatchView {
  readonly id: number;
  readonly candidateId: number;
  readonly candidateNo: string;
  readonly fullName: string;
  readonly currentPosition: string | null;
  readonly candidateState: string;
  /** 0..1, presentation only. */
  readonly score: number;
  readonly evidence: readonly { kind: string; detail: string; weight: number }[];
  readonly missingRequirements: readonly string[];
  readonly source: string;
  readonly generation: Record<string, unknown> | null;
  readonly status: string;
  readonly applicationId: number | null;
  readonly reason: string | null;
  readonly version: number;
}

export interface MatchFilters {
  readonly status?: readonly string[];
  readonly minScore?: number;
}

export interface MatchingReadModel {
  matchesFor(
    requisitionId: number, f: MatchFilters, p: PageRequest, ctx: AuthContext,
  ): Promise<Page<MatchView>>;
}
