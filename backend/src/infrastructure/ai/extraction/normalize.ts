// Deterministic value normalization. Pure, no I/O, no model.
//
// NORMALIZATION MAY NOT INVENT. Every function here is a total function of its
// input that either returns a cleaned form of what it was given or returns the
// input unchanged. None of them consults a dictionary of expected values, none
// guesses a missing part, and none upgrades a value's trust — normalizing a
// wrong value produces a tidier wrong value, which is exactly why normalization
// and validation are separate steps.
//
// Both forms are always kept by the caller: `raw` is what the CV said, the
// normalized value is what would be stored. A stored value that can no longer be
// traced back to the document is unauditable.

import {
  normalizeDigits, normalizeEmail, normalizePhone, normalizeText,
} from '../../../modules/shared/kernel/text.js';

/** Collapse whitespace and strip decoration a heading or bullet left behind. */
export const cleanValue = (input: string): string => normalizeText(input)
  .replace(/^[\s•*\-–—|]+/, '')
  .replace(/[\s|]+$/, '')
  .trim();

/**
 * A person's name, tidied but never re-cased.
 *
 * Deliberately NOT title-cased: "van der Berg", "McDonald" and every Arabic
 * name are damaged by naive casing, and a candidate's name is the one field
 * where getting the spelling wrong is most visible to them.
 */
export const normalizeName = (input: string): string => cleanValue(input)
  .replace(/\s*,\s*/g, ' ')
  .replace(/\s{2,}/g, ' ');

/** Store the number as written, plus the digits that make it comparable. */
export const normalizePhoneValue = (input: string): {
  readonly value: string; readonly digits: string;
} => {
  const phone = normalizePhone(input);
  return { value: phone.raw, digits: phone.digits };
};

export const normalizeEmailValue = (input: string): string => normalizeEmail(cleanValue(input));

/**
 * A four-digit year, or null.
 *
 * Accepts Arabic-Indic digits, and rejects anything outside a range a CV can
 * plausibly contain. Null means "this is not a year" — never a guess.
 */
export const normalizeYear = (input: string | number): number | null => {
  const text = normalizeDigits(String(input));
  const match = /\b(1[89]\d{2}|20\d{2}|21\d{2})\b/.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) ? year : null;
};

/**
 * A count of years of experience, or null.
 *
 * Bounded at 60: a larger number is a mis-read (a year, a salary, a phone
 * fragment) far more often than it is a real career length.
 */
export const normalizeYearsExperience = (input: string | number): number | null => {
  const text = normalizeDigits(String(input));
  const match = /(\d{1,2})(?:\s*[.,]\s*\d+)?/.exec(text);
  if (match === null) return null;
  const years = Number(match[1]);
  if (!Number.isInteger(years) || years < 0 || years > 60) return null;
  return years;
};

/**
 * An organisation or institution name.
 *
 * Trailing separators and a leading "at"/"في" are removed because they are
 * artefacts of the sentence the value was cut out of, not part of the name.
 */
export const normalizeOrganisation = (input: string): string => cleanValue(input)
  .replace(/^(?:at|with|for|في|لدى)\s+/i, '')
  .replace(/[.,;:]+$/, '')
  .replace(/\s{2,}/g, ' ');

/** A job title. Same treatment as an organisation, minus the leading preposition. */
export const normalizeTitle = (input: string): string => cleanValue(input)
  .replace(/[.,;:]+$/, '')
  .replace(/\s{2,}/g, ' ');

/**
 * An ISO date, a year, or null.
 *
 * Only formats that are unambiguous are converted. "03/04/2020" is deliberately
 * NOT parsed: it is March in one convention and April in another, and choosing
 * silently would put a fabricated month into a candidate's employment history.
 */
export const normalizeDate = (input: string): string | null => {
  const text = cleanValue(normalizeDigits(input));
  if (text === '') return null;

  const iso = /\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/.exec(text);
  if (iso !== null) {
    return iso[3] !== undefined ? `${iso[1]}-${iso[2]}-${iso[3]}` : `${iso[1]}-${iso[2]}`;
  }

  const MONTHS: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const named = /\b([a-z]{3,9})\.?\s+(\d{4})\b/i.exec(text);
  if (named !== null) {
    const month = MONTHS[(named[1] ?? '').slice(0, 3).toLowerCase()];
    if (month !== undefined) return `${named[2]}-${month}`;
  }

  const year = normalizeYear(text);
  return year === null ? null : String(year);
};

/** De-duplicate a list case-insensitively while keeping the original spelling. */
export const normalizeList = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = cleanValue(value);
    if (cleaned === '') continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
};
