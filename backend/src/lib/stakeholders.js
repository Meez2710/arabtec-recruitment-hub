// Request stakeholders and the decisions they may take (recruitment team, 25 Oct 2026).
//
// A hiring manager and the technical interviewers meet a candidate at
// Shortlisted — the first stage they can see. From there they take exactly
// three decisions on that candidate, without holding candidate.move_stage:
//
//   Move to Interview   → interviewing
//   On Hold             → on_hold   (reason required, as for everyone)
//   Disqualify          → rejected  (reason required, as for everyone)
//
// Who counts: the hiring manager named on the request, and anyone with
// interview.feedback who sits on an interview panel for that request. The
// recruitment team (candidate.move_stage) is not a "stakeholder" here — it has
// the whole board and gets no special buttons.
import { get } from './db.js';
import { Requests } from './models.js';
import { APP, appNorm } from './stages.js';

export const STAKEHOLDER_DECISIONS = [APP.INTERVIEWING, APP.ON_HOLD, APP.REJECTED];
const has = (user, p) => (user?.permissions || []).includes(p);

export const isRequestHiringManager = (user, r) =>
  !!(user?.id && r?.hiring_manager_id && Number(r.hiring_manager_id) === Number(user.id));

/** On the panel of any interview held for this request (request-level or for one of its applications). */
export function isRequestInterviewer(userId, requestId) {
  if (!userId || !requestId) return false;
  return !!get(`SELECT 1 AS x FROM interview_panel ip JOIN interview i ON i.id = ip.interview_id
                 LEFT JOIN application a ON a.id = i.application_id
                WHERE ip.interviewer_id = ? AND (i.request_id = ? OR a.request_id = ?) LIMIT 1`,
  [userId, requestId, requestId]);
}

export function isRequestStakeholder(user, r) {
  if (!user || !r) return false;
  return isRequestHiringManager(user, r) || (has(user, 'interview.feedback') && isRequestInterviewer(user.id, r.id));
}

/**
 * The stage keys this user may move this application to as a stakeholder.
 * Empty for the recruitment team (they move anything), for any stage other
 * than Shortlisted, and for anyone not connected to the request.
 */
export function stakeholderDecisions(user, app, request) {
  if (!user || !app || has(user, 'candidate.move_stage')) return [];
  if (appNorm(app.status) !== APP.SHORTLISTED) return [];
  const r = request || (app.request_id ? Requests.byId(app.request_id) : null);
  if (!r || !isRequestStakeholder(user, r)) return [];
  return [...STAKEHOLDER_DECISIONS];
}
