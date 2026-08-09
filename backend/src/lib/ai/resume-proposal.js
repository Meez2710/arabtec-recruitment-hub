// Strict validation of what the model returned.
//
// THE POSTURE: reject, drop, never coerce. A value that is not the right shape
// is not "nearly right" — a phone number that arrived as an object, or a
// years-experience of 900, is a sign the reader misread the document, and
// silently repairing it is how an invented value reaches a candidate record.
//
// Mirrors the TypeScript `ExtractedResume` port
// (src/modules/shared/kernel/ai/capabilities.ts) so the JS runtime enforces the
// same contract the gateway's adapters were written against. SCHEMA_VERSION is
// recorded on the task, so a draft can always be traced to the shape that
// admitted it.
//
// Everything is OPTIONAL except the collections, which default to empty.
// Absent must stay absent: a CV that does not state a location must produce a
// draft with no location, not a guess a recruiter has to notice and delete.

export const PROPOSAL_SCHEMA_VERSION = 'resume-proposal/1.0.0';

/** Bounds are sanity limits, not business rules. Anything beyond is a misread. */
const LIMITS = {
  shortText: 200,
  longText: 2000,
  listItems: 100,
  entries: 50,
  maxYears: 70,
};

const cleanString = (v, max) => {
  if (typeof v !== 'string') return undefined;
  // Collapse whitespace so a value cannot carry newlines into a UI or a log.
  const s = v.replace(/\s+/g, ' ').trim();
  if (s === '' || s.length > max) return undefined;
  return s;
};

const cleanList = (v, max = LIMITS.shortText) => {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = cleanString(item, max);
    if (s !== undefined && !out.includes(s)) out.push(s);
    if (out.length >= LIMITS.listItems) break;
  }
  return out;
};

const cleanYears = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > LIMITS.maxYears) return undefined;
  return Math.round(n * 10) / 10;
};

/** Dates stay STRINGS, exactly as written. Normalising "2019" into a Date is a lie. */
const cleanPeriod = (v) => ({
  ...(cleanString(v?.from, 40) !== undefined ? { from: cleanString(v.from, 40) } : {}),
  ...(cleanString(v?.to, 40) !== undefined ? { to: cleanString(v.to, 40) } : {}),
  ...(typeof v?.current === 'boolean' ? { current: v.current } : {}),
});

const cleanEmployment = (v) => {
  const employer = cleanString(v?.employer, LIMITS.shortText);
  const title = cleanString(v?.title, LIMITS.shortText);
  // An entry with neither an employer nor a title says nothing; it is noise a
  // recruiter would have to delete by hand.
  if (employer === undefined && title === undefined) return null;
  return {
    employer: employer ?? '',
    title: title ?? '',
    ...(cleanString(v?.summary, LIMITS.longText) !== undefined
      ? { summary: cleanString(v.summary, LIMITS.longText) } : {}),
    ...cleanPeriod(v),
  };
};

const cleanEducation = (v) => {
  const institution = cleanString(v?.institution, LIMITS.shortText);
  const qualification = cleanString(v?.qualification, LIMITS.shortText);
  if (institution === undefined && qualification === undefined) return null;
  return {
    institution: institution ?? '',
    ...(qualification !== undefined ? { qualification } : {}),
    ...(cleanString(v?.field, LIMITS.shortText) !== undefined
      ? { field: cleanString(v.field, LIMITS.shortText) } : {}),
    ...cleanPeriod(v),
  };
};

const cleanEntries = (v, mapper) => {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const mapped = mapper(item);
    if (mapped !== null) out.push(mapped);
    if (out.length >= LIMITS.entries) break;
  }
  return out;
};

/**
 * Validate a model extraction into a draft proposal.
 *
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function validateResumeProposal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'Extraction was not an object.' };
  }

  const value = {
    ...(cleanString(raw.fullName, LIMITS.shortText) !== undefined
      ? { fullName: cleanString(raw.fullName, LIMITS.shortText) } : {}),
    ...(cleanEmail(raw.email) !== undefined ? { email: cleanEmail(raw.email) } : {}),
    ...(cleanPhone(raw.phone) !== undefined ? { phone: cleanPhone(raw.phone) } : {}),
    ...(cleanString(raw.location, LIMITS.shortText) !== undefined
      ? { location: cleanString(raw.location, LIMITS.shortText) } : {}),
    ...(cleanString(raw.headline, LIMITS.shortText) !== undefined
      ? { headline: cleanString(raw.headline, LIMITS.shortText) } : {}),
    ...(cleanYears(raw.totalYearsExperience) !== undefined
      ? { totalYearsExperience: cleanYears(raw.totalYearsExperience) } : {}),
    skills: cleanList(raw.skills),
    employment: cleanEntries(raw.employment, cleanEmployment),
    education: cleanEntries(raw.education, cleanEducation),
    languages: cleanList(raw.languages),
    certifications: cleanList(raw.certifications),
    uncertainFields: cleanList(raw.uncertainFields, 60),
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
  };

  // A proposal with nothing usable in it is a failed read dressed as a success.
  // Better to fail the task and let the recruiter type it in than to open a
  // review screen with every field blank.
  const hasAnything = value.fullName !== undefined || value.email !== undefined
    || value.phone !== undefined || value.skills.length > 0
    || value.employment.length > 0 || value.education.length > 0;
  if (!hasAnything) return { ok: false, reason: 'Extraction contained no usable field.' };

  return { ok: true, value };
}

/**
 * Emails are kept only when they are plausibly an address.
 *
 * Not RFC-complete on purpose: this decides whether to SHOW a value for review,
 * and the ordinary candidate service validates again on confirmation.
 */
function cleanEmail(v) {
  const s = cleanString(v, LIMITS.shortText);
  if (s === undefined) return undefined;
  const compact = s.replace(/\s/g, '');
  return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(compact) ? compact.toLowerCase() : undefined;
}

/**
 * Phone numbers keep their ORIGINAL formatting.
 *
 * Reformatting a Gulf mobile into a guessed international form is a
 * correctness risk with no upside — the recruiter can see and edit the value
 * exactly as the CV wrote it.
 */
function cleanPhone(v) {
  const s = cleanString(v, 40);
  if (s === undefined) return undefined;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return undefined;
  return s;
}
