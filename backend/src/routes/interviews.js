import { canSeeApplicationStage, hasFullPipelineAccess } from '../lib/pipeline-visibility.js';
import { Router } from 'express';
import {
  Interviews, InterviewPanel, InterviewFeedback, InterviewActivity,
  Applications, Candidates, Requests, Users, CandidateActivity,
} from '../lib/models.js';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { ACTIVE_STATUSES, MAX_DURATION_MIN, findPanelClashes, intervalOf } from '../lib/interview-clashes.js';
import { writeAudit } from '../lib/audit.js';
import { isEnabled } from '../lib/feature-flags.js';
import { APP_TERMINAL, APP_LABELS, appNorm, REQ_TERMINAL, REQ_LABELS, reqNorm } from '../lib/stages.js';
import { schedulingGuard, evaluateConflicts, conflictRefusal, attendanceRefusal, actionsOpenAt, workingHoursWarning, workingWeek, validateWorkWeek, WORK_WEEK_SETTING } from '../lib/interview-rules.js';
import { tx, run as dbRun, all as dbAll } from '../lib/db.js';
import { canSeeCandidate } from '../lib/candidate-scope.js';
import {
  PLACEHOLDERS, DEFAULT_TEMPLATES, AUDIENCES, HAS_SUBJECT, KINDS, TEMPLATE_SETTING, globalTemplates, storedTemplates, validateTemplateSet, validateText,
  messageValues, fill, cairoParts, intlPhone, whatsappLink, telLink, detailsProblem, EMAIL_OK,
} from '../lib/interview-messages.js';
import {
  effectiveMessages, saveMessages, renderAll, recipients, channelStatus, sendAction, dispatchesFor, recordWhatsappHandoff, recordCallHandoff, lastReminderAt, appUrl,
} from '../lib/interview-dispatch.js';
import { SystemSettings } from '../lib/models.js';

const router = Router();
router.use(requireAuth);

const IV_TYPES = ['phone', 'technical', 'client', 'final', 'hr', 'reference'];

// Calendar entries are built in lib/interview-messages.js (stable UID, rising SEQUENCE).
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
  if (!hasFullPipelineAccess(user) && !canSeeApplicationStage(user, { id: iv.application_id })) return false;
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
    overlapReason: iv.overlap_reason || null,
    calendarSeq: Number(iv.calendar_seq || 0),
    // From when Completed / No-Show / feedback may be recorded (audit A4/A5).
    actionsOpenAt: actionsOpenAt(iv),
    // The candidate's answer to the invitation (audit A3): pending | confirmed | change_requested | declined.
    candidateResponse: iv.candidate_response || 'pending',
    // Last reminder to the candidate for the current version (audit A7).
    remindedAt: lastReminderAt(iv),
    // A change or cancellation that has not been communicated yet.
    notice: (() => { try { return iv.notice_state ? JSON.parse(iv.notice_state) : null; } catch { return null; } })(),
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
    // The candidate's stored CV, for whoever may see this candidate (the
    // panel through existing assignment scope). The file itself is served by
    // the authenticated, scope-checked GET /candidates/:id/resume.
    out.cv = cand && canSeeCandidate(user, cand.id)
      ? { available: !!cand.resume_path, fileName: cand.resume_name || null, candidateId: cand.id }
      : null;
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
  // The calendar draws the organisation's working week (Scheduling Setup).
  res.json({ interviews: rows.filter((iv) => canViewInterview(req.user, iv)).map((iv) => serialize(iv, req.user)), scoped: !canViewAll(req.user), workingWeek: workingWeek() });
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
  const excludeId = Number(req.query.excludeId) || null;
  const candidateId = Number(req.query.candidateId) || null;
  const location = typeof req.query.location === 'string' ? req.query.location.slice(0, 500) : '';
  const found = evaluateConflicts({ start: req.query.start, durationMin, panelIds: panel, candidateId, location, excludeId });
  // Times only — no candidate, request or interview number — so a scheduler
  // learns nothing about interviews they cannot open.
  res.json({
    clashes: found.panel.map(({ interviewerId, name, start, end }) => ({ interviewerId, name, start, end })),
    candidateConflicts: found.candidate.map(({ start, end }) => ({ start, end })),
    locationWarnings: found.location.map(({ start, end }) => ({ start, end })),
    // Outside the working week: a warning, never a block (audit A9).
    hoursWarning: workingHoursWarning(req.query.start, durationMin),
  });
});

/* ---------------- LIST for a request's pipeline / application ---------------- */
router.get('/application/:applicationId', (req, res) => {
  const app = Applications.byId(Number(req.params.applicationId));
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (!req.user.permissions.includes('interview.view_all') && !req.user.permissions.includes('interview.view_assigned')) {
    return res.status(403).json({ error: 'Insufficient permissions.' });
  }
  const rows = Interviews.forApplication(app.id).filter((iv) => canViewInterview(req.user, iv));
  res.json({ interviews: rows.filter((iv) => canViewInterview(req.user, iv)).map((iv) => serialize(iv, req.user)) });
});

/* ---------------- INVITATION TEMPLATES (global) ---------------- */
// Registered before `/:id`. Reading needs a scheduling permission; changing the
// organisation's defaults needs notification.manage (the existing Notifications
// permission). Templates carry placeholders only — never salary or HR data —
// and never touch sender credentials.
// notification.manage may change these, so it may also open them (HR Director
// holds it without the scheduling permissions and was refused the panel).
router.get('/message-templates', requireAnyPermission('interview.schedule', 'interview.edit', 'notification.manage'), (req, res) => {
  res.json({ templates: globalTemplates(), defaults: DEFAULT_TEMPLATES, audiences: Object.fromEntries(Object.entries(AUDIENCES).map(([k, v]) => [k, withoutCall(v)])), hasSubject: HAS_SUBJECT, phoneCalls: phoneCalls(), headOfficeAddress: SystemSettings.get(HQ_SETTING) || '', workingWeek: workingWeek(),
    placeholders: Object.entries(PLACEHOLDERS).map(([name, p]) => ({ name, label: p.label, in: p.in })),
    canEdit: req.user.permissions.includes('notification.manage') });
});
router.put('/message-templates', requirePermission('notification.manage'), (req, res) => {
  const d = req.body || {};
  // `raw` is what is in the setting (audit shows it as it was); `stored` is it
  // read in our format, so a value written by the old GitHub format is
  // converted on this save instead of being merged character by character.
  const raw = SystemSettings.get(TEMPLATE_SETTING) || '{}';
  let rawParsed = {}; try { rawParsed = JSON.parse(raw) || {}; } catch { rawParsed = {}; }
  const stored = storedTemplates(raw);
  if (d.reset) {
    SystemSettings.upsert(TEMPLATE_SETTING, '{}');
    writeAudit(req, { action: 'interview.templates_reset', entityType: 'setting', entityId: TEMPLATE_SETTING, oldValue: rawParsed });
    return res.json({ templates: globalTemplates() });
  }
  if (d.workingWeek !== undefined) {
    const wErr = validateWorkWeek(d.workingWeek);
    if (wErr) return res.status(400).json({ error: wErr });
    const before = workingWeek();
    const next = { days: [...new Set(d.workingWeek.days)].sort(), start: d.workingWeek.start, end: d.workingWeek.end };
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      SystemSettings.upsert(WORK_WEEK_SETTING, JSON.stringify(next));
      writeAudit(req, { action: 'interview.working_week_changed', entityType: 'setting', entityId: WORK_WEEK_SETTING, oldValue: before, newValue: next });
    }
    if (d.templates === undefined && d.headOfficeAddress === undefined) return res.json({ templates: globalTemplates(), workingWeek: workingWeek() });
  }
  if (d.headOfficeAddress !== undefined) {
    const addr = String(d.headOfficeAddress || '').replace(/\s+/g, ' ').trim();
    if (addr.length > 300) return res.status(400).json({ error: 'The Head Office address is too long (300 characters at most).' });
    const before = SystemSettings.get(HQ_SETTING) || '';
    if (addr !== before) {
      SystemSettings.upsert(HQ_SETTING, addr);
      writeAudit(req, { action: 'interview.head_office_address_changed', entityType: 'setting', entityId: HQ_SETTING, oldValue: { address: before }, newValue: { address: addr } });
    }
    if (d.templates === undefined) return res.json({ templates: globalTemplates(), headOfficeAddress: addr, workingWeek: workingWeek() });
  }
  const err = validateTemplateSet(d.templates);
  if (err) return res.status(400).json({ error: err });
  const merged = JSON.parse(JSON.stringify(stored));
  for (const [kind, auds] of Object.entries(d.templates)) {
    merged[kind] = merged[kind] || {};
    for (const [aud, partsIn] of Object.entries(auds)) merged[kind][aud] = { ...(merged[kind][aud] || {}), ...partsIn };
  }
  SystemSettings.upsert(TEMPLATE_SETTING, JSON.stringify(merged));
  writeAudit(req, { action: 'interview.templates_updated', entityType: 'setting', entityId: TEMPLATE_SETTING,
    oldValue: rawParsed, newValue: merged });
  res.json({ templates: globalTemplates(), headOfficeAddress: SystemSettings.get(HQ_SETTING) || '', workingWeek: workingWeek() });
});

/* ---------------- DRAFT PREVIEW (scheduling form, nothing saved) ---------------- */
router.post('/message-preview', requirePermission('interview.schedule'), (req, res) => {
  const d = req.body || {};
  const kind = 'invite';
  const app = d.applicationId ? Applications.byId(Number(d.applicationId)) : null;
  const candidate = app ? Candidates.byId(app.candidate_id) : d.candidateId ? Candidates.byId(Number(d.candidateId)) : null;
  if (candidate && !canSeeCandidate(req.user, candidate.id)) return res.status(403).json({ error: 'You can only use candidates assigned to you.' });
  const request = app?.request_id ? Requests.byId(app.request_id) : d.requestId ? Requests.byId(Number(d.requestId)) : null;
  const cand = candidate || { full_name: String(d.candidateName || '').trim(), email: d.candidateEmail || null, phone: d.candidatePhone || null };
  const at = canonicalInstant(d.scheduledAt || '') || new Date(Date.now() + 86400000).toISOString();
  const iv = { id: 0, interview_no: '(assigned on save)', scheduled_at: at, duration_min: validDuration(d.durationMin) || 60,
    mode: IV_MODES.includes(d.mode) ? d.mode : 'onsite', interview_type: IV_TYPES.includes(d.interviewType) ? d.interviewType : 'technical', location_or_link: d.locationOrLink || '' };
  const panel = (Array.isArray(d.panel) ? d.panel : []).map((id) => Users.byId(Number(id))).filter(Boolean);
  const organizer = Users.byId(req.user.id);
  const base = globalTemplates()[kind];
  const msgs = {};
  const errors = {};
  for (const aud of AUDIENCES[kind]) {
    const m = (d.messages && d.messages[aud]) || {};
    msgs[aud] = { subject: m.subject !== undefined ? m.subject : base[aud].subject, body: m.body !== undefined ? m.body : base[aud].body };
    const e = (HAS_SUBJECT[aud] ? validateText(msgs[aud].subject, aud, 'subject') : null) || validateText(msgs[aud].body, aud, 'body');
    if (e) errors[aud] = e;
  }
  const v = (recipient) => messageValues({ iv, candidate: cand, request, organizer, panel, recipient, appUrl: appUrl() });
  const out = {
    candidate: { subject: fill(msgs.candidate.subject, v(null)), body: fill(msgs.candidate.body, v(null)), to: cand.email || null, reachable: EMAIL_OK(cand.email) },
    whatsapp: { body: fill(msgs.whatsapp.body, v(null)), phone: intlPhone(cand.phone) || cand.phone || null, valid: !!intlPhone(cand.phone), link: whatsappLink(cand.phone, fill(msgs.whatsapp.body, v(null))) },
    call: phoneCalls() ? { body: fill(msgs.call.body, v(null)), phone: intlPhone(cand.phone) || cand.phone || null, valid: !!intlPhone(cand.phone), tel: telLink(cand.phone) } : null,
    panel: panel.map((u) => ({ userId: u.id, name: u.full_name, to: u.email || null, reachable: EMAIL_OK(u.email), subject: fill(msgs.panel.subject, v(u)), body: fill(msgs.panel.body, v(u)) })),
  };
  res.json({ messages: msgs, preview: out, errors, when: cairoParts(at), detailsProblem: detailsProblem(iv), channel: channelStatus(kind) });
});

/* ---------------- DETAIL ---------------- */
router.get('/:id', (req, res) => {
  const iv = Interviews.byId(Number(req.params.id));
  if (!iv) return res.status(404).json({ error: 'Interview not found.' });
  if (!canViewInterview(req.user, iv)) return res.status(403).json({ error: 'You can only view interviews assigned to you.' });
  res.json({ interview: serialize(iv, req.user, { detail: true }) });
});

// Where an on-site interview can be held (owner, 12 Oct): Head Office or one of
// the company's active sites. The chosen place's name and address become the
// interview's location text, which {{where}} puts in every message.
export const HQ_SETTING = 'interview_head_office_address';
function interviewPlaces() {
  const hq = { key: 'hq', name: 'Head Office', address: SystemSettings.get(HQ_SETTING) || '' };
  const sites = dbAll(`SELECT s.id, s.name, s.location, p.name AS project FROM site s LEFT JOIN project p ON p.id = s.project_id
                       WHERE s.is_active = 1 AND s.status = 'active' ORDER BY s.name`)
    .map((r) => ({ key: `site:${r.id}`, name: r.name, address: r.location || '', project: r.project || null }));
  return [hq, ...sites];
}

// Phone calls are a later service (owner, 12 Oct): the "call" message and the
// Call hand-off exist but are offered only when this switch is on.
const phoneCalls = () => isEnabled('interview_phone_call');
const withoutCall = (auds) => (phoneCalls() ? auds : auds.filter((a) => a !== 'call'));

/* ---------------- MESSAGES for one interview ---------------- */
// For the people who arrange interviews (schedule/edit), not for panelists.
const canArrange = (u) => u.permissions.includes('interview.edit') || u.permissions.includes('interview.schedule');
function loadForMessages(req, res) {
  const iv = Interviews.byId(Number(req.params.id));
  if (!iv) { res.status(404).json({ error: 'Interview not found.' }); return null; }
  if (!canArrange(req.user) || !canViewInterview(req.user, iv)) { res.status(403).json({ error: 'You cannot manage this interview’s messages.' }); return null; }
  return iv;
}
const kindOf = (v, iv) => (KINDS.includes(v) ? v : iv.status === 'cancelled' ? 'cancel' : 'invite');

router.get('/:id/messages', (req, res) => {
  const iv = loadForMessages(req, res); if (!iv) return;
  const kind = kindOf(req.query.kind, iv);
  const { rendered, messages } = renderAll(iv, kind);
  const reach = recipients(iv, kind);
  res.json({ kind, messages, rendered, recipients: reach.list, whatsapp: { ...reach.whatsapp, link: whatsappLink(reach.whatsapp.phone, rendered.whatsapp.body), text: rendered.whatsapp.body },
    call: phoneCalls() ? { ...reach.call, script: rendered.call.body } : null,
    channel: channelStatus(kind), detailsProblem: kind === 'cancel' ? null : detailsProblem(iv), when: cairoParts(iv.scheduled_at),
    notice: (() => { try { return iv.notice_state ? JSON.parse(iv.notice_state) : null; } catch { return null; } })(),
    dispatches: dispatchesFor(iv.id) });
});

router.put('/:id/messages', requirePermission('interview.edit'), (req, res) => {
  const iv = loadForMessages(req, res); if (!iv) return;
  const d = req.body || {};
  if (!KINDS.includes(d.kind)) return res.status(400).json({ error: 'kind must be invite, update or cancel.' });
  const msgs = d.messages || {};
  for (const [aud, m] of Object.entries(msgs)) {
    if (!AUDIENCES[d.kind].includes(aud)) return res.status(400).json({ error: `Unknown recipient "${aud}".` });
    const e = (HAS_SUBJECT[aud] && m.subject !== undefined ? validateText(m.subject, aud, 'subject') : null) || validateText(m.body, aud, 'body');
    if (e) return res.status(400).json({ error: `${aud}: ${e}` });
  }
  saveMessages(iv, d.kind, msgs, req.user);
  writeAudit(req, { action: 'interview.messages_edited', entityType: 'interview', entityId: iv.id, newValue: { kind: d.kind, audiences: Object.keys(msgs) } });
  res.json({ messages: effectiveMessages(iv, d.kind) });
});

// Render unsaved edits for the preview pane; nothing is stored.
router.post('/:id/messages/preview', (req, res) => {
  const iv = loadForMessages(req, res); if (!iv) return;
  const d = req.body || {};
  const kind = kindOf(d.kind, iv);
  const current = effectiveMessages(iv, kind);
  const merged = {}; const errors = {};
  for (const aud of AUDIENCES[kind]) {
    const m = (d.messages && d.messages[aud]) || {};
    merged[aud] = { subject: m.subject !== undefined ? m.subject : current[aud].subject, body: m.body !== undefined ? m.body : current[aud].body };
    const e = (HAS_SUBJECT[aud] ? validateText(merged[aud].subject, aud, 'subject') : null) || validateText(merged[aud].body, aud, 'body');
    if (e) errors[aud] = e;
  }
  if (Object.keys(errors).length) return res.json({ errors, rendered: null });
  const { rendered } = renderAll(iv, kind, { messages: merged });
  res.json({ errors, rendered, whatsappLink: whatsappLink(Candidates.byId(iv.candidate_id)?.phone, rendered.whatsapp.body) });
});

router.post('/:id/send', requirePermission('interview.edit'), async (req, res) => {
  const iv = loadForMessages(req, res); if (!iv) return;
  const d = req.body || {};
  if (!KINDS.includes(d.kind)) return res.status(400).json({ error: 'kind must be invite, update, cancel or reminder.' });
  let batchKey = typeof d.batchKey === 'string' ? d.batchKey.trim().slice(0, 100) : '';
  if (d.kind === 'reminder') {
    // A reminder is for an interview still ahead (audit A7)…
    if (!['scheduled', 'rescheduled'].includes(iv.status) || !(Date.parse(iv.scheduled_at) > Date.now())) {
      return res.status(409).json({ code: 'interview_not_upcoming', error: 'A reminder can only be sent for an interview that is still ahead.' });
    }
    // …and goes at most once per recipient per Cairo day for this version:
    // the batch key is the day, so a second click (or a colleague's) replays
    // instead of sending again. A retry of failures keeps the caller's key.
    if (!d.retryFailed) batchKey = `reminder-${iv.id}-r${Number(iv.calendar_seq || 0)}-${new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' })}`;
  }
  if (!batchKey) return res.status(400).json({ error: 'A batchKey (one per send action) is required.' });
  if (d.kind === 'cancel' && iv.status !== 'cancelled') return res.status(409).json({ error: 'Cancel the interview before sending a cancellation.' });
  if (d.kind !== 'cancel' && !['scheduled', 'rescheduled'].includes(iv.status)) return res.status(409).json({ error: `This interview is ${iv.status}; only a scheduled interview’s invitation or update can be sent.` });
  if (d.kind !== 'cancel') { const p = detailsProblem(iv); if (p) return res.status(400).json({ error: p, code: 'details_incomplete' }); }
  if (!d.retryFailed && !d.candidate && !(Array.isArray(d.panel) && d.panel.length)) return res.status(400).json({ error: 'Choose at least one recipient.' });
  const r = await sendAction(Interviews.byId(iv.id), { kind: d.kind, batchKey, candidate: !!d.candidate, panel: d.panel || [], attachCv: d.attachCv || [], retryFailed: !!d.retryFailed, actor: req.user });
  if (r.nothingToRetry) return res.status(409).json({ error: 'There are no failed messages to retry for the current version of this interview.' });
  if (!r.replayed) {
    writeAudit(req, { action: 'interview.messages_sent', entityType: 'interview', entityId: iv.id,
      newValue: { kind: d.kind, batchKey, retry: !!d.retryFailed, summary: r.summary,
        recipients: r.rows.map((x) => ({ audience: x.audience, recipient: x.recipientName, status: x.status, attachCv: x.attachCv })) } });
  }
  res.json({ replayed: !!r.replayed, dispatches: r.rows, summary: r.summary || null, interview: serialize(Interviews.byId(iv.id), req.user, { detail: true }) });
});

// An explicit decision not to tell anyone about a change or cancellation.
router.post('/:id/notice/skip', requirePermission('interview.edit'), (req, res) => {
  const iv = loadForMessages(req, res); if (!iv) return;
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Give a reason for not sending this update.' });
  let n = null; try { n = iv.notice_state ? JSON.parse(iv.notice_state) : null; } catch { n = null; }
  if (!n || n.communicated) return res.status(409).json({ error: 'There is no pending change to skip.' });
  Interviews.setNotice(iv.id, { ...n, communicated: false, skipped: true, skippedAt: new Date().toISOString(), skippedBy: req.user.fullName, skipReason: reason });
  InterviewActivity.add(iv.id, req.user, 'notice_not_sent', reason);
  writeAudit(req, { action: 'interview.notice_skipped', entityType: 'interview', entityId: iv.id, newValue: { kind: n.kind }, comments: reason });
  res.json({ interview: serialize(Interviews.byId(iv.id), req.user, { detail: true }) });
});

router.post('/:id/whatsapp-handoff', requirePermission('interview.edit'), (req, res) => {
  const iv = loadForMessages(req, res); if (!iv) return;
  const d = req.body || {};
  const kind = kindOf(d.kind, iv);
  const batchKey = typeof d.batchKey === 'string' && d.batchKey.trim() ? d.batchKey.trim().slice(0, 100) : `wa-${iv.id}-${Date.now()}`;
  const r = recordWhatsappHandoff(iv, { kind, batchKey, actor: req.user });
  if (r.error) return res.status(400).json({ error: r.error });
  InterviewActivity.add(iv.id, req.user, 'whatsapp_opened', 'Opened in WhatsApp for sending by hand — not confirmed as sent');
  res.json({ link: r.link, text: r.text, dispatches: dispatchesFor(iv.id).filter((x) => x.batchKey === batchKey) });
});

/* ---------------- CANDIDATE'S ANSWER (audit A3, from GitHub PR #46) ----------------
   What the candidate said back by phone, WhatsApp or email, recorded by the
   people who arrange interviews so everyone can see who has confirmed. Only
   for an interview still to happen; moving the time resets it (they agreed to
   the old time, not the new one). "Declined" does not cancel anything. */
export const RESPONSES = ['pending', 'confirmed', 'change_requested', 'declined'];
const RESPONSE_WORDS = { pending: 'No answer yet', confirmed: 'Candidate confirmed', change_requested: 'Candidate asked for another time', declined: 'Candidate declined' };
router.post('/:id/response', (req, res) => {
  const iv = loadForMessages(req, res); if (!iv) return;
  const response = (req.body || {}).response;
  if (!RESPONSES.includes(response)) return res.status(400).json({ error: 'The answer must be one of: no answer yet, confirmed, wants another time, declined.' });
  if (!['scheduled', 'rescheduled'].includes(iv.status)) {
    return res.status(409).json({ code: 'interview_not_upcoming', error: 'The candidate\'s answer can only be recorded for an interview that is still to happen.' });
  }
  const before = iv.candidate_response || 'pending';
  if (before !== response) {
    Interviews.setCandidateResponse(iv.id, response);
    InterviewActivity.add(iv.id, req.user, 'candidate_response', RESPONSE_WORDS[response]);
    writeAudit(req, { action: 'interview.candidate_response', entityType: 'interview', entityId: iv.id, oldValue: { response: before }, newValue: { response } });
  }
  res.json({ interview: serialize(Interviews.byId(iv.id), req.user, { detail: true }) });
});

// A phone call made by a person (audit A11): recorded as a hand-off, never as
// "reached". The script is the call audience's text for this kind.
router.post('/:id/call-handoff', requirePermission('interview.edit'), (req, res) => {
  const iv = loadForMessages(req, res); if (!iv) return;
  const d = req.body || {};
  const kind = kindOf(d.kind, iv);
  const batchKey = typeof d.batchKey === 'string' && d.batchKey.trim() ? d.batchKey.trim().slice(0, 100) : `call-${iv.id}-${Date.now()}`;
  if (!phoneCalls()) return res.status(404).json({ code: 'feature_off', error: 'Phone calls from the Hub are not switched on yet.' });
  const r = recordCallHandoff(iv, { kind, batchKey, actor: req.user });
  if (r.error) return res.status(400).json({ error: r.error });
  InterviewActivity.add(iv.id, req.user, 'call_made', 'Phone call started by hand — not confirmed as reached');
  res.json({ tel: r.tel, script: r.script, dispatches: dispatchesFor(iv.id).filter((x) => x.batchKey === batchKey) });
});

router.get('/:id/dispatches', (req, res) => {
  const iv = loadForMessages(req, res); if (!iv) return;
  res.json({ dispatches: dispatchesFor(iv.id) });
});

/* ---------------- SCHEDULE ---------------- */
router.post('/', requirePermission('interview.schedule'), async (req, res) => {
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
  // Request and application state (awaiting approval, on hold, closed,
  // terminal application with the authorised override) — lib/interview-rules.js.
  const reqRow = requestId ? Requests.byId(requestId) : null;
  const blocked = schedulingGuard({ reqRow, app, user: req.user, body: d, action: 'schedule' });
  if (blocked) return res.status(blocked.status).json(blocked.body);
  const idempotencyKey = typeof d.idempotencyKey === 'string' && d.idempotencyKey.trim() ? d.idempotencyKey.trim().slice(0, 100) : null;
  const panelIds = panel.map((m) => Number(m.interviewerId));

  // Check and write in one transaction behind the booking lock, so two people
  // booking the same slot at once cannot both pass the check, and a repeated
  // submission (double click, network retry) returns the interview it made.
  let outcome;
  tx(() => {
    dbRun("UPDATE system_setting SET value=value WHERE key='interview_booking_lock'");
    const earlier = Interviews.byIdempotencyKey(idempotencyKey);
    if (earlier) { outcome = { replayed: earlier }; return; }
    const conflicts = evaluateConflicts({ start: scheduledAt, durationMin, panelIds, candidateId, location: d.locationOrLink });
    const refusal = conflictRefusal(conflicts, d);
    if (refusal) { outcome = { refusal }; return; }
    const overlapReason = conflicts.panel.length ? String(d.overlapReason).trim() : null;
    const interviewNo = Interviews.nextNo();
    const created = Interviews.create({
      interviewNo, applicationId: app ? app.id : null, candidateId, requestId,
      round: d.round || 1, interviewType: d.interviewType || 'technical', mode: d.mode || 'onsite',
      scheduledAt, durationMin, locationOrLink: d.locationOrLink,
      organizerId: req.user.id, status: 'scheduled', createdBy: req.user.id, idempotencyKey, overlapReason,
    });
    InterviewPanel.set(created.id, panel.map((m) => ({ interviewerId: Number(m.interviewerId), isLead: !!m.isLead })));
    InterviewActivity.add(created.id, req.user, 'scheduled', `${created.interview_type} interview scheduled`);
    if (overlapReason) InterviewActivity.add(created.id, req.user, 'panel_overlap_acknowledged', overlapReason);
    CandidateActivity.add({ candidateId, applicationId: app ? app.id : null, actorId: req.user.id, actorName: req.user.fullName, type: 'interview_scheduled', note: `${interviewNo} (${created.interview_type})` });
    if (requestId) Requests.stampLifecycle(requestId, 'first_interview_at'); // lifecycle: first interview scheduled
    writeAudit(req, { action: 'interview.scheduled', entityType: 'interview', entityId: created.id,
      newValue: { interviewNo, applicationId: app ? app.id : null, candidateId, requestId, standalone: !app, panel: panelIds,
        panelOverlap: conflicts.panel.length ? conflicts.panel.map((x) => x.interviewerId) : undefined },
      comments: d.overrideTerminal ? `Terminal-app override: ${d.overrideReason}` : (overlapReason ? `Panel overlap acknowledged: ${overlapReason}` : null) });
    const hoursW = workingHoursWarning(created.scheduled_at, created.duration_min);
    outcome = { created, warnings: conflicts.location.length || hoursW ? { ...(conflicts.location.length ? { location: conflicts.location.map(({ start, end }) => ({ start, end })) } : {}), ...(hoursW ? { hours: hoursW } : {}) } : null };
  });
  if (outcome.refusal) return res.status(outcome.refusal.status).json(outcome.refusal.body);
  if (outcome.replayed) {
    return res.status(200).json({ interview: serialize(outcome.replayed, req.user, { detail: true }), replayed: true, delivery: { state: 'not_requested' } });
  }
  const { created } = outcome;
  // NOTE: scheduling an interview does NOT change application.status. They are independent.
  // Invitations are an explicit act (audit 2026-10-06, decision 7): saving an
  // interview sends nothing unless the caller asks for it.
  let delivery = { state: 'not_requested' };
  if (d.sendInvitations) {
    // API convenience: send the invitation to the candidate and the whole
    // panel straight away (the screen previews first and sends explicitly).
    const fresh = Interviews.byId(created.id);
    const problem = detailsProblem(fresh);
    if (problem) delivery = { state: 'not_sent', reason: 'details_incomplete', message: problem };
    else {
      const r = await sendAction(fresh, { kind: 'invite', batchKey: `create-${created.id}`, candidate: true,
        panel: InterviewPanel.interviewerIds(created.id).map(Number), attachCv: [], actor: req.user });
      const cRow = r.rows.find((x) => x.audience === 'candidate');
      delivery = { state: cRow && ['accepted', 'dry_run'].includes(cRow.status) ? 'queued' : 'not_sent', to: cRow?.recipientAddress || null, reason: cRow?.reason || null, summary: r.summary, dispatches: r.rows };
    }
  }
  res.status(201).json({ interview: serialize(Interviews.byId(created.id), req.user, { detail: true }), delivery, warnings: outcome.warnings });
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
  // What would change. A "material" change is one the candidate or panel
  // must hear about: time, length, place/link, mode, or who sits on the panel.
  const panelBefore = InterviewPanel.interviewerIds(iv.id).map(Number);
  const newPanelIds = Array.isArray(d.panel) ? d.panel.map((m) => Number(m.interviewerId)) : panelBefore;
  const sameSet = (a, b) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));
  const next = {
    scheduledAt: scheduledAt || iv.scheduled_at,
    durationMin: durationMin || Number(iv.duration_min) || 60,
    locationOrLink: d.locationOrLink !== undefined ? String(d.locationOrLink ?? '') : (iv.location_or_link || ''),
    mode: d.mode || iv.mode,
  };
  const changes = [];
  if (new Date(next.scheduledAt).getTime() !== new Date(iv.scheduled_at).getTime()) changes.push('date_time');
  if (next.durationMin !== (Number(iv.duration_min) || 60)) changes.push('duration');
  if (next.locationOrLink.trim() !== String(iv.location_or_link || '').trim()) changes.push('location_or_link');
  if (next.mode !== iv.mode) changes.push('mode');
  if (!sameSet(newPanelIds, panelBefore)) changes.push('panel');
  const timing = changes.some((c) => ['date_time', 'duration', 'panel', 'location_or_link'].includes(c));

  // A material change re-applies the booking rules: request/application state
  // and conflicts (excluding this interview). Cancelling stays possible always.
  let warnings = null;
  let overlapReason = null;
  if (changes.length) {
    const reqRow = iv.request_id ? Requests.byId(iv.request_id) : null;
    const app = iv.application_id ? Applications.byId(iv.application_id) : null;
    const blocked = schedulingGuard({ reqRow, app, user: req.user, body: d, action: 'reschedule' });
    if (blocked) return res.status(blocked.status).json(blocked.body);
  }
  let refusal = null;
  tx(() => {
    if (timing) {
      dbRun("UPDATE system_setting SET value=value WHERE key='interview_booking_lock'");
      const conflicts = evaluateConflicts({ start: next.scheduledAt, durationMin: next.durationMin, panelIds: newPanelIds,
        candidateId: iv.candidate_id, location: next.locationOrLink, excludeId: iv.id });
      refusal = conflictRefusal(conflicts, d);
      if (refusal) return;
      if (conflicts.panel.length) overlapReason = String(d.overlapReason).trim();
      if (conflicts.location.length) warnings = { location: conflicts.location.map(({ start, end }) => ({ start, end })) };
    }
    const before = { scheduledAt: iv.scheduled_at, durationMin: iv.duration_min, mode: iv.mode, locationOrLink: iv.location_or_link };
    const rescheduled = changes.includes('date_time');
    const updated = Interviews.update(iv.id, { ...d, scheduledAt, durationMin });
    let added = []; let removed = [];
    if (Array.isArray(d.panel)) {
      InterviewPanel.set(iv.id, d.panel.map((m) => ({ interviewerId: Number(m.interviewerId), isLead: !!m.isLead })));
      const panelAfter = InterviewPanel.interviewerIds(iv.id).map(Number);
      added = panelAfter.filter((x) => !panelBefore.includes(x));
      removed = panelBefore.filter((x) => !panelAfter.includes(x));
      if (added.length || removed.length) {
        InterviewActivity.add(iv.id, req.user, 'panel_changed');
        writeAudit(req, { action: 'interview.panel_changed', entityType: 'interview', entityId: iv.id, oldValue: { panel: panelBefore }, newValue: { panel: panelAfter } });
      }
    }
    if (overlapReason) {
      Interviews.setOverlapReason(iv.id, overlapReason);
      InterviewActivity.add(iv.id, req.user, 'panel_overlap_acknowledged', overlapReason);
    }
    // The candidate agreed to the old time, not the new one (audit A3).
    if (rescheduled && (iv.candidate_response || 'pending') !== 'pending') {
      Interviews.setCandidateResponse(iv.id, 'pending');
      InterviewActivity.add(iv.id, req.user, 'candidate_response', 'Answer reset to "No answer yet" — the time changed');
    }
    if (rescheduled) { Interviews.setStatus(iv.id, 'rescheduled'); { const p = cairoParts(scheduledAt); InterviewActivity.add(iv.id, req.user, 'rescheduled', `Moved to ${p.date}, ${p.time} (${p.timezone})`); } }
    else if (!added.length && !removed.length) InterviewActivity.add(iv.id, req.user, 'updated');
    if (changes.length) {
      // The calendar entry's revision rises; its UID never changes. What
      // changed is kept until it has been communicated (or explicitly not).
      const prevNotice = (() => { try { return iv.notice_state ? JSON.parse(iv.notice_state) : null; } catch { return null; } })();
      const carry = prevNotice && prevNotice.kind === 'update' && !prevNotice.communicated ? prevNotice : null;
      Interviews.setNotice(iv.id, {
        kind: 'update', communicated: false, at: new Date().toISOString(),
        changes: [...new Set([...(carry?.changes || []), ...changes])],
        addedPanel: [...new Set([...(carry?.addedPanel || []), ...added])].filter((x) => !removed.includes(x)),
        removedPanel: [...new Set([...(carry?.removedPanel || []), ...removed])].filter((x) => !added.includes(x)),
        // What the people being told last heard, for the update message.
        previous: carry?.previous || before,
      }, { bumpSeq: true });
    }
    writeAudit(req, { action: 'interview.updated', entityType: 'interview', entityId: iv.id, oldValue: before,
      newValue: { scheduledAt: updated.scheduled_at, durationMin: updated.duration_min, mode: updated.mode, locationOrLink: updated.location_or_link, rescheduled, changes },
      comments: overlapReason ? `Panel overlap acknowledged: ${overlapReason}` : null });
  });
  if (refusal) return res.status(refusal.status).json(refusal.body);
  { const after = Interviews.byId(iv.id); const hw = workingHoursWarning(after.scheduled_at, after.duration_min); if (hw) warnings = { ...(warnings || {}), hours: hw }; }
  res.json({ interview: serialize(Interviews.byId(iv.id), req.user, { detail: true }), changes, warnings });
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
  if (['completed', 'no_show'].includes(status) && ['scheduled', 'rescheduled'].includes(iv.status)) {
    const early = attendanceRefusal(iv, status);
    if (early) return res.status(early.status).json(early.body);
  }
  // A No-Show is the attendance record (audit A8): it is not overwritten by a
  // cancellation. Reopening it first is the deliberate, audited route.
  if (status === 'cancelled' && iv.status === 'no_show') {
    return res.status(409).json({ code: 'no_show_recorded', error: 'This interview is recorded as a No-Show, which is kept as the attendance record. Reopen it first if it should be cancelled instead.' });
  }
  if (status === 'scheduled' && ['completed', 'no_show'].includes(iv.status)) {
    // Reopening returns the interview to the schedule, so the request and
    // application must still allow scheduling; a future slot must still be free.
    const blocked = schedulingGuard({ reqRow: iv.request_id ? Requests.byId(iv.request_id) : null,
      app: iv.application_id ? Applications.byId(iv.application_id) : null, user: req.user, body: req.body || {}, action: 'reopen' });
    if (blocked) return res.status(blocked.status).json(blocked.body);
    if (new Date(iv.scheduled_at).getTime() > Date.now()) {
      const refusal = conflictRefusal(evaluateConflicts({ start: iv.scheduled_at, durationMin: iv.duration_min,
        panelIds: InterviewPanel.interviewerIds(iv.id).map(Number), candidateId: iv.candidate_id, excludeId: iv.id }), req.body || {});
      if (refusal) return res.status(refusal.status).json(refusal.body);
    }
  }
  Interviews.setStatus(iv.id, status, status === 'cancelled' ? { cancel_reason: reason } : {});
  if (status === 'cancelled') {
    // The cancellation is a new calendar revision, still to be communicated.
    Interviews.setNotice(iv.id, { kind: 'cancel', communicated: false, at: new Date().toISOString() }, { bumpSeq: true });
  }
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
  // Feedback describes an interview that took place (audit A5).
  if (['cancelled', 'no_show'].includes(iv.status)) {
    return res.status(409).json({ code: 'interview_not_held', error: iv.status === 'no_show' ? 'The candidate did not attend this interview, so there is nothing to give feedback on.' : 'This interview was cancelled, so there is nothing to give feedback on.' });
  }
  if (iv.status !== 'completed') {
    const early = attendanceRefusal(iv, 'feedback');
    if (early) return res.status(early.status).json(early.body);
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
    places: interviewPlaces(),
  });
});

export default router;
