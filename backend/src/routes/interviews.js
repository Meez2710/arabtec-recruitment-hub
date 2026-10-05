import { Router } from 'express';
import {
  Interviews, InterviewPanel, InterviewFeedback, InterviewActivity,
  Applications, Candidates, Requests, Users, CandidateActivity,
} from '../lib/models.js';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { ACTIVE_STATUSES, MAX_DURATION_MIN, findPanelClashes, intervalOf } from '../lib/interview-clashes.js';
import { writeAudit } from '../lib/audit.js';
import { APP_TERMINAL, APP_LABELS, appNorm, REQ_TERMINAL, REQ_LABELS, reqNorm } from '../lib/stages.js';
import { deliveryPlan, candidateEmailReporter } from '../lib/candidate-email.js';
import { notifyEvent } from '../lib/notify.js';
import { sendMail } from '../lib/mailer.js';
import { interviewInvite as interviewInviteTpl } from '../lib/email_templates.js';

const router = Router();
router.use(requireAuth);

const IV_TYPES = ['phone', 'technical', 'client', 'final', 'hr', 'reference'];

// A calendar entry for the invite email, so the interview lands in Outlook
// (or any calendar) with one click instead of being retyped from the text.
// METHOD:PUBLISH, not REQUEST: the ATS is not the meeting organizer and does
// not track replies, so this is an entry to add, not a meeting to accept.
function icsText(s) { return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsDate(d) { return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function interviewIcs(iv, cand) {
  const start = new Date(iv.scheduled_at);
  if (isNaN(start)) return null;
  const end = new Date(start.getTime() + (Number(iv.duration_min) || 60) * 60000);
  const summary = `Interview — ${cand?.current_position || cand?.full_name || 'Arabtec'} (${iv.interview_type || 'interview'})`;
  const description = [cand?.full_name ? `Candidate: ${cand.full_name}` : null, iv.interview_no ? `Reference: ${iv.interview_no}` : null,
    iv.mode ? `Mode: ${iv.mode}` : null, iv.location_or_link ? `Where: ${iv.location_or_link}` : null].filter(Boolean).join('\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Arabtec Recruitment Hub//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${iv.interview_no || iv.id}@arabtec-recruitment-hub`, `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsText(summary)}`,
    ...(iv.location_or_link ? [`LOCATION:${icsText(iv.location_or_link)}`] : []),
    `DESCRIPTION:${icsText(description)}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}
const IV_MODES = ['onsite', 'video', 'phone'];
const IV_STATUSES = ['scheduled', 'completed', 'no_show', 'cancelled', 'rescheduled'];
const RECS = ['strong_yes', 'yes', 'no', 'strong_no'];

// One unambiguous instant per interview. Accepts an ISO-8601 date-time with Z
// or an explicit offset and returns it as ISO UTC; refuses what the server
// would have to guess (no offset = the server's own timezone) or would
// silently roll over (V8 reads 2031-02-30 as 2 March). null = unusable.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function canonicalInstant(v) {
  if (typeof v !== 'string') return null;
  const m = ISO_INSTANT.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec = '0'] = m;
  if (+h > 23 || +mi > 59 || +sec > 59) return null;
  const civil = new Date(Date.UTC(+y, +mo - 1, +d));
  if (civil.getUTCFullYear() !== +y || civil.getUTCMonth() !== +mo - 1 || civil.getUTCDate() !== +d) return null;
  const t = new Date(v.trim()).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
// Whole minutes the calendar can reason about (its clash lookup looks back at
// most MAX_DURATION_MIN). null = unusable.
function validDuration(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n > 0 && n <= MAX_DURATION_MIN ? n : null;
}
const BAD_INSTANT = 'Scheduled date/time must be a valid date and time with a timezone, e.g. 2031-01-06T10:00:00Z.';
const BAD_DURATION = `Duration must be a whole number of minutes from 1 to ${MAX_DURATION_MIN}.`;
const given = (v) => v !== undefined && v !== null;

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

// Optional ISO date query param → canonical ISO-8601 UTC, or an error string.
function isoParam(value, name) {
  if (value == null || value === '') return { value: null };
  const d = new Date(String(value));
  return isNaN(d) ? { error: `\`${name}\` must be an ISO date.` } : { value: d.toISOString() };
}

/* ---------------- LIST (scoped) ---------------- */
router.get('/', (req, res) => {
  if (!canViewAll(req.user) && !req.user.permissions.includes('interview.view_assigned')) {
    return res.status(403).json({ error: 'Insufficient permissions to view interviews.' });
  }
  // The calendar asks for the visible range only; the list view sends neither.
  const from = isoParam(req.query.from, 'from');
  const to = isoParam(req.query.to, 'to');
  if (from.error || to.error) return res.status(400).json({ error: from.error || to.error });
  const range = { from: from.value, to: to.value };
  let rows;
  if (canViewAll(req.user)) {
    rows = Interviews.list({ status: req.query.status, q: req.query.q, ...range });
  } else {
    // Scoped: panel interviews ∪ interviews on requests the user owns/requested.
    const byPanel = Interviews.list({ assignedTo: req.user.id, status: req.query.status, q: req.query.q, ...range });
    const all = Interviews.list({ status: req.query.status, q: req.query.q, ...range });
    const owned = all.filter((iv) => ownsRequest(req.user, iv.request_id) || iv.organizer_id === req.user.id);
    const seen = new Set();
    rows = [...byPanel, ...owned].filter((iv) => (seen.has(iv.id) ? false : seen.add(iv.id)));
    rows.sort((a, b) => String(b.scheduled_at || '').localeCompare(String(a.scheduled_at || '')));
  }
  res.json({ interviews: rows.map((iv) => serialize(iv, req.user)), scoped: !canViewAll(req.user) });
});

/* ---------------- PANEL CLASHES (warning, never a block) ---------------- */
// Registered before `/:id`, which would otherwise read "clashes" as an id.
// Answers only "who is busy, when": no candidate, request or interview number,
// so a scheduler with a scoped view learns nothing about interviews they
// cannot open.
router.get('/clashes', requireAnyPermission('interview.schedule', 'interview.edit'), (req, res) => {
  const panel = String(req.query.panel || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
  // Bounded, so a huge duration cannot turn one lookup into a full-table scan.
  const durationMin = Math.min(Number(req.query.durationMin) > 0 ? Number(req.query.durationMin) : 60, MAX_DURATION_MIN);
  const wanted = intervalOf(req.query.start, durationMin);
  if (!wanted) return res.status(400).json({ error: '`start` must be an ISO date.' });
  if (panel.length === 0) return res.json({ clashes: [] });
  const excludeId = Number(req.query.excludeId) || null;
  const from = new Date(wanted.start - MAX_DURATION_MIN * 60000).toISOString();
  const to = new Date(wanted.end).toISOString();
  const existing = Interviews.activeBetween(from, to, ACTIVE_STATUSES).map((iv) => ({
    id: iv.id, status: iv.status, scheduledAt: iv.scheduled_at, durationMin: iv.duration_min,
    panel: InterviewPanel.forInterview(iv.id).map((m) => ({ id: m.interviewer_id, name: m.full_name })),
  }));
  const clashes = findPanelClashes({ start: req.query.start, durationMin, panel, excludeId }, existing)
    .map(({ interviewerId, name, start, end }) => ({ interviewerId, name, start, end }));
  res.json({ clashes });
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
  // Two ways in: from an application (the pipeline), or standalone — a
  // candidate from the Talent Pool with an optional hiring request. A
  // standalone interview has no application, so no application status moves.
  let app = null;
  let candidateId; let requestId = null;
  if (d.applicationId) {
    app = Applications.byId(Number(d.applicationId));
    if (!app) return res.status(404).json({ error: 'Application not found.' });
    candidateId = app.candidate_id; requestId = app.request_id;
  } else {
    if (!d.candidateId) return res.status(400).json({ error: 'A candidate is required.' });
    if (!Candidates.byId(Number(d.candidateId))) return res.status(404).json({ error: 'Candidate not found.' });
    candidateId = Number(d.candidateId);
    if (d.requestId) {
      if (!Requests.byId(Number(d.requestId))) return res.status(404).json({ error: 'Hiring request not found.' });
      requestId = Number(d.requestId);
    }
  }
  // Validation
  if (d.interviewType && !IV_TYPES.includes(d.interviewType)) return res.status(400).json({ error: 'Invalid interview type.' });
  if (d.mode && !IV_MODES.includes(d.mode)) return res.status(400).json({ error: 'Invalid interview mode.' });
  if (!given(d.scheduledAt) || d.scheduledAt === '') return res.status(400).json({ error: 'Scheduled date/time is required.' });
  const scheduledAt = canonicalInstant(d.scheduledAt);
  if (!scheduledAt) return res.status(400).json({ error: BAD_INSTANT });
  if (new Date(scheduledAt) < new Date(Date.now() - 60000)) return res.status(400).json({ error: 'Interview cannot be scheduled in the past.' });
  const durationMin = given(d.durationMin) ? validDuration(d.durationMin) : 60;
  if (!durationMin) return res.status(400).json({ error: BAD_DURATION });
  const panel = Array.isArray(d.panel) ? d.panel : [];
  if (panel.length === 0) return res.status(400).json({ error: 'At least one interviewer (panel member) is required.' });
  for (const m of panel) if (!Users.byId(Number(m.interviewerId))) return res.status(400).json({ error: 'A selected interviewer does not exist.' });
  // Cannot schedule for a terminal application (rejected, offer declined, joined)
  // unless an authorized user explicitly overrides (candidate.merge gate +
  // reason), matching the duplicate-override pattern used elsewhere. The
  // terminal set is the canonical one in lib/stages.js, compared after alias
  // normalisation — a hand-kept list here used legacy names and let a
  // canonical 'offer_declined' application be scheduled again.
  if (app && APP_TERMINAL.includes(appNorm(app.status))) {
    if (!d.overrideTerminal) {
      const label = APP_LABELS[appNorm(app.status)] || app.status;
      return res.status(409).json({ error: `Cannot schedule an interview for an application that is ${label}.`, applicationStatus: appNorm(app.status) });
    }
    if (!req.user.permissions.includes('candidate.merge')) {
      return res.status(403).json({ error: 'You are not permitted to override scheduling for a terminal application.' });
    }
    if (!d.overrideReason || !d.overrideReason.trim()) {
      return res.status(400).json({ error: 'A reason is required to override and schedule for a terminal application.' });
    }
  }

  // A closed/cancelled request: recruiting for it has ended. Same override
  // discipline as a terminal application (candidate.merge + reason).
  const reqRow = requestId ? Requests.byId(requestId) : null;
  if (reqRow && REQ_TERMINAL.includes(reqNorm(reqRow.status)) && !(d.overrideTerminal && req.user.permissions.includes('candidate.merge') && d.overrideReason && d.overrideReason.trim())) {
    if (d.overrideTerminal && !req.user.permissions.includes('candidate.merge')) return res.status(403).json({ error: 'You are not permitted to override scheduling for this request.' });
    if (d.overrideTerminal) return res.status(400).json({ error: 'A reason is required to override and schedule for a closed request.' });
    return res.status(409).json({ error: `Hiring request ${reqRow.ticket_no || ''} is ${REQ_LABELS[reqNorm(reqRow.status)] || reqRow.status}; interviews for it are no longer scheduled.`.replace('  ', ' '), requestStatus: reqNorm(reqRow.status) });
  }
  // Owner decision Q-01: a request on hold pauses interview scheduling;
  // existing interviews are untouched and scheduling returns on resume.
  if (reqRow && reqNorm(reqRow.status) === 'on_hold') {
    return res.status(409).json({ error: `Interview scheduling is unavailable because hiring request ${reqRow.ticket_no || ''} is currently On Hold. It resumes when the request is resumed.`.replace('  ', ' '), requestStatus: 'on_hold' });
  }
  const interviewNo = Interviews.nextNo();
  const created = Interviews.create({
    interviewNo, applicationId: app ? app.id : null, candidateId, requestId,
    round: d.round || 1, interviewType: d.interviewType || 'technical', mode: d.mode || 'onsite',
    scheduledAt, durationMin, locationOrLink: d.locationOrLink,
    organizerId: req.user.id, status: 'scheduled', createdBy: req.user.id,
  });
  InterviewPanel.set(created.id, panel.map((m) => ({ interviewerId: Number(m.interviewerId), isLead: !!m.isLead })));
  InterviewActivity.add(created.id, req.user, 'scheduled', `${created.interview_type} interview scheduled`);
  CandidateActivity.add({ candidateId, applicationId: app ? app.id : null, actorId: req.user.id, actorName: req.user.fullName, type: 'interview_scheduled', note: `${interviewNo} (${created.interview_type})` });
  if (requestId) Requests.stampLifecycle(requestId, 'first_interview_at'); // lifecycle: first interview scheduled
  writeAudit(req, { action: 'interview.scheduled', entityType: 'interview', entityId: created.id, newValue: { interviewNo, applicationId: app ? app.id : null, candidateId, requestId, standalone: !app, panel: panel.map((m) => m.interviewerId) }, comments: d.overrideTerminal ? `Terminal-app override: ${d.overrideReason}` : null });
  // NOTE: scheduling an interview does NOT change application.status. They are independent.
  // Auto-email the candidate an invitation (best-effort; no-op until email configured).
  // Routed through the console: the invitation reaches the candidate AND the
  // panel, and an administrator controls both from one row.
  const cand = Candidates.byId(candidateId);
  const dateText = created.scheduled_at
    ? new Date(created.scheduled_at).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' }) : '';
  const panelUsers = panel.map((m) => { try { return Users.byId(Number(m.interviewerId)); } catch { return null; } }).filter(Boolean);
  const invited = notifyEvent('interview.scheduled', {
    actor: req.user, candidate: cand, panel: panelUsers,
    linkType: 'interview', linkId: created.id,
    vars: { candidateName: cand ? cand.full_name : null, position: cand ? cand.current_position : null,
      dateText, mode: created.mode, locationOrLink: created.location_or_link },
    title: `Interview scheduled: ${interviewNo}`,
    body: `${cand ? cand.full_name : 'A candidate'} — ${dateText}`,
    attachments: (() => { const ics = interviewIcs(created, cand); return ics ? [{ filename: `${interviewNo}.ics`, contentType: 'text/calendar; charset=utf-8; method=PUBLISH', content: ics }] : []; })(),
    onExternalResult: cand ? candidateEmailReporter({ candidateId: cand.id, applicationId: app ? app.id : null, actorId: req.user.id, what: 'Interview invite' }) : undefined,
  });
  res.status(201).json({ interview: serialize(created, req.user, { detail: true }), delivery: deliveryPlan(invited, cand) });
});

/* ---------------- RESCHEDULE ---------------- */
router.put('/:id', requirePermission('interview.edit'), (req, res) => {
  const iv = Interviews.byId(Number(req.params.id));
  if (!iv) return res.status(404).json({ error: 'Interview not found.' });
  if (['cancelled', 'completed'].includes(iv.status)) return res.status(409).json({ error: `Cannot edit a ${iv.status} interview.` });
  const d = req.body || {};
  // Everything is checked before anything is written: a refused update must
  // leave the interview exactly as it was.
  let scheduledAt;
  if (given(d.scheduledAt)) {
    scheduledAt = canonicalInstant(d.scheduledAt);
    if (!scheduledAt) return res.status(400).json({ error: BAD_INSTANT });
    if (new Date(scheduledAt) < new Date(Date.now() - 60000)) return res.status(400).json({ error: 'Cannot reschedule into the past.' });
  }
  let durationMin;
  if (given(d.durationMin)) {
    durationMin = validDuration(d.durationMin);
    if (!durationMin) return res.status(400).json({ error: BAD_DURATION });
  }
  if (d.interviewType && !IV_TYPES.includes(d.interviewType)) return res.status(400).json({ error: 'Invalid interview type.' });
  if (d.mode && !IV_MODES.includes(d.mode)) return res.status(400).json({ error: 'Invalid interview mode.' });
  if (Array.isArray(d.panel)) {
    if (d.panel.length === 0) return res.status(400).json({ error: 'At least one interviewer is required.' });
    for (const m of d.panel) if (!Users.byId(Number(m.interviewerId))) return res.status(400).json({ error: 'A selected interviewer does not exist.' });
  }
  const before = { scheduledAt: iv.scheduled_at, mode: iv.mode };
  // Same instant in another spelling is not a reschedule.
  const rescheduled = !!scheduledAt && new Date(scheduledAt).getTime() !== new Date(iv.scheduled_at).getTime();
  const panelBefore = InterviewPanel.interviewerIds(iv.id);
  const updated = Interviews.update(iv.id, { ...d, scheduledAt, durationMin });
  let panelChanged = false;
  if (Array.isArray(d.panel)) {
    InterviewPanel.set(iv.id, d.panel.map((m) => ({ interviewerId: Number(m.interviewerId), isLead: !!m.isLead })));
    const panelAfter = InterviewPanel.interviewerIds(iv.id);
    panelChanged = JSON.stringify([...panelBefore].sort()) !== JSON.stringify([...panelAfter].sort());
    if (panelChanged) {
      InterviewActivity.add(iv.id, req.user, 'panel_changed');
      writeAudit(req, { action: 'interview.panel_changed', entityType: 'interview', entityId: iv.id, oldValue: { panel: panelBefore }, newValue: { panel: panelAfter } });
    }
  }
  if (rescheduled) { Interviews.setStatus(iv.id, 'rescheduled'); InterviewActivity.add(iv.id, req.user, 'rescheduled', `→ ${scheduledAt}`); }
  else if (!panelChanged) InterviewActivity.add(iv.id, req.user, 'updated');
  writeAudit(req, { action: 'interview.updated', entityType: 'interview', entityId: iv.id, oldValue: before, newValue: { scheduledAt: updated.scheduled_at, rescheduled } });
  res.json({ interview: serialize(Interviews.byId(iv.id), req.user, { detail: true }) });
});

/* ---------------- LINK a standalone interview to an application ---------------- */
// The interview assessment is stored per application. An interview scheduled
// from the Interviews page without one has no assessment until it is attached
// to the candidate's application on the hiring request it was for.
router.post('/:id/link-application', requirePermission('interview.edit'), (req, res) => {
  const iv = Interviews.byId(Number(req.params.id));
  if (!iv) return res.status(404).json({ error: 'Interview not found.' });
  if (iv.application_id) return res.status(409).json({ error: 'This interview is already linked to an application.', applicationId: iv.application_id });
  if (iv.status === 'cancelled') return res.status(409).json({ error: 'A cancelled interview cannot be linked.' });
  const app = Applications.byId(Number((req.body || {}).applicationId));
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (Number(app.candidate_id) !== Number(iv.candidate_id)) return res.status(400).json({ error: 'That application belongs to a different candidate.' });
  if (APP_TERMINAL.includes(appNorm(app.status))) {
    return res.status(409).json({ error: `Cannot link an interview to an application that is ${APP_LABELS[appNorm(app.status)] || app.status}.` });
  }
  if (iv.request_id && app.request_id && Number(iv.request_id) !== Number(app.request_id)) {
    return res.status(400).json({ error: 'That application is for a different hiring request than this interview.' });
  }
  const linked = Interviews.linkApplication(iv.id, app.id, app.request_id || iv.request_id || null);
  InterviewActivity.add(iv.id, req.user, 'updated', `Linked to application ${app.application_no || app.id}`);
  writeAudit(req, { action: 'interview.application_linked', entityType: 'interview', entityId: iv.id, oldValue: { applicationId: null, requestId: iv.request_id }, newValue: { applicationId: app.id, requestId: linked.request_id } });
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
