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
import { Interviews, InterviewPanel } from './models.js';
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
