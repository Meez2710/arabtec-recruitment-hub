// Competency evaluation contracts. TYPES ONLY.
//
// SCOPE NOTE. This file deliberately does NOT define a résumé proposal, a
// proposed field, or a provenance record. Those already exist as
// `CandidateProposal`, `ProposedField` and `ProposalGeneration` in
// `modules/talent/domain/proposal.ts`, and that aggregate is the one that is
// reviewed and persisted. A second model of the same concept here would be a
// parallel truth about what the system believes a CV says.
//
// What has no existing equivalent is the competency VERDICT, because the parser
// this replaces expressed it as `score: 0-100` plus a `recommendation` string.

/**
 * The ONLY permitted competency verdicts.
 *
 * Qualitative by design. A percentage or a match score invites ranking people
 * by a number a model produced, which is neither calibrated nor explainable —
 * and an unexplainable ranking is one you cannot defend to the person it
 * affected.
 */
export const COMPETENCY_LEVELS = [
  'Exceeds Requirements',
  'Proficient',
  'Requires Development',
  'No Evidence Found',
] as const;

export type CompetencyLevel = (typeof COMPETENCY_LEVELS)[number];

/**
 * One competency, judged against supplied evidence only.
 *
 * `evidence` must quote the candidate data given to the evaluator. An evaluator
 * that cannot quote anything must return 'No Evidence Found' rather than a
 * level it inferred from a job title.
 */
export interface CompetencyAssessment {
  readonly competency: string;
  readonly level: CompetencyLevel;
  /** Verbatim quotes from the supplied candidate data. Never invented. */
  readonly evidence: readonly string[];
  readonly rationale: string;
}

export interface CandidateEvaluation {
  readonly competencies: readonly CompetencyAssessment[];
  readonly overall: CompetencyLevel;
  readonly summary: string;
  /** Requirements no supplied evidence spoke to. Surfaced, never guessed at. */
  readonly gaps: readonly string[];
  /** Opaque identifiers of what produced this. Never parsed. */
  readonly modelId: string;
  readonly promptVersionId: string;
  readonly documentId: string;
  readonly producedAt: Date;
}
