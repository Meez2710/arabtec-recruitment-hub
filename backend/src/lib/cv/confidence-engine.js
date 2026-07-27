// ConfidenceEngine — deterministic, explainable scoring. No model, no randomness:
// the same input always yields the same number, and every score decomposes into
// (extraction method) x (validation outcome).
//
//   field confidence = METHOD_WEIGHT[method] * VALIDATION_WEIGHT[validation]
//   overall          = sum(FIELD_WEIGHT * confidence) / sum(FIELD_WEIGHT)

export const METHOD_WEIGHT = {
  section: 1.00,   // found inside the correct canonical section
  labelled: 1.00,  // explicitly labelled in the document ("Mobile: ...")
  nearby: 0.85,    // adjacent to a contextual anchor
  global: 0.70,    // document-wide pattern match
  filename: 0.35,  // derived from the file name, not the content
};

export const VALIDATION_WEIGHT = {
  verified: 1.00,
  likely: 0.85,
  uncertain: 0.55,
  rejected: 0,
};

// Relative importance for the overall score. Fields the ATS needs most weigh more.
export const FIELD_WEIGHT = {
  full_name: 2.0,
  email: 1.5,
  phone: 1.0,
  location: 1.0,
  current_company: 1.5,
  current_position: 1.5,
  years_experience: 0.5,
  role_applied: 0.25,
  university: 1.0,
  major: 0.75,
  graduation_year: 0.75,
};

export function fieldConfidence(method, validation) {
  const m = METHOD_WEIGHT[method] ?? 0.5;
  const v = VALIDATION_WEIGHT[validation] ?? 0;
  return Math.round(m * v * 100) / 100;
}

// Fields that must be present for a parse to count as complete.
export const CORE_FIELDS = [
  'full_name', 'current_company', 'current_position',
  'location', 'university', 'major', 'graduation_year',
];

/**
 * @param {Record<string,{value:any,confidence:number}>} fields
 * @returns {{ overall_confidence:number, found:string[], missing:string[], core_found:number }}
 */
export function summarise(fields) {
  let earned = 0;
  let possible = 0;
  const found = [];
  const missing = [];
  for (const [name, weight] of Object.entries(FIELD_WEIGHT)) {
    possible += weight;
    const f = fields[name];
    if (f && f.value != null && f.value !== '') {
      earned += weight * (f.confidence ?? 0);
      found.push(name);
    } else missing.push(name);
  }
  const core_found = CORE_FIELDS.filter((c) => fields[c] && fields[c].value != null).length;
  return {
    overall_confidence: possible ? Math.round((earned / possible) * 100) / 100 : 0,
    found, missing, core_found,
  };
}

/**
 * F3 — parse status reflects DATA QUALITY, not how many fields are non-null.
 *
 * The previous rule counted populated core fields, so a CV whose company was a
 * mis-read tagline still reported "done". Status now requires that the core
 * fields are actually TRUSTWORTHY:
 *
 *   failed    no text, or nothing usable extracted
 *   partial   usable, but incomplete or containing low-trust values
 *   review    core fields present but several are uncertain — a human should look
 *   done      all core fields present, none uncertain, overall confidence >= 0.75
 *
 * "done" is therefore a statement about reliability, not completeness.
 */
export const STATUS = { FAILED: 'failed', PARTIAL: 'partial', REVIEW: 'review', DONE: 'done' };

const TRUSTED = new Set(['verified', 'likely']);
export const DONE_MIN_CONFIDENCE = 0.75;

export function deriveStatus({ hasText, fields }) {
  if (!hasText) return STATUS.FAILED;
  if (!fields) return STATUS.FAILED;

  const core = CORE_FIELDS.map((f) => fields[f]).filter(Boolean);
  const present = core.filter((f) => f.value != null && f.value !== '');
  if (present.length === 0) return STATUS.FAILED;

  const trusted = present.filter((f) => TRUSTED.has(f.validation));
  const uncertain = present.filter((f) => f.validation === 'uncertain');
  const { overall_confidence } = summarise(fields);

  // Every core field present, all trusted, and confident overall.
  if (present.length === CORE_FIELDS.length
      && uncertain.length === 0
      && overall_confidence >= DONE_MIN_CONFIDENCE) {
    return STATUS.DONE;
  }
  // Complete but with doubtful values -> explicitly flag for human review.
  if (present.length === CORE_FIELDS.length && uncertain.length > 0) return STATUS.REVIEW;
  // Mostly complete but a couple of values are untrustworthy.
  if (trusted.length >= 2 && uncertain.length >= 2) return STATUS.REVIEW;

  return STATUS.PARTIAL;
}

/** Human-readable reason, useful for a future review queue. */
export function statusReason({ hasText, fields }) {
  if (!hasText) return 'No text could be extracted from the document.';
  const core = CORE_FIELDS.map((f) => ({ f, d: fields[f] })).filter((x) => x.d);
  const missing = core.filter((x) => x.d.value == null).map((x) => x.f);
  const uncertain = core.filter((x) => x.d.value != null && x.d.validation === 'uncertain').map((x) => x.f);
  const bits = [];
  if (missing.length) bits.push(`missing: ${missing.join(', ')}`);
  if (uncertain.length) bits.push(`uncertain: ${uncertain.join(', ')}`);
  return bits.length ? bits.join('; ') : 'All core fields extracted and validated.';
}
