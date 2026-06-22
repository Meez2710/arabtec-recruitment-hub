import { Router } from 'express';
import {
  Candidates, CandidateDocuments, Applications, CandidateNotes, CandidateActivity,
  Users, Projects, Requests, Interviews, Offers, CustomFields,
} from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { multipart, streamFile } from '../lib/upload.js';
import { run as dbRun, get as dbGet } from '../lib/db.js';
import fs from 'node:fs';

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
    ownerRecruiter: owner ? { id: owner.id, name: owner.full_name } : null,
    ownerRecruiterId: c.owner_recruiter_id, createdAt: c.created_at, updatedAt: c.updated_at,
    salaryVisible: seeSalary,
    expectedSalary: seeSalary ? c.expected_salary : null,
    applicationCount: Applications.forCandidate(c.id).length,
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
  const rows = Candidates.list({
    q: req.query.q, source: req.query.source, location: req.query.location,
    currentCompany: req.query.currentCompany, noticePeriod: req.query.noticePeriod,
    ownerRecruiterId: req.query.ownerRecruiterId, minExp: req.query.minExp, maxExp: req.query.maxExp, tag: req.query.tag,
  });
  res.json({ candidates: rows.map((c) => serialize(c, req.user)) });
});

/* ---------------- DETAIL ---------------- */
router.get('/:id', requirePermission('candidate.view'), (req, res) => {
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
  res.status(201).json({ candidate: serialize(created, req.user, { withDetail: true }) });
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
router.post('/:id/resume', requirePermission('candidate.edit'), multipart, (req, res) => {
  const c = Candidates.byId(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  if (!req.uploadedFile) return res.status(400).json({ error: 'No file uploaded.' });
  dbRun('UPDATE candidate SET resume_path=?, resume_name=?, updated_at=? WHERE id=?',
    [req.uploadedFile.storedName, req.uploadedFile.originalName, new Date().toISOString(), c.id]);
  CandidateActivity.add({ candidateId: c.id, actorId: req.user.id, actorName: req.user.fullName, type: 'resume_uploaded', note: req.uploadedFile.originalName });
  writeAudit(req, { action: 'candidate.resume_uploaded', entityType: 'candidate', entityId: c.id, newValue: { fileName: req.uploadedFile.originalName } });
  res.status(201).json({ candidate: serialize(Candidates.byId(c.id), req.user, { withDetail: true }) });
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

export default router;
