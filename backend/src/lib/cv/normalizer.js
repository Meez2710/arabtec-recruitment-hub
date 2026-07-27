// Normalizer — value shaping only. No detection, no I/O, no invention.
// Every function is pure and idempotent: normalize(normalize(x)) === normalize(x).
import path from 'node:path';
import { SENIORITY, DEGREE_MAP, CITIES, COUNTRIES } from './dictionaries.js';

export function toTitleCase(str) {
  return String(str || '').replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}
export function cleanDigits(s) { return String(s || '').replace(/\D/g, ''); }
export function compactPhone(raw) { return raw ? String(raw).replace(/[()\s.\-]/g, '') : null; }

export function collapseSpacedCaps(line) {
  if (/^(?:[A-Z]\s+){3,}[A-Z]?\.?$/.test(String(line || '').trim())) {
    return String(line).replace(/\s+/g, '');
  }
  return line;
}
export function normalizeName(name) {
  if (!name) return name;
  return name.toUpperCase() === name ? toTitleCase(name) : name;
}
export function nameFromFilename(filename) {
  const stem = path.basename(filename, path.extname(filename))
    .replace(/\b(cv|resume|final|updated|revamped)\b/gi, ' ')
    .replace(/[_\-.]+/g, ' ');
  return stem.split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ').trim() || 'Unknown Candidate';
}

/** Whitespace + stray punctuation only. Shared base for free-text fields. */
export function tidy(s) {
  return String(s || '')
    .replace(/[|│▪●•]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, '')
    .trim();
}

/**
 * Job title: expand sector abbreviations, then title-case.
 * "Sr. Planning Eng." -> "Senior Planning Engineer"
 */
export function normalizeJobTitle(raw) {
  let s = tidy(raw);
  if (!s) return null;
  for (const [re, full] of SENIORITY) s = s.replace(new RegExp(re.source, 'gi'), full);
  s = s.replace(/\s+/g, ' ').trim();
  // Preserve known all-caps acronyms that title-casing would mangle.
  const ACRONYMS = ['HSE', 'QA', 'QC', 'QA/QC', 'MEP', 'HVAC', 'BIM', 'IT', 'HR', 'CAD', 'PMO'];
  s = toTitleCase(s);
  for (const a of ACRONYMS) s = s.replace(new RegExp(`\\b${a.replace('/', '\\/')}\\b`, 'gi'), a);
  return s || null;
}

/** Degree level only — the field of study is captured separately as `major`. */
export function normalizeDegree(raw) {
  const s = tidy(raw);
  if (!s) return null;
  for (const [re, canonical] of DEGREE_MAP) if (re.test(s)) return canonical;
  return null;
}

/** Whitespace/punctuation only — never rewrites or matches against a registry. */
export function normalizeCompany(raw) {
  let s = tidy(raw);
  if (!s) return null;
  s = s.replace(/\s*[,\-–—]\s*$/, '').replace(/\s{2,}/g, ' ');
  return s || null;
}

/** Whitespace + capitalisation only. No geocoding, no country inference. */
export function normalizeLocation(raw) {
  let s = tidy(raw);
  if (!s) return null;
  const parts = s.split(/\s*,\s*/).filter(Boolean).map((p) => {
    const known = [...CITIES, ...COUNTRIES].find((k) => k.toLowerCase() === p.toLowerCase());
    return known || toTitleCase(p);
  });
  return parts.join(', ') || null;
}

/** Formatting inconsistencies only. Never invents or corrects institution names. */
export function normalizeUniversity(raw) {
  let s = tidy(raw);
  if (!s) return null;
  s = s.replace(/^(?:at|from|graduated\s+from)\s+/i, '');
  s = s.replace(/\s*[,\-–—]\s*$/, '');
  if (s === s.toUpperCase() && s.length > 4) s = toTitleCase(s);
  return s.replace(/\bOf\b/g, 'of').replace(/\bThe\b/g, 'the').replace(/^the\b/i, 'The') || null;
}

export function normalizeMajor(raw) {
  const s = tidy(raw);
  if (!s) return null;
  return toTitleCase(s.replace(/^(?:in|of)\s+/i, ''));
}
