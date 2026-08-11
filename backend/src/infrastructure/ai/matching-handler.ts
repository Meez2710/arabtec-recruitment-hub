// Candidate matching — capability wiring, no model.
//
// Builds criteria from the requisition, asks the matcher, returns suggestions.
// Writes nothing: `MatchingService.recordSuggestions` persists, and a human
// still has to act before anybody enters a pipeline.

import { eq } from 'drizzle-orm';
import { hiringRequisition } from '../db/schema/index.js';
import type { Executor } from '../db/types.js';
import type { AICapabilities } from '../../modules/shared/kernel/ai/index.js';
import { isProposal } from '../../modules/shared/kernel/ai/index.js';
import type { MatchGeneration, SuggestionInput } from '../../modules/matching/index.js';

export interface MatchInput {
  readonly requisitionId: number;
  readonly limit?: number;
}

export type MatchOutcome =
  | {
      readonly kind: 'SUGGESTIONS';
      readonly suggestions: readonly SuggestionInput[];
      readonly generation: MatchGeneration;
    }
  | { readonly kind: 'ABSTAIN'; readonly reason: string; readonly permanent: boolean };

export const runCandidateMatch = async (
  input: MatchInput,
  deps: { capabilities: AICapabilities; db: Executor },
): Promise<MatchOutcome> => {
  const matcher = deps.capabilities.candidateMatcher;
  if (matcher === undefined) {
    // TEMPORARY — the requisition is fine, the environment has no matcher.
    return { kind: 'ABSTAIN', permanent: false, reason: 'No matching provider is configured.' };
  }

  const rows = await deps.db
    .select({ id: hiringRequisition.id, title: hiringRequisition.title })
    .from(hiringRequisition)
    .where(eq(hiringRequisition.id, input.requisitionId))
    .limit(1);

  if (rows[0] === undefined) {
    // PERMANENT — a deleted requisition does not come back.
    return {
      kind: 'ABSTAIN', permanent: true,
      reason: `Requisition ${input.requisitionId} no longer exists.`,
    };
  }

  const outcome = await matcher.match({
    requisitionId: input.requisitionId,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });

  if (!isProposal(outcome)) {
    return { kind: 'ABSTAIN', permanent: outcome.permanent, reason: outcome.reason };
  }
  if (outcome.content.length === 0) {
    // PERMANENT for this run: the matcher looked and found nobody. A retry
    // would search the same population and reach the same answer.
    return { kind: 'ABSTAIN', permanent: true, reason: 'No candidates matched.' };
  }

  return {
    kind: 'SUGGESTIONS',
    suggestions: outcome.content.map((m) => ({
      candidateId: m.candidateId,
      score: m.score,
      // The port names these dimension/contribution; the domain names them
      // kind/weight. Mapped here rather than renaming either side — the AI
      // contract and the aggregate are allowed to have their own vocabulary.
      evidence: m.evidence.map((e) => ({
        kind: e.dimension, detail: e.detail, weight: e.contribution,
      })),
      missingRequirements: m.missingRequirements,
    })),
    generation: {
      capability: outcome.provenance.capability,
      modelId: outcome.provenance.modelId,
      promptVersionId: outcome.provenance.promptVersionId,
      generatedAt: outcome.provenance.producedAt,
    },
  };
};
