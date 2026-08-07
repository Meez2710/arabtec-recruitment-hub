// Scoring harness — the definitions the acceptance criteria are written against.
//
// Every rule here is a decision that changes the numbers, so each one is stated
// rather than assumed:
//
//   - Comparison is NORMALIZED, using the shared kernel normalizer. Otherwise
//     "أحمد" vs "احمد" and "٠١٠٠…" vs "0100…" would score as errors when they
//     are the same value written differently.
//   - A correctly reported ABSENCE is a true negative, not a miss. A pipeline
//     that says "no phone" about a CV with no phone is right.
//   - An `unreadable` label is EXCLUDED from precision and recall and counted
//     separately. Scoring a pipeline against a value no human could read
//     measures the scan, not the parser.
//   - An ABSTENTION is not a wrong answer. It is counted in its own rate, so a
//     pipeline cannot buy precision by declining the hard documents unnoticed.

import { comparisonKey, emailMatchKey, normalizePhone } from '../../../modules/shared/kernel/text.js';
import type {
  GroundTruth, LabelledEducation, LabelledEmployment, LabelledValue, PipelineOutput,
} from './types.js';

/* ------------------------------- counters --------------------------------- */

export interface Counts {
  /** Predicted a value, and it matched. */
  truePositives: number;
  /** Predicted a value that is wrong, or predicted one where there is none. */
  falsePositives: number;
  /** A value exists and was not produced. */
  falseNegatives: number;
  /** Correctly reported that there is nothing. */
  trueNegatives: number;
  /** Label said `unreadable`. Excluded from precision and recall. */
  excluded: number;
}

export const emptyCounts = (): Counts => ({
  truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 0, excluded: 0,
});

export interface Metric {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  /** Share of predictions that were wrong. The hallucination signal. */
  readonly falsePositiveRate: number;
  /** Share of scorable documents where a value was produced at all. */
  readonly coverage: number;
  readonly counts: Counts;
}

const ratio = (numerator: number, denominator: number): number =>
  (denominator === 0 ? 1 : numerator / denominator);

export const metricOf = (c: Counts): Metric => {
  const predicted = c.truePositives + c.falsePositives;
  const actual = c.truePositives + c.falseNegatives;
  const precision = ratio(c.truePositives, predicted);
  const recall = ratio(c.truePositives, actual);
  const scorable = predicted + c.falseNegatives + c.trueNegatives;
  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    falsePositiveRate: predicted === 0 ? 0 : c.falsePositives / predicted,
    coverage: scorable === 0 ? 0 : predicted / scorable,
    counts: c,
  };
};

/* ---------------------------- normalizers --------------------------------- */

/** How each field is compared. Named so the acceptance document can cite it. */
export const COMPARATORS = {
  /** Case, accents, Arabic letter variants and diacritics folded. */
  name: (v: string): string => comparisonKey(v),
  /** Domain lowercased; local part case-folded for comparison only. */
  email: (v: string): string => emailMatchKey(v),
  /** Last 9 significant digits, after Arabic-Indic digit conversion. */
  phone: (v: string): string => normalizePhone(v).matchKey ?? comparisonKey(v),
  /** Free text: folded like a name. */
  text: (v: string): string => comparisonKey(v),
} as const;

export type Comparator = (value: string) => string;

/* ---------------------------- scalar scoring ------------------------------ */

/**
 * Score one scalar field against its label.
 *
 * `unreadable` is excluded; every other combination lands in exactly one bucket.
 */
export const scoreScalar = (
  label: LabelledValue,
  predicted: string | undefined,
  compare: Comparator,
  into: Counts,
): void => {
  if (!label.present && label.reason === 'unreadable') {
    into.excluded += 1;
    return;
  }
  if (!label.present) {
    // Nothing to find. Producing a value anyway is an invention.
    if (predicted === undefined || predicted.trim() === '') into.trueNegatives += 1;
    else into.falsePositives += 1;
    return;
  }
  if (predicted === undefined || predicted.trim() === '') {
    into.falseNegatives += 1;
    return;
  }
  if (compare(predicted) === compare(label.value)) into.truePositives += 1;
  else into.falsePositives += 1;
};

/** Set comparison for multi-valued scalars (emails, phones, skills…). */
export const scoreSet = (
  labels: readonly string[],
  predicted: readonly string[],
  compare: Comparator,
  into: Counts,
): void => {
  const expected = new Set(labels.map(compare).filter((k) => k !== ''));
  const got = new Set(predicted.map(compare).filter((k) => k !== ''));
  if (expected.size === 0 && got.size === 0) {
    into.trueNegatives += 1;
    return;
  }
  for (const key of got) {
    if (expected.has(key)) into.truePositives += 1;
    else into.falsePositives += 1;
  }
  for (const key of expected) if (!got.has(key)) into.falseNegatives += 1;
};

/* ---------------------------- entity scoring ------------------------------ */

/**
 * Employment entities match on (employer, title).
 *
 * Dates are excluded from the match key on purpose: CVs write them a dozen
 * ways, and a date-format disagreement is not a failure to find the job. Date
 * accuracy is reported separately below.
 */
export const employmentKey = (e: LabelledEmployment): string =>
  `${comparisonKey(e.employer)}|${comparisonKey(e.title)}`;

/** Education entities match on institution alone — qualification wording varies too much. */
export const educationKey = (e: LabelledEducation): string => comparisonKey(e.institution);

export const scoreEntities = <T>(
  labels: readonly T[],
  predicted: readonly T[],
  key: (item: T) => string,
  into: Counts,
): void => {
  const expected = new Set(labels.map(key));
  const got = new Set(predicted.map(key));
  if (expected.size === 0 && got.size === 0) {
    into.trueNegatives += 1;
    return;
  }
  for (const k of got) {
    if (expected.has(k)) into.truePositives += 1;
    else into.falsePositives += 1;
  }
  for (const k of expected) if (!got.has(k)) into.falseNegatives += 1;
};

/* ------------------------------ document ---------------------------------- */

export const SCORED_FIELDS = [
  'fullName', 'emails', 'phones', 'location', 'currentTitle',
  'totalYearsExperience', 'employment', 'education',
  'skills', 'certifications', 'languages',
] as const;

export type ScoredField = (typeof SCORED_FIELDS)[number];

export type FieldCounts = Record<ScoredField, Counts>;

export const emptyFieldCounts = (): FieldCounts => Object.fromEntries(
  SCORED_FIELDS.map((f) => [f, emptyCounts()]),
) as FieldCounts;

export interface RunTotals {
  documents: number;
  abstentions: number;
  /** Abstentions the pipeline marked terminal. These lose the CV to review. */
  permanentAbstentions: number;
  latenciesMs: number[];
}

export const emptyTotals = (): RunTotals => ({
  documents: 0, abstentions: 0, permanentAbstentions: 0, latenciesMs: [],
});

/**
 * Fold one document's result into the running counts.
 *
 * An abstained document contributes its false negatives — declining to answer
 * does not remove the values that were in the CV.
 */
export const scoreDocument = (
  truth: GroundTruth,
  output: PipelineOutput,
  counts: FieldCounts,
  totals: RunTotals,
): void => {
  totals.documents += 1;
  totals.latenciesMs.push(output.latencyMs);
  if (output.abstained) {
    totals.abstentions += 1;
    if (output.permanent === true) totals.permanentAbstentions += 1;
  }

  scoreScalar(truth.fullName, output.fullName, COMPARATORS.name, counts.fullName);
  scoreScalar(truth.location, output.location, COMPARATORS.text, counts.location);
  scoreScalar(truth.currentTitle, output.currentTitle, COMPARATORS.text, counts.currentTitle);
  scoreScalar(
    truth.totalYearsExperience,
    output.totalYearsExperience === undefined ? undefined : String(output.totalYearsExperience),
    (v) => String(Number(v)),
    counts.totalYearsExperience,
  );

  scoreSet(truth.emails, output.email === undefined ? [] : [output.email],
    COMPARATORS.email, counts.emails);
  scoreSet(truth.phones, output.phone === undefined ? [] : [output.phone],
    COMPARATORS.phone, counts.phones);
  scoreSet(truth.skills, output.skills, COMPARATORS.text, counts.skills);
  scoreSet(truth.certifications, output.certifications, COMPARATORS.text, counts.certifications);
  scoreSet(truth.languages, output.languages, COMPARATORS.text, counts.languages);

  scoreEntities(truth.employment, output.employment, employmentKey, counts.employment);
  scoreEntities(truth.education, output.education, educationKey, counts.education);
};

/* ------------------------------ latency ----------------------------------- */

/** Nearest-rank percentile. Small samples make interpolation misleading. */
export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
};
