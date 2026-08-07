// Per-cohort reporting.
//
// COHORTS ARE MANDATORY, NOT OPTIONAL DETAIL. An overall average hides exactly
// the failure this migration is most likely to produce: a pipeline that reads
// English digital CVs well and Arabic scans badly scores respectably overall
// while being unusable for a large part of the real inbox. Every report below
// prints per-cohort numbers and marks any cohort with too few documents to
// judge, rather than quietly reporting a number computed from three CVs.

import type {
  DocumentTrait, GroundTruth, LanguageCohort, PipelineOutput,
} from './types.js';
import type { FieldCounts, Metric, RunTotals, ScoredField } from './score.js';
import {
  SCORED_FIELDS, emptyFieldCounts, emptyTotals, metricOf, percentile, scoreDocument,
} from './score.js';

/** Below this, a cohort's percentages are noise. Reported, never hidden. */
export const MIN_COHORT_SIZE = 8;

export type CohortKey = LanguageCohort | DocumentTrait | 'all';

export interface CohortReport {
  readonly cohort: CohortKey;
  readonly documents: number;
  /** True when `documents < MIN_COHORT_SIZE`; percentages are indicative only. */
  readonly underpowered: boolean;
  readonly fields: Readonly<Record<ScoredField, Metric>>;
  readonly abstentionRate: number;
  readonly permanentAbstentionRate: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
}

export interface BenchmarkReport {
  readonly pipeline: string;
  readonly pinnedConfig: Readonly<Record<string, string>>;
  readonly split: 'tuning' | 'held-out';
  readonly manifestChecksum: string;
  readonly generatedAt: string;
  readonly overall: CohortReport;
  readonly byCohort: readonly CohortReport[];
}

export interface ScoredPair {
  readonly truth: GroundTruth;
  readonly output: PipelineOutput;
}

const buildCohort = (cohort: CohortKey, pairs: readonly ScoredPair[]): CohortReport => {
  const counts: FieldCounts = emptyFieldCounts();
  const totals: RunTotals = emptyTotals();
  for (const { truth, output } of pairs) scoreDocument(truth, output, counts, totals);

  const fields = Object.fromEntries(
    SCORED_FIELDS.map((f) => [f, metricOf(counts[f])]),
  ) as Record<ScoredField, Metric>;

  return {
    cohort,
    documents: totals.documents,
    underpowered: totals.documents < MIN_COHORT_SIZE,
    fields,
    abstentionRate: totals.documents === 0 ? 0 : totals.abstentions / totals.documents,
    permanentAbstentionRate: totals.documents === 0
      ? 0 : totals.permanentAbstentions / totals.documents,
    latencyP50Ms: percentile(totals.latenciesMs, 50),
    latencyP95Ms: percentile(totals.latenciesMs, 95),
  };
};

const LANGUAGES: readonly LanguageCohort[] = ['arabic', 'english', 'mixed'];
const TRAITS: readonly DocumentTrait[] = [
  'digital', 'scanned', 'image-heavy', 'single-column', 'multi-column',
  'has-tables', 'long', 'malformed',
];

/**
 * Build the full report.
 *
 * Cohorts overlap by design: a scanned Arabic multi-column CV appears in three
 * of them, because each answers a different question about the pipeline.
 */
export const buildReport = (input: {
  readonly pipeline: string;
  readonly pinnedConfig: Readonly<Record<string, string>>;
  readonly split: 'tuning' | 'held-out';
  readonly manifestChecksum: string;
  readonly generatedAt: string;
  readonly pairs: readonly ScoredPair[];
}): BenchmarkReport => {
  const byCohort: CohortReport[] = [];

  for (const language of LANGUAGES) {
    const pairs = input.pairs.filter((p) => p.truth.language === language);
    if (pairs.length > 0) byCohort.push(buildCohort(language, pairs));
  }
  for (const trait of TRAITS) {
    const pairs = input.pairs.filter((p) => p.truth.traits.includes(trait));
    if (pairs.length > 0) byCohort.push(buildCohort(trait, pairs));
  }

  return {
    pipeline: input.pipeline,
    pinnedConfig: input.pinnedConfig,
    split: input.split,
    manifestChecksum: input.manifestChecksum,
    generatedAt: input.generatedAt,
    overall: buildCohort('all', input.pairs),
    byCohort,
  };
};

/* ------------------------------ rendering --------------------------------- */

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** Markdown, safe to commit: counts and percentages only, never CV content. */
export const renderReport = (report: BenchmarkReport): string => {
  const lines: string[] = [
    `# Benchmark — ${report.pipeline} (${report.split})`,
    '',
    `Manifest checksum: \`${report.manifestChecksum}\``,
    `Generated: ${report.generatedAt}`,
    '',
    '## Pinned configuration',
    '',
    ...Object.entries(report.pinnedConfig).map(([k, v]) => `- \`${k}\`: ${v}`),
    '',
    '## Overall',
    '',
    '| Field | Precision | Recall | F1 | FP rate | Coverage |',
    '|---|---|---|---|---|---|',
  ];

  for (const field of SCORED_FIELDS) {
    const m = report.overall.fields[field];
    lines.push(`| ${field} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} `
      + `| ${pct(m.falsePositiveRate)} | ${pct(m.coverage)} |`);
  }

  lines.push(
    '',
    `Documents: ${report.overall.documents} · `
    + `abstentions: ${pct(report.overall.abstentionRate)} `
    + `(permanent ${pct(report.overall.permanentAbstentionRate)}) · `
    + `latency p50 ${report.overall.latencyP50Ms} ms / p95 ${report.overall.latencyP95Ms} ms`,
    '',
    '## By cohort',
    '',
    '| Cohort | n | Name | Email | Phone | Title | Work F1 | Edu F1 | Abstain |',
    '|---|---|---|---|---|---|---|---|---|',
  );

  for (const c of [report.overall, ...report.byCohort]) {
    const f = c.fields;
    const flag = c.underpowered ? ' ⚠︎' : '';
    lines.push(
      `| ${c.cohort}${flag} | ${c.documents} | ${pct(f.fullName.f1)} | ${pct(f.emails.f1)} `
      + `| ${pct(f.phones.f1)} | ${pct(f.currentTitle.f1)} | ${pct(f.employment.f1)} `
      + `| ${pct(f.education.f1)} | ${pct(c.abstentionRate)} |`,
    );
  }

  const weak = [report.overall, ...report.byCohort].filter((c) => c.underpowered);
  if (weak.length > 0) {
    lines.push(
      '',
      `⚠︎ Cohorts with fewer than ${MIN_COHORT_SIZE} documents — indicative only, `
      + `not evidence: ${weak.map((c) => c.cohort).join(', ')}.`,
    );
  }

  return `${lines.join('\n')}\n`;
};

/** Side-by-side, for the legacy-vs-new decision. Deltas in percentage points. */
export const renderComparison = (
  baseline: BenchmarkReport,
  candidate: BenchmarkReport,
): string => {
  const lines = [
    `# ${candidate.pipeline} vs ${baseline.pipeline} (${candidate.split})`,
    '',
    '| Field | Baseline F1 | New F1 | Δ pp |',
    '|---|---|---|---|',
  ];
  for (const field of SCORED_FIELDS) {
    const b = baseline.overall.fields[field].f1;
    const n = candidate.overall.fields[field].f1;
    const delta = (n - b) * 100;
    lines.push(`| ${field} | ${pct(b)} | ${pct(n)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} |`);
  }
  return `${lines.join('\n')}\n`;
};
