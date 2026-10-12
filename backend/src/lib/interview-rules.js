// Interview booking rules shared by create, reschedule, reopen and the
// availability check (audit 2026-10-06, INTERVIEW_IMPLEMENTATION_BRIEF.md).
//
// One place decides:
//   • whether the hiring request / application allows scheduling at all
//     (awaiting approval — owner decision Q-05; on hold — Q-01; closed or
//     terminal — earlier audit, with the authorised override kept);
//   • which existing interviews conflict with a proposed slot
//     (candidate = block; shared panelist = acknowledged reason; identical
//     location/link = warning).
// The routes only call these, so the check shown before saving and the check
// made at save time cannot disagree.
import { Interviews, InterviewPanel, SystemSettings } from './models.js';
import { APP_TERMINAL, APP_LABELS, appNorm, REQ, REQ_TERMINAL, REQ_LABELS, reqNorm } from './stages.js';
import { ACTIVE_STATUSES, MAX_DURATION_MIN, intervalOf, findPanelClashes, findCandidateConflicts, findLocationOverlaps } from './interview-clashes.js';

const VERB = { schedule: 'Interview scheduling', reschedule: 'Rescheduling', reopen: 'Reopening this interview' };
const ref = (r) => (r.ticket_no ? `hiring request ${r.ticket_no}` : 'the hiring request');

/**
 * May this action proceed for this request/application? Returns null, or
 * { status, body } to send. `body` (the request body) may carry the existing
 * terminal override: overrideTerminal + overrideReason, needing candidate.merge.
 */
export function schedulingGuard({ reqRow, app, user, body = {}, action = 'schedule' }) {
  const verb = VERB[action] || VERB.schedule;
  const perms = user?.permissions || [];
  const overrideAsked = !!body.overrideTerminal;
  const overrideOk = overrideAsked && perms.includes('candidate.merge') && !!(body.overrideReason && String(body.overrideReason).trim());
  const overrideError = () => (!perms.includes('candidate.merge')
    ? { status: 403, body: { error: 'You are not permitted to override scheduling for this request or application.' } }
    : { status: 400, body: { error: 'A reason is required to override.' } });

  if (app && APP_TERMINAL.includes(appNorm(app.status))) {
    if (!overrideAsked) {
      const label = APP_LABELS[appNorm(app.status)] || app.status;
      return { status: 409, body: { error: action === 'schedule' ? `Cannot schedule an interview for an application that is ${label}.` : `${verb} is unavailable for an application that is ${label}.`, applicationStatus: appNorm(app.status) } };
    }
    if (!overrideOk) return overrideError();
  }
  if (!reqRow) return null;
  const st = reqNorm(reqRow.status);
  if (st === REQ.PENDING) {
    // Owner decision Q-05: before approval, candidates may be matched and
    // shortlisted, but formal interviews wait for the decision. No override:
    // approval is the gate itself.
    return { status: 409, body: { code: 'request_awaiting_approval', requestStatus: st,
      error: `${verb} is unavailable because ${ref(reqRow)} is awaiting approval. Candidates can be matched and shortlisted now; interviews can be scheduled once it is approved.` } };
  }
  if (st === REQ.ON_HOLD) {
    return { status: 409, body: { requestStatus: 'on_hold',
      error: `${verb} is unavailable because ${ref(reqRow)} is currently On Hold. It resumes when the request is resumed.` } };
  }
  if (REQ_TERMINAL.includes(st) && !overrideOk) {
    if (overrideAsked) return overrideError();
    return { status: 409, body: { requestStatus: st,
      error: `${ref(reqRow).replace(/^h/, 'H')} is ${REQ_LABELS[st] || st}; interviews for it are no longer scheduled.` } };
  }
  return null;
}

/**
 * Conflicts for a proposed slot.
 * @returns {{ candidate: object[], panel: object[], location: object[] }}
 */
export function evaluateConflicts({ start, durationMin, panelIds = [], candidateId = null, location = '', excludeId = null }) {
  const wanted = intervalOf(start, durationMin);
  if (!wanted) return { candidate: [], panel: [], location: [] };
  const from = new Date(wanted.start - MAX_DURATION_MIN * 60000).toISOString();
  const to = new Date(wanted.end).toISOString();
  const existing = Interviews.activeBetween(from, to, ACTIVE_STATUSES).map((iv) => ({
    id: iv.id, status: iv.status, scheduledAt: iv.scheduled_at, durationMin: iv.duration_min,
    candidateId: iv.candidate_id, locationOrLink: iv.location_or_link, interviewNo: iv.interview_no,
    panel: InterviewPanel.forInterview(iv.id).map((m) => ({ id: m.interviewer_id, name: m.full_name })),
  }));
  const proposal = { start, durationMin, panel: panelIds, candidateId, location, excludeId };
  return {
    candidate: findCandidateConflicts(proposal, existing),
    panel: findPanelClashes(proposal, existing),
    location: findLocationOverlaps(proposal, existing),
  };
}

/**
 * Turn conflicts into the save-time decision: null to proceed, or
 * { status, body } to refuse. Candidate overlap always refuses; a shared
 * panelist needs ackPanelOverlap + overlapReason.
 */
export function conflictRefusal(conflicts, body = {}) {
  if (conflicts.candidate.length) {
    return { status: 409, body: { code: 'candidate_conflict',
      error: 'The candidate already has an interview at an overlapping time. Choose another time; one person cannot attend two interviews at once.',
      conflicts: conflicts.candidate.map(({ start, end }) => ({ start, end })) } };
  }
  if (conflicts.panel.length) {
    const reason = typeof body.overlapReason === 'string' ? body.overlapReason.trim() : '';
    if (!body.ackPanelOverlap) {
      return { status: 409, body: { code: 'panel_conflict',
        error: 'A panel member is already booked at an overlapping time. Confirm the overlap and give a reason to save anyway.',
        clashes: conflicts.panel.map(({ interviewerId, name, start, end }) => ({ interviewerId, name, start, end })) } };
    }
    if (!reason) return { status: 400, body: { error: 'Give a reason for booking a panel member who is already busy at this time.' } };
    if (reason.length > 500) return { status: 400, body: { error: 'The overlap reason is too long (500 characters at most).' } };
  }
  return null;
}

/* ------------------------------------------------------------------------
 * Attendance and feedback describe an interview that has happened
 * (audit 2026-10-12, findings A4/A5). Completed, No-Show and feedback open at
 * a moment derived from the start; before it, the routes refuse with
 * `interview_not_started` and the UI hides the buttons. One rule, shared by
 * the routes and by serialize(), so the UI and the server cannot disagree.
 * --------------------------------------------------------------------- */
export const ATTENDANCE_ACTIONS = ['completed', 'no_show', 'feedback'];

/**
 * When may `action` ('completed' | 'no_show' | 'feedback') first be recorded
 * for this interview? Returns epoch milliseconds. `iv.scheduled_at` is the
 * start (ISO, UTC); `iv.duration_min` its length in minutes.
 */
// Owner rules (12 Oct 2026): Completed from the scheduled END; No-Show 15
// minutes after the start (a late candidate is not marked absent); feedback
// from the start. A missing or unreadable start or duration returns NaN,
// which attendanceRefusal() REFUSES — bad data never bypasses the guard.
export const NO_SHOW_AFTER_MIN = 15;
export function attendanceOpensAt(iv, action) {
  const start = Date.parse(iv?.scheduled_at ?? '');
  if (!Number.isFinite(start)) return NaN;
  if (action === 'feedback') return start;
  if (action === 'no_show') return start + NO_SHOW_AFTER_MIN * 60000;
  if (action === 'completed') {
    const dur = Number(iv.duration_min);
    return Number.isFinite(dur) && dur > 0 ? start + dur * 60000 : NaN;
  }
  return NaN; // an unknown action is never open
}

const cairoClock = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
const ACTION_WORD = { completed: 'mark it Completed', no_show: 'mark it No-Show', feedback: 'add feedback' };

/** null to proceed, or { status, body } refusing an action that is not open yet. */
export function attendanceRefusal(iv, action, now = Date.now()) {
  const opens = attendanceOpensAt(iv, action);
  if (!Number.isFinite(opens)) {
    return { status: 409, body: { code: 'interview_time_invalid',
      error: 'This interview has no valid date, time or length, so it cannot be marked or given feedback. Reschedule it with a correct time first.' } };
  }
  if (now >= opens) return null;
  return { status: 409, body: { code: 'interview_not_started', opensAt: new Date(opens).toISOString(),
    error: `This interview has not happened yet. You can ${ACTION_WORD[action]} from ${cairoClock(opens)} (Cairo time).` } };
}

/** { completed, no_show, feedback } → ISO instant each action opens, for the UI. */
export function actionsOpenAt(iv) {
  const out = {};
  for (const a of ATTENDANCE_ACTIONS) { const ms = attendanceOpensAt(iv, a); if (Number.isFinite(ms)) out[a] = new Date(ms).toISOString(); }
  return out;
}

/* ------------------------------------------------------------------------
 * Working week (audit A9). A booking outside the organisation's working
 * days or hours is WARNED about, never refused. Default until the owner
 * decides (D1): Sunday–Thursday, 09:00–17:00 Cairo time; adjustable in
 * Invitation templates (setting interview_working_week).
 * --------------------------------------------------------------------- */
export const WORK_WEEK_SETTING = 'interview_working_week';
export const DEFAULT_WORK_WEEK = { days: [0, 1, 2, 3, 4], start: '09:00', end: '17:00' };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** A valid working week, or the reason it is not. */
export function validateWorkWeek(ww) {
  if (!ww || typeof ww !== 'object') return 'The working week must be an object.';
  if (!Array.isArray(ww.days) || !ww.days.length || ww.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Choose at least one working day.';
  if (!HHMM.test(ww.start || '') || !HHMM.test(ww.end || '')) return 'Working hours must be times like 09:00.';
  if (toMin(ww.start) >= toMin(ww.end)) return 'The working day must end after it starts.';
  return null;
}
export function workingWeek(raw = SystemSettings.get(WORK_WEEK_SETTING)) {
  try { const ww = JSON.parse(raw || 'null'); if (ww && !validateWorkWeek(ww)) return { days: [...new Set(ww.days)].sort(), start: ww.start, end: ww.end }; } catch { /* default */ }
  return { ...DEFAULT_WORK_WEEK };
}

function cairoDayMin(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), min: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** null, or { reason, message } when the slot falls outside the working week. */
export function workingHoursWarning(start, durationMin, ww = workingWeek()) {
  const s = Date.parse(start); const dur = Number(durationMin) || 60;
  if (!Number.isFinite(s)) return null;
  const a = cairoDayMin(s); const b = cairoDayMin(s + dur * 60000);
  if (!ww.days.includes(a.day)) return { reason: 'non_working_day', message: `${DAY_NAMES[a.day]} is not a working day.` };
  if (a.min < toMin(ww.start)) return { reason: 'before_hours', message: `Starts before ${ww.start} (Cairo time), the start of the working day.` };
  if (b.day !== a.day || b.min > toMin(ww.end)) return { reason: 'after_hours', message: `Ends after ${ww.end} (Cairo time), the end of the working day.` };
  return null;
}
