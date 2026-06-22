import { Router } from 'express';
import {
  Applications, Candidates, Requests, Seats, StageHistory, CandidateActivity, RequestActivity,
  Users, Projects, SystemSettings, RejectReasons, Posts,
} from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { hasOpenSeat, fillSeatAndCount } from '../lib/vacancy.js';
import {
  APP, APP_STATUSES as STAGES, APP_REASON_REQUIRED, APP_TERMINAL,
  appNorm, appCanMove, APP_LABELS,
} from '../lib/stages.js';

const router = Router();
router.use(requireAuth);

const canSalary = (u) => u.permissions.includes('salary.view');

// Canonical pipeline stages now live in lib/stages.js (single source of truth).
export const APP_STATUSES = STAGES;
const REASON_REQUIRED = APP_REASON_REQUIRED;
const TERMINAL = APP_TERMINAL;
// hasOpenSeat / fillSeatAndCount now live in lib/vacancy.js (shared with offers).

function appOut(a, user) {
  const cand = Candidates.byId(a.candidate_id);
  const rec = a.recruiter_id ? Users.byId(a.recruiter_id) : null;
  const seeSalary = canSalary(user);
  return {
    id: a.id, applicationNo: a.application_no, candidateId: a.candidate_id, requestId: a.request_id,
    position: a.position_applied, status: a.status, matchScore: a.match_score, source: a.source,
    stageDate: a.stage_date, lastActivityAt: a.last_activity_at,
    nextAction: a.next_action, nextActionDate: a.next_action_date, interviewOutcome: a.interview_outcome,
    rejectionReason: a.rejection_reason, onHoldReason: a.on_hold_reason, withdrawnReason: a.withdrawn_reason,
    recruiter: rec ? { id: rec.id, name: rec.full_name } : null,
    candidate: cand ? {
      id: cand.id, candidateNo: cand.candidate_no, fullName: cand.full_name,
      currentPosition: cand.current_position, currentCompany: cand.current_company,
      yearsExperience: cand.years_experience, location: cand.location, noticePeriod: cand.notice_period,
      source: cand.source, expectedSalary: seeSalary ? cand.expected_salary : null, salaryVisible: seeSalary,
      // enhancement fields for the workspace table
      employer: cand.employer, currentProject: cand.current_project,
      graduationYear: cand.graduation_year, university: cand.university, major: cand.major,
    } : null,
  };
}

/* ---------------- LINK candidate to request (create application) ---------------- */
router.post('/', requirePermission('candidate.link'), (req, res) => {
  const d = req.body || {};
  const requestId = Number(d.requestId);
  const request = Requests.byId(requestId);
  if (!request) return res.status(404).json({ error: 'Recruitment request not found.' });
  if (['closed', 'cancelled', 'rejected', 'filled'].includes(request.status)) {
    return res.status(409).json({ error: `Cannot link candidates to a ${request.status} request.` });
  }

  let candidateId = d.candidateId ? Number(d.candidateId) : null;

  // Create-and-link path
  if (!candidateId && d.newCandidate) {
    const nc = d.newCandidate;
    if (!nc.fullName || (!nc.email && !nc.phone)) return res.status(400).json({ error: 'New candidate needs a name and at least one contact method.' });
    const dups = Candidates.findDuplicates({ email: nc.email, phone: nc.phone, linkedinUrl: nc.linkedinUrl });
    if (dups.length && !nc.overrideDuplicate) {
      return res.status(409).json({ error: 'Possible duplicate candidate.', duplicates: dups.map((c) => ({ id: c.id, fullName: c.full_name, candidateNo: c.candidate_no })) });
    }
    const candNo = Candidates.nextNo();
    const created = Candidates.create({
      candidateNo: candNo, fullName: nc.fullName, email: nc.email, phone: nc.phone, location: nc.location,
      linkedinUrl: nc.linkedinUrl, currentCompany: nc.currentCompany, currentPosition: nc.currentPosition,
      yearsExperience: nc.yearsExperience != null && nc.yearsExperience !== '' ? Number(nc.yearsExperience) : null,
      expectedSalary: canSalary(req.user) && nc.expectedSalary ? Number(nc.expectedSalary) : null,
      noticePeriod: nc.noticePeriod, source: nc.source, ownerRecruiterId: req.user.id, createdBy: req.user.id,
    });
    candidateId = created.id;
    CandidateActivity.add({ candidateId, actorId: req.user.id, actorName: req.user.fullName, type: 'candidate_created', note: candNo });
    writeAudit(req, { action: 'candidate.created', entityType: 'candidate', entityId: candidateId, newValue: { candidateNo: candNo } });
  }

  if (!candidateId) return res.status(400).json({ error: 'Provide candidateId or newCandidate.' });
  const candidate = Candidates.byId(candidateId);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });

  // Prevent duplicate application (one per candidate per request) unless admin override allowed.
  const existing = Applications.existing(candidateId, requestId);
  if (existing) {
    const allowDup = SystemSettings.all().allow_duplicate_application === 'true';
    const adminOverride = allowDup && req.user.permissions.includes('candidate.merge') && d.overrideExisting;
    if (!adminOverride) {
      return res.status(409).json({ error: 'This candidate already has an application to this request.', applicationId: existing.id });
    }
  }

  const initialStatus = APP_STATUSES.includes(appNorm(d.initialStatus)) ? appNorm(d.initialStatus) : APP.SOURCED;
  const appNo = Applications.nextNo();
  const created = Applications.create({
    applicationNo: appNo, candidateId, requestId,
    positionApplied: d.positionApplied || request.title,
    status: initialStatus, matchScore: d.matchScore != null ? Number(d.matchScore) : null,
    recruiterId: d.recruiterId ? Number(d.recruiterId) : (request.owner_id || req.user.id),
    source: d.source || candidate.source, createdBy: req.user.id,
  });
  StageHistory.add(created.id, null, initialStatus, req.user, 'Application created');
  Requests.stampLifecycle(requestId, 'first_candidate_at'); // lifecycle: first candidate added
  if (initialStatus === APP.SHORTLISTED) Requests.stampLifecycle(requestId, 'first_shortlist_at');
  CandidateActivity.add({ candidateId, applicationId: created.id, actorId: req.user.id, actorName: req.user.fullName, type: 'application_created', note: `${appNo} → ${request.ticket_no}` });
  RequestActivity.add(requestId, req.user, 'candidate_linked', { note: `${candidate.full_name} linked (${appNo})` });
  writeAudit(req, { action: 'application.created', entityType: 'application', entityId: created.id, newValue: { applicationNo: appNo, candidateId, requestId, status: initialStatus } });
  res.status(201).json({ application: appOut(created, req.user) });
});

/* ---------------- PIPELINE for a request ---------------- */
router.get('/request/:requestId', (req, res) => {
  if (!req.user.permissions.includes('candidate.view')) return res.status(403).json({ error: 'Insufficient permissions.' });
  const request = Requests.byId(Number(req.params.requestId));
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  const apps = Applications.forRequest(request.id).map((a) => appOut(a, req.user));
  res.json({ applications: apps, statuses: APP_STATUSES });
});

/* ---------------- APPLICATION detail ---------------- */
router.get('/:id', (req, res) => {
  if (!req.user.permissions.includes('candidate.view')) return res.status(403).json({ error: 'Insufficient permissions.' });
  const a = Applications.byId(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  res.json({ application: appOut(a, req.user), history: StageHistory.forApplication(a.id) });
});

/* ---------------- helper: move one application, handle reasons + automation ---------------- */
function performMove(appRow, toStatus, req, reason) {
  const fromStatus = appRow.status;
  const reasonField = REASON_REQUIRED[toStatus] || null;
  Applications.setStatus(appRow.id, toStatus, reasonField, reason);
  StageHistory.add(appRow.id, fromStatus, toStatus, req.user, reason);
  CandidateActivity.add({ candidateId: appRow.candidate_id, applicationId: appRow.id, actorId: req.user.id, actorName: req.user.fullName, type: 'application_status_changed', note: `${fromStatus} → ${toStatus}` });
  writeAudit(req, { action: 'application.status_changed', entityType: 'application', entityId: appRow.id, oldValue: { status: fromStatus }, newValue: { status: toStatus }, comments: reason });
  // Post candidate progress into the request thread so everyone is updated.
  const cand = Candidates.byId(appRow.candidate_id);
  Posts.system(appRow.request_id, `${cand ? cand.full_name : 'Candidate'} moved: ${fromStatus} → ${toStatus}.`,
    { event: 'stage_changed', applicationId: appRow.id, candidateId: appRow.candidate_id, fromStatus, toStatus }, req.user);
  // lifecycle stamping on first shortlist / first interview stage
  if (toStatus === APP.SHORTLISTED) Requests.stampLifecycle(appRow.request_id, 'first_shortlist_at');
  if (toStatus === APP.INTERVIEWING) Requests.stampLifecycle(appRow.request_id, 'first_interview_at');

  // Vacancy automation on Joined: fill a seat, bump count, transition request.
  if (toStatus === APP.JOINED && fromStatus !== APP.JOINED) {
    const request = Requests.byId(appRow.request_id);
    const before = request.headcount_filled;
    const result = fillSeatAndCount(request, appRow.id);
    RequestActivity.add(request.id, req.user, 'seat_filled', { note: `${result.filled}/${request.headcount} filled${result.newStatus === 'filled' ? ' — request Filled' : ''}` });
    writeAudit(req, { action: 'request.seat_filled', entityType: 'recruitment_request', entityId: request.id, newValue: { filled: result.filled, status: result.newStatus } });
    writeAudit(req, { action: 'request.vacancy_changed', entityType: 'recruitment_request', entityId: request.id, oldValue: { headcountFilled: before }, newValue: { headcountFilled: result.filled, remaining: request.headcount - result.filled, status: result.newStatus } });
  }
}

/* ---------------- MOVE STAGE ---------------- */
router.post('/:id/move', requirePermission('candidate.move_stage'), (req, res) => {
  const a = Applications.byId(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  const toStatus = appNorm((req.body || {}).status);
  if (!APP_STATUSES.includes(toStatus)) return res.status(400).json({ error: 'Invalid status.' });
  const fromStatus = appNorm(a.status);
  if (TERMINAL.includes(fromStatus)) return res.status(409).json({ error: `Application is terminal (${APP_LABELS[fromStatus] || fromStatus}) and cannot be moved.` });
  // Enforce the allowed-transition map (no skipping stages).
  if (!appCanMove(fromStatus, toStatus)) {
    return res.status(409).json({ error: `Cannot move from ${APP_LABELS[fromStatus] || fromStatus} to ${APP_LABELS[toStatus] || toStatus}.` });
  }
  const reasonField = REASON_REQUIRED[toStatus];
  const reason = (req.body || {}).reason;
  if (reasonField && (!reason || !reason.trim())) return res.status(400).json({ error: `A reason is required to set status '${APP_LABELS[toStatus] || toStatus}'.` });
  // Overfill protection: block Joined when no vacancy remains.
  if (toStatus === APP.JOINED && !hasOpenSeat(a.request_id)) {
    return res.status(409).json({ error: 'All vacancies for this request are already filled. Cannot join another candidate.' });
  }
  performMove(a, toStatus, req, reasonField ? reason : null);
  res.json({ application: appOut(Applications.byId(a.id), req.user) });
});

/* ---------------- SET next action (recruiter workspace) ---------------- */
router.post('/:id/next-action', requirePermission('candidate.move_stage'), (req, res) => {
  const a = Applications.byId(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  const { nextAction, nextActionDate } = req.body || {};
  Applications.setNextAction(a.id, nextAction || null, nextActionDate || null);
  CandidateActivity.add({ candidateId: a.candidate_id, applicationId: a.id, actorId: req.user.id, actorName: req.user.fullName, type: 'next_action_set', note: nextAction || null });
  writeAudit(req, { action: 'application.next_action_set', entityType: 'application', entityId: a.id, newValue: { nextAction, nextActionDate } });
  res.json({ application: appOut(Applications.byId(a.id), req.user) });
});

/* ---------------- ASSIGN recruiter to application ---------------- */
router.post('/:id/assign', requirePermission('request.assign_recruiter'), (req, res) => {
  const a = Applications.byId(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  const recruiterId = Number((req.body || {}).recruiterId);
  if (!Users.byId(recruiterId)) return res.status(400).json({ error: 'Recruiter not found.' });
  Applications.setRecruiter(a.id, recruiterId);
  CandidateActivity.add({ candidateId: a.candidate_id, applicationId: a.id, actorId: req.user.id, actorName: req.user.fullName, type: 'application_assigned' });
  writeAudit(req, { action: 'application.recruiter_assigned', entityType: 'application', entityId: a.id, newValue: { recruiterId } });
  res.json({ application: appOut(Applications.byId(a.id), req.user) });
});

/* ---------------- BULK ACTIONS ---------------- */
router.post('/bulk', requirePermission('application.bulk_action'), (req, res) => {
  const { ids, action, reason, recruiterId, tag } = req.body || {};
  const status = action === 'move' ? appNorm((req.body || {}).status) : (req.body || {}).status;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No applications selected.' });
  const reasonField = action === 'move' ? REASON_REQUIRED[status] : null;
  if (action === 'move') {
    if (!APP_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    if (reasonField && (!reason || !reason.trim())) return res.status(400).json({ error: `A reason is required for bulk '${status}'.` });
  }
  if (action === 'assign' && recruiterId && !Users.byId(Number(recruiterId))) {
    return res.status(400).json({ error: 'Recruiter not found.' });
  }
  let affected = 0;
  const skipped = []; // safe partial-failure reporting
  for (const id of ids) {
    const a = Applications.byId(Number(id));
    if (!a) { skipped.push({ id, reason: 'not_found' }); continue; }
    if (action === 'move') {
      const from = appNorm(a.status);
      if (TERMINAL.includes(from)) { skipped.push({ id, reason: `terminal_${from}` }); continue; }
      if (!appCanMove(from, status)) { skipped.push({ id, reason: `illegal_${from}_to_${status}` }); continue; }
      if (status === APP.JOINED && !hasOpenSeat(a.request_id)) { skipped.push({ id, reason: 'no_vacancy' }); continue; }
      performMove(a, status, req, reasonField ? reason : null); affected++;
    } else if (action === 'assign' && recruiterId) {
      Applications.setRecruiter(a.id, Number(recruiterId)); affected++;
    } else { skipped.push({ id, reason: 'unknown_action' }); }
  }
  writeAudit(req, { action: 'application.bulk_action', entityType: 'application', entityId: ids.join(','), newValue: { action, status, affected, skipped: skipped.length }, comments: reason || null });
  res.json({ ok: true, affected, skipped });
});

/* ---------------- reject reasons lookup ---------------- */
router.get('/meta/reject-reasons', (req, res) => res.json({ reasons: RejectReasons.all() }));

export default router;
