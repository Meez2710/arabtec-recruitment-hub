/* ===========================================================================
   Auto-ingest: a clean CV becomes a Talent Pool candidate without a human.
   ---------------------------------------------------------------------------
   Arabtec collects CVs long before a vacancy exists, so incoming mail must not
   wait on a recruiter and must not depend on a hiring request. Before this
   module every successfully parsed CV stopped at `candidate_intake` with
   status PENDING and needed a person to accept each field one at a time. In
   production that queue reached 41 CVs and produced zero candidates.

   WHAT THIS IS NOT. It is not a second intake path. The decision to create a
   candidate still runs through `reviewIntake()` — the same transaction, the
   same duplicate classifier, the same proposal history, the same audit. All
   this module adds is the judgement a recruiter was making by hand: is this
   parse clean enough to accept as-is? Everything downstream is unchanged, which
   is also why no Application is ever created: `reviewIntake` raises one only
   when the intake carries a `requestId`, and a mailbox CV never does.

   THE SPLIT. Candidate Review stops being a queue of everything and becomes a
   queue of exceptions — unreadable documents, unusable identity, thin
   extractions, and duplicate ambiguity a machine must not resolve.
   =========================================================================== */

import {
  reviewIntake, classifyDuplicates, IntakeReviewError,
  markIntakeDuplicate, markIntakeNeedsReview, stampIntakeClassification,
} from '../intake-store.js';
import { Candidates } from '../models.js';

/* --------------------------------------------------------------------------
   Identity sufficiency.

   A candidate record is only useful if you can name the person and reach them.
   Everything else — location, university, current employer — is enrichment: a
   CV with no LinkedIn URL is a normal CV, not a defect, and must not cost a
   recruiter a review click.

   This is deliberately the same rule the parser already applies when it sets
   `parse_status: 'done'` (a name, plus an email or a phone). Restating it here
   rather than importing the parser's metadata keeps the gate readable on its
   own and keeps it working for intakes that arrived through the upload route,
   whose rich metadata is not persisted on the intake row.
   -------------------------------------------------------------------------- */
const REACHABLE = ['email', 'phone', 'linkedinUrl'];

/** Fields that, present together, make the profile worth searching. */
const PROFILE_SIGNALS = [
  'currentPosition', 'currentCompany', 'yearsExperience',
  'skills', 'university', 'major', 'location',
];

/** A parsed field is "present" only with a value a person could act on. */
function present(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

/** field -> value, from the intake's proposed-field array. */
export function valuesOf(fields) {
  const map = new Map();
  for (const f of fields || []) {
    if (present(f.value)) map.set(f.field, f.value);
  }
  return map;
}

/* --------------------------------------------------------------------------
   Broad classification.

   NOT a match against hiring requests, and never a reason to reject anyone.
   Arabtec is a construction contractor, so an accountant or an IT administrator
   is a real hire for a real department — the bucket exists so a recruiter can
   filter the pool, not so the system can turn people away.

   Keyword matching against the candidate's own words. Cheap, explainable and
   offline: no model call, so classifying 1,700 CVs costs nothing.
   -------------------------------------------------------------------------- */
export const CLASSES = Object.freeze({
  CORE: 'Construction / Engineering Core',
  SUPPORT: 'Construction / Engineering Support',
  ADJACENT: 'Adjacent / Transferable',
  OTHER: 'Other Professional Background',
  UNCLEAR: 'Unclear / Needs Review',
});

// Ordered most-specific first: the first bucket that matches wins, so
// "site engineer" is Core rather than being caught by a generic term.
const RULES = [
  [CLASSES.CORE, [
    'civil engineer', 'site engineer', 'structural engineer', 'construction manager',
    'project engineer', 'resident engineer', 'quantity surveyor', 'qa/qc', 'qaqc',
    'planning engineer', 'mep engineer', 'mechanical engineer', 'electrical engineer',
    'architect', 'surveyor', 'foreman', 'site manager', 'construction',
    'draughtsman', 'draftsman', 'autocad', 'revit', 'primavera', 'bim',
    'formwork', 'reinforcement', 'concrete', 'steel structure', 'piling',
    'hse engineer', 'safety engineer', 'geotechnical', 'estimation engineer',
    'technical office', 'contracts engineer', 'plant engineer', 'site supervisor',
  ]],
  [CLASSES.SUPPORT, [
    'procurement', 'purchasing', 'logistics', 'store keeper', 'storekeeper',
    'warehouse', 'document control', 'document controller', 'hse officer',
    'safety officer', 'quality control', 'quality assurance', 'cost control',
    'contract administrator', 'project coordinator', 'project control',
    'materials engineer', 'surveying technician', 'equipment', 'maintenance',
  ]],
  [CLASSES.ADJACENT, [
    'mechanical', 'electrical', 'industrial engineer', 'manufacturing',
    'oil and gas', 'petroleum', 'chemical engineer', 'energy', 'utilities',
    'facility', 'facilities', 'real estate', 'property', 'surveying',
    'engineer', 'engineering', 'technician',
  ]],
  [CLASSES.OTHER, [
    'accountant', 'accounting', 'finance', 'audit', 'human resources', 'hr ',
    'recruitment', 'payroll', 'administrator', 'administration', 'secretary',
    'receptionist', 'sales', 'marketing', 'customer service', 'legal',
    'information technology', 'it support', 'software', 'developer', 'network',
    'translator', 'teacher', 'nurse', 'driver', 'graphic designer', 'data entry',
  ]],
];

/**
 * Classify from whatever the CV actually yielded.
 *
 * Reads position, company, major and skills — the fields that describe the work
 * — and never the person's name or contact details.
 */
export function classifyProfile(values) {
  const parts = [];
  for (const key of ['currentPosition', 'currentCompany', 'major', 'skills']) {
    const v = values.get ? values.get(key) : values[key];
    if (!present(v)) continue;
    parts.push(Array.isArray(v) ? v.join(' ') : String(v));
  }
  const hay = ` ${parts.join(' ').toLowerCase()} `;
  if (hay.trim() === '') return CLASSES.UNCLEAR;

  for (const [bucket, terms] of RULES) {
    if (terms.some((t) => hay.includes(t))) return bucket;
  }
  // Words were found but none of them are recognisable work. Still a candidate,
  // still searchable — just not sorted into a bucket a recruiter can trust.
  return CLASSES.UNCLEAR;
}

/* --------------------------------------------------------------------------
   The gate.
   -------------------------------------------------------------------------- */

/**
 * Average confidence across the identity fields that actually carry weight.
 * A CV where the name and the phone number were both read at 0.35 is a guess,
 * however many other fields came back.
 */
export function identityConfidence(fields) {
  const wanted = new Set(['fullName', ...REACHABLE]);
  const scored = (fields || []).filter((f) => wanted.has(f.field) && present(f.value));
  if (scored.length === 0) return 0;
  const sum = scored.reduce((a, f) => a + (typeof f.confidence === 'number' ? f.confidence : 1), 0);
  return Number((sum / scored.length).toFixed(3));
}

/**
 * The minimum confidence an identity may carry and still be trusted unattended.
 *
 * Tuned to admit a deterministic read (an email matched by rule scores 1.0) and
 * a solid model read, while sending a genuinely uncertain one to a person.
 * Parsers that report no confidence at all score 1 by the rule in
 * identityConfidence(), because a provider that does not grade itself must not
 * be silently treated as untrustworthy.
 */
export const MIN_IDENTITY_CONFIDENCE = 0.55;

/** Distinct profile signals required before a record is worth searching. */
export const MIN_PROFILE_SIGNALS = 1;

/**
 * Decide whether an intake may enter the Talent Pool unattended.
 *
 * Returns a verdict, never a throw: the caller records the reason on the intake
 * so a recruiter opening Candidate Review is told WHY this one needed them.
 *
 * @returns {{ok: boolean, code: string|null, reason: string|null,
 *            classification: string, values: Map<string, unknown>}}
 */
export function assessIntake(intake) {
  const fields = intake?.fields || [];
  const values = valuesOf(fields);
  const classification = classifyProfile(values);
  const verdict = (ok, code, reason) => ({ ok, code, reason, classification, values });

  if (fields.length === 0) {
    return verdict(false, 'no-fields', 'The reader returned no usable field from this document.');
  }

  const name = values.get('fullName');
  if (!present(name) || String(name).trim().length < 3) {
    return verdict(false, 'identity-unclear', 'No usable full name could be read from the CV.');
  }

  const reachable = REACHABLE.filter((f) => present(values.get(f)));
  if (reachable.length === 0) {
    return verdict(false, 'identity-unclear',
      'The CV has a name but no email, phone or LinkedIn — the person could not be contacted.');
  }

  const confidence = identityConfidence(fields);
  if (confidence < MIN_IDENTITY_CONFIDENCE) {
    return verdict(false, 'low-confidence',
      `Identity fields were read with low confidence (${confidence}).`);
  }

  const signals = PROFILE_SIGNALS.filter((f) => present(values.get(f)));
  if (signals.length < MIN_PROFILE_SIGNALS) {
    return verdict(false, 'thin-profile',
      'Nothing about the person\'s work could be read, so the record would not be searchable.');
  }

  return verdict(true, null, null);
}

/* --------------------------------------------------------------------------
   Applying the verdict.
   -------------------------------------------------------------------------- */

/**
 * Run a clean intake straight through review, as the system.
 *
 * Every proposed field is accepted, which is precisely what a recruiter was
 * doing by hand for a clean CV. Rejecting fields is a human judgement and stays
 * one — this never drops a value the reader supported.
 *
 * Duplicates are the one case that changes shape. `reviewIntake` refuses an
 * exact duplicate so a person can decide, which is right for a manual review
 * and wrong for an unattended queue: the correct unattended outcome is to keep
 * the one candidate, not to raise a decision nobody asked for. So an exact
 * match resolves the intake as DUPLICATE against the candidate it matched, and
 * a name-only lookalike — where merging would be a guess about a real person —
 * goes to a human.
 *
 * @param {object} intake     a PENDING intake, as returned by createIntake()
 * @param {{id: number|null, fullName?: string}} actor
 * @returns {Promise<{outcome: string, candidateId: number|null,
 *                    classification: string, reason: string|null}>}
 */
export async function autoIngest(intake, actor) {
  const assessment = assessIntake(intake);
  if (!assessment.ok) {
    return {
      outcome: 'NEEDS_REVIEW',
      candidateId: null,
      classification: assessment.classification,
      code: assessment.code,
      reason: assessment.reason,
    };
  }

  // Name-only lookalikes are checked BEFORE the write. `reviewIntake` reports
  // them after the fact because a human had already decided; unattended, a
  // second "Ahmed Hassan" is exactly the case a machine must not resolve.
  const { exact, potential } = classifyDuplicates(assessment.values, intake.fileHash ?? null);

  if (exact.length > 0) {
    return {
      outcome: 'DUPLICATE',
      candidateId: exact[0].id,
      classification: assessment.classification,
      code: 'duplicate',
      reason: `Already in the Talent Pool as ${exact[0].candidateNo} `
        + `(matched on ${exact[0].matchedFields.join(', ')}).`,
      matches: exact,
    };
  }

  if (potential.length > 0) {
    return {
      outcome: 'NEEDS_REVIEW',
      candidateId: null,
      classification: assessment.classification,
      code: 'duplicate-ambiguous',
      reason: `${potential.length} existing candidate(s) share this name but no contact detail. `
        + 'Merging or separating them is a judgement about a real person.',
      matches: potential,
    };
  }

  const decisions = {};
  for (const f of intake.fields) decisions[f.field] = true;

  try {
    const result = await reviewIntake(intake.id, decisions, actor, { source: 'cv_auto_ingest' });
    if (!result || result.status !== 'CONVERTED') {
      return {
        outcome: 'NEEDS_REVIEW', candidateId: null, classification: assessment.classification,
        code: 'not-converted', reason: 'The intake could not be converted automatically.',
      };
    }
    return {
      outcome: 'CONVERTED',
      candidateId: result.candidateId,
      classification: assessment.classification,
      code: null,
      reason: null,
    };
  } catch (e) {
    // A rule the candidate record itself enforces (an invalid email that got
    // past the reader, a requisition that closed). The intake is untouched and
    // still PENDING, so the CV is never lost — a person sees it with the
    // reason attached.
    const reason = e instanceof IntakeReviewError
      ? e.message
      : `Automatic ingest failed: ${e.message}`;
    return {
      outcome: 'NEEDS_REVIEW', candidateId: null, classification: assessment.classification,
      code: e instanceof IntakeReviewError ? (e.code || 'invalid') : 'error', reason,
    };
  }
}

/* --------------------------------------------------------------------------
   The one entry point.
   -------------------------------------------------------------------------- */

/**
 * Decide, act, and record — for a freshly created intake.
 *
 * Both callers (the mailbox sync and the manual upload route) go through here,
 * so a CV behaves identically whichever door it came in by. Never throws: an
 * intake that cannot be resolved stays PENDING with a reason, which is a
 * recruiter's queue item, not a lost CV.
 *
 * @param {object} intake  a PENDING intake as returned by createIntake()
 * @param {{id: number|null, fullName?: string}} actor
 */
export async function ingestIntake(intake, actor) {
  if (!intake || !intake.id) {
    return { outcome: 'NEEDS_REVIEW', candidateId: null, code: 'no-intake', reason: null,
      classification: CLASSES.UNCLEAR };
  }

  /* NEVER auto-create an Application. `reviewIntake` raises one whenever the
     intake names a requisition, so an intake that carries a requestId is
     refused here rather than guarded at each call site — that makes the rule
     structural: a future caller cannot wire around it by forgetting a check.

     A recruiter who uploaded a CV AGAINST a vacancy has expressed an intent to
     put this person forward, and that is a hiring decision, not a filing one.
     It stays with them. Mailbox CVs never carry a requisition, so the whole
     incoming-mail flow is unaffected. */
  if (intake.requestId !== null && intake.requestId !== undefined) {
    return {
      outcome: 'NEEDS_REVIEW', candidateId: null, classification: CLASSES.UNCLEAR,
      code: 'request-linked',
      reason: 'This CV was uploaded against a hiring request, so putting the person '
        + 'forward stays a recruiter decision.',
    };
  }

  let result;
  try {
    result = await autoIngest(intake, actor);
  } catch (e) {
    // The gate itself failing must never cost the CV. Leave it for a person.
    result = {
      outcome: 'NEEDS_REVIEW', candidateId: null, classification: CLASSES.UNCLEAR,
      code: 'error', reason: `Automatic ingest could not run: ${e.message}`,
    };
  }

  try {
    if (result.outcome === 'CONVERTED') {
      stampIntakeClassification(intake.id, result.classification);
      if (result.candidateId) {
        Candidates.setDisciplineClass(result.candidateId, result.classification);
      }
    } else if (result.outcome === 'DUPLICATE') {
      markIntakeDuplicate(intake.id, result.candidateId, result.reason, actor);
    } else {
      markIntakeNeedsReview(intake.id, {
        code: result.code, reason: result.reason, classification: result.classification,
      });
    }
  } catch { /* the intake and any candidate already stand; metadata is not worth losing them over */ }

  return result;
}
