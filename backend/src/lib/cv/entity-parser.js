// EntityParser — deterministic field detection.
//
// Every detector returns { value, method } where `method` records HOW the value
// was found. ConfidenceEngine turns that into a score, so extraction quality is
// traceable rather than a black box.
//
// Extraction priority, applied per field:
//   1. section   — found inside the correct canonical section
//   2. nearby    — found adjacent to a contextual anchor
//   3. global    — document-wide pattern (weakest)
//
// No I/O, no database knowledge, no logging of CV content.
import {
  cleanDigits, collapseSpacedCaps, normalizeName, nameFromFilename,
  normalizeJobTitle, normalizeCompany, normalizeLocation, normalizeUniversity,
  normalizeMajor, normalizeDegree, tidy,
} from './normalizer.js';
import {
  TITLE_KEYWORDS, DISCIPLINES, MAJOR_KEYWORDS, UNIVERSITY_TOKENS,
  CITIES, COUNTRIES, COMPANY_SUFFIXES, NOISE_WORDS, DEGREE_MAP, HEADLINE_PATTERNS,
} from './dictionaries.js';
import { sectionLines, sectionText } from './section-detector.js';

export const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
export const YEARS_RE = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/i;
// PRODUCTION-CRITICAL FIX (approved parser exception).
// The original patterns used `\s`, which matches newlines, so a phone run could
// swallow the first digit of the NEXT line: "+20 128 999 0011\n6th of October"
// parsed as "+2012899900116". Phone is a duplicate-detection key, so this
// corrupted dedup. Space and tab are now listed explicitly, keeping every match
// on a single line. Deterministic; no other behaviour changes.
const PHONE_LABEL_RE = /(?:phone|mobile|mob|tel|cell|whatsapp|contact)[ \t]*[:#]?[ \t]*([+()\d][\d() \t.\-]{6,}\d)/i;
const PHONE_ANY_RE = /(\+?\d[\d() \t.\-]{7,}\d)/;
const CURRENT_RE = /\b(present|current|now|to\s+date|till\s+date)\b/i;
const YEAR_RE = /\b(19[5-9]\d|20[0-4]\d)\b/;

const NAME_STOP = new Set([
  'curriculum vitae', 'resume', 'cv', 'professional overview', 'profile',
  'summary', 'professional summary', 'contact', 'contacts', 'personal details',
  'personal information', 'objective', 'career objective', 'experience',
  'work experience', 'education', 'skills', 'references', 'portfolio', 'about',
  'about me', 'overview',
]);

const hit = (value, method) => ({ value: value ?? null, method: value == null ? null : method });
const MISS = { value: null, method: null };
const lower = (s) => String(s || '').toLowerCase();
const isNoise = (l) => NOISE_WORDS.some((w) => lower(l).startsWith(w));

/* ------------------------------- personal -------------------------------- */

function looksLikeName(line) {
  // NOTE: String.trim() ignores arguments — the original passed ' :.-' here, so it
  // only ever trimmed whitespace. Preserved: changing it would alter which lines
  // qualify as names across every CV already parsed.
  const low = line.toLowerCase().trim(' :.-');
  if (NAME_STOP.has(low)) return false;
  if (NAME_STOP.has(low.replace(/[:\-.]/g, '').trim())) return false;
  if (/[0-9@]/.test(line)) return false;
  const words = line.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  const letters = [...line].filter((c) => /[a-zA-Z؀-ۿ]/.test(c)).length;
  return letters >= Math.max(4, line.length - words.length - 2);
}

export function detectName(text, filename, detected) {
  // 1. header section (before any heading) — where a name almost always sits
  const header = detected ? sectionLines(detected, 'header') : [];
  for (let i = 0; i < Math.min(header.length, 8); i++) {
    const cand = collapseSpacedCaps(header[i]);
    if (looksLikeName(cand)) return hit(normalizeName(cand), 'section');
  }
  // 2. first lines of the document
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const cand = collapseSpacedCaps(lines[i]);
    if (looksLikeName(cand)) return hit(normalizeName(cand), 'nearby');
  }
  // 3. filename
  return hit(nameFromFilename(filename || ''), 'filename');
}

export function detectEmail(text) {
  const m = EMAIL_RE.exec(String(text || ''));
  return m ? hit(m[0], 'global') : MISS;   // raw case preserved for legacy parity
}

export function detectPhone(text) {
  if (!text) return MISS;
  for (const m of text.matchAll(new RegExp(PHONE_LABEL_RE.source, 'gi'))) {
    const d = cleanDigits(m[1]);
    if (d.length >= 9 && d.length <= 15) return hit(m[1].trim(), 'labelled');
  }
  for (const m of text.matchAll(new RegExp(PHONE_ANY_RE.source, 'g'))) {
    const raw = m[1];
    const d = cleanDigits(raw);
    if (d.length < 9 || d.length > 15) continue;
    if (d.length <= 8) continue;
    return hit(raw.trim(), 'global');
  }
  return MISS;
}

/** City/country dictionary first, then a "City, Country" shape near the header. */
export function detectLocation(text, detected) {
  const scopes = [
    [detected ? sectionText(detected, 'header') : '', 'section'],
    [detected ? sectionText(detected, 'contact') : '', 'section'],
    [String(text || '').split(/\r?\n/).slice(0, 15).join('\n'), 'nearby'],
    [String(text || ''), 'global'],
  ];
  for (const [scope, method] of scopes) {
    if (!scope) continue;
    for (const city of CITIES) {
      const re = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(scope)) {
        const country = COUNTRIES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(scope));
        return hit(normalizeLocation(country ? `${city}, ${country}` : city), method);
      }
    }
    const m = scope.match(/^\s*([A-Z][a-zA-Z .'-]{2,28}),\s*([A-Z][a-zA-Z .'-]{2,28})\s*$/m);
    if (m) return hit(normalizeLocation(`${m[1]}, ${m[2]}`), method);
  }
  return MISS;
}

/* ------------------------------ employment ------------------------------- */

// A date range, "Present", or a bare year is never a company or a title.
const DATE_FRAGMENT_RE = /^(?:\d{1,2}[\/.-])?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)?[a-z]*\.?\s*\d{0,4}\s*(?:[-–—]\s*)?(?:present|current|now|to\s+date|\d{4})?$/i;
const isDateFragment = (l) => {
  const t = tidy(l);
  if (!t) return true;
  if (CURRENT_RE.test(t) && t.split(/\s+/).length <= 3) return true;
  return DATE_FRAGMENT_RE.test(t) && /\d|present|current/i.test(t);
};

// Test against the NORMALISED form so "Eng." matches the "engineer" keyword.
/**
 * F1 — a personal headline describes the CANDIDATE, never an employer.
 * "Fresh Graduate - Civil Engineering", "Seeking a role in...", "8 years of
 * experience" must never become current_company.
 */
export function isPersonalHeadline(line) {
  const t = tidy(line);
  if (!t) return true;
  if (HEADLINE_PATTERNS.some((re) => re.test(t))) return true;
  // A bare job title with no employer marker is a headline, not a company.
  if (looksLikeTitleRaw(t) && !hasCompanyEvidence(t)) return true;
  return false;
}

/** Positive evidence that a string names an ORGANISATION. */
export function hasCompanyEvidence(line) {
  const t = tidy(line);
  if (!t) return false;
  if (COMPANY_SUFFIXES.some((sfx) => new RegExp(`\\b${sfx.replace('.', '\\.')}\\b`, 'i').test(t))) return true;
  if (/\b(?:plc|s\.?a\.?e?|a\.?g|n\.?v|b\.?v|pvt|llp|&\s*co)\b/i.test(t)) return true;
  if (UNIVERSITY_TOKENS.some((u) => lower(t).includes(u))) return true;   // universities employ
  if (/&/.test(t)) return true;                                          // "McKinsey & Company"
  // Multi-word proper noun with no title keyword reads as an organisation name.
  const words = t.split(/\s+/);
  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
  return words.length >= 2 && words.length <= 6 && capitalised >= 2 && !looksLikeTitleRaw(t);
}

// Raw title test used by the guards above (no headline filtering, avoids recursion).
const looksLikeTitleRaw = (l) => {
  if (isDateFragment(l)) return false;
  const norm = lower(normalizeJobTitle(l) || l);
  return TITLE_KEYWORDS.some((k) => norm.includes(k)) && String(l).split(/\s+/).length <= 8 && !isNoise(l);
};

const looksLikeTitle = (l) => {
  if (isDateFragment(l)) return false;
  const norm = lower(normalizeJobTitle(l) || l);
  return TITLE_KEYWORDS.some((k) => norm.includes(k)) && l.split(/\s+/).length <= 8 && !isNoise(l);
};
// A line naming a degree or academic qualification is education, not employment.
const isEducationLine = (l) => {
  const t = String(l || '');
  if (DEGREE_MAP.some(([re]) => re.test(t))) return true;
  return MAJOR_KEYWORDS.some((m) => lower(t).includes(m)) && UNIVERSITY_TOKENS.some((u) => lower(t).includes(u));
};

const looksLikeCompany = (l) => {
  const low = lower(l);
  if (isNoise(l) || l.split(/\s+/).length > 9) return false;
  return COMPANY_SUFFIXES.some((s) => new RegExp(`\\b${s.replace('.', '\\.')}\\b`, 'i').test(low));
};

/**
 * Splits a line like "Orascom Construction — Site Engineer (2019 – Present)" or
 * "Site Engineer at Orascom Construction" into its parts.
 */
/**
 * F2 — narrative experience lines.
 * "Site Engineer at Orascom Construction since 2019"
 *   -> { title: 'Site Engineer', company: 'Orascom Construction' }
 * Returns null when the line is not a recognisable narrative role sentence, so
 * an entire sentence can never be assigned to either field.
 */
export function splitNarrative(line) {
  const t = tidy(String(line || ''))
    .replace(/\s+(?:since|from|starting)\s+.*$/i, '')
    .replace(/\s+\(?\d{4}\s*[-–—]?\s*(?:present|current|now|\d{4})?\)?\s*$/i, '')
    .trim();
  if (!t) return null;
  // The connector must be a standalone word: "<title> at|@|with|for <company>".
  const m = t.match(/^(.{3,60}?)\s+(?:at|@|with|for|,\s*)\s*(.{2,80})$/i);
  if (!m) return null;
  const title = tidy(m[1]);
  const company = tidy(m[2]);
  if (!looksLikeTitleRaw(title)) return null;
  // The connector ("at"/"with"/"for") is itself strong grammatical evidence that
  // what follows is an employer, so a corporate suffix is not additionally
  // required — that would drop single-word companies such as "Arabtec".
  // The company half must still not be a headline or another job title.
  if (isPersonalHeadline(company) || looksLikeTitleRaw(company)) return null;
  if (!/[A-Za-z\u0600-\u06FF]/.test(company)) return null;
  // Neither half may be sentence-length — that is the corruption we are preventing.
  if (title.split(/\s+/).length > 8 || company.split(/\s+/).length > 8) return null;
  return { title, company };
}

function splitRole(line) {
  // Strip a parenthesised or trailing date range first: "(2019 – Present)",
  // ", Jan 2021 - Present". Otherwise the date becomes a phantom company.
  // NB: do NOT use tidy() here — it strips '|', which is a column separator in
  // many CV layouts and the only thing marking the title/company boundary.
  const softClean = (v) => String(v || '').replace(/\s+/g, ' ').replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, '').trim();
  let cleaned = softClean(String(line || '')
    .replace(/\((?:[^)]*)\)\s*$/, '')
    .replace(/[,;|]?\s*(?:[A-Za-z]{3,9}\.?\s*)?\d{4}\s*[-–—]\s*(?:present|current|now|to\s+date|\d{4}).*$/i, '')
    .replace(/[,;|]?\s*\d{4}\s*[-–—]\s*\d{4}\s*$/, ''));
  cleaned = cleaned.replace(/[|│]\s*$/, '').trim();

  // F2: try the narrative form first — "Title at Company since YYYY".
  const narrative = splitNarrative(cleaned);
  if (narrative) return narrative;

  const parts = cleaned.split(/\s*[—–|]\s*|\s+-\s+|\s*,\s*/)
    .map(tidy).filter((p) => p && !isDateFragment(p));

  if (parts.length >= 2) {
    const titleIdx = parts.findIndex(looksLikeTitle);
    if (titleIdx !== -1) {
      const title = parts[titleIdx];
      // F1: only accept a company half that shows organisation evidence.
      // Being the non-title half of an experience entry is itself the evidence.
      // Requiring a corporate suffix here dropped single-word employers ("Arabtec").
      const company = parts.find((p, i) => i !== titleIdx && !looksLikeTitle(p)
        && !isPersonalHeadline(p) && !isEducationLine(p)) || null;
      return { title, company };
    }
    const first = parts[0];
    return { title: null, company: !isPersonalHeadline(first) && !isEducationLine(first) ? first : null };
  }
  if (parts.length === 1) {
    const p0 = parts[0];
    if (looksLikeTitle(p0)) return { title: p0, company: null };
    return { title: null, company: hasCompanyEvidence(p0) && !isPersonalHeadline(p0) ? p0 : null };
  }
  return { title: null, company: null };
}

/** Prefers the entry marked Present/Current, else the first entry in the section. */
function currentRole(detected) {
  const lines = sectionLines(detected, 'experience');
  if (!lines.length) return { title: null, company: null, method: null };
  for (const l of lines) {
    if (CURRENT_RE.test(l)) {
      const r = splitRole(l);
      if (r.title || r.company) return { ...r, method: 'section' };
    }
  }
  for (const l of lines.slice(0, 6)) {
    const r = splitRole(l);
    if (r.title || r.company) return { ...r, method: 'section' };
  }
  return { title: null, company: null, method: null };
}

export function detectCurrentCompany(text, detected) {
  const r = currentRole(detected);
  if (r.company) return hit(normalizeCompany(r.company), r.method);
  // Fallback when no experience section exists. Education and summary lines are
  // excluded: "B.Sc. Civil Engineering" matches a company suffix ("engineering")
  // but is a qualification, not an employer (F1).
  const expScope = detected ? sectionText(detected, 'experience') : '';
  const excluded = new Set(['education', 'summary', 'skills', 'certifications', 'languages', 'references']);
  let candidateLines;
  if (expScope) {
    candidateLines = expScope.split(/\r?\n/);
  } else if (detected) {
    candidateLines = detected.order.filter((sec) => !excluded.has(sec))
      .flatMap((sec) => sectionLines(detected, sec));
  } else {
    candidateLines = String(text || '').split(/\r?\n/);
  }
  for (const l of candidateLines) {
    // F2: narrative form wins — "Site Engineer at Orascom Construction since 2019".
    const nar = splitNarrative(l);
    if (nar && nar.company) return hit(normalizeCompany(nar.company), expScope ? 'nearby' : 'global');
  }
  for (const l of candidateLines) {
    if (looksLikeCompany(l) && !isPersonalHeadline(l) && !isEducationLine(l)) {
      return hit(normalizeCompany(l), expScope ? 'nearby' : 'global');
    }
  }
  return MISS;
}

export function detectCurrentPosition(text, detected) {
  const r = currentRole(detected);
  if (r.title) return hit(normalizeJobTitle(r.title), r.method);
  // F2: narrative lines anywhere outside education/summary.
  const excluded = new Set(['education', 'summary', 'skills', 'certifications', 'languages', 'references']);
  const scan = detected
    ? detected.order.filter((sec) => !excluded.has(sec)).flatMap((sec) => sectionLines(detected, sec))
    : String(text || '').split(/\r?\n/);
  for (const l of scan) {
    const nar = splitNarrative(l);
    if (nar && nar.title) return hit(normalizeJobTitle(nar.title), 'nearby');
  }
  // Header tagline fallback — but F1: never a personal headline, never a sentence.
  const header = detected ? sectionLines(detected, 'header') : [];
  const acceptable = (l) => looksLikeTitle(l)
    && !isPersonalHeadline(l)
    && tidy(l).split(/\s+/).length <= 6;
  for (const l of header.slice(0, 5)) {
    if (acceptable(l) && DISCIPLINES.some((d) => lower(l).includes(d))) return hit(normalizeJobTitle(l), 'nearby');
  }
  for (const l of header.slice(0, 5)) if (acceptable(l)) return hit(normalizeJobTitle(l), 'nearby');
  return MISS;
}

export function detectYearsExperience(text) {
  const m = YEARS_RE.exec(String(text || ''));
  return m ? hit(parseInt(m[1], 10), 'global') : MISS;
}

// Preserved from the original parser: never inferred from CV content.
export function detectRoleApplied() { return MISS; }

/* ------------------------------- education ------------------------------- */

export function detectUniversity(text, detected) {
  const scopes = [
    [detected ? sectionLines(detected, 'education') : [], 'section'],
    [String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean), 'global'],
  ];
  for (const [lines, method] of scopes) {
    let best = null;
    for (const l of lines) {
      if (isNoise(l) || l.length > 120) continue;
      if (UNIVERSITY_TOKENS.some((t) => lower(l).includes(t))) {
        // Take the institution clause only, dropping degree/date fragments.
        const clause = l.split(/\s*[—–|]\s*|\s+-\s+|\s*,\s*/)
          .find((p) => UNIVERSITY_TOKENS.some((t) => lower(p).includes(t))) || l;
        // Drop any trailing year: "Imperial College London, 2019" -> the college.
        const cand = normalizeUniversity(clause.replace(/[,\s]*\b(19|20)\d{2}\b\s*$/, ''));
        if (cand && (!best || cand.length > best.length)) best = cand;
      }
    }
    if (best) return hit(best, method);
  }
  return MISS;
}

export function detectMajor(text, detected) {
  const scopes = [
    [detected ? sectionText(detected, 'education') : '', 'section'],
    [String(text || ''), 'global'],
  ];
  for (const [scope, method] of scopes) {
    if (!scope) continue;
    const low = lower(scope);
    // Longest keyword first so "civil engineering" beats "engineering".
    const found = [...MAJOR_KEYWORDS].sort((a, b) => b.length - a.length)
      .find((k) => low.includes(k));
    if (found) return hit(normalizeMajor(found), method);
  }
  return MISS;
}

/** Latest plausible year inside education; graduation is the most recent one. */
export function detectGraduationYear(text, detected) {
  const thisYear = new Date().getFullYear();
  const pick = (scope) => {
    const years = [...String(scope).matchAll(new RegExp(YEAR_RE.source, 'g'))]
      .map((m) => parseInt(m[1], 10))
      .filter((y) => y >= 1950 && y <= thisYear + 6);
    return years.length ? Math.max(...years) : null;
  };
  const edu = detected ? sectionText(detected, 'education') : '';
  if (edu) {
    const y = pick(edu);
    return y ? hit(y, 'section') : MISS;   // education exists but states no year
  }
  // No education section: only accept a year sitting on a line that also names a
  // degree or institution. A bare year elsewhere is an employment date, not a
  // graduation year — that produced false positives on CVs with no education.
  for (const l of String(text || '').split(/\r?\n/)) {
    const hasEduContext = UNIVERSITY_TOKENS.some((t) => lower(l).includes(t))
      || DEGREE_MAP.some(([re]) => re.test(l));
    if (!hasEduContext) continue;
    const y = pick(l);
    if (y) return hit(y, 'nearby');
  }
  return MISS;
}

/** Degree level ("Bachelor's Degree"), separate from field of study. */
export function detectDegree(text, detected) {
  const scope = (detected ? sectionText(detected, 'education') : '') || String(text || '');
  for (const [re] of DEGREE_MAP) {
    const m = re.exec(scope);
    if (m) return hit(normalizeDegree(m[0]), detected && sectionText(detected, 'education') ? 'section' : 'global');
  }
  return MISS;
}
