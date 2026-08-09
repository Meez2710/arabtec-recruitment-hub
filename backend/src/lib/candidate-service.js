// Candidate creation as a SERVICE, callable from more than one route.
//
// WHY THIS WAS EXTRACTED. AI-assisted intake ends with a human confirming a
// proposal, and that confirmation must produce a candidate the same way the
// manual form does — same validation, same duplicate detection, same override
// gate, same activity and audit trail. A second creation path written next to
// the AI code would drift from this one within a release, and the drift would
// show up as candidates that skipped a rule nobody remembered was there.
//
// So the rules live here and `POST /api/candidates` delegates to it. The AI
// confirm endpoint calls the SAME function. The AI path gets no shortcut: it
// cannot bypass duplicate detection, it cannot set a salary the user may not
// set, and it is subject to the same permissions, because it is not a
// different kind of creation — it is the same act with a different way of
// filling in the form.
//
// Behaviour is preserved exactly as the route implemented it; this is a move,
// not a redesign.

import {
  Candidates, Applications, CandidateActivity, Requests, CustomFields, StageHistory,
} from './models.js';
import { writeAudit } from './audit.js';
import { tx } from './db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const canSalary = (u) => u.permissions.includes('salary.view');

/** Statuses of a requisition that may not receive a new application. */
const CLOSED_REQUEST_STATUSES = ['closed', 'cancelled', 'rejected', 'filled'];

/** Thrown for anything a caller should turn into a 4xx. Carries the status. */
export class CandidateServiceError extends Error {
  constructor(status, body) {
    super(body.error);
    this.name = 'CandidateServiceError';
    this.status = status;
    this.body = body;
  }
}

function saveCustomFields(entity, recordId, body) {
  const vals = body && body.customFields;
  if (!vals || typeof vals !== 'object') return;
  const defined = new Set(CustomFields.forEntity(entity).map((f) => f.field_key));
  for (const [k, v] of Object.entries(vals)) if (defined.has(k)) CustomFields.setValue(entity, recordId, k, v);
}

/**
 * Validate a candidate payload and report what is wrong.
 * Separated so a caller can check BEFORE spending work (the AI review screen
 * validates a draft without creating anything).
 *
 * @returns {{ok: true} | {ok: false, status: number, body: object}}
 */
export function validateCandidatePayload(d, user) {
  if (!d.fullName || !String(d.fullName).trim()) {
    return { ok: false, status: 400, body: { error: 'Full name is required.' } };
  }
  if (!d.email && !d.phone) {
    return { ok: false, status: 400, body: { error: 'At least one contact method (email or phone) is required.' } };
  }
  if (d.email && !EMAIL_RE.test(d.email)) {
    return { ok: false, status: 400, body: { error: 'Invalid email format.' } };
  }
  if (d.yearsExperience != null && d.yearsExperience !== '' && Number.isNaN(Number(d.yearsExperience))) {
    return { ok: false, status: 400, body: { error: 'Years of experience must be numeric.' } };
  }
  void user;
  return { ok: true };
}

/**
 * Create a candidate, optionally linking it to a requisition.
 *
 * @param {object} req  express request — supplies the actor, ip and user-agent
 * @param {object} d    the candidate payload
 * @param {{source?: string}} [opts] provenance note for the activity trail
 * @returns {{candidate: object, application: object|null}}
 * @throws {CandidateServiceError}
 */
export function createCandidate(req, d, opts = {}) {
  const user = req.user;
  const check = validateCandidatePayload(d, user);
  if (!check.ok) throw new CandidateServiceError(check.status, check.body);

  const dups = Candidates.findDuplicates({ email: d.email, phone: d.phone, linkedinUrl: d.linkedinUrl });
  if (dups.length && !d.overrideDuplicate) {
    throw new CandidateServiceError(409, {
      error: 'Possible duplicate candidate detected.',
      duplicates: dups.map((c) => ({
        id: c.id, candidateNo: c.candidate_no, fullName: c.full_name, email: c.email, phone: c.phone,
      })),
      hint: 'Resubmit with overrideDuplicate=true and a reason (requires candidate.merge), or use an existing candidate.',
    });
  }
  if (dups.length && d.overrideDuplicate) {
    if (!user.permissions.includes('candidate.merge')) {
      throw new CandidateServiceError(403, { error: 'You are not permitted to override duplicate detection.' });
    }
    if (!d.overrideReason || !String(d.overrideReason).trim()) {
      throw new CandidateServiceError(400, { error: 'A reason is required to override duplicate detection.' });
    }
  }

  // Salary only settable by authorized roles — unchanged by how the form was filled.
  const expectedSalary = canSalary(user) && d.expectedSalary != null && d.expectedSalary !== ''
    ? Number(d.expectedSalary) : null;

  return tx(() => {
    const candidateNo = Candidates.nextNo();
    const created = Candidates.create({
      candidateNo, fullName: String(d.fullName).trim(), email: d.email, phone: d.phone,
      nationality: d.nationality, location: d.location, linkedinUrl: d.linkedinUrl,
      currentCompany: d.currentCompany, currentPosition: d.currentPosition,
      yearsExperience: d.yearsExperience != null && d.yearsExperience !== '' ? Number(d.yearsExperience) : null,
      expectedSalary, noticePeriod: d.noticePeriod, source: d.source,
      employer: d.employer, currentProject: d.currentProject,
      graduationYear: d.graduationYear != null && d.graduationYear !== '' ? Number(d.graduationYear) : null,
      university: d.university, major: d.major,
      tags: Array.isArray(d.tags)
        ? d.tags
        : (d.tags ? String(d.tags).split(',').map((s) => s.trim()).filter(Boolean) : []),
      ownerRecruiterId: d.ownerRecruiterId ? Number(d.ownerRecruiterId) : user.id,
      createdBy: user.id,
    });
    saveCustomFields('candidate', created.id, d);
    CandidateActivity.add({
      candidateId: created.id, actorId: user.id, actorName: user.fullName,
      type: 'candidate_created',
      note: opts.source ? `${candidateNo} (${opts.source})` : candidateNo,
    });
    writeAudit(req, {
      action: 'candidate.created', entityType: 'candidate', entityId: created.id,
      newValue: { candidateNo, fullName: created.full_name, ...(opts.source ? { via: opts.source } : {}) },
      comments: d.overrideDuplicate ? `Duplicate override: ${d.overrideReason}` : null,
    }, { strict: true });

    // Auto-link to a requisition when one was named. Entry stage only — BL-03.
    let linkedApp = null;
    if (d.requestId && user.permissions.includes('candidate.link')) {
      const reqId = Number(d.requestId);
      const request = Requests.byId(reqId);
      if (request && !CLOSED_REQUEST_STATUSES.includes(request.status)) {
        const existing = Applications.existing(created.id, reqId);
        if (!existing) {
          const appNo = Applications.nextNo();
          const app = Applications.create({
            applicationNo: appNo, candidateId: created.id, requestId: reqId,
            positionApplied: d.positionApplied || request.title, status: 'sourced',
            recruiterId: user.id, source: d.source, createdBy: user.id,
          });
          StageHistory.add(app.id, null, 'sourced', user);
          CandidateActivity.add({
            candidateId: created.id, applicationId: app.id, actorId: user.id,
            actorName: user.fullName, type: 'linked_to_request',
            note: `Linked to ${request.ticket_no}`,
          });
          linkedApp = app;
        }
      }
    }
    return { candidate: created, application: linkedApp };
  });
}
