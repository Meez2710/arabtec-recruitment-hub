import { Router } from 'express';
import {
  Interviews, InterviewPanel, InterviewFeedback, InterviewActivity,
  Applications, Candidates, Requests, Users, CandidateActivity,
} from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { interviewInvite as interviewInviteTpl } from '../lib/email_templates.js';

const router = Router();
router.use(requireAuth);

const IV_TYPES = ['phone', 'technical', 'client', 'final', 'hr', 'reference'];
const IV_MODES = ['onsite', 'video', 'phone'];
const IV_STATUSES = ['scheduled', 'completed', 'no_show', 'cancelled', 'rescheduled'];
const RECS = ['strong_yes', 'yes', 'no', 'strong_no'];

// --- Scope helpers ----------------------------------------------------------
// Full-view roles see every interview; scoped roles (HM, interviewer) only see
// interviews where they are a panelist (or organizer).
function canViewAll(user) { return user.permissions.includes('interview.view_all'); }
// Scoped users (HM, interviewer) may see an interview if they are: the organizer,
// a panel member, OR the requester/owner of the underlying recruitment request
// (so a Hiring Manager sees interviews on their own requisitions).
function ownsRequest(user, requestId) {
  const r = Requests.byId(requestId);
  return !!r && (r.requester_id === user.id || r.owner_id === user.id || r.created_by === user.id);
}
function canViewInterview(user, iv) {
  if (canViewAll(user)) return true;
  if (!user.permissions.includes('interview.view_assigned')) return false;
  if (iv.organizer_id === user.id) return true;
  if (Interviews.isPanelist(iv.id, user.id)) return true;
  return ownsRequest(user, iv.request_id);
}

function serialize(iv, user, { detail = false } = {}) {
  const cand = Candidates.byId(iv.candidate_id);
  const req = Requests.byId(iv.request_id);
  const app = Applications.byId(iv.application_id);
  const organizer = iv.organizer_id ? Users.byId(iv.organizer_id) : null;
  const out = {
    id: iv.id, interviewNo: iv.interview_no,
    applicationId: iv.application_id, candidateId: iv.candidate_id, requestId: iv.request_id,
    round: iv.round, interviewType: iv.interview_type, mode: iv.mode,
    scheduledAt: iv.scheduled_at, durationMin: iv.duration_min, locationOrLink: iv.location_or_link,
    status: iv.status,                       // INTERVIEW status — independent of application status
    cancelReason: iv.cancel_reason, overallOutcome: iv.overall_outcome,
    organizer: organizer ? { id: organizer.id, name: organizer.full_name } : null,
    // The links that the spec requires every interview to carry:
    candidate: cand ? { id: cand.id, candidateNo: cand.candidate_no, fullName: cand.full_name, currentPosition: cand.current_position } : null,
    request: req ? { id: req.id, ticketNo: req.ticket_no, title: req.title } : null,
    application: app ? { id: app.id, applicationNo: app.application_no, status: app.status } : null, // shows application status SEPARATELY
    panel: InterviewPanel.forInterview(iv.id).map((m) => ({ id: m.interviewer_id, name: m.full_name, isLead: m.is_lead === 1 })),
    createdAt: iv.created_at,
  };
  if (detail) {
    // Feedback visibility: panelists see their own + (for organizers/full-view) all.
    const all = InterviewFeedback.forInterview(iv.id);
    const seeAll = canViewAll(user) || iv.organizer_id === user.id;
    out.feedback = (seeAll ? all : all.filter((f) => f.interviewer_id === user.id)).map((f) => ({
      id: f.id, interviewerId: f.interviewer_id,
      interviewerName: Users.byId(f.interviewer_id)?.full_name,
      criteria: f.criteria ? JSON.parse(f.criteria) : [],
      overallScore: f.overall_score, recommendation: f.recommendation, comments: f.comments, submittedAt: f.submitted_at,
    }));
    out.myFeedback = all.find((f) => f.interviewer_id === user.id) ? true : false;
    out.activity = InterviewActivity.forInterview(iv.id);
  }
  return out;
}

/* ---------------- LIST (scoped) ---------------- */
router.get('/', (req, res) => {
  if (!canViewAll(req.user) && !req.user.permissions.includes('interview.view_assigned')) {
    return res.status(403).json({ error: 'Insufficient permissions to view interviews.' });
  }
  let rows;
  if (canViewAll(req.user)) {
    rows = Interviews.list({ status: req.query.status, q: req.query.q });
  } else {
    // Scoped: panel interviews ∪ interviews on requests the user owns/requested.
    const byPanel = Interviews.list({ assignedTo: req.user.id, status: req.query.status, q: req.query.q });
    const all = Interviews.list({ status: req.query.status, q: req.query.q });
    const owned = all.filter((iv) => ownsRequest(req.user, iv.request_id) || iv.organizer_id === req.user.id);
    const seen = new Set();
    rows = [...byPanel, ...owned].filter((iv) => (seen.has(iv.id) ? false : seen.add(iv.id)));
    rows.sort((a, b) => String(b.scheduled_at || '').localeCompare(String(a.scheduled_at || '')));
  }
  res.json({ interviews: rows.map((iv) => serialize(iv, req.user)), scoped: !canViewAll(req.user) });
});

/* ---------------- LIST for a request's pipeline / application ---------------- */
router.get('/application/:applicationId', (req, res) => {
  const app = Applications.byId(Number(req.params.applicationId));
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (!req.user.permissions.includes('interview.view_all') && !req.user.permissions.includes('interview.view_assigned')) {
    return res.status(403).json({ error: 'Insufficient permissions.' });
  }
  const rows = Interviews.forApplication(app.id).filter((iv) => canViewInterview(req.user, iv));
  res.json({ interviews: rows.map((iv) => serialize(iv, req.user)) });
});

/* ---------------- DETAIL ---------------- */
router.get('/:id', (req, res) => {
  const iv = Interviews.byId(Number(req.params.id));
  if (!iv) return res.status(404).json({ error: 'Interview not found.' });
  if (!canViewInterview(req.user, iv)) return res.status(403).json({ error: 'You can only view interviews assigned to you.' });
  res.json({ interview: serialize(iv, req.user, { detail: true }) });
});

/* ---------------- SCHEDULE ---------------- */
router.post('/', requirePermission('interview.schedule'), (req, res) => {
  const d = req.body || {};
  const app = Applications.byId(Number(d.applicationId));
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  // Validation
  if (d.interviewType && !IV_TYPES.includes(d.interviewType)) return res.status(400).json({ error: 'Invalid interview type.' });
  if (d.mode && !IV_MODES.includes(d.mode)) return res.status(400).json({ error: 'Invalid interview mode.' });
  if (!d.scheduledAt) return res.status(400).json({ error: 'Scheduled date/time is required.' });
  if (new Date(d.scheduledAt) < new Date(Date.now() - 60000)) return res.status(400).json({ error: 'Interview cannot be scheduled in the past.' });
  const panel = Array.isArray(d.panel) ? d.panel : [];
  if (panel.length === 0) return res.status(400).json({ error: 'At least one interviewer (panel member) is required.' });
  for (const m of panel) if (!Users.byId(Number(m.interviewerId))) return res.status(400).json({ error: 'A selected interviewer does not exist.' });
  // Cannot schedule for a terminal application (rejected/withdrawn/hired) unless an
  // authorized user explicitly overrides (candidate.merge gate + reason), matching
  // the duplicate-override pattern used elsewhere.
  const TERMINAL_APP = ['rejected', 'withdrawn', 'joined', 'offer_rejected'];
  if (TERMINAL_APP.includes(app.status)) {
    if (!d.overrideTerminal) {
      return res.status(409).json({ error: `Cannot schedule an interview for a ${app.status} application.`, applicationStatus: app.status });
    }
    if (!req.user.permissions.includes('candidate.merge')) {
      return res.status(403).json({ error: 'You are not permitted to override scheduling for a terminal application.' });
    }
    if (!d.overrideReason || !d.overrideReason.trim()) {
      return res.status(400).json({ error: 'A reason is required to override and schedule for a terminal application.' });
    }
  }

  const interviewNo = Interviews.nextNo();
  const created = Interviews.create({
    interviewNo, applicationId: app.id, candidateId: app.candidate_id, requestId: app.request_id,
    round: d.round || 1, interviewType: d.interviewType || 'technical', mode: d.mode || 'onsite',
    scheduledAt: d.scheduledAt, durationMin: d.durationMin || 60, locationOrLink: d.locationOrLink,
    organizerId: req.user.id, status: 'scheduled', createdBy: req.user.id,
  });
  InterviewPanel.set(created.id, panel.map((m) => ({ interviewerId: Number(m.interviewerId), isLead: !!m.isLead })));
  InterviewActivity.add(created.id, req.user, 'scheduled', `${created.interview_type} interview scheduled`);
  CandidateActivity.add({ candidateId: app.candidate_id, applicationId: app.id, actorId: req.user.id, actorName: req.user.fullName, type: 'interview_scheduled', note: `${interviewNo} (${created.interview_type})` });
  Requests.stampLifecycle(app.request_id, 'first_interview_at'); // lifecycle: first interview scheduled
  writeAudit(req, { action: 'interview.scheduled', entityType: 'interview', entityId: created.id, newValue: { interviewNo, applicationId: app.id, candidateId: app.candidate_id, requestId: app.request_id, panel: panel.map((m) => m.interviewerId) }, comments: d.overrideTerminal ? `Terminal-app override: ${d.overrideReason}` : null });
  // NOTE: scheduling an interview does NOT change application.status. They are independent.
  // Auto-email the candidate an invitation (best-effort; no-op until email configured).
  const cand = Candidates.byId(app.candidate_id);
  if (cand?.email) {
    const dateText = created.scheduled_at ? new Date(created.scheduled_at).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' }) : '';
    const tpl = interviewInviteTpl({ candidateName: cand.full_name, position: cand.current_position,
      dateText, mode: created.mode, locationOrLink: created.location_or_link });
    sendMail({ to: cand.email, subject: tpl.subject, html: tpl.html })
      .then((r) => { if (r.ok) CandidateActivity.add({ candidateId: cand.id, applicationId: app.id, actorId: req.user.id, actorName: 'System', type: 'email_sent', note: 'Interview invite sent' }); })
      .catch(() => {});
  }
  res.status(201).json({ interview: serialize(created, req.user, { detail: true }) });
});

/* ---------------- RESCHEDULE ---------------- */
router.put('/:id', requirePermission('interview.edit'), (req, res) => {
  const iv = Interviews.byId(Number(req.params.id));
  if (!iv) return res.status(404).json({ error: 'Interview not found.' });
  if (['cancelled', 'completed'].includes(iv.status)) return res.status(409).json({ error: `Cannot edit a ${iv.status} interview.` });
  const d = req.body || {};
  if (d.scheduledAt && new Date(d.scheduledAt) < new Date(Date.now() - 60000)) return res.status(400).json({ error: 'Cannot reschedule into the past.' });
  const before = { scheduledAt: iv.scheduled_at, mode: iv.mode };
  const rescheduled = d.scheduledAt && d.scheduledAt !== iv.scheduled_at;
  const panelBefore = InterviewPanel.interviewerIds(iv.id);
  const updated = Interviews.update(iv.id, d);
  let panelChanged = false;
  if (Array.isArray(d.panel)) {
    if (d.panel.length === 0) return res.status(400).json({ error: 'At least one interviewer is required.' });
    for (const m of d.panel) if (!Users.byId(Number(m.interviewerId))) return res.status(400).json({ error: 'A selected interviewer does not exist.' });
    InterviewPanel.set(iv.id, d.panel.map((m) => ({ interviewerId: Number(m.interviewerId), isLead: !!m.isLead })));
    const panelAfter = InterviewPanel.interviewerIds(iv.id);
    panelChanged = JSON.stringify([...panelBefore].sort()) !== JSON.stringify([...panelAfter].sort());
    if (panelChanged) {
      InterviewActivity.add(iv.id, req.user, 'panel_changed');
      writeAudit(req, { action: 'interview.panel_changed', entityType: 'interview', entityId: iv.id, oldValue: { panel: panelBefore }, newValue: { panel: panelAfter } });
    }
  }
  if (rescheduled) { Interviews.setStatus(iv.id, 'rescheduled'); InterviewActivity.add(iv.id, req.user, 'rescheduled', `→ ${d.scheduledAt}`); }
  else if (!panelChanged) InterviewActivity.add(iv.id, req.user, 'updated');
  writeAudit(req, { action: 'interview.updated', entityType: 'interview', entityId: iv.id, oldValue: before, newValue: { scheduledAt: updated.scheduled_at, rescheduled } });
  res.json({ interview: serialize(Interviews.byId(iv.id), req.user, { detail: true }) });
});

/* ---------------- STATUS: complete / no_show / cancel ---------------- */
router.post('/:id/status', requirePermission('interview.edit'), (req, res) => {
  const iv = Interviews.byId(Number(req.params.id));
  if (!iv) return res.status(404).json({ error: 'Interview not found.' });
  const { status, reason } = req.body || {};
  if (!['completed', 'no_show', 'cancelled', 'scheduled'].includes(status)) return res.status(400).json({ error: 'Invalid interview status.' });
  if (status === 'cancelled' && (!reason || !reason.trim())) return res.status(400).json({ error: 'A reason is required to cancel an interview.' });
  if (iv.status === 'cancelled') return res.status(409).json({ error: 'Interview is already cancelled.' });
  Interviews.setStatus(iv.id, status, status === 'cancelled' ? { cancel_reason: reason } : {});
  InterviewActivity.add(iv.id, req.user, status, reason || null);
  CandidateActivity.add({ candidateId: iv.candidate_id, applicationId: iv.application_id, actorId: req.user.id, actorName: req.user.fullName, type: 'interview_' + status });
  writeAudit(req, { action: 'interview.status_changed', entityType: 'interview', entityId: iv.id, oldValue: { status: iv.status }, newValue: { status }, comments: reason || null });
  // Reminder: this changes ONLY the interview status, never application.status.
  res.json({ interview: serialize(Interviews.byId(iv.id), req.user, { detail: true }) });
});

/* ---------------- FEEDBACK (permission + scope controlled) ---------------- */
router.post('/:id/feedback', requirePermission('interview.feedback'), (req, res) => {
  const iv = Interviews.byId(Number(req.params.id));
  if (!iv) return res.status(404).json({ error: 'Interview not found.' });
  // Scope: a feedback author must be a panelist on this interview, the organizer, or a full-view role.
  const isPanelist = Interviews.isPanelist(iv.id, req.user.id);
  if (!isPanelist && !canViewAll(req.user) && iv.organizer_id !== req.user.id) {
    return res.status(403).json({ error: 'Only assigned panel members can submit feedback for this interview.' });
  }
  const d = req.body || {};
  if (d.recommendation && !RECS.includes(d.recommendation)) return res.status(400).json({ error: 'Invalid recommendation.' });
  if (!d.recommendation && d.overallScore == null && !d.comments) return res.status(400).json({ error: 'Provide at least a recommendation, score, or comments.' });

  const alreadyHad = !!InterviewFeedback.byInterviewer(iv.id, req.user.id); // distinguish update vs submit
  const fb = InterviewFeedback.upsert({
    interviewId: iv.id, interviewerId: req.user.id,
    criteria: d.criteria, overallScore: d.overallScore != null ? Number(d.overallScore) : null,
    recommendation: d.recommendation, comments: d.comments,
  });
  // Derive an aggregate outcome (advisory only — does NOT change application.status).
  const all = InterviewFeedback.forInterview(iv.id);
  const score = { strong_yes: 2, yes: 1, no: -1, strong_no: -2 };
  const sum = all.reduce((s, f) => s + (score[f.recommendation] || 0), 0);
  const outcome = sum > 0 ? 'positive' : sum < 0 ? 'negative' : 'mixed';
  Interviews.setOutcome(iv.id, outcome);

  const fbAction = alreadyHad ? 'interview.feedback_updated' : 'interview.feedback_submitted';
  InterviewActivity.add(iv.id, req.user, alreadyHad ? 'feedback_updated' : 'feedback_submitted', d.recommendation || null);
  CandidateActivity.add({ candidateId: iv.candidate_id, applicationId: iv.application_id, actorId: req.user.id, actorName: req.user.fullName, type: 'interview_feedback', note: d.recommendation || null });
  writeAudit(req, { action: fbAction, entityType: 'interview', entityId: iv.id, newValue: { interviewer: req.user.id, recommendation: d.recommendation, overallScore: d.overallScore } });
  res.status(201).json({ interview: serialize(Interviews.byId(iv.id), req.user, { detail: true }) });
});

/* ---------------- meta for scheduling form ---------------- */
router.get('/meta/form', (req, res) => {
  res.json({
    interviewers: Users.list({}).map((u) => ({ id: u.id, name: u.full_name, jobTitle: u.job_title })),
    types: IV_TYPES, modes: IV_MODES, recommendations: RECS,
  });
});

export default router;
