// Validator — classifies each detected value into one of four states rather than
// a boolean. `rejected` is the only state that nulls the value; `uncertain`
// keeps it but flags it for human review downstream.
//
//   verified   strong structural evidence (matches a strict pattern / known term)
//   likely     plausible, consistent with expectations, minor doubt
//   uncertain  kept, but should be reviewed before being trusted
//   rejected   implausible — value is discarded
import { CITIES, COUNTRIES, UNIVERSITY_TOKENS, TITLE_KEYWORDS, COMPANY_SUFFIXES } from './dictionaries.js';

export const VERIFIED = 'verified';
export const LIKELY = 'likely';
export const UNCERTAIN = 'uncertain';
export const REJECTED = 'rejected';

const THIS_YEAR = new Date().getFullYear();
const low = (s) => String(s || '').toLowerCase();
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

const RULES = {
  full_name(v, method) {
    if (!v || v === 'Unknown Candidate') return REJECTED;
    const w = words(v);
    if (w.length < 2 || w.length > 5) return REJECTED;
    if (/\d|@/.test(v) || v.length > 80) return REJECTED;
    if (method === 'filename') return UNCERTAIN;      // derived, not read from the CV
    if (method === 'section') return VERIFIED;
    return LIKELY;
  },
  email(v) {
    if (!v) return REJECTED;
    if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(v) || v.length > 254) return REJECTED;
    return VERIFIED;                                  // strict pattern, unambiguous
  },
  phone(v) {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length < 9 || d.length > 15) return REJECTED;
    return VERIFIED;
  },
  location(v, method) {
    if (!v || v.length > 80) return REJECTED;
    const known = [...CITIES, ...COUNTRIES].some((k) => low(v).includes(low(k)));
    if (known) return method === 'section' ? VERIFIED : LIKELY;
    return UNCERTAIN;                                 // shape matched, place unknown
  },
  current_company(v, method) {
    if (!v || v.length < 2 || v.length > 120) return REJECTED;
    if (words(v).length > 10) return REJECTED;
    const hasSuffix = COMPANY_SUFFIXES.some((s) => new RegExp(`\\b${s.replace('.', '\\.')}\\b`, 'i').test(v));
    if (method === 'section' && hasSuffix) return VERIFIED;
    if (method === 'section' || hasSuffix) return LIKELY;
    return UNCERTAIN;
  },
  current_position(v, method) {
    if (!v || v.length < 3 || v.length > 100) return REJECTED;
    const hasKeyword = TITLE_KEYWORDS.some((k) => low(v).includes(k));
    if (!hasKeyword) return UNCERTAIN;
    return method === 'section' ? VERIFIED : LIKELY;
  },
  years_experience(v) {
    if (!Number.isInteger(v)) return REJECTED;
    if (v < 0 || v > 60) return REJECTED;
    return VERIFIED;
  },
  role_applied(v) { return v ? LIKELY : REJECTED; },
  university(v, method) {
    if (!v || v.length < 4 || v.length > 120) return REJECTED;
    const hasToken = UNIVERSITY_TOKENS.some((t) => low(v).includes(t));
    if (!hasToken) return REJECTED;                   // must name an institution
    return method === 'section' ? VERIFIED : LIKELY;
  },
  major(v, method) {
    if (!v || v.length < 3 || v.length > 80) return REJECTED;
    return method === 'section' ? VERIFIED : LIKELY;
  },
  graduation_year(v, method) {
    if (!Number.isInteger(v)) return REJECTED;
    if (v < 1950 || v > THIS_YEAR + 6) return REJECTED;
    if (v > THIS_YEAR) return LIKELY;                 // expected graduation
    return method === 'section' ? VERIFIED : UNCERTAIN;
  },
  degree(v, method) {
    if (!v) return REJECTED;
    return method === 'section' ? VERIFIED : LIKELY;
  },
};

/**
 * @returns {{ value:any, validation:'verified'|'likely'|'uncertain'|'rejected' }}
 *   Rejected values are nulled here so callers never see an invalid value.
 */
export function validate(field, value, method) {
  const rule = RULES[field];
  if (!rule) return { value, validation: value == null ? REJECTED : LIKELY };
  if (value == null || value === '') return { value: null, validation: REJECTED };
  const validation = rule(value, method);
  return { value: validation === REJECTED ? null : value, validation };
}

export const VALIDATION_STATES = [VERIFIED, LIKELY, UNCERTAIN, REJECTED];
