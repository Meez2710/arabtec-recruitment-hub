// Ground-truth annotation — schema, validation, and empty templates.
//
// TEMPLATES ARE EMPTY BY CONSTRUCTION. `blankTemplate` never pre-fills a value
// from a parser, because a label seeded with a machine's guess is not ground
// truth: an annotator confirming a pre-filled field measures the parser, not
// the CV. Every scalar starts as an explicit "unlabelled" marker that fails
// validation until a human replaces it.

import { z } from 'zod';
import type { CorpusEntry, GroundTruth } from './types.js';

export const ANNOTATION_SCHEMA_VERSION = 'ground-truth/1.0.0';

/** Placeholder written into a blank template. Rejected by the validator. */
export const UNLABELLED = '__UNLABELLED__';

const absenceReason = z.enum(['not-in-document', 'unreadable', 'unsupported-field']);

const labelledValue = z.union([
  z.object({ present: z.literal(true), value: z.string().trim().min(1) }).strict(),
  z.object({ present: z.literal(false), reason: absenceReason }).strict(),
]);

const employment = z.object({
  employer: z.string().trim().min(1),
  title: z.string().trim().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
  current: z.boolean().optional(),
}).strict();

const education = z.object({
  institution: z.string().trim().min(1),
  qualification: z.string().optional(),
  field: z.string().optional(),
  to: z.string().optional(),
}).strict();

export const groundTruthSchema = z.object({
  docId: z.string().regex(/^cv-[0-9a-f]{16}$/),
  annotator: z.string().trim().min(1).refine((v) => v !== UNLABELLED, 'annotator is unlabelled'),
  reviewedBy: z.string().trim().min(1).nullable(),
  language: z.enum(['arabic', 'english', 'mixed']),
  traits: z.array(z.enum([
    'digital', 'scanned', 'image-heavy', 'single-column', 'multi-column',
    'has-tables', 'long', 'malformed',
  ])),
  fullName: labelledValue,
  emails: z.array(z.string().trim().min(1)),
  phones: z.array(z.string().trim().min(1)),
  location: labelledValue,
  currentTitle: labelledValue,
  totalYearsExperience: labelledValue,
  employment: z.array(employment),
  education: z.array(education),
  skills: z.array(z.string().trim().min(1)),
  certifications: z.array(z.string().trim().min(1)),
  languages: z.array(z.string().trim().min(1)),
  note: z.string().optional(),
}).strict();

export type ValidationResult =
  | { readonly ok: true; readonly value: GroundTruth }
  | { readonly ok: false; readonly errors: readonly string[] };

export const validateGroundTruth = (raw: unknown): ValidationResult => {
  const parsed = groundTruthSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, value: parsed.data as GroundTruth };
};

/**
 * An empty label file for one document.
 *
 * The scalar fields carry the UNLABELLED marker so an untouched template is
 * REJECTED rather than silently scored as "everything absent" — which would
 * hand a perfect score to a pipeline that extracts nothing.
 */
export const blankTemplate = (entry: CorpusEntry): Record<string, unknown> => ({
  docId: entry.docId,
  annotator: UNLABELLED,
  reviewedBy: null,
  language: UNLABELLED,
  traits: [],
  fullName: { present: true, value: UNLABELLED },
  emails: [],
  phones: [],
  location: { present: true, value: UNLABELLED },
  currentTitle: { present: true, value: UNLABELLED },
  totalYearsExperience: { present: true, value: UNLABELLED },
  employment: [],
  education: [],
  skills: [],
  certifications: [],
  languages: [],
});

/**
 * Reject any record that still contains a template marker.
 *
 * Structural validity is not enough: a file can satisfy the schema while every
 * field still says UNLABELLED.
 */
export const containsUnlabelled = (raw: unknown): boolean =>
  JSON.stringify(raw).includes(UNLABELLED);

export interface AnnotationSetReport {
  readonly total: number;
  readonly valid: number;
  readonly unlabelled: number;
  readonly invalid: readonly { readonly docId: string; readonly errors: readonly string[] }[];
  /** Double-reviewed share. The acceptance document sets the minimum. */
  readonly doubleReviewed: number;
}

/** Audit a directory's worth of label files before any scoring runs. */
export const auditAnnotations = (
  records: readonly { readonly docId: string; readonly raw: unknown }[],
): AnnotationSetReport => {
  const invalid: { docId: string; errors: readonly string[] }[] = [];
  let valid = 0;
  let unlabelled = 0;
  let doubleReviewed = 0;

  for (const record of records) {
    if (containsUnlabelled(record.raw)) {
      unlabelled += 1;
      invalid.push({ docId: record.docId, errors: ['contains unlabelled template markers'] });
      continue;
    }
    const result = validateGroundTruth(record.raw);
    if (!result.ok) {
      invalid.push({ docId: record.docId, errors: result.errors });
      continue;
    }
    valid += 1;
    if (result.value.reviewedBy !== null) doubleReviewed += 1;
  }

  return {
    total: records.length, valid, unlabelled, invalid, doubleReviewed,
  };
};
