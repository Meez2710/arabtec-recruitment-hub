// CV → candidate mapping.
//
// The ONLY place that knows both the parser's generic entity shape and the ATS
// candidate columns. Parser modules under lib/cv/ stay database-agnostic; this
// adapter sits between them and the persistence layer.
//
// Extracted CV text is deliberately NOT mapped: the uploaded file is the single
// source of truth and is re-read whenever a re-parse is needed.
import crypto from 'node:crypto';
import fs from 'node:fs';

// Only values at or above this trust level are written to a candidate record.
// `uncertain` values are kept in the parse report for review but never persisted,
// so the Talent Pool does not fill with doubtful data.
const PERSISTABLE = new Set(['verified', 'likely']);

/** entity group key -> Candidates.create/update payload key */
const FIELD_MAP = {
  full_name: 'fullName',
  email: 'email',
  phone: 'phone',
  location: 'location',
  linkedin_url: 'linkedinUrl',
  current_company: 'currentCompany',
  current_position: 'currentPosition',
  years_experience: 'yearsExperience',
  university: 'university',
  major: 'major',
  graduation_year: 'graduationYear',
};

/** Flattens { personal, employment, education } into one field map. */
export function flattenEntities(parsed) {
  return { ...(parsed.personal || {}), ...(parsed.employment || {}), ...(parsed.education || {}) };
}

/**
 * Build the persistable payload from parser output.
 * @param {object} parsed  result of parseEntities()
 * @param {object} [opts]
 * @param {boolean} [opts.includeUncertain=false]  persist `uncertain` values too
 * @returns {{ payload: object, skipped: string[], persisted: string[] }}
 */
export function toCandidatePayload(parsed, { includeUncertain = false, verifiedOnly = false } = {}) {
  const fields = flattenEntities(parsed);
  const payload = {};
  const persisted = [];
  const skipped = [];

  // `verifiedOnly` is the CV-import setting. A `likely` value is one only the
  // MODEL read — located in the document and well-formed, but with no
  // independent rule agreeing — so it goes to a proposal for a human instead of
  // straight onto the record. Every other caller keeps the original threshold.
  const allowed = verifiedOnly ? new Set(['verified']) : PERSISTABLE;

  for (const [entity, column] of Object.entries(FIELD_MAP)) {
    const f = fields[entity];
    if (!f || f.value == null || f.value === '') { skipped.push(entity); continue; }
    const trusted = allowed.has(f.validation) || (includeUncertain && f.validation === 'uncertain');
    if (!trusted) { skipped.push(entity); continue; }
    payload[column] = f.value;
    persisted.push(entity);
  }
  return { payload, skipped, persisted };
}

/** Parse-quality metadata stored alongside the candidate (never the CV text). */
export function toParseMetadata(parsed) {
  return {
    parseStatus: parsed?.metadata?.parse_status || 'failed',
    parseConfidence: typeof parsed?.metadata?.overall_confidence === 'number'
      ? parsed.metadata.overall_confidence : null,
    parsedAt: new Date().toISOString(),
  };
}

/** SHA-256 of the stored file — the primary duplicate key for re-uploads. */
export function fileHash(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch { return null; }
}

/**
 * Per-file import outcome, safe to return to the UI.
 * Contains no CV text.
 */
export function toImportReport(parsed, { fileName, candidateNo = null, duplicateOf = null } = {}) {
  const { persisted, skipped } = toCandidatePayload(parsed);
  return {
    fileName,
    candidateNo,
    duplicateOf,
    parseStatus: parsed?.metadata?.parse_status || 'failed',
    confidence: parsed?.metadata?.overall_confidence ?? 0,
    reason: parsed?.metadata?.parse_status_reason || null,
    fieldsPersisted: persisted,
    fieldsSkipped: skipped,
  };
}

export { FIELD_MAP, PERSISTABLE };
