// The extraction schema — the contract the model must satisfy.
//
// STRICT ON PURPOSE. A model that returns a plausible-looking object with an
// invented phone number is worse than one that returns nothing, because the
// invention reaches a review screen wearing the same confidence as a real
// reading. Everything here fails closed:
//
//   - unknown keys are stripped, never passed through
//   - a wrong type is a rejection, not a coercion
//   - "" and "N/A"-style filler collapse to absent, so a field the CV does not
//     support is ABSENT rather than empty-but-present
//
// SCHEMA_VERSION is recorded on every proposal. A change here changes what the
// model is asked for, which changes the output — so it must be bumped and
// pinned alongside the prompt version.

import { z } from 'zod';
import type { ExtractedResume } from '../../../modules/shared/kernel/ai/index.js';

export const SCHEMA_VERSION = 'resume-extract/1.0.0';

/** Filler a model emits when it wants to fill a slot it cannot fill. */
const FILLER = new Set([
  'n/a', 'na', 'none', 'null', 'unknown', 'not specified', 'not provided',
  'not mentioned', 'not available', '-', '--', 'غير محدد', 'غير متوفر',
]);

/** Absent, blank, or filler → undefined. Never a fabricated empty string. */
const text = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    if (t === '' || FILLER.has(t.toLowerCase())) return undefined;
    return t;
  },
  z.string().optional(),
);

const textArray = z.preprocess(
  (v) => {
    if (!Array.isArray(v)) return [];
    return v
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s !== '' && !FILLER.has(s.toLowerCase()));
  },
  z.array(z.string()),
);

/** A year, or a free-form date the CV actually contained. Never inferred. */
const period = {
  from: text,
  to: text,
  current: z.preprocess((v) => (typeof v === 'boolean' ? v : undefined), z.boolean().optional()),
};

const employment = z.object({
  employer: z.string().trim().min(1),
  title: z.string().trim().min(1),
  summary: text,
  ...period,
}).strip();

const education = z.object({
  institution: z.string().trim().min(1),
  qualification: text,
  field: text,
  ...period,
}).strip();

/**
 * Years of experience.
 *
 * Bounded because a model asked for a number will sometimes return a year
 * (2019) or a month count (240). Both are out of range for a career length and
 * are rejected rather than silently written to a candidate.
 */
const years = z.preprocess(
  (v) => {
    const n = typeof v === 'number' ? v : Number.NaN;
    return Number.isFinite(n) && n >= 0 && n <= 60 ? Math.round(n * 10) / 10 : undefined;
  },
  z.number().optional(),
);

export const resumeSchema = z.object({
  fullName: text,
  email: text,
  phone: text,
  location: text,
  headline: text,
  totalYearsExperience: years,
  skills: textArray,
  employment: z.preprocess(
    (v) => (Array.isArray(v) ? v : []),
    z.array(employment).catch([]),
  ),
  education: z.preprocess(
    (v) => (Array.isArray(v) ? v : []),
    z.array(education).catch([]),
  ),
  languages: textArray,
  certifications: textArray,
  uncertainFields: textArray,
}).strip();

export type SchemaResult =
  | { readonly ok: true; readonly value: ExtractedResume }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate a model response.
 *
 * Returns a result rather than throwing: a malformed response is an expected
 * outcome for a language model and belongs in the abstention path, not in an
 * exception handler.
 */
export const validateResume = (raw: unknown): SchemaResult => {
  const parsed = resumeSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason: first
        ? `Response failed schema validation at ${first.path.join('.') || '(root)'}: ${first.message}`
        : 'Response failed schema validation.',
    };
  }

  const v = parsed.data;
  // Every field optional and every array empty means the model returned a
  // well-formed object containing nothing. That is an abstention, not a result.
  const hasAnything = v.fullName !== undefined || v.email !== undefined
    || v.phone !== undefined || v.location !== undefined
    || v.skills.length > 0 || v.employment.length > 0 || v.education.length > 0;
  if (!hasAnything) return { ok: false, reason: 'Response contained no extractable fields.' };

  return { ok: true, value: v as ExtractedResume };
};

/**
 * JSON Schema handed to the runtime's structured-output mode.
 *
 * Constraining generation is far more reliable than repairing prose
 * afterwards — but it is not trusted: `validateResume` still runs on whatever
 * comes back.
 */
export const RESUME_JSON_SCHEMA = {
  type: 'object',
  properties: {
    fullName: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    headline: { type: ['string', 'null'] },
    totalYearsExperience: { type: ['number', 'null'] },
    skills: { type: 'array', items: { type: 'string' } },
    employment: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          employer: { type: 'string' },
          title: { type: 'string' },
          from: { type: ['string', 'null'] },
          to: { type: ['string', 'null'] },
          current: { type: ['boolean', 'null'] },
        },
        required: ['employer', 'title'],
      },
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          institution: { type: 'string' },
          qualification: { type: ['string', 'null'] },
          field: { type: ['string', 'null'] },
          to: { type: ['string', 'null'] },
        },
        required: ['institution'],
      },
    },
    languages: { type: 'array', items: { type: 'string' } },
    certifications: { type: 'array', items: { type: 'string' } },
    uncertainFields: { type: 'array', items: { type: 'string' } },
  },
  required: ['skills', 'employment', 'education', 'languages', 'certifications', 'uncertainFields'],
} as const;
