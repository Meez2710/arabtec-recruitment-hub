// Assessment model — a direct transcription of the Arabtec Construction
// INTERVIEW ASSESSMENT FORM. Criteria, hints, score guide, critical flags,
// decisions and fit thresholds all come from that sheet. Nothing here is
// invented; where the sheet is silent, this file is silent.

export type ScoreValue = 1 | 2 | 3 | 4 | 5;
/** The sheet offers "N/A Not Applicable" alongside 1–5. */
export type Score = ScoreValue | 'NA';

export interface Criterion {
  readonly key: string;
  readonly label: string;
  /** The sheet's "What to Evaluate" column, shown inline on the form. */
  readonly hint: string;
}

/** Section 1 — "HR Assessment — Behavioral (Big Five Model)". */
export const BEHAVIOURAL_CRITERIA: readonly Criterion[] = [
  { key: 'openness', label: 'Openness',
    hint: 'Adaptability, learning agility, response to new systems and processes.' },
  { key: 'conscientiousness', label: 'Conscientiousness',
    hint: 'Reliability, follow-through, accountability, documentation discipline.' },
  { key: 'extraversion', label: 'Extraversion',
    hint: 'Communication clarity, assertiveness, stakeholder coordination.' },
  { key: 'agreeableness', label: 'Agreeableness',
    hint: 'Cooperation, respect, teamwork without passivity.' },
  { key: 'emotional_stability', label: 'Emotional Stability',
    hint: 'Composure under pressure, stress tolerance, conflict response.' },
];

/** Section 2 — "Technical Assessment — Role Competency". */
export const TECHNICAL_CRITERIA: readonly Criterion[] = [
  { key: 'technical_knowledge', label: 'Technical Knowledge',
    hint: 'Role-specific expertise and depth of knowledge for the position.' },
  { key: 'relevant_experience', label: 'Relevant Experience',
    hint: 'Years, project complexity and similarity to current scope.' },
  { key: 'problem_solving', label: 'Problem-Solving',
    hint: 'Critical thinking, structured approach, sound decision-making.' },
  { key: 'tools_software', label: 'Tools & Software',
    hint: 'Proficiency with role-required software, systems and tools.' },
  { key: 'planning_organizing', label: 'Planning & Organizing',
    hint: 'Prioritization, scheduling, resource and risk management.' },
];

/** "Score Guide" as printed on the sheet. */
export const SCORE_GUIDE: Readonly<Record<ScoreValue, string>> = {
  5: 'Excellent', 4: 'Proficient', 3: 'Average', 2: 'Below Standard', 1: 'Unsuitable',
};

/** "Critical Flags — Review if Any Are True". */
export const CRITICAL_FLAGS: readonly Criterion[] = [
  { key: 'blaming', label: 'Repeated blaming of others or no ownership', hint: '' },
  { key: 'no_evidence', label: 'No specific examples or evidence provided', hint: '' },
  { key: 'cv_inconsistency', label: 'Inconsistencies between CV and stated experience', hint: '' },
];

/** "Final Recommendation — Decision". */
export const DECISIONS = ['PROCEED', 'PROCEED_WITH_CONDITIONS', 'HOLD', 'CV_POOL', 'REJECT'] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_LABELS: Readonly<Record<Decision, string>> = {
  PROCEED: 'Proceed',
  PROCEED_WITH_CONDITIONS: 'Proceed with Conditions',
  HOLD: 'Hold',
  CV_POOL: 'CV Pool',
  REJECT: 'Reject',
};

/** Fit bands, with the exact thresholds printed on the sheet. */
export const FIT_BANDS = [
  { key: 'STRONG', label: 'Strong', min: 4.2 },
  { key: 'ACCEPTABLE', label: 'Acceptable', min: 3.5 },
  { key: 'BORDERLINE', label: 'Borderline', min: 3.0 },
  { key: 'WEAK', label: 'Weak', min: 0 },
] as const;

export type FitBand = (typeof FIT_BANDS)[number]['key'];

/**
 * Which section an evaluator completes.
 * The sheet has two signature blocks — HR Interviewer and Technical Interviewer —
 * which map onto the Recruiter and Hiring Manager roles.
 */
export type EvaluatorRole = 'RECRUITER' | 'HIRING_MANAGER';

export function criteriaFor(role: EvaluatorRole): readonly Criterion[] {
  return role === 'RECRUITER' ? BEHAVIOURAL_CRITERIA : TECHNICAL_CRITERIA;
}

export interface Assessment {
  readonly evaluatorRole: EvaluatorRole;
  readonly evaluatorUserId: number;
  readonly evaluatorName: string;
  /** criterionKey -> Score. Absent keys are unscored, which is not the same as N/A. */
  readonly scores: Readonly<Record<string, Score>>;
  readonly criticalFlags: Readonly<Record<string, boolean>>;
  readonly justification: string;
  readonly submittedAt: Date;
}

/**
 * Mean of the numeric scores. 'NA' is EXCLUDED from the denominator — a criterion
 * marked not-applicable must not drag the average down, which is the difference
 * between "we did not assess this" and "they scored zero".
 *
 * Returns null when nothing numeric was scored, so callers cannot mistake an
 * unscored assessment for a zero.
 */
export function averageScore(scores: Readonly<Record<string, Score>>): number | null {
  const numeric = Object.values(scores).filter((s): s is ScoreValue => s !== 'NA');
  if (numeric.length === 0) return null;
  const total = numeric.reduce<number>((sum, s) => sum + s, 0);
  return total / numeric.length;
}

/** Map an average onto a fit band using the sheet's thresholds. */
export function fitBandFor(average: number | null): FitBand | null {
  if (average === null) return null;
  for (const band of FIT_BANDS) {
    if (average >= band.min) return band.key;
  }
  return 'WEAK';
}

export function hasAnyCriticalFlag(flags: Readonly<Record<string, boolean>>): boolean {
  return Object.values(flags).some(Boolean);
}

/** How complete an assessment is, for the "N of M scored" progress indicator. */
export function completeness(
  role: EvaluatorRole, scores: Readonly<Record<string, Score>>,
): { scored: number; total: number } {
  const criteria = criteriaFor(role);
  const scored = criteria.filter((c) => scores[c.key] !== undefined).length;
  return { scored, total: criteria.length };
}
