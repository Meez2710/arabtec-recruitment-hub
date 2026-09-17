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
import { Candidates, CandidateDocuments } from '../models.js';
import { raiseProposal, reviewProposal } from '../proposal-store.js';

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
  // NOT a review state. "I could not bucket this" and "a person must look at
  // this" are different facts, and the earlier label 'Unclear / Needs Review'
  // conflated them — an Arabic CV, an unusual job title or a sector the English
  // keyword rules do not cover would read as though it needed a recruiter when
  // the parse was perfectly good. Classification is a SEARCH aid and has never
  // been consulted by the gate; the name now says so.
  UNCLASSIFIED: 'Unclassified',
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
  if (hay.trim() === '') return CLASSES.UNCLASSIFIED;

  for (const [bucket, terms] of RULES) {
    if (terms.some((t) => hay.includes(t))) return bucket;
  }
  // Words were found but none of them are recognisable work. Still a candidate,
  // still searchable — just not sorted into a bucket a recruiter can trust.
  return CLASSES.UNCLASSIFIED;
}

/* --------------------------------------------------------------------------
   Data-quality labels, and the four things that actually stop a candidate.

   THE PHILOSOPHY CHANGED HERE, deliberately. An earlier version of this file
   treated a missing phone number, a thin profile or a low-confidence read as
   reasons to withhold the candidate until a recruiter approved them. That is
   backwards for a talent pool: the cost of a slightly incomplete record is that
   one field is blank, and the cost of withholding it is that the person is
   invisible to every search until somebody does paperwork.

   So uncertainty is now LABELLED, not blocked. A recruiter opening the Talent
   Pool sees everyone, with what is uncertain written on the record.

   Only four things stop a candidate being created, and each is a case where
   there is no person to create or creating one would damage someone else.
   -------------------------------------------------------------------------- */

/** The labels. Code, the badge a recruiter sees, and the sentence explaining it. */
export const FLAGS = Object.freeze({
  CONTACT_MISSING: {
    code: 'contact-missing', label: 'Contact Missing',
    reason: 'No email or phone could be extracted.',
  },
  INCOMPLETE_PROFILE: {
    code: 'incomplete-profile', label: 'Incomplete Profile',
    reason: 'Current position and experience could not be extracted reliably.',
  },
  LOW_CONFIDENCE: {
    code: 'low-confidence', label: 'Low Confidence',
    reason: 'Some parsed fields have low extraction confidence.',
  },
  UNCLASSIFIED: {
    code: 'unclassified', label: 'Unclassified',
    reason: 'Professional classification could not be determined confidently.',
  },
  POSSIBLE_DUPLICATE: {
    code: 'possible-duplicate', label: 'Possible Duplicate',
    reason: 'Another candidate has the same name, but no shared contact details were found.',
  },
  NEEDS_REVIEW: {
    code: 'needs-review', label: 'Needs Review',
    reason: 'Identity information is incomplete or conflicting.',
  },
});

/** Every flag code, for validating a filter value. */
export const FLAG_CODES = Object.freeze(Object.values(FLAGS).map((f) => f.code));

/** Hard exceptions: no candidate is created. There is no person, or making one would hurt. */
export const BLOCKED = Object.freeze({
  UNREADABLE: 'unreadable',
  NO_IDENTITY: 'no-identity',
});

/**
 * Average confidence across the identity fields that actually carry weight.
 * Parsers that report no confidence score 1 by the rule below, because a
 * provider that does not grade itself must not be treated as untrustworthy.
 */
export function identityConfidence(fields) {
  const wanted = new Set(['fullName', ...REACHABLE]);
  const scored = (fields || []).filter((f) => wanted.has(f.field) && present(f.value));
  if (scored.length === 0) return 0;
  const sum = scored.reduce((a, f) => a + (typeof f.confidence === 'number' ? f.confidence : 1), 0);
  return Number((sum / scored.length).toFixed(3));
}

/** Below this, identity fields are labelled Low Confidence — never withheld. */
export const LOW_CONFIDENCE_BELOW = 0.55;

/**
 * Assess a parsed CV.
 *
 * Returns whether a candidate can be created at all, and the labels that should
 * travel with them. `ok: false` happens only for the two document-level
 * failures; every other kind of uncertainty comes back as a flag on an
 * otherwise perfectly good candidate.
 *
 * @returns {{ok: boolean, blockCode: string|null, reason: string|null,
 *            flags: Array<{code: string, label: string, reason: string}>,
 *            classification: string, values: Map<string, unknown>}}
 */
export function assessIntake(intake) {
  const fields = intake?.fields || [];
  const values = valuesOf(fields);
  const classification = classifyProfile(values);
  const flags = [];

  /* ---- hard exception 1: nothing was read at all ---- */
  if (fields.length === 0) {
    return {
      ok: false, blockCode: BLOCKED.UNREADABLE,
      reason: 'The document could not be read — no candidate field was extracted.',
      flags, classification, values,
    };
  }

  /* ---- hard exception 2: there is no person to create ---- */
  const name = values.get('fullName');
  if (!present(name) || String(name).trim().length < 3) {
    return {
      ok: false, blockCode: BLOCKED.NO_IDENTITY,
      reason: 'No usable candidate name could be extracted from the document.',
      flags, classification, values,
    };
  }

  /* ---- everything below is a LABEL, never a blocker ---- */

  // Reachable by nothing. Still a real person with a real CV on file, and a
  // recruiter can often find a number in the document itself.
  if (REACHABLE.every((f) => !present(values.get(f)))) flags.push(FLAGS.CONTACT_MISSING);

  // Nothing readable about the work. Searchable by name and by CV text; the
  // label says the structured fields are thin.
  if (!PROFILE_SIGNALS.some((f) => present(values.get(f)))) flags.push(FLAGS.INCOMPLETE_PROFILE);

  if (identityConfidence(fields) < LOW_CONFIDENCE_BELOW) flags.push(FLAGS.LOW_CONFIDENCE);

  // A search limitation, stated as one. Never a review state.
  if (classification === CLASSES.UNCLASSIFIED) flags.push(FLAGS.UNCLASSIFIED);

  return { ok: true, blockCode: null, reason: null, flags, classification, values };
}

/** Flags as they are stored: codes for filtering, one note a person reads. */
export function encodeFlags(flags) {
  const unique = [];
  for (const f of flags) if (!unique.some((x) => x.code === f.code)) unique.push(f);
  return {
    codes: unique.length ? JSON.stringify(unique.map((f) => f.code)) : null,
    note: unique.length ? unique.map((f) => `${f.label}: ${f.reason}`).join(' ') : null,
    list: unique,
  };
}

/* ==========================================================================
   An updated CV from someone already in the pool.
   --------------------------------------------------------------------------
   Preventing a second candidate was never the whole job. A person who sends a
   newer CV two years later is telling us they are now a Senior MEP Engineer
   with eleven years behind them, and a Talent Pool that still says "MEP
   Engineer, 8 years" cannot be searched for the person they actually are.

   BUILT ON WHAT EXISTS. `raiseProposal` / `reviewProposal` are the mechanism
   the product already uses to change an existing candidate from a parsed
   document: they supersede any pending proposal, apply accepted fields to the
   candidate row, and keep the per-field accept/reject record with the previous
   value. Nothing new is invented here — the refresh is a proposal that the
   system reviews with a fixed, conservative policy instead of a person.

   THE POLICY, in one line: career data moves, identity never does.
   ========================================================================== */

/**
 * Career data. A newer CV is the candidate's own more recent statement about
 * their working life, so these are refreshed without asking.
 *
 * Nothing is destroyed silently: every change lands in the proposal record with
 * the value it replaced, and in the audit log.
 */
const REFRESHABLE = new Set([
  'currentPosition', 'currentCompany', 'yearsExperience',
  'skills', 'location', 'university', 'major', 'graduationYear',
  'languages', 'certifications', 'nationality', 'noticePeriod',
]);

/**
 * Identity and contact. NEVER changed automatically, even for a confirmed
 * match: the new document proved this is the same person, which is not the
 * same as proving their name or number should be rewritten. A recruiter
 * changes these, through the review they already have.
 */
const IDENTITY = new Set(['fullName', 'email', 'phone', 'linkedinUrl']);

/** Compare names for "is this even the same person", not for equality. */
const normName = (v) => String(v ?? '')
  .toLowerCase().normalize('NFKD')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Does the new CV dispute WHO this is, rather than update what they do?
 *
 * A shared email with a different person's name is the dangerous case — a
 * colleague forwarding a CV, a family address, a recruiter's own mailbox — and
 * silently rewriting a career onto the wrong record is worse than any queue.
 * A name that merely grew or shrank (an added middle name, a dropped initial)
 * is the same person and passes.
 */
export function identityConflict(existing, values) {
  const incoming = normName(values.get ? values.get('fullName') : values.fullName);
  const current = normName(existing?.full_name);
  if (!incoming || !current) return false;
  if (incoming === current) return false;
  // One contained in the other: "nour ibrahim" vs "nour a ibrahim".
  if (incoming.includes(current) || current.includes(incoming)) return false;
  // Otherwise require a real overlap of name parts before calling it the same
  // person; two entirely different names sharing one contact detail is exactly
  // what a human should look at.
  const a = new Set(incoming.split(' ').filter((x) => x.length > 1));
  const b = new Set(current.split(' ').filter((x) => x.length > 1));
  const shared = [...a].filter((x) => b.has(x)).length;
  return shared < Math.min(a.size, b.size);
}

/**
 * Apply a newer CV to the person already on file.
 *
 * @returns {Promise<{refreshed: string[], held: string[], proposalId: number|null}>}
 */
async function refreshExisting(existing, intake, values, actor) {
  // Career fields the new CV actually carries AND that would change something.
  // A field proposing the value already stored is noise in the history.
  const changed = [];
  for (const f of intake.fields) {
    if (!REFRESHABLE.has(f.field) || !present(f.value)) continue;
    const column = CANDIDATE_COLUMN[f.field];
    const before = column ? existing[column] : undefined;
    const same = Array.isArray(f.value)
      ? JSON.stringify(f.value) === JSON.stringify(decodeMaybeList(before))
      : String(before ?? '') === String(f.value);
    if (!same) changed.push(f);
  }

  // Identity fields are proposed too, so the record shows they were read and
  // deliberately not applied, rather than appearing never to have been seen.
  const identityFields = intake.fields.filter((f) => IDENTITY.has(f.field) && present(f.value));
  const fields = [...changed, ...identityFields];
  if (fields.length === 0) return { refreshed: [], held: [], proposalId: null };

  const proposal = await raiseProposal({
    candidateId: existing.id,
    origin: 'cv_auto_refresh',
    taskId: intake.taskId || '',
    modelId: intake.modelId || '',
    documentId: intake.documentId,
    generation: intake.generation,
    fields,
  });
  if (proposal === null) return { refreshed: [], held: [], proposalId: null };

  // The fixed policy, expressed as the decision map the reviewer would send.
  const decisions = {};
  for (const f of proposal.fields) decisions[f.field] = REFRESHABLE.has(f.field);

  const reviewed = await reviewProposal(proposal.id, decisions, actor);
  return {
    refreshed: reviewed?.applied ?? [],
    held: proposal.fields.filter((f) => IDENTITY.has(f.field)).map((f) => f.field),
    proposalId: proposal.id,
  };
}

/** candidate table column for a proposable field, for before/after comparison. */
const CANDIDATE_COLUMN = {
  currentPosition: 'current_position', currentCompany: 'current_company',
  yearsExperience: 'years_experience', location: 'location', university: 'university',
  major: 'major', graduationYear: 'graduation_year', skills: 'skills',
  languages: 'languages', certifications: 'certifications',
  nationality: 'nationality', noticePeriod: 'notice_period',
};

/** Stored list columns are JSON text; compare like with like. */
function decodeMaybeList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || v === '') return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

/**
 * Write the labels onto the candidate.
 *
 * Replaces rather than accumulates: the flags describe what the LATEST document
 * left uncertain, so a newer CV that supplies the missing phone number should
 * clear "Contact Missing" rather than leave it on the record for ever.
 */
function applyFlags(candidateId, flags) {
  if (!candidateId) return;
  try { Candidates.setQualityFlags(candidateId, encodeFlags(flags)); }
  catch { /* the candidate stands; a label is not worth losing them over */ }
}

/** Keep the document itself, so the CV history is real and hash dedup works. */
function attachDocument(candidateId, intake, actor) {
  if (!candidateId || !intake?.fileHash) return;
  try {
    const already = CandidateDocuments.byHash(intake.fileHash)
      .some((d) => Number(d.candidate_id) === Number(candidateId));
    if (already) return;
    CandidateDocuments.add({
      candidateId,
      docType: 'cv',
      fileName: intake.fileName || intake.storedName || 'cv',
      fileHash: intake.fileHash,
      fileSize: null,
      note: null,
      uploadedBy: actor?.id ?? null,
    });
  } catch { /* the candidate and the intake both stand without the document row */ }
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

  // The only two document-level failures. There is no person to create, so the
  // intake stays PENDING and a human looks at the file itself.
  if (!assessment.ok) {
    return {
      outcome: 'BLOCKED',
      candidateId: null,
      classification: assessment.classification,
      code: assessment.blockCode,
      reason: assessment.reason,
      flags: [],
    };
  }

  const { exact, potential } = classifyDuplicates(assessment.values, intake.fileHash ?? null);
  const flags = [...assessment.flags];

  const existing = exact.length > 0 ? Candidates.byId(exact[0].id) : null;

  // A shared contact detail but a materially different name — a family address,
  // a forwarded CV. Refreshing the person on file would write one career onto
  // another's record, which IS the case this module hard-refuses. That record is
  // left entirely alone; this CV becomes its own candidate carrying the flag, so
  // nothing is merged and nothing is withheld. A recruiter resolves it later.
  const conflicted = !!(existing && identityConflict(existing, assessment.values));
  if (conflicted) {
    flags.push({
      ...FLAGS.NEEDS_REVIEW,
      reason: `This CV shares ${exact[0].matchedFields.join(', ')} with `
        + `${exact[0].candidateNo} (${existing.full_name}) but names someone else.`,
    });
  }

  // Same person, newer document: move the career data, leave the identity, keep
  // both CVs. See refreshExisting() for the policy and why.
  if (existing && !conflicted) {
    let refresh = { refreshed: [], held: [], proposalId: null };
    attachDocument(existing.id, intake, actor);
    try {
      refresh = await refreshExisting(existing, intake, assessment.values, actor);
      if (refresh.refreshed.length > 0) {
        Candidates.setDisciplineClass(existing.id, assessment.classification);
      }
    } catch (e) {
      // The person is still correctly deduplicated and the document is kept.
      // A stale profile is a worse search result, never a lost CV.
      refresh = { refreshed: [], held: [], proposalId: null, error: e.message };
    }
    // Flags found on THIS document apply to the person it describes.
    applyFlags(existing.id, flags);

    const moved = refresh.refreshed.length;
    return {
      outcome: 'DUPLICATE',
      candidateId: existing.id,
      classification: assessment.classification,
      code: 'duplicate',
      reason: `Already in the Talent Pool as ${exact[0].candidateNo} `
        + `(matched on ${exact[0].matchedFields.join(', ')}). `
        + (moved > 0
          ? `Profile refreshed from the newer CV: ${refresh.refreshed.join(', ')}.`
          : 'The newer CV added nothing the profile did not already hold.'),
      matches: exact,
      refreshed: refresh.refreshed,
      heldBack: refresh.held,
      proposalId: refresh.proposalId,
      flags: encodeFlags(flags).list,
    };
  }

  // A namesake with no shared contact detail. Two people genuinely called
  // Mohamed Ali are ordinary, and withholding the second one until a recruiter
  // adjudicates makes them invisible to every search in the meantime. Create
  // them, label the uncertainty, and let a recruiter merge later if they turn
  // out to be one person. Auto-merging remains forbidden.
  if (potential.length > 0) {
    flags.push({
      ...FLAGS.POSSIBLE_DUPLICATE,
      reason: potential.length === 1
        ? `${potential[0].fullName} (${potential[0].candidateNo}) has the same name, `
          + 'but no shared contact details were found.'
        : `${potential.length} existing candidates share this name, `
          + 'but no shared contact details were found.',
    });
  }

  const decisions = {};
  for (const f of intake.fields) decisions[f.field] = true;

  try {
    // On an identity conflict we have already decided this is a DIFFERENT
    // person from the one sharing that contact detail, so reviewIntake's own
    // duplicate refusal — which exists to make a human choose — must be
    // overridden deliberately and with a reason on the record. Every other
    // path leaves it in force.
    const result = await reviewIntake(intake.id, decisions, actor, {
      source: 'cv_auto_ingest',
      ...(conflicted ? {
        overrideDuplicate: true,
        overrideReason: `Shares ${exact[0].matchedFields.join(', ')} with `
          + `${exact[0].candidateNo} but names a different person; `
          + 'created separately and flagged for a recruiter rather than merged.',
      } : {}),
    });
    if (!result || result.status !== 'CONVERTED') {
      return {
        outcome: 'NEEDS_REVIEW', candidateId: null, classification: assessment.classification,
        code: 'not-converted', reason: 'The intake could not be converted automatically.',
      };
    }
    const encoded = encodeFlags(flags);
    return {
      outcome: 'CONVERTED',
      candidateId: result.candidateId,
      classification: assessment.classification,
      code: null,
      reason: encoded.note,
      flags: encoded.list,
      matches: potential.length ? potential : undefined,
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
      classification: CLASSES.UNCLASSIFIED };
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
      outcome: 'NEEDS_REVIEW', candidateId: null, classification: CLASSES.UNCLASSIFIED,
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
      outcome: 'NEEDS_REVIEW', candidateId: null, classification: CLASSES.UNCLASSIFIED,
      code: 'error', reason: `Automatic ingest could not run: ${e.message}`,
    };
  }

  try {
    if (result.outcome === 'CONVERTED') {
      stampIntakeClassification(intake.id, result.classification);
      if (result.candidateId) {
        Candidates.setDisciplineClass(result.candidateId, result.classification);
        applyFlags(result.candidateId, result.flags || []);
        // Without this the CV history is empty and classifyDuplicates' own
        // documentHash rule can never match, so the same file arriving twice
        // would only be caught if it also shared a contact detail.
        attachDocument(result.candidateId, intake, actor);
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
