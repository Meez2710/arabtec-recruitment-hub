// Deterministic validation. Pure, no I/O, AND NO MODEL — by construction.
//
// This module never sees the extractor that produced a value, never sees a
// prompt, and cannot be handed a confidence to respect. It applies rules to a
// value and says whether the value satisfies them. That independence is the
// entire point: it is the only step in the pipeline whose verdict a model
// cannot influence, so it is the only step whose "validated" means anything.
//
// WHAT IT IS NOT. Validation is not verification. A well-formed email address
// that belongs to somebody else passes every rule here. `validated` means "this
// value is structurally possible", never "this value is true about this person".
// Truth is established by a human at the review boundary.

import { canonicalSectionFor } from '../document/structure-builder.js';
import { normalizeYear, normalizeYearsExperience } from './normalize.js';

/**
 * The verdict of a deterministic rule.
 *
 * Local to this stage on purpose — it is NOT persisted and NOT part of the
 * proposal contract. `CandidateProposal` records a reviewer's decision
 * (PENDING/ACCEPTED/REJECTED); this says only whether a rule accepted a value's
 * shape. Conflating the two is how "a regex liked it" becomes "a human
 * approved it".
 *
 *   unvalidated — no rule applies to this field. NOT a pass.
 *   validated   — a rule ran and the value satisfied it.
 *   invalid     — a rule ran and the value failed it.
 */
export type ValidationState = 'unvalidated' | 'validated' | 'invalid';

export interface ValidationResult {
  readonly state: ValidationState;
  /** Why a rule failed. Short, safe to log, never a whole CV line. */
  readonly note?: string;
}

const OK: ValidationResult = { state: 'validated' };
const NO_RULE: ValidationResult = { state: 'unvalidated' };
const fail = (note: string): ValidationResult => ({ state: 'invalid', note });

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
/** A URL or handle that is not a person's name. */
const NOT_A_NAME = /[@/\\<>{}[\]()0-9]|https?:|www\./i;

const wordCount = (value: string): number => value.split(/\s+/).filter(Boolean).length;

/** Fields whose value is a short label, not a sentence. */
const LABEL_LIMITS: Record<string, { readonly maxChars: number; readonly maxWords: number }> = {
  fullName: { maxChars: 80, maxWords: 6 },
  location: { maxChars: 120, maxWords: 10 },
  currentCompany: { maxChars: 120, maxWords: 10 },
  currentPosition: { maxChars: 120, maxWords: 10 },
  university: { maxChars: 150, maxWords: 12 },
  major: { maxChars: 100, maxWords: 8 },
  degree: { maxChars: 100, maxWords: 8 },
  headline: { maxChars: 200, maxWords: 20 },
};

/**
 * Validate one value in isolation.
 *
 * `unvalidated` for a field with no rule is deliberately NOT a pass: a caller
 * that treats "no rule applied" as "checked and fine" has re-introduced exactly
 * the false trust this pipeline exists to remove.
 */
export const validateField = (field: string, value: unknown): ValidationResult => {
  if (value === null || value === undefined) return fail('the value is empty');

  if (Array.isArray(value)) {
    return value.length === 0 ? fail('the list is empty') : OK;
  }

  if (field === 'yearsExperience') {
    const years = typeof value === 'number' ? value : normalizeYearsExperience(String(value));
    if (years === null) return fail('not a number of years');
    if (!Number.isInteger(years) || years < 0 || years > 60) {
      return fail('outside the plausible range of 0–60 years');
    }
    return OK;
  }

  if (field === 'graduationYear') {
    const year = typeof value === 'number' ? value : normalizeYear(String(value));
    if (year === null) return fail('not a four-digit year');
    const now = new Date().getFullYear();
    // A future year is legitimate for an expected graduation, but only just.
    if (year < 1900 || year > now + 8) return fail(`the year ${year} is implausible`);
    return OK;
  }

  const text = String(value).trim();
  if (text === '') return fail('the value is empty');

  if (field === 'email') {
    return EMAIL.test(text) ? OK : fail('not a well-formed email address');
  }

  if (field === 'phone') {
    const digits = text.replace(/\D/g, '');
    if (digits.length < 7) return fail('too few digits for a phone number');
    if (digits.length > 15) return fail('more digits than E.164 permits');
    return OK;
  }

  const limits = LABEL_LIMITS[field];
  if (limits === undefined) return NO_RULE;

  if (text.length > limits.maxChars) {
    return fail(`longer than a ${field} value can be (${text.length} characters)`);
  }
  if (wordCount(text) > limits.maxWords) {
    // The measured failure this catches: a whole sentence — "Quantity Surveyor
    // at Pyramid Cost Consultants since 2021" — stored as both employer and
    // title because the splitter could not divide it.
    return fail(`reads as a sentence rather than a ${field} value`);
  }

  if (field === 'fullName') {
    if (NOT_A_NAME.test(text)) return fail('contains characters a name does not');
    // The measured failure this catches: the heading "CONTACT INFORMATION"
    // accepted as a person's name.
    if (canonicalSectionFor(text) !== 'other') return fail('is a section heading, not a name');
    if (!/\p{L}/u.test(text)) return fail('contains no letters');
    return OK;
  }

  if (field === 'major' || field === 'degree') {
    // The measured failure this catches: the word "Education" — a heading —
    // proposed as a field of study.
    if (canonicalSectionFor(text) !== 'other') return fail('is a section heading, not a subject');
    return OK;
  }

  return OK;
};

/* ---------------------------- cross-field rules ---------------------------- */

export interface CrossFieldConflict {
  readonly field: string;
  readonly note: string;
}

/**
 * Rules that need more than one field.
 *
 * Kept apart from `validateField` because a conflict is not a property of
 * either value: both may be individually well-formed and still cannot both be
 * true, and a reviewer needs to be shown the pair rather than one of them.
 */
export const crossValidate = (
  values: ReadonlyMap<string, unknown>,
): readonly CrossFieldConflict[] => {
  const conflicts: CrossFieldConflict[] = [];

  const graduation = values.get('graduationYear');
  const years = values.get('yearsExperience');
  if (typeof graduation === 'number' && typeof years === 'number') {
    const now = new Date().getFullYear();
    // Six years of slack: internships, part-time work during study and a career
    // that began before graduation are all ordinary, so only a claim that
    // cannot be reconciled at all is reported.
    const possible = now - graduation + 6;
    if (years > possible) {
      conflicts.push({
        field: 'yearsExperience',
        note: `${years} years of experience is not reconcilable with graduating in ${graduation}`,
      });
    }
  }

  const company = values.get('currentCompany');
  const position = values.get('currentPosition');
  if (typeof company === 'string' && typeof position === 'string'
    && company.trim() !== '' && company.trim() === position.trim()) {
    // The measured failure this catches: one unsplit sentence written into both
    // the employer and the title column.
    conflicts.push({
      field: 'currentCompany',
      note: 'the employer and the job title are the same text, so the pair was not separated',
    });
  }

  return conflicts;
};
