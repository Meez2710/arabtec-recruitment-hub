// Pre-candidate CV intake.
//
// THE GAP THIS FILLS. `POST /parse-cv` uploads a CV for someone who is not in
// the system yet. There is no candidate to raise a proposal against, and
// creating one first would be exactly the unreviewed write this design exists to
// prevent — `candidate.full_name` is NOT NULL, so creating the row means writing
// a parsed name before anyone has looked at it.
//
// So the parse lands HERE instead, and a candidate is created only when a person
// approves the intake. A rejected intake creates nothing.
//
// A PERSISTENCE ENVELOPE, NOT A SECOND PROPOSAL MODEL. The fields it stores are
// the shape `CandidateProposal` consumes; on approval they are handed to that
// aggregate unchanged, and it — not this file — decides what "accepted" means.

import { get, all, run, tx } from './db.js';
import { Applications, Candidates, Requests, StageHistory } from './models.js';
import { loadAggregate, raiseProposalIn, reviewProposalIn } from './proposal-store.js';

/** A conversion that cannot proceed. `code` picks the HTTP status at the route. */
export class IntakeReviewError extends Error {
  constructor(message, code, detail = null) {
    super(message);
    this.name = 'IntakeReviewError';
    this.code = code; // 'not-pending' | 'incomplete' | 'stale' | 'invalid' | 'duplicate'
    this.detail = detail;
  }
}

const parseJson = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value; // Postgres may return an object
  try { return JSON.parse(value); } catch { return fallback; }
};

function toIntake(row) {
  return {
    id: row.id,
    status: row.status,
    storedName: row.stored_name ?? null,
    fileName: row.file_name ?? null,
    mimeType: row.mime_type ?? null,
    fileHash: row.file_hash ?? null,
    origin: row.origin,
    taskId: row.task_id ?? '',
    modelId: row.model_id ?? '',
    documentId: row.document_id ?? null,
    generation: parseJson(row.generation, null),
    fields: parseJson(row.fields, []),
    requestId: row.request_id ?? null,
    candidateId: row.candidate_id ?? null,
    proposalId: row.proposal_id ?? null,
    applicationId: row.application_id ?? null,
    reason: row.reason ?? null,
    createdBy: row.created_by ?? null,
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at ?? null,
    version: row.version ?? 0,
    createdAt: row.created_at ?? null,
  };
}

/* ------------------------------- creating --------------------------------- */

/**
 * Record a parsed CV that has no candidate yet.
 *
 * Returns null when the parse produced nothing worth reviewing — there is no
 * value in a review screen with no fields on it.
 */
export function createIntake(input) {
  if (!input.fields || input.fields.length === 0) return null;

  return tx(() => {
    const inserted = run(
      `INSERT INTO candidate_intake
        (tenant_id, status, stored_name, file_name, mime_type, file_hash,
         origin, task_id, model_id, document_id, generation, fields,
         request_id, created_by, version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        1, 'PENDING', input.storedName ?? null, input.fileName ?? null,
        input.mimeType ?? null, input.fileHash ?? null,
        input.origin ?? 'resume.extract', input.taskId ?? '', input.modelId ?? '',
        input.documentId ?? null,
        input.generation ? JSON.stringify(input.generation) : null,
        JSON.stringify(input.fields),
        // Carried, not acted on: no application exists until a human approves.
        input.requestId ?? null,
        input.createdBy ?? null, 0, new Date().toISOString(),
      ],
    );
    const id = Number(inserted?.lastInsertRowid
      ?? get('SELECT id FROM candidate_intake ORDER BY id DESC LIMIT 1')?.id);
    return toIntake(get('SELECT * FROM candidate_intake WHERE id=?', [id]));
  });
}

export function intakeById(id) {
  const row = get('SELECT * FROM candidate_intake WHERE id=?', [id]);
  return row ? toIntake(row) : null;
}

/** Everything awaiting review, oldest first — a work queue, not a feed. */
export function pendingIntakes() {
  return all("SELECT * FROM candidate_intake WHERE status='PENDING' ORDER BY id ASC")
    .map(toIntake);
}

/* ------------------------------- converting -------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A requisition in one of these states can no longer take new candidates. */
const CLOSED_REQUEST_STATES = ['closed', 'cancelled', 'rejected', 'filled'];

/**
 * Is this requisition real and still open?
 *
 * Used at intake creation (fail fast, before storing a reference that can never
 * resolve) and again at conversion, because a requisition can close in between.
 */
export function checkRequest(requestId) {
  const request = Requests.byId(Number(requestId));
  if (!request) return { ok: false, reason: 'The requisition does not exist.', request: null };
  if (CLOSED_REQUEST_STATES.includes(request.status)) {
    return {
      ok: false,
      reason: `The requisition is ${request.status} and cannot take new candidates.`,
      request,
    };
  }
  return { ok: true, request };
}

/** Case-insensitive text equality, ignoring surrounding space. */
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Phone equality on digits alone: "+20 100…" and "0100…" are one number. */
const sameDigits = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = a.replace(/\D/g, '');
  const right = b.replace(/\D/g, '');
  return left.length >= 7 && left.slice(-9) === right.slice(-9);
};

/** List fields are stored as JSON arrays; everything else passes through. */
const LIST_FIELDS = new Set(['skills', 'languages', 'certifications']);

/**
 * Approve an intake and create the candidate it describes.
 *
 * ONE transaction. The candidate, its proposal, the proposal's per-field
 * decisions and the intake's own resolution commit together or not at all —
 * a candidate created without its proposal would have machine-supplied values
 * and no record of who accepted them.
 *
 * The candidate is created INSIDE the review, never before it.
 *
 * @param {number} intakeId
 * @param {Record<string, boolean>} decisions COMPLETE map: every proposed field
 * @param {{ id: number, fullName?: string }} actor
 * @param {{ expectedVersion?: number, overrideDuplicate?: boolean,
 *           overrideReason?: string, source?: string,
 *           ownerRecruiterId?: number }} [opts]
 */
export async function reviewIntake(intakeId, decisions, actor, opts = {}) {
  // Resolved BEFORE the transaction: tx() callbacks must be synchronous.
  const Aggregate = await loadAggregate();

  return tx(() => {
    // Re-read inside the transaction so a concurrent review loses rather than
    // creating a second candidate from the same CV.
    const row = get('SELECT * FROM candidate_intake WHERE id=?', [intakeId]);
    if (!row) return null;
    const intake = toIntake(row);

    if (intake.status !== 'PENDING') {
      throw new IntakeReviewError(
        `This intake is ${intake.status} and can no longer be reviewed.`, 'not-pending',
      );
    }
    if (opts.expectedVersion !== undefined && Number(opts.expectedVersion) !== intake.version) {
      throw new IntakeReviewError(
        'This intake changed since it was loaded. Reload it and review again.', 'stale',
      );
    }

    const proposed = intake.fields.map((f) => f.field);
    const missing = proposed.filter((f) => !(f in decisions));
    if (missing.length > 0) {
      throw new IntakeReviewError(
        `A decision is required for every proposed field. Missing: ${missing.join(', ')}.`,
        'incomplete',
      );
    }

    const accepted = new Map(
      intake.fields.filter((f) => decisions[f.field] === true).map((f) => [f.field, f.value]),
    );

    /* --- the candidate's own invariants, unchanged from manual creation --- */

    if (accepted.size === 0) {
      // Nothing accepted is a rejection, not a conversion. No candidate.
      run(`UPDATE candidate_intake SET status='REJECTED', reason=?, reviewed_by=?,
           reviewed_at=?, version=? WHERE id=?`,
      ['no field was accepted', actor.id, new Date().toISOString(), intake.version + 1, intake.id]);
      return { status: 'REJECTED', intakeId: intake.id, candidateId: null, applied: [] };
    }

    const fullName = accepted.get('fullName');
    if (typeof fullName !== 'string' || fullName.trim() === '') {
      // The same rule POST /candidates enforces. A candidate without a name is
      // not a weaker record, it is an unusable one.
      throw new IntakeReviewError(
        'A candidate cannot be created without an accepted full name.',
        'invalid', { requires: ['fullName'] },
      );
    }
    const email = accepted.get('email');
    if (email !== undefined && email !== null && !EMAIL_RE.test(String(email))) {
      throw new IntakeReviewError('The accepted email address is not valid.',
        'invalid', { requires: ['email'] });
    }

    /* ------------------------- duplicate detection ------------------------ */

    if (opts.overrideDuplicate !== true) {
      const duplicates = Candidates.findDuplicates({
        email: accepted.get('email') ?? null,
        phone: accepted.get('phone') ?? null,
        linkedinUrl: accepted.get('linkedinUrl') ?? null,
      });
      if (duplicates.length > 0) {
        // The intake is PRESERVED: a duplicate is a decision for a person, not
        // a reason to discard a parsed CV.
        //
        // FACTS ONLY. Which fields matched, and whether the match is on an
        // identity-grade field. No severity words, no colours — how an exact
        // match is presented differently from a potential one is the UI's
        // decision, not this layer's.
        const matches = duplicates.map((d) => {
          const matchedFields = [];
          if (sameText(d.email, accepted.get('email'))) matchedFields.push('email');
          if (sameDigits(d.phone, accepted.get('phone'))) matchedFields.push('phone');
          if (sameText(d.linkedin_url, accepted.get('linkedinUrl'))) matchedFields.push('linkedinUrl');
          return {
            id: d.id,
            candidateNo: d.candidate_no,
            fullName: d.full_name,
            email: d.email,
            matchedFields,
            // Email is an identity-grade match; a shared phone or profile link
            // is common enough between real, distinct people to be only a hint.
            kind: matchedFields.includes('email') ? 'exact' : 'potential',
          };
        });
        throw new IntakeReviewError(
          'A candidate with these contact details already exists.',
          'duplicate',
          {
            matches,
            // Conversion did not happen and will not until someone decides.
            blocked: true,
            overridable: true,
          },
        );
      }
    }

    /* ---------------------------- create + link --------------------------- */

    const payload = { candidateNo: Candidates.nextNo(), fullName: fullName.trim() };
    for (const [field, value] of accepted) {
      if (field === 'fullName') continue;
      payload[field] = LIST_FIELDS.has(field) && !Array.isArray(value) ? [] : value;
    }
    payload.source = opts.source ?? 'cv_parse';
    payload.createdBy = actor.id;
    if (opts.ownerRecruiterId !== undefined) payload.ownerRecruiterId = opts.ownerRecruiterId;

    const candidate = Candidates.create(payload);

    // The proposal is raised against the REAL candidate and then reviewed with
    // the very decisions that produced it, so the record carries the same
    // per-field accept/reject history an existing candidate's proposal does.
    const proposal = raiseProposalIn(Aggregate, {
      candidateId: candidate.id,
      origin: intake.origin,
      taskId: intake.taskId,
      modelId: intake.modelId,
      documentId: intake.documentId,
      generation: intake.generation,
      fields: intake.fields,
    });

    /* ------------------------- link to the requisition -------------------- */

    let application = null;
    if (intake.requestId !== null) {
      // Re-validated HERE, not trusted from intake time: a requisition can be
      // closed between upload and review. Failing inside the transaction means
      // no partial candidate survives a stale reference.
      const check = checkRequest(intake.requestId);
      if (!check.ok) {
        throw new IntakeReviewError(check.reason, 'request-ineligible', {
          requestId: intake.requestId,
          requestStatus: check.request ? check.request.status : null,
        });
      }

      // The existing guard against two applications for one candidate/request
      // pair. A fresh candidate cannot have one yet, but the check is the
      // contract and a retry must not create a second.
      const existing = Applications.existing(candidate.id, check.request.id);
      application = existing ?? Applications.create({
        applicationNo: Applications.nextNo(),
        candidateId: candidate.id,
        requestId: check.request.id,
        positionApplied: check.request.title,
        status: 'sourced',
        recruiterId: actor.id,
        source: opts.source ?? 'cv_intake',
        createdBy: actor.id,
      });
      if (!existing) StageHistory.add(application.id, null, 'sourced', actor);
    }

    let reviewed = null;
    if (proposal !== null) {
      // Restricted to the fields the aggregate actually kept — it filters to the
      // proposable whitelist, so the intake's map may be wider than the proposal.
      const kept = new Set(proposal.fields.map((f) => f.field));
      const forProposal = {};
      for (const field of kept) forProposal[field] = decisions[field] === true;
      reviewed = reviewProposalIn(Aggregate, proposal.id, forProposal, actor);
    }

    run(`UPDATE candidate_intake SET status='CONVERTED', candidate_id=?, proposal_id=?,
         application_id=?, reviewed_by=?, reviewed_at=?, version=? WHERE id=?`,
    [candidate.id, proposal ? proposal.id : null, application ? application.id : null,
      actor.id, new Date().toISOString(), intake.version + 1, intake.id]);

    return {
      status: 'CONVERTED',
      intakeId: intake.id,
      candidateId: candidate.id,
      proposalId: proposal ? proposal.id : null,
      applicationId: application ? application.id : null,
      requestId: intake.requestId,
      applied: reviewed ? reviewed.applied : [],
      rejected: reviewed ? reviewed.rejected : [],
      candidate: Candidates.byId(candidate.id),
      application,
      // The reviewed proposal, so the caller does not have to re-read it.
      proposal: proposal ? { id: proposal.id, status: reviewed ? reviewed.status : 'PENDING' } : null,
      // Everything below has COMMITTED by the time the caller sees this, which
      // is what makes it safe to dispatch an evaluation afterwards.
      storedName: intake.storedName,
    };
  });
}

/** Reject an intake outright. Creates no candidate, keeps the record. */
export function rejectIntake(intakeId, actor, reason) {
  return tx(() => {
    const row = get('SELECT * FROM candidate_intake WHERE id=?', [intakeId]);
    if (!row) return null;
    const intake = toIntake(row);
    if (intake.status !== 'PENDING') {
      throw new IntakeReviewError(
        `This intake is ${intake.status} and can no longer be reviewed.`, 'not-pending',
      );
    }
    run(`UPDATE candidate_intake SET status='REJECTED', reason=?, reviewed_by=?,
         reviewed_at=?, version=? WHERE id=?`,
    [reason ?? null, actor.id, new Date().toISOString(), intake.version + 1, intake.id]);
    return { status: 'REJECTED', intakeId: intake.id, candidateId: null };
  });
}
