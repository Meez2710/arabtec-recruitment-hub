import { Router } from 'express';
import {
  Candidates, CandidateDocuments, Applications, CandidateNotes, CandidateActivity,
  Users, Projects, Requests, Interviews, Offers, CustomFields, StageHistory,
  decodeList, HardDelete } from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { multipart, streamFile, uploadPath } from '../lib/upload.js';
import { run as dbRun, get as dbGet } from '../lib/db.js';
import { sendMail } from '../lib/mailer.js';
import { rejection as rejectionTpl } from '../lib/email_templates.js';
// Resolved per request through the parsing registry, never imported directly.
// One provider serves a request; there is no fallback chain and no fan-out.
import { getParser } from '../lib/parsing/registry.js';
import { evaluateAgainstRequest } from '../lib/parsing/evaluation.js';
import { parseDocument, reviewableFields } from '../lib/parsing/pipeline-provider.js';
import { createJob, completeJob, failJob, getJob } from '../lib/parsing/jobs.js';
import {
  checkRequest, createIntake, intakeById, pendingIntakes, reviewIntake, rejectIntake,
} from '../lib/intake-store.js';
import { raiseProposal, pendingProposal, proposalsFor, reviewProposal } from '../lib/proposal-store.js';
import { toCandidatePayload, toParseMetadata, fileHash, toImportReport, FIELD_MAP } from '../lib/cv-mapper.js';
import { getWatcherStatus } from '../lib/cv-watcher.js';
import { interpretSearch } from '../lib/ai/recruiter-ai.js';
import fs from 'node:fs';
import path from 'node:path';

const router = Router();
router.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const canSalary = (u) => u.permissions.includes('salary.view');

// Persist any custom-field values posted with the candidate (admin-defined fields).
function saveCustomFields(entity, recordId, body) {
  const vals = body && body.customFields;
  if (!vals || typeof vals !== 'object') return;
  const defined = new Set(CustomFields.forEntity(entity).map((f) => f.field_key));
  for (const [k, v] of Object.entries(vals)) if (defined.has(k)) CustomFields.setValue(entity, recordId, k, v);
}

function serialize(c, user, { withDetail = false } = {}) {
  const seeSalary = canSalary(user);
  const owner = c.owner_recruiter_id ? Users.byId(c.owner_recruiter_id) : null;
  // Read once and derive both the count and the compact link summary below.
  // The count already cost this query; the summary is what the Talent Pool
  // needs to show WHICH request a candidate is on without opening the profile.
  const applications = Applications.forCandidate(c.id);
  const out = {
    id: c.id, candidateNo: c.candidate_no, fullName: c.full_name, email: c.email, phone: c.phone,
    nationality: c.nationality, location: c.location, linkedinUrl: c.linkedin_url,
    currentCompany: c.current_company, currentPosition: c.current_position,
    yearsExperience: c.years_experience, noticePeriod: c.notice_period, source: c.source,
    // enhancement fields (HR-leadership requested)
    employer: c.employer, currentProject: c.current_project,
    graduationYear: c.graduation_year, university: c.university, major: c.major,
    resumeName: c.resume_name, hasResume: !!c.resume_path,
    tags: c.tags ? JSON.parse(c.tags) : [], candidateState: c.candidate_state,
    // Always arrays through the API, even when the column is NULL.
    skills: decodeList(c.skills), languages: decodeList(c.languages),
    certifications: decodeList(c.certifications),
    parseStatus: c.parse_status || null, parseConfidence: c.parse_confidence ?? null,
    parsedAt: c.parsed_at || null,
    screeningStatus: c.screening_status || 'new',
    // GDPR/PDPL status (shown on the candidate profile)
    consentStatus: c.consent_status || 'unknown', consentAt: c.consent_at,
    retentionUntil: c.retention_until, erasedAt: c.erased_at,
    ownerRecruiter: owner ? { id: owner.id, name: owner.full_name } : null,
    ownerRecruiterId: c.owner_recruiter_id, createdAt: c.created_at, updatedAt: c.updated_at,
    salaryVisible: seeSalary,
    expectedSalary: seeSalary ? c.expected_salary : null,
    applicationCount: applications.length,
    // Which requests this candidate is already on. Enough for the Talent Pool
    // to render the link and route to the request, and to stop a recruiter
    // re-linking a request they are already on — the same rule POST
    // /applications enforces, surfaced before the click rather than after it.
    links: applications.map((a) => {
      const r = a.request_id ? Requests.byId(a.request_id) : null;
      return {
        applicationId: a.id,
        applicationNo: a.application_no,
        requestId: a.request_id,
        ticketNo: r ? r.ticket_no : null,
        requestTitle: r ? r.title : null,
        requestStatus: r ? r.status : null,
        status: a.status,
      };
    }),
    customFields: CustomFields.valuesFor('candidate', c.id),
  };
  if (withDetail) {
    out.documents = CandidateDocuments.forCandidate(c.id);
    out.notes = CandidateNotes.forCandidate(c.id);
    out.activity = CandidateActivity.forCandidate(c.id);
    // Interviews for this candidate (scoped: full-view roles see all; others see only theirs).
    const seeAllIv = user.permissions.includes('interview.view_all');
    const seeAssignedIv = user.permissions.includes('interview.view_assigned');
    if (seeAllIv || seeAssignedIv) {
      out.interviews = Interviews.forCandidate(c.id)
        .filter((iv) => {
          if (seeAllIv) return true;
          if (iv.organizer_id === user.id || Interviews.isPanelist(iv.id, user.id)) return true;
          const r = iv.request_id ? Requests.byId(iv.request_id) : null; // request-owner scope
          return !!r && (r.requester_id === user.id || r.owner_id === user.id || r.created_by === user.id);
        })
        .map((iv) => {
          const req = iv.request_id ? Requests.byId(iv.request_id) : null;
          return { id: iv.id, interviewNo: iv.interview_no, applicationId: iv.application_id, requestId: iv.request_id,
            ticketNo: req?.ticket_no, interviewType: iv.interview_type, mode: iv.mode, round: iv.round,
            scheduledAt: iv.scheduled_at, status: iv.status, overallOutcome: iv.overall_outcome };
        });
    } else { out.interviews = []; }
    // Offers for this candidate (offer-salary masked unless offer.salary_view).
    if (user.permissions.includes('offer.view')) {
      const seeOfferSalary = user.permissions.includes('offer.salary_view');
      out.offers = Offers.forCandidate(c.id).map((o) => {
        const req = o.request_id ? Requests.byId(o.request_id) : null;
        return { id: o.id, offerNo: o.offer_no, applicationId: o.application_id, requestId: o.request_id,
          ticketNo: req?.ticket_no, positionTitle: o.position_title, status: o.status,
          joiningDate: o.joining_date, salaryVisible: seeOfferSalary,
          salaryOffered: seeOfferSalary ? o.salary_offered : null, currency: o.currency, createdAt: o.created_at };
      });
    } else { out.offers = []; }
    out.applications = Applications.forCandidate(c.id).map((a) => {
      const req = a.request_id ? Requests.byId(a.request_id) : null;
      const proj = req?.project_id ? Projects.byId(req.project_id) : null;
      const rec = a.recruiter_id ? Users.byId(a.recruiter_id) : null;
      return {
        id: a.id, applicationNo: a.application_no, requestId: a.request_id,
        ticketNo: req?.ticket_no, position: a.position_applied || req?.title,
        project: proj ? { id: proj.id, name: proj.name } : null,
        status: a.status, matchScore: a.match_score,
        recruiter: rec ? { id: rec.id, name: rec.full_name } : null,
        lastActivityAt: a.last_activity_at, createdAt: a.created_at,
      };
    });
  }
  return out;
}

/* ---------------- LIST ---------------- */
router.get('/', requirePermission('candidate.view'), (req, res) => {
  const q = req.query;
  // Server-side pagination. Previously the whole table was returned and the UI
  // paginated in the browser, which does not scale past a few thousand rows.
  const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 50, 1), 200);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const filters = {
    q: q.q, source: q.source, location: q.location, currentCompany: q.currentCompany,
    currentPosition: q.currentPosition, university: q.university, graduationYear: q.graduationYear,
    noticePeriod: q.noticePeriod, ownerRecruiterId: q.ownerRecruiterId,
    minExp: q.minExp, maxExp: q.maxExp, tag: q.tag,
    screeningStatus: q.screeningStatus, parseStatus: q.parseStatus,
    sort: q.sort, dir: q.dir,
  };
  const total = Candidates.count(filters);
  const rows = Candidates.list({ ...filters, limit: pageSize, offset: (page - 1) * pageSize });
  res.json({
    candidates: rows.map((c) => serialize(c, req.user)),   // unchanged key for compatibility
    // Talent Pool tab counts. Deliberately whole-pool and unfiltered, so the
    // tabs do not change as you page or filter. Dropped by accident when this
    // handler gained pagination; `Candidates.screeningCounts()` was left with
    // no caller.
    screeningCounts: Candidates.screeningCounts(),
    pagination: {
      page, pageSize, total,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
      hasMore: page * pageSize < total,
    },
  });
});


/* ---------------- SMART SEARCH ---------------- */

/**
 * Natural-language candidate search.
 *
 * Claude only TRANSLATES the sentence into the filters GET /api/candidates
 * already accepts; the search itself is the same SQL as every other listing,
 * with the same scoping. So this cannot return a row the recruiter could not
 * already reach, and a misread query is a visibly odd result set rather than a
 * silent permission hole.
 *
 * `interpretation` is returned so the recruiter can see what was understood —
 * a search that quietly reinterprets the question is worse than one that gets
 * it wrong out loud.
 *
 * Registered BEFORE `/:id`, or Express would read "smart-search" as an id.
 */
router.get('/smart-search', requirePermission('candidate.view'), async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query === '') return res.status(400).json({ error: 'A search query is required.' });
  if (query.length > 400) return res.status(400).json({ error: 'Search query is too long.' });

  let outcome;
  try {
    outcome = await interpretSearch(query);
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'smart-search.exception',
      requestId: req.requestId, error: e.message, stack: e.stack }));
    return res.status(500).json({ error: 'Search failed.', detail: e.message });
  }
  if (!outcome.ok) return res.status(503).json({ error: outcome.reason });

  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 200);
  const filters = outcome.filters;
  const total = Candidates.count(filters);
  const rows = Candidates.list({ ...filters, limit: pageSize, offset: 0 });

  res.json({
    candidates: rows.map((c) => serialize(c, req.user)),
    interpretation: outcome.interpretation,
    // Echoed so the UI can show them as removable chips, exactly like a filter
    // the recruiter typed by hand.
    filters,
    pagination: { page: 1, pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1), hasMore: total > pageSize },
  });
});

router.get('/:id', requirePermission('candidate.view'), (req, res, next) => {
  // A candidate id is numeric. Anything else is a LITERAL path registered later
  // in this router — `/intakes` is the live one — and must fall through rather
  // than be read as an id: `Number('intakes')` is NaN, which this handler would
  // report as "Candidate not found", making the real route unreachable.
  if (!/^\d+$/.test(req.params.id)) return next();
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  res.json({ candidate: serialize(c, req.user, { withDetail: true }) });
});

/* ---------------- DUPLICATE CHECK ---------------- */
router.post('/check-duplicate', requirePermission('candidate.view'), (req, res) => {
  const { email, phone, linkedinUrl, excludeId } = req.body || {};
  const dups = Candidates.findDuplicates({ email, phone, linkedinUrl, excludeId: excludeId ? Number(excludeId) : null });
  res.json({ duplicates: dups.map((c) => ({ id: c.id, candidateNo: c.candidate_no, fullName: c.full_name, email: c.email, phone: c.phone, currentCompany: c.current_company })) });
});

/* ---------------- CREATE ---------------- */
router.post('/', requirePermission('candidate.add'), (req, res) => {
  const d = req.body || {};
  if (!d.fullName || !d.fullName.trim()) return res.status(400).json({ error: 'Full name is required.' });
  if (!d.email && !d.phone) return res.status(400).json({ error: 'At least one contact method (email or phone) is required.' });
  if (d.email && !EMAIL_RE.test(d.email)) return res.status(400).json({ error: 'Invalid email format.' });
  if (d.yearsExperience != null && d.yearsExperience !== '' && isNaN(Number(d.yearsExperience))) return res.status(400).json({ error: 'Years of experience must be numeric.' });

  // Duplicate detection
  const dups = Candidates.findDuplicates({ email: d.email, phone: d.phone, linkedinUrl: d.linkedinUrl });
  if (dups.length && !d.overrideDuplicate) {
    return res.status(409).json({
      error: 'Possible duplicate candidate detected.',
      duplicates: dups.map((c) => ({ id: c.id, candidateNo: c.candidate_no, fullName: c.full_name, email: c.email, phone: c.phone })),
      hint: 'Resubmit with overrideDuplicate=true and a reason (requires candidate.merge), or use an existing candidate.',
    });
  }
  if (dups.length && d.overrideDuplicate) {
    if (!req.user.permissions.includes('candidate.merge')) return res.status(403).json({ error: 'You are not permitted to override duplicate detection.' });
    if (!d.overrideReason || !d.overrideReason.trim()) return res.status(400).json({ error: 'A reason is required to override duplicate detection.' });
  }

  // Salary only settable by authorized roles.
  const expectedSalary = canSalary(req.user) && d.expectedSalary != null && d.expectedSalary !== '' ? Number(d.expectedSalary) : null;
  const candidateNo = Candidates.nextNo();
  const created = Candidates.create({
    candidateNo, fullName: d.fullName.trim(), email: d.email, phone: d.phone, nationality: d.nationality,
    location: d.location, linkedinUrl: d.linkedinUrl, currentCompany: d.currentCompany,
    currentPosition: d.currentPosition,
    yearsExperience: d.yearsExperience != null && d.yearsExperience !== '' ? Number(d.yearsExperience) : null,
    expectedSalary, noticePeriod: d.noticePeriod, source: d.source,
    // enhancement fields
    employer: d.employer, currentProject: d.currentProject,
    graduationYear: d.graduationYear != null && d.graduationYear !== '' ? Number(d.graduationYear) : null,
    university: d.university, major: d.major,
    tags: Array.isArray(d.tags) ? d.tags : (d.tags ? String(d.tags).split(',').map((s) => s.trim()).filter(Boolean) : []),
    ownerRecruiterId: d.ownerRecruiterId ? Number(d.ownerRecruiterId) : req.user.id, createdBy: req.user.id,
  });
  saveCustomFields('candidate', created.id, d);
  CandidateActivity.add({ candidateId: created.id, actorId: req.user.id, actorName: req.user.fullName, type: 'candidate_created', note: candidateNo });
  writeAudit(req, { action: 'candidate.created', entityType: 'candidate', entityId: created.id, newValue: { candidateNo, fullName: created.full_name }, comments: d.overrideDuplicate ? `Duplicate override: ${d.overrideReason}` : null });

  // Auto-link to request when requestId is provided (single-step create+link).
  let linkedApp = null;
  if (d.requestId && req.user.permissions.includes('candidate.link')) {
    const reqId = Number(d.requestId);
    const request = Requests.byId(reqId);
    if (request && !['closed','cancelled','rejected','filled'].includes(request.status)) {
      const existing = Applications.existing(created.id, reqId);
      if (!existing) {
        const appNo = Applications.nextNo();
        const app = Applications.create({
          applicationNo: appNo, candidateId: created.id, requestId: reqId,
          positionApplied: d.positionApplied || request.title, status: 'sourced',
          recruiterId: req.user.id, source: d.source, createdBy: req.user.id,
        });
        StageHistory.add(app.id, null, 'sourced', req.user);
        CandidateActivity.add({ candidateId: created.id, applicationId: app.id, actorId: req.user.id, actorName: req.user.fullName, type: 'linked_to_request', note: `Linked to ${request.ticket_no}` });
        linkedApp = app;
      }
    }
  }
  const result = { candidate: serialize(created, req.user, { withDetail: true }) };
  if (linkedApp) result.application = linkedApp;
  res.status(201).json(result);
});

/**
 * Read-only provenance of the document stage: which parser produced the text,
 * and whether any of it came from OCR rather than a native text layer.
 *
 * Returned to the reviewer, never persisted and never consulted by the
 * persistence gate — it answers "where did this text come from", not "is this
 * value trustworthy", which stays with evidence + deterministic validation.
 */
function documentProvenance(parsed) {
  const structure = parsed?.parsed?.structure;
  if (!structure) return null;
  return {
    parser: structure.provenance?.parser ?? null,
    parserVersion: structure.provenance?.parserVersion ?? null,
    ocrApplied: structure.ocrApplied === true,
    ocrEngine: structure.provenance?.ocrEngine ?? null,
    pageCount: structure.pages?.length ?? 0,
    blockCount: structure.blocks?.length ?? 0,
    degradedPages: structure.degradedPages ?? [],
  };
}

/* ---------------- PARSE CV (upload -> PENDING intake, no candidate) ---------------- */
//
// This route used to create a candidate from whatever the parser returned. It no
// longer creates anything: the CV is parsed, evidence is located, deterministic
// validation runs, and the result is stored as a PENDING intake for a person to
// review. A candidate is created only by POST /intakes/:iid/review.
//
// Why not create the candidate first and propose against it? `candidate.full_name`
// is NOT NULL, so creating the row means writing a parsed name before anyone has
// looked at it — precisely the unreviewed write this design forbids.
router.post('/parse-cv', requirePermission('candidate.add'), multipart, async (req, res) => {
  if (!req.uploadedFile) return res.status(400).json({ error: 'CV file is required.' });
  try {
    const filePath = uploadPath(req.uploadedFile.storedName);

    // The requisition this CV was submitted against, if any. Validated NOW so a
    // reviewer is not told at approval time that the reference was never good —
    // but NO application is created here: there is no candidate yet.
    const requestId = req.fields?.requestId ? Number(req.fields.requestId) : null;
    if (requestId !== null) {
      const check = checkRequest(requestId);
      if (!check.ok) {
        return res.status(409).json({
          error: check.reason, code: 'request-ineligible', requestId,
        });
      }
    }

    const entities = await getParser().parseEntities(filePath);
    const parsed = await parseDocument(filePath);
    const hash = fileHash(filePath);

    if (!parsed.ok || parsed.fields.length === 0) {
      return res.json({
        intake: null,
        file: { originalName: req.uploadedFile.originalName, size: req.uploadedFile.size },
        report: toImportReport(entities, { fileName: req.uploadedFile.originalName }),
        reason: parsed.reason || 'No candidate field could be supported by the document.',
        // Still shown even when nothing was proposable: a recruiter should see
        // WHAT was read and rejected, not just that nothing survived.
        preview: parsed.preview ?? [],
      });
    }

    const intake = createIntake({
      // The stored upload, so the reviewer can open the original CV.
      storedName: req.uploadedFile.storedName,
      fileName: req.uploadedFile.originalName,
      mimeType: req.uploadedFile.mimeType || null,
      fileHash: hash,
      origin: 'resume.extract',
      modelId: parsed.generation?.modelId ?? '',
      documentId: parsed.documentId,
      generation: parsed.generation,
      fields: parsed.fields,
      ...(requestId !== null ? { requestId } : {}),
      createdBy: req.user.id,
    });

    writeAudit(req, {
      action: 'candidate.intake_created', entityType: 'candidate_intake',
      entityId: intake.id,
      newValue: {
        fileName: req.uploadedFile.originalName, fields: intake.fields.length, requestId,
      },
    });

    res.json({
      // PENDING. No candidate exists yet and nothing has been written.
      intake,
      file: { originalName: req.uploadedFile.originalName, size: req.uploadedFile.size },
      // How the text a reviewer is about to judge was actually obtained. Text
      // recovered by OCR is a recognition, not a reading, so a reviewer must be
      // able to see that before trusting an evidence snippet. Read-only
      // provenance: nothing downstream branches on it.
      document: documentProvenance(parsed),
      report: toImportReport(entities, { fileName: req.uploadedFile.originalName }),
      // EVERY field the reader saw — accepted, rejected (with why), or never
      // stated in the CV at all. Never persisted; for the review screen only.
      preview: parsed.preview ?? [],
    });
  } catch (e) {
    // The catch block sends its own response, so this never reaches the
    // server's unhandled-error logger — the exception was visible ONLY in the
    // response body, never in Render logs. Log it here so the next failure is
    // diagnosable from the log stream alone.
    console.error(JSON.stringify({
      level: 'error', msg: 'parse-cv.exception', requestId: req.requestId,
      error: e.message, stack: e.stack,
    }));
    res.status(500).json({ error: 'CV parsing failed.', detail: e.message });
  }
});

// ---------------- ASYNC PARSE (the two Claude calls off the request) ----------------
//
// WHY A SEPARATE ROUTE, NOT A CHANGED ONE. /parse-cv above is used exactly as
// written by Candidate Review's own upload and by Bulk Upload CVs — changing
// its response shape to "returns a job id" would break both. This is instead
// an additional entry point: same read, same createIntake(), same audit
// trail, just not held open on the two Claude calls that make it slow. Only
// the new "Parse CV" primary flow (ParseCvModal) calls it.
router.post('/parse-cv-async', requirePermission('candidate.add'), multipart, (req, res) => {
  if (!req.uploadedFile) return res.status(400).json({ error: 'CV file is required.' });
  const filePath = uploadPath(req.uploadedFile.storedName);
  const requestId = req.fields?.requestId ? Number(req.fields.requestId) : null;
  if (requestId !== null) {
    const check = checkRequest(requestId);
    if (!check.ok) {
      return res.status(409).json({ error: check.reason, code: 'request-ineligible', requestId });
    }
  }

  const jobId = createJob();
  res.status(202).json({ jobId });

  // NOT AWAITED. The response above has already gone out — this is the exact
  // same read-and-propose work /parse-cv does inline, just running after the
  // request that started it has already finished.
  (async () => {
    try {
      const parsed = await parseDocument(filePath);
      const hash = fileHash(filePath);

      if (!parsed.ok || parsed.fields.length === 0) {
        completeJob(jobId, {
          intake: null,
          file: { originalName: req.uploadedFile.originalName, size: req.uploadedFile.size },
          reason: parsed.reason || 'No candidate field could be supported by the document.',
          preview: parsed.preview ?? [],
        });
        return;
      }

      const intake = createIntake({
        storedName: req.uploadedFile.storedName,
        fileName: req.uploadedFile.originalName,
        mimeType: req.uploadedFile.mimeType || null,
        fileHash: hash,
        origin: 'resume.extract',
        modelId: parsed.generation?.modelId ?? '',
        documentId: parsed.documentId,
        generation: parsed.generation,
        fields: parsed.fields,
        ...(requestId !== null ? { requestId } : {}),
        createdBy: req.user.id,
      });

      writeAudit(req, {
        action: 'candidate.intake_created', entityType: 'candidate_intake',
        entityId: intake.id,
        newValue: { fileName: req.uploadedFile.originalName, fields: intake.fields.length, requestId },
      });

      completeJob(jobId, {
        intake,
        file: { originalName: req.uploadedFile.originalName, size: req.uploadedFile.size },
        document: documentProvenance(parsed),
        preview: parsed.preview ?? [],
      });
    } catch (e) {
      console.error(JSON.stringify({
        level: 'error', msg: 'parse-cv-async.exception', jobId, error: e.message, stack: e.stack,
      }));
      failJob(jobId, 'CV parsing failed.');
    }
  })();
});

router.get('/parse-cv-async/:jobId', requirePermission('candidate.add'), (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  res.json(job);
});

/* ---------------- PRE-CANDIDATE INTAKES (review before creation) ---------------- */

router.get('/intakes', requirePermission('candidate.view'), (req, res) => {
  res.json({ intakes: pendingIntakes() });
});

router.get('/intakes/:iid', requirePermission('candidate.view'), (req, res) => {
  const intake = intakeById(Number(req.params.iid));
  if (!intake) return res.status(404).json({ error: 'Intake not found.' });
  res.json({ intake });
});

// The original CV, so a reviewer can check a proposed value against the document
// it was read from. Uses the existing upload storage and the existing auth.
router.get('/intakes/:iid/document', requirePermission('candidate.view'), (req, res) => {
  const intake = intakeById(Number(req.params.iid));
  if (!intake) return res.status(404).json({ error: 'Intake not found.' });
  if (!intake.storedName) return res.status(404).json({ error: 'No document on file.' });
  streamFile(intake.storedName, res, intake.fileName || 'cv');
});

// Approve an intake: create the candidate and record the review, atomically.
router.post('/intakes/:iid/review', requirePermission('candidate.add'), async (req, res) => {
  const body = req.body || {};
  const decisions = body.decisions;

  // An explicit rejection creates nothing and keeps the record.
  if (body.reject === true) {
    try {
      const result = rejectIntake(Number(req.params.iid), req.user, body.reason || null);
      if (result === null) return res.status(404).json({ error: 'Intake not found.' });
      writeAudit(req, {
        action: 'candidate.intake_rejected', entityType: 'candidate_intake',
        entityId: result.intakeId, comments: body.reason || undefined,
      });
      return res.json(result);
    } catch (e) {
      return res.status(409).json({ error: e.message, code: e.code || null });
    }
  }

  if (decisions === undefined || decisions === null || typeof decisions !== 'object') {
    return res.status(400).json({
      error: 'decisions is required: { "fullName": true, "phone": false }.',
    });
  }

  try {
    const result = await reviewIntake(Number(req.params.iid), decisions, req.user, {
      ...(body.version !== undefined ? { expectedVersion: Number(body.version) } : {}),
      ...(body.overrideDuplicate === true ? { overrideDuplicate: true } : {}),
      ...(body.ownerRecruiterId !== undefined
        ? { ownerRecruiterId: Number(body.ownerRecruiterId) } : {}),
    });
    if (result === null) return res.status(404).json({ error: 'Intake not found.' });

    if (result.status === 'REJECTED') {
      writeAudit(req, {
        action: 'candidate.intake_rejected', entityType: 'candidate_intake',
        entityId: result.intakeId,
      });
      return res.json(result);
    }

    CandidateActivity.add({
      candidateId: result.candidateId, actorId: req.user.id, actorName: req.user.fullName,
      type: 'candidate_created',
      note: `${result.candidate.candidate_no} (CV intake ${result.intakeId} approved)`,
    });
    writeAudit(req, {
      action: 'candidate.created', entityType: 'candidate', entityId: result.candidateId,
      newValue: {
        candidateNo: result.candidate.candidate_no,
        source: 'cv_intake', intakeId: result.intakeId,
        proposalId: result.proposalId, applicationId: result.applicationId,
        requestId: result.requestId, accepted: result.applied,
      },
    });
    if (result.applicationId !== null) {
      CandidateActivity.add({
        candidateId: result.candidateId, actorId: req.user.id, actorName: req.user.fullName,
        type: 'linked_to_request',
        note: `Linked to request ${result.requestId}`,
      });
    }

    // Respond FIRST. Everything above has committed; the evaluation below is a
    // separate, best-effort job and its failure must not undo a completed review.
    res.status(201).json({
      intake: intakeById(result.intakeId),
      intakeId: result.intakeId,
      proposalId: result.proposalId,
      applicationId: result.applicationId,
      applied: result.applied,
      rejected: result.rejected,
      // Name-only lookalikes. Non-blocking: the conversion already happened.
      potentialMatches: result.potentialMatches ?? [],
      candidate: serialize(result.candidate, req.user, { withDetail: true }),
      application: result.application
        ? { id: result.application.id, applicationNo: result.application.application_no }
        : null,
      proposal: result.proposal,
    });

    // Competency evaluation — AFTER the transaction committed, dispatched once,
    // and only when the CV was submitted against a requisition. It reads the
    // ACCEPTED values and their evidence, so a field the reviewer rejected can
    // never appear in an assessment.
    if (result.requestId !== null && result.storedName) {
      const request = Requests.byId(result.requestId);
      if (request) {
        const evalCandidateId = result.candidateId;
        const evalApplicationId = result.applicationId;
        const evalActorId = req.user.id;
        const evalActorName = req.user.fullName;
        evaluateAgainstRequest(uploadPath(result.storedName), request).then((evaluation) => {
          // null = no model configured, or the evaluator abstained. Both normal.
          if (!evaluation) return;
          CandidateNotes.add({
            candidateId: evalCandidateId,
            applicationId: evalApplicationId,
            noteType: 'ai_evaluation',
            body: evaluation.body,
            authorId: evalActorId,
            authorName: evalActorName,
          });
        }).catch((e) => console.error(JSON.stringify({
          // Reported, never silently swallowed — and the candidate stands.
          level: 'error', msg: 'evaluation.dispatch_failed',
          candidateId: evalCandidateId, intakeId: result.intakeId,
          error: String((e && e.message) || e),
        })));
      }
    }
    return undefined;
  } catch (e) {
    if (e.code === 'duplicate') {
      // The intake is PRESERVED; a duplicate is a decision for a person. The
      // payload is structured facts only — no colours, no severity words. How
      // an exact match differs from a potential one is the UI's to render.
      return res.status(409).json({ error: e.message, code: 'duplicate', ...e.detail });
    }
    if (e.code === 'request-ineligible') {
      // requestId is neither discarded nor half-applied; the intake stays
      // PENDING so it can be corrected and retried.
      return res.status(409).json({ error: e.message, code: e.code, ...(e.detail || {}) });
    }
    const status = e.code === 'incomplete' || e.code === 'invalid' ? 400 : 409;
    res.status(status).json({ error: e.message, code: e.code || null, ...(e.detail || {}) });
  }
});

/* ---------------- SCAN INBOX (folder-drop CV import) ---------------- */
router.post('/inbox-scan', requirePermission('candidate.add'), async (req, res) => {
  const inboxDir = process.env.CV_INBOX || path.resolve(process.cwd(), '../../cv_inbox');
  if (!fs.existsSync(inboxDir)) {
    // Render's free tier has no persistent disk — CV_INBOX has nowhere durable
    // to point to, so this is an environment limitation, not a broken feature.
    // Say so, and name the path that works in this environment right now.
    return res.status(400).json({
      error: 'No CV inbox is configured for this environment. Use "Bulk Upload CVs" instead — it needs no folder on disk.',
      path: inboxDir,
    });
  }
  const requestId = req.body?.requestId ? Number(req.body.requestId) : null;
  const imported = [];
  const skipped = [];
  const errors = [];

  const files = fs.readdirSync(inboxDir).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ['.pdf', '.docx', '.doc'].includes(ext);
  });

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    try {
      const parsed = await getParser().parseLegacy(filePath);
      if (parsed.extraction_status === 'failed') {
        skipped.push({ file, reason: 'Could not extract text' });
        continue;
      }

      // Check for duplicates by email
      if (parsed.email) {
        const dups = Candidates.findDuplicates({ email: parsed.email });
        if (dups.length) {
          skipped.push({ file, reason: `Duplicate email: ${parsed.email} (existing: ${dups[0].candidate_no})` });
          continue;
        }
      }

      const candidateNo = Candidates.nextNo();
      const created = Candidates.create({
        candidateNo,
        fullName: parsed.full_name,
        email: parsed.email,
        phone: parsed.phone,
        yearsExperience: parsed.years_experience,
        source: 'folder_drop',
        ownerRecruiterId: req.user.id,
        createdBy: req.user.id,
        resumeName: file,
        resumePath: filePath,
      });

      CandidateDocuments.add({
        candidateId: created.id,
        docType: 'cv',
        fileName: file,
        fileHash: null,
        uploadedBy: req.user.id,
      });

      CandidateActivity.add({
        candidateId: created.id,
        actorId: req.user.id,
        actorName: req.user.fullName,
        type: 'candidate_created',
        note: `${candidateNo} (folder_drop: ${file})`,
      });

      writeAudit(req, {
        action: 'candidate.created',
        entityType: 'candidate',
        entityId: created.id,
        newValue: { candidateNo, fullName: created.full_name, source: 'folder_drop' },
      });

      // Auto-link to request if provided
      let linkedApp = null;
      if (requestId && req.user.permissions.includes('candidate.link')) {
        const request = Requests.byId(requestId);
        if (request && !['closed', 'cancelled', 'rejected', 'filled'].includes(request.status)) {
          const existing = Applications.existing(created.id, requestId);
          if (!existing) {
            const appNo = Applications.nextNo();
            const app = Applications.create({
              applicationNo: appNo,
              candidateId: created.id,
              requestId,
              positionApplied: request.title,
              status: 'sourced',
              recruiterId: req.user.id,
              source: 'folder_drop',
              createdBy: req.user.id,
            });
            StageHistory.add(app.id, null, 'sourced', req.user);
            linkedApp = app;
          }
        }
      }

      imported.push({
        file,
        candidateNo: created.candidate_no,
        fullName: created.full_name,
        email: parsed.email,
        phone: parsed.phone,
        applicationNo: linkedApp?.application_no || null,
      });
    } catch (e) {
      errors.push({ file, error: e.message });
    }
  }

  res.json({ imported: imported.length, skipped: skipped.length, errors: errors.length, details: { imported, skipped, errors } });
});

/* ---------------- WATCHER STATUS ---------------- */
router.get('/watcher/status', requireAuth, (req, res) => {
  res.json(getWatcherStatus());
});

/* ---------------- EDIT ---------------- */
router.put('/:id', requirePermission('candidate.edit'), (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const d = req.body || {};
  if (d.email && !EMAIL_RE.test(d.email)) return res.status(400).json({ error: 'Invalid email format.' });
  if (d.fullName !== undefined && !d.fullName.trim()) return res.status(400).json({ error: 'Full name cannot be empty.' });
  const patch = { ...d };
  if (!canSalary(req.user)) delete patch.expectedSalary; // can't change salary without permission
  else if (d.expectedSalary === '' ) patch.expectedSalary = null;
  if (d.tags !== undefined) patch.tags = Array.isArray(d.tags) ? d.tags : String(d.tags).split(',').map((s) => s.trim()).filter(Boolean);
  const before = { fullName: c.full_name, currentCompany: c.current_company };
  const updated = Candidates.update(c.id, patch);
  saveCustomFields('candidate', c.id, req.body || {});
  CandidateActivity.add({ candidateId: c.id, actorId: req.user.id, actorName: req.user.fullName, type: 'candidate_updated' });
  writeAudit(req, { action: 'candidate.updated', entityType: 'candidate', entityId: c.id, oldValue: before, newValue: { fullName: updated.full_name } });
  res.json({ candidate: serialize(updated, req.user, { withDetail: true }) });
});

/* ---------------- SCREENING GATE (Database fitness screen) ----------------
   Moves a candidate through new → screening → fit | unfit, BEFORE they are
   attached to a requisition. 'unfit' is where the future auto-rejection email
   will fire (queue/email not built yet). Gated on candidate.edit. */
const SCREENING_STATES = ['new', 'screening', 'fit', 'unfit'];
router.post('/:id/screening', requirePermission('candidate.edit'), (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const status = String((req.body || {}).status || '').toLowerCase();
  if (!SCREENING_STATES.includes(status)) {
    return res.status(400).json({ error: `Invalid screening status. One of: ${SCREENING_STATES.join(', ')}.` });
  }
  const reason = (req.body || {}).reason || null;
  if (status === 'unfit' && !reason) {
    return res.status(400).json({ error: 'A reason is required to mark a candidate unfit.' });
  }
  const before = c.screening_status || 'new';
  const updated = Candidates.setScreening(c.id, status);
  CandidateActivity.add({ candidateId: c.id, actorId: req.user.id, actorName: req.user.fullName,
    type: 'screening_changed', note: `${before} → ${status}${reason ? ' — ' + reason : ''}` });
  writeAudit(req, { action: 'candidate.screening_changed', entityType: 'candidate', entityId: c.id,
    oldValue: { screeningStatus: before }, newValue: { screeningStatus: status }, comments: reason || undefined });
  // Auto-email a respectful decline when marked unfit (best-effort; no-op until email configured).
  if (status === 'unfit' && c.email) {
    const tpl = rejectionTpl({ candidateName: c.full_name, position: c.current_position });
    sendMail({ to: c.email, subject: tpl.subject, html: tpl.html })
      .then((r) => { if (r.ok) CandidateActivity.add({ candidateId: c.id, actorId: req.user.id, actorName: 'System', type: 'email_sent', note: 'Rejection email sent' }); })
      .catch(() => {});
  }
  res.json({ candidate: serialize(updated, req.user, { withDetail: true }) });
});

/* ---------------- GDPR / PDPL data-protection (C1.6) ---------------- */
// Retention report — active candidates past their retention window. MUST be registered
// before the '/:id/...' routes so 'privacy' is never captured as an :id segment.
router.get('/privacy/retention', requirePermission('candidate.privacy'), (req, res) => {
  const rows = Candidates.retentionOverdue();
  const months = parseInt(dbGet("SELECT value FROM system_setting WHERE key='retention_months'")?.value || '24', 10);
  res.json({
    retentionMonths: months,
    overdueCount: rows.length,
    candidates: rows.map((c) => ({
      id: c.id, candidateNo: c.candidate_no, fullName: c.full_name,
      createdAt: c.created_at, retentionUntil: c.retention_until, consentStatus: c.consent_status || 'unknown',
    })),
  });
});

// Record or withdraw consent (lawful basis). Editable by anyone who can edit candidates.
router.post('/:id/consent', requirePermission('candidate.edit'), (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const status = String((req.body || {}).status || '').toLowerCase();
  if (!['given', 'withdrawn', 'unknown'].includes(status)) {
    return res.status(400).json({ error: 'Consent status must be one of: given, withdrawn, unknown.' });
  }
  const updated = Candidates.setConsent(c.id, { status, source: (req.body || {}).source, note: (req.body || {}).note });
  CandidateActivity.add({ candidateId: c.id, actorId: req.user.id, actorName: req.user.fullName,
    type: 'consent_changed', note: `Consent ${status}` });
  writeAudit(req, { action: 'candidate.consent_changed', entityType: 'candidate', entityId: c.id,
    oldValue: { consentStatus: c.consent_status || 'unknown' }, newValue: { consentStatus: status } });
  res.json({ candidate: serialize(updated, req.user, { withDetail: true }) });
});

// Subject Access Request — export everything held about the candidate as a JSON file.
router.get('/:id/export', requirePermission('candidate.privacy'), (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const data = Candidates.exportData(c.id);
  writeAudit(req, { action: 'candidate.data_exported', entityType: 'candidate', entityId: c.id,
    newValue: { candidateNo: c.candidate_no } });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${c.candidate_no}-data-export.json"`);
  res.send(JSON.stringify(data, null, 2));
});

// Right to erasure — anonymise PII in place, drop CV binaries; row kept for audit integrity.
// Requires an explicit typed confirmation to guard against accidental irreversible action.
router.post('/:id/erase', requirePermission('candidate.privacy'), (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  if (c.candidate_state === 'erased') return res.status(409).json({ error: 'This candidate has already been erased.' });
  const reason = (req.body || {}).reason || null;
  if ((req.body || {}).confirm !== 'ERASE') {
    return res.status(400).json({ error: 'Erasure must be confirmed by sending confirm:"ERASE". This action is irreversible.' });
  }
  const updated = Candidates.erase(c.id);
  CandidateActivity.add({ candidateId: c.id, actorId: req.user.id, actorName: req.user.fullName,
    type: 'data_erased', note: reason ? `Erased — ${reason}` : 'Personal data erased' });
  writeAudit(req, { action: 'candidate.data_erased', entityType: 'candidate', entityId: c.id,
    oldValue: { candidateNo: c.candidate_no }, comments: reason || undefined });
  res.json({ candidate: serialize(updated, req.user, { withDetail: true }) });
});

/* ---------------- PARSE PROPOSALS (human review of suggested fields) ---------------- */
//
// The review boundary. A CV parse writes deterministic, document-supported
// values straight to the record and PROPOSES everything only the model read.
// These two endpoints are how a proposed value becomes candidate data — there
// is no other path.

router.get('/:id/proposals', requirePermission('candidate.view'), (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  res.json({
    pending: pendingProposal(c.id),
    proposals: proposalsFor(c.id),
  });
});

router.post('/:id/proposals/:pid/review', requirePermission('candidate.edit'), async (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });

  const decisions = (req.body || {}).decisions;
  if (decisions === undefined || decisions === null || typeof decisions !== 'object') {
    return res.status(400).json({
      error: 'decisions is required: { "fullName": true, "phone": false }.',
    });
  }

  try {
    const result = await reviewProposal(Number(req.params.pid), decisions, req.user, {
      // Optimistic concurrency: the client echoes the version it reviewed, so
      // two reviewers on the same proposal cannot both win.
      ...(req.body.version !== undefined ? { expectedVersion: Number(req.body.version) } : {}),
    });
    if (result === null) return res.status(404).json({ error: 'Proposal not found.' });

    CandidateActivity.add({
      candidateId: c.id, actorId: req.user.id, actorName: req.user.fullName,
      type: 'proposal_reviewed',
      note: result.applied.length > 0
        ? `Accepted: ${result.applied.join(', ')}`
        : 'No field accepted',
    });
    // Provenance: the audit trail records WHO accepted a machine suggestion.
    writeAudit(req, {
      action: 'candidate.proposal_reviewed', entityType: 'candidate', entityId: c.id,
      newValue: { proposalId: result.id, status: result.status, accepted: result.applied },
    });

    res.json({
      proposal: { id: result.id, status: result.status, version: result.version },
      applied: result.applied,
      rejected: result.rejected,
      // Accepted but with nowhere to store them on the candidate table.
      unapplied: result.unapplied,
      candidate: serialize(result.candidate, req.user, { withDetail: true }),
    });
  } catch (e) {
    // An incomplete decision map is the caller's mistake; everything else is a
    // conflict with the proposal's current state.
    const status = e.code === 'incomplete' || e.name === 'UnknownProposalFieldError' ? 400 : 409;
    res.status(status).json({ error: e.message, code: e.code || null });
  }
});

/* ---------------- DOCUMENTS (metadata; file storage is Phase 4) ---------------- */
router.post('/:id/documents', requirePermission('candidate.edit'), (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const { docType, fileName, fileHash, fileSize, note } = req.body || {};
  if (!fileName) return res.status(400).json({ error: 'File name is required.' });
  // CV-hash dedup warning (non-blocking)
  let hashDup = [];
  if (fileHash) hashDup = CandidateDocuments.byHash(fileHash).filter((doc) => doc.candidate_id !== c.id);
  const doc = CandidateDocuments.add({ candidateId: c.id, docType, fileName, fileHash, fileSize, note, uploadedBy: req.user.id });
  CandidateActivity.add({ candidateId: c.id, actorId: req.user.id, actorName: req.user.fullName, type: 'cv_uploaded', note: fileName });
  writeAudit(req, { action: 'candidate.document_uploaded', entityType: 'candidate', entityId: c.id, newValue: { fileName, docType } });
  res.status(201).json({ document: doc, hashDuplicateOf: hashDup.map((x) => x.candidate_id) });
});

/* ---------------- RESUME upload / download (real file) ---------------- */

// D-01/D-02 fix. Parsing used to live only in POST /parse-cv, so a CV attached to
// an existing candidate (Add/Edit Candidate form, profile attach) stored the file
// and extracted nothing. This runs the SAME pipeline parse-cv uses — the parser
// itself is untouched.
//
// Only columns that are currently empty are written: a recruiter's manual
// correction must never be overwritten by a later upload. Parse metadata is
// always refreshed so the quality badge reflects the newest file.
// Parse a CV attached to an EXISTING candidate and PROPOSE what it says.
//
// This used to write every parsed value straight into the candidate's empty
// columns. It no longer writes any field value at all: the parse raises a
// PENDING CandidateProposal and a person decides, field by field, through
// POST /:id/proposals/:pid/review.
//
// Parse-quality metadata (status, confidence, timestamp) IS still written. That
// is a fact about the DOCUMENT, not a claim about the person, and the quality
// badge would otherwise never reflect the newest file.
async function parseAndPropose(candidateId, storedName, req) {
  const filePath = uploadPath(storedName);
  const entities = await getParser().parseEntities(filePath);
  const meta = toParseMetadata(entities);
  Candidates.setParseMeta?.(candidateId, meta);

  const { parseDocument } = await import('../lib/parsing/pipeline-provider.js');
  const parsed = await parseDocument(filePath);

  let proposal = null;
  if (parsed.ok && parsed.fields.length > 0) {
    proposal = await raiseProposal({
      candidateId,
      origin: 'resume.extract',
      documentId: parsed.documentId,
      modelId: parsed.generation?.modelId ?? '',
      generation: parsed.generation,
      fields: parsed.fields,
    });
  }

  return { meta, entities, proposal, preview: parsed.preview ?? [] };
}


router.post('/:id/resume', requirePermission('candidate.edit'), multipart, async (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  if (!req.uploadedFile) return res.status(400).json({ error: 'No file uploaded.' });
  dbRun('UPDATE candidate SET resume_path=?, resume_name=?, updated_at=? WHERE id=?',
    [req.uploadedFile.storedName, req.uploadedFile.originalName, new Date().toISOString(), c.id]);

  // Parse the newly attached CV (D-01). A parser failure must never fail the
  // upload — the file is already stored and is the source of truth.
  let report = null;
  let proposal = null;
  let preview = [];
  try {
    const r = await parseAndPropose(c.id, req.uploadedFile.storedName, req);
    report = toImportReport(r.entities, { fileName: req.uploadedFile.originalName, candidateNo: c.candidate_no });
    // No candidate field was written. What the CV says is waiting for a person.
    proposal = r.proposal;
    preview = r.preview;
    CandidateDocuments.add({
      candidateId: c.id, docType: 'cv', fileName: req.uploadedFile.originalName,
      fileHash: fileHash(uploadPath(req.uploadedFile.storedName)), uploadedBy: req.user.id,
    });
  } catch (e) {
    Candidates.setParseMeta?.(c.id, { parseStatus: 'failed', parseConfidence: 0, parsedAt: new Date().toISOString() });
  }

  CandidateActivity.add({ candidateId: c.id, actorId: req.user.id, actorName: req.user.fullName, type: 'resume_uploaded', note: req.uploadedFile.originalName });
  writeAudit(req, { action: 'candidate.resume_uploaded', entityType: 'candidate', entityId: c.id, newValue: { fileName: req.uploadedFile.originalName } });
  res.status(201).json({
    candidate: serialize(Candidates.byId(c.id), req.user, { withDetail: true }),
    report,
    // PENDING. Nothing here has touched the candidate record.
    proposal,
    // EVERY field the reader saw — accepted, rejected (with why), or never
    // stated in the CV at all. Never persisted; for the review screen only.
    preview,
  });
});

// D-02: re-run the parser against the resume already on file. Reads the stored
// file (the designated source of truth) — no upload, no schema change.
// ?overwrite=true replaces existing values; default fills only empty ones.
router.post('/:id/reparse', requirePermission('candidate.edit'), async (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  if (!c.resume_path) return res.status(400).json({ error: 'No resume on file to parse.' });
  try {
    const r = await parseAndPropose(c.id, c.resume_path, req);
    const proposed = r.proposal ? r.proposal.fields.length : 0;
    CandidateActivity.add({ candidateId: c.id, actorId: req.user.id, actorName: req.user.fullName,
      type: 'resume_reparsed', note: `${proposed} field(s) proposed for review` });
    writeAudit(req, { action: 'candidate.resume_reparsed', entityType: 'candidate', entityId: c.id,
      newValue: { proposalId: r.proposal ? r.proposal.id : null, proposed } });
    res.json({
      candidate: serialize(Candidates.byId(c.id), req.user, { withDetail: true }),
      // A re-parse supersedes any pending proposal and raises a new one. It
      // writes no field value: `overwrite` is gone because there is nothing to
      // overwrite until a person accepts something.
      proposal: r.proposal,
      report: toImportReport(r.entities, { fileName: c.resume_name || c.resume_path, candidateNo: c.candidate_no }),
      // EVERY field the reader saw — accepted, rejected (with why), or never
      // stated in the CV at all. Never persisted; for the review screen only.
      preview: r.preview,
    });
  } catch (e) {
    Candidates.setParseMeta?.(c.id, { parseStatus: 'failed', parseConfidence: 0, parsedAt: new Date().toISOString() });
    res.status(422).json({ error: 'Could not parse the resume on file.' });
  }
});

router.get('/:id/resume', requirePermission('candidate.view'), (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  if (!c.resume_path) return res.status(404).json({ error: 'No resume on file.' });
  streamFile(c.resume_path, res, c.resume_name || 'resume');
});

/* ---------------- NOTES ---------------- */
router.post('/:id/notes', requirePermission('candidate.note'), (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const { body, noteType, applicationId } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Note body is required.' });
  CandidateNotes.add({ candidateId: c.id, applicationId: applicationId || null, noteType, body: body.trim(), authorId: req.user.id, authorName: req.user.fullName });
  CandidateActivity.add({ candidateId: c.id, actorId: req.user.id, actorName: req.user.fullName, type: 'note_added' });
  writeAudit(req, { action: 'candidate.note_added', entityType: 'candidate', entityId: c.id });
  res.status(201).json({ candidate: serialize(Candidates.byId(c.id), req.user, { withDetail: true }) });
});

/* ---------------- form metadata ---------------- */
router.get('/meta/form', requirePermission('candidate.view'), (req, res) => {
  res.json({
    recruiters: Users.list({}).map((u) => ({ id: u.id, name: u.full_name })),
    sources: ['referral', 'agency', 'direct', 'portal', 'database', 'headhunt', 'event'],
    noticePeriods: ['Immediate', '2 weeks', '1 month', '2 months', '3 months', '> 3 months'],
    canSeeSalary: canSalary(req.user),
  });
});

/* ---------------- DELETE ----------------
   Two defects lived here. The gate read `req.user.role` — singular — which the
   auth middleware has never set (it sets `roles`, an array), so `isAdmin` was
   permanently false and a System Administrator could not delete a candidate
   somebody else created. It then called `Candidates.delete`, which does not
   exist, so anything that DID get past the gate threw a 500. Deleting a
   candidate has therefore never worked.

   Now governed like every other endpoint: the `candidate.delete` permission
   decides, so the Roles console is the single place this is granted. A written
   reason is required, and the audit entry — including what is about to be
   destroyed — is written BEFORE the row goes, because afterwards there is
   nothing left to describe. */
router.delete('/:id', requirePermission('candidate.delete'), (req, res) => {
  const candidate = Candidates.byId(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });

  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to delete a candidate.' });

  // Cascades take applications, interviews, offers and documents with it. Say so.
  const counts = HardDelete.candidateCounts(candidate.id);
  writeAudit(req, {
    action: 'candidate.deleted', entityType: 'candidate', entityId: candidate.id,
    oldValue: { name: candidate.full_name, candidateNo: candidate.candidate_no, email: candidate.email, cascaded: counts },
    comments: reason,
  });
  HardDelete.candidate(candidate.id);
  res.json({ deleted: true, candidateNo: candidate.candidate_no, cascaded: counts });
});

/* What a delete would destroy. The UI asks first so a recruiter sees the blast
   radius before confirming, not after. */
router.get('/:id/delete-impact', requirePermission('candidate.delete'), (req, res) => {
  const candidate = Candidates.byId(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });
  res.json({ candidateNo: candidate.candidate_no, fullName: candidate.full_name, cascaded: HardDelete.candidateCounts(candidate.id) });
});

export default router;
