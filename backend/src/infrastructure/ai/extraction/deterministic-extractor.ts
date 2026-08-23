// Deterministic, section-scoped extraction. Pure, no I/O, no model.
//
// THE CONTROL PATH. Rules are high-precision and low-recall by design: they
// answer the fields a CV states unambiguously and stay silent on the rest. The
// model handles what rules cannot, and where both answer, agreement between an
// independent rule and an independent model is real evidence.
//
// SCOPED TO SECTIONS, NOT TO THE WHOLE DOCUMENT. Every measured false positive
// in the previous parser came from searching the entire text for a keyword:
//   - "no education section" in prose → major = "Education"
//   - the heading "CONTACT INFORMATION" → the candidate's name
//   - a sentence spanning title and employer → both columns set to the sentence
// A rule that may only look inside the Education section cannot make the first
// mistake, and a rule that may not read headings cannot make the second.
//
// Every hit carries the block it came from, so the caller can cite it. A rule
// that cannot name its source is not allowed to produce a value.

import type {
  CanonicalSection, DocumentBlock, StructuredDocument,
} from '../../../modules/shared/kernel/ai/index.js';
import { normalizeDigits, normalizeText } from '../../../modules/shared/kernel/text.js';
import {
  cleanValue, normalizeEmailValue, normalizeName, normalizeOrganisation,
  normalizePhoneValue, normalizeTitle, normalizeYear, normalizeYearsExperience,
} from './normalize.js';
import { validateField } from './validate.js';

/** One value a rule is prepared to stand behind, with where it read it. */
export interface RuleHit {
  readonly field: string;
  readonly value: unknown;
  /** The source text the value was cut from, before normalization. */
  readonly raw: string;
  readonly block: DocumentBlock;
}

/* -------------------------------- helpers --------------------------------- */

const blocksOfSection = (
  structure: StructuredDocument,
  canonical: CanonicalSection,
): readonly DocumentBlock[] => {
  const sections = structure.sections.filter((s) => s.canonical === canonical);
  if (sections.length === 0) return [];
  const ids = new Set(sections.flatMap((s) => s.blockIds));
  return structure.blocks.filter((b) => ids.has(b.id));
};

/**
 * The letterhead: everything on page one before the first section opens.
 *
 * A leading `title` block does NOT open a section — it is the CV's own title,
 * usually the candidate's name, and the contact lines beneath it are part of the
 * same letterhead. Treating it as a section boundary leaves the letterhead
 * empty, which is how the location and phone lines under an H1 name become
 * invisible to every rule scoped to it.
 */
const headerBlocks = (structure: StructuredDocument): readonly DocumentBlock[] => {
  const opensSection = structure.blocks.find(
    (b, index) => index > 0 && (b.kind === 'heading' || b.kind === 'title'),
  );
  const limit = opensSection?.readingOrder ?? Number.MAX_SAFE_INTEGER;
  return structure.blocks.filter((b) => b.readingOrder < limit && b.page === 1);
};

const isHeadingBlock = (block: DocumentBlock): boolean => block.kind === 'heading'
  || block.kind === 'title';

/* --------------------------------- contact -------------------------------- */

const EMAIL_PATTERN = /[^\s@,;<>()[\]]+@[^\s@,;<>()[\]]+\.[a-z]{2,}/i;

const findEmail = (structure: StructuredDocument): RuleHit | null => {
  for (const block of structure.blocks) {
    const match = EMAIL_PATTERN.exec(normalizeText(block.text));
    if (match === null) continue;
    const value = normalizeEmailValue(match[0]);
    if (validateField('email', value).state !== 'validated') continue;
    return { field: 'email', value, raw: match[0], block };
  }
  return null;
};

/**
 * A phone number, with Arabic-Indic digits folded first.
 *
 * The measured Arabic failure was exactly this: an ASCII-only `\d` pattern is
 * blind to "٠١٠٠١٢٣٤٥٦٧", so the field was reported missing on every Arabic CV.
 */
const PHONE_PATTERN = /(?:\+|00)?\d[\d\s()\-.]{6,18}\d/;

const findPhone = (structure: StructuredDocument): RuleHit | null => {
  const contact = blocksOfSection(structure, 'contact');
  const header = headerBlocks(structure);
  // Contact and letterhead first; a number in the body is far more likely to be
  // a project reference or a date range than the candidate's own number.
  const ordered = [...contact, ...header, ...structure.blocks];
  const seen = new Set<string>();

  for (const block of ordered) {
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    const text = normalizeDigits(normalizeText(block.text));
    const match = PHONE_PATTERN.exec(text);
    if (match === null) continue;
    const { value } = normalizePhoneValue(match[0]);
    if (validateField('phone', value).state !== 'validated') continue;
    return { field: 'phone', value, raw: match[0].trim(), block };
  }
  return null;
};

/**
 * The candidate's name.
 *
 * Only the letterhead and the contact section are eligible, and a heading is
 * never eligible. Rules alone cannot tell a name from a company in running
 * prose, so when the letterhead does not state one this returns null and the
 * model is left to answer.
 */
const findName = (structure: StructuredDocument): RuleHit | null => {
  // A CV's H1 IS the person's name in the overwhelming majority of layouts, and
  // it is what a layout-aware parser emits for the largest text on page one. It
  // is admitted as a candidate, not accepted: `validateField` still rejects it
  // if the text is a section heading like "CONTACT INFORMATION".
  const first = structure.blocks[0];
  const titleBlock = first !== undefined && first.kind === 'title' && first.page === 1
    ? [first]
    : [];
  const candidates = [
    ...titleBlock, ...headerBlocks(structure), ...blocksOfSection(structure, 'contact'),
  ];
  for (const block of candidates) {
    if (block.kind === 'table') continue;
    const first = normalizeText(block.text).split('\n')[0] ?? '';
    const value = normalizeName(first);
    if (value === '') continue;
    if (validateField('fullName', value).state !== 'validated') continue;
    // A title block at the top of a CV is the name in the overwhelming majority
    // of layouts; a paragraph there may be an address. Both are accepted, but a
    // section heading was already excluded by validation above.
    return { field: 'fullName', value, raw: first, block };
  }
  return null;
};

const LOCATION_PATTERN = /^[\p{L}][\p{L}\s'.-]{1,40}(?:,\s*[\p{L}][\p{L}\s'.-]{1,40}){1,2}$/u;

const findLocation = (structure: StructuredDocument): RuleHit | null => {
  const candidates = [...blocksOfSection(structure, 'contact'), ...headerBlocks(structure)];
  for (const block of candidates) {
    for (const line of normalizeText(block.text).split('\n')) {
      const value = cleanValue(line);
      if (value === '' || EMAIL_PATTERN.test(value)) continue;
      // "City, Country" — a comma-separated place, and nothing that looks like
      // a sentence or a number.
      if (!LOCATION_PATTERN.test(value)) continue;
      if (validateField('location', value).state !== 'validated') continue;
      return { field: 'location', value, raw: line, block };
    }
  }
  return null;
};

/* ------------------------------- experience -------------------------------- */

/** "8 years of experience", "خبرة 8 سنوات", "8+ yrs experience". */
const YEARS_PATTERNS: readonly RegExp[] = [
  /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:professional\s+|relevant\s+|total\s+)?experience/i,
  /experience\s*[:\-–]\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i,
  /(?:خبرة|خبره)\s*(?:تزيد عن|أكثر من)?\s*(\d{1,2})\s*(?:سنوات|سنة|عام|أعوام)/,
  /(\d{1,2})\s*(?:سنوات|سنة|عام|أعوام)\s*(?:من\s*)?(?:الخبرة|خبرة)/,
];

/**
 * A STATED number of years.
 *
 * Only an explicit claim counts. Summing date ranges is a derivation, not a
 * reading, and belongs to a step that can mark its result `derived` rather than
 * `supported` — presenting a computed figure as something the CV said is the
 * kind of quiet invention this pipeline exists to prevent.
 */
const findYearsExperience = (structure: StructuredDocument): RuleHit | null => {
  for (const block of structure.blocks) {
    if (isHeadingBlock(block)) continue;
    const text = normalizeDigits(normalizeText(block.text));
    for (const pattern of YEARS_PATTERNS) {
      const match = pattern.exec(text);
      if (match === null) continue;
      const years = normalizeYearsExperience(match[1] ?? '');
      if (years === null) continue;
      if (validateField('yearsExperience', years).state !== 'validated') continue;
      return { field: 'yearsExperience', value: years, raw: match[0], block };
    }
  }
  return null;
};

/** "Senior Engineer at Arabtec", "Senior Engineer — Arabtec", "Senior Engineer | Arabtec". */
const ROLE_SEPARATORS = /\s+(?:at|@|with|لدى|في)\s+|\s+[—–|]\s+/i;

/**
 * The current role, read from the first entry of the Experience section.
 *
 * "First" means first in reading order, which is how CVs are written — most
 * recent at the top. When the entry cannot be split into a title and an
 * employer, NEITHER is returned: writing the whole sentence into both columns
 * is the measured failure this refusal prevents.
 */
const findCurrentRole = (structure: StructuredDocument): readonly RuleHit[] => {
  const blocks = blocksOfSection(structure, 'experience');
  for (const block of blocks) {
    if (block.kind === 'table') continue;
    const first = normalizeText(block.text).split('\n')[0] ?? '';
    const line = cleanValue(first);
    if (line === '') continue;

    const parts = line.split(ROLE_SEPARATORS);
    if (parts.length < 2) continue;

    const title = normalizeTitle(parts[0] ?? '');
    // Trailing dates — "Arabtec, 2021–present" — are not part of the employer.
    const employer = normalizeOrganisation(
      (parts[1] ?? '').replace(/[,;]?\s*(?:\d{4}.*|since\s+\d{4}.*|present.*)$/i, ''),
    );

    const hits: RuleHit[] = [];
    if (validateField('currentPosition', title).state === 'validated') {
      hits.push({ field: 'currentPosition', value: title, raw: parts[0] ?? '', block });
    }
    if (validateField('currentCompany', employer).state === 'validated') {
      hits.push({ field: 'currentCompany', value: employer, raw: parts[1] ?? '', block });
    }
    if (hits.length === 2) return hits;
  }
  return [];
};

/* -------------------------------- education -------------------------------- */

const INSTITUTION = /(university|universite|college|institute|academy|school of|جامعة|كلية|معهد)/i;

const DEGREE_WORDS = /\b(b\.?sc|b\.?a|b\.?eng|bachelor|m\.?sc|m\.?a|master|mba|ph\.?d|doctorate|diploma|بكالوريوس|ماجستير|دكتوراه|دبلوم)\b/i;

const findEducation = (structure: StructuredDocument): readonly RuleHit[] => {
  const blocks = blocksOfSection(structure, 'education');
  if (blocks.length === 0) return [];
  const hits: RuleHit[] = [];

  for (const block of blocks) {
    for (const line of normalizeText(block.text).split('\n')) {
      const text = cleanValue(line);
      if (text === '') continue;

      if (!hits.some((h) => h.field === 'university') && INSTITUTION.test(text)) {
        // The institution's own clause, not the whole dated line.
        const clause = text.split(/[,;|]/).find((part) => INSTITUTION.test(part)) ?? text;
        const value = normalizeOrganisation(clause);
        if (validateField('university', value).state === 'validated') {
          hits.push({ field: 'university', value, raw: clause, block });
        }
      }

      const degree = DEGREE_WORDS.exec(text);
      if (degree !== null && !hits.some((h) => h.field === 'degree')) {
        const clause = text.split(/[,;|]/).find((part) => DEGREE_WORDS.test(part)) ?? text;
        const value = normalizeTitle(clause.replace(/\s*\(?\d{4}\)?\s*$/, ''));
        if (validateField('degree', value).state === 'validated') {
          hits.push({ field: 'degree', value, raw: clause, block });
        }
      }

      // "BSc in Civil Engineering" / "Major: Civil Engineering".
      if (!hits.some((h) => h.field === 'major')) {
        const major = /(?:\bin\b|major\s*[:\-]|تخصص\s*[:\-]?)\s+([\p{L}][\p{L}\s&'-]{2,60})/u.exec(text);
        const captured = major?.[1];
        if (captured !== undefined) {
          const value = normalizeTitle(captured.replace(/\s+(?:at|from|university|جامعة).*$/i, ''));
          if (validateField('major', value).state === 'validated') {
            hits.push({ field: 'major', value, raw: captured, block });
          }
        }
      }

      if (!hits.some((h) => h.field === 'graduationYear')) {
        const year = normalizeYear(text);
        // Only a year that sits in the Education section counts, and only when
        // the line also mentions an institution or a degree — a bare number in
        // an education block is as likely to be a grade as a graduation year.
        if (year !== null && (INSTITUTION.test(text) || DEGREE_WORDS.test(text))) {
          if (validateField('graduationYear', year).state === 'validated') {
            hits.push({ field: 'graduationYear', value: year, raw: text, block });
          }
        }
      }
    }
  }
  return hits;
};

/* --------------------------------- lists ----------------------------------- */

const listFromSection = (
  structure: StructuredDocument,
  canonical: CanonicalSection,
  field: string,
): RuleHit | null => {
  const blocks = blocksOfSection(structure, canonical);
  if (blocks.length === 0) return null;

  const values: string[] = [];
  let source: DocumentBlock | null = null;
  for (const block of blocks) {
    if (block.kind === 'table') continue;
    source ??= block;
    for (const line of normalizeText(block.text).split('\n')) {
      // A skills section is written either as bullets or as one comma-separated
      // run; both are split the same way.
      for (const part of line.split(/[,;،]|\s{2,}\|\s{2,}/)) {
        const value = cleanValue(part);
        if (value === '' || value.length > 60) continue;
        if (!/\p{L}/u.test(value)) continue;
        values.push(value);
      }
    }
  }

  if (values.length === 0 || source === null) return null;
  return { field, value: values, raw: values.join(', '), block: source };
};

/* -------------------------------- the entry -------------------------------- */

/**
 * Run every rule over one structured document.
 *
 * Returns only what the rules are confident about. Silence on a field is a
 * result, not a gap to be filled by a looser rule.
 */
export const extractDeterministically = (
  structure: StructuredDocument,
): readonly RuleHit[] => {
  const hits: RuleHit[] = [];
  const push = (hit: RuleHit | null): void => { if (hit !== null) hits.push(hit); };

  push(findName(structure));
  push(findEmail(structure));
  push(findPhone(structure));
  push(findLocation(structure));
  push(findYearsExperience(structure));
  hits.push(...findCurrentRole(structure));
  hits.push(...findEducation(structure));
  push(listFromSection(structure, 'skills', 'skills'));
  push(listFromSection(structure, 'languages', 'languages'));
  push(listFromSection(structure, 'certifications', 'certifications'));

  return hits;
};
