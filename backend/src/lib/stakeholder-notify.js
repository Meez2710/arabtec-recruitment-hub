// Tell the recruitment team what hiring managers and interviewers do
// (recruitment team request, 25 Oct 2026).
//
// Recruitment runs the request; the hiring manager and the panel act on it
// from outside the recruitment roles. Every such action — a decision on a
// shortlisted candidate, a message or file in the request conversation,
// interview feedback, an assessment — reaches the request's recruiter and the
// recruitment team, through the catalogued events below, which the Control
// Center can tune like any other. Actions BY the recruitment team itself are
// not announced to the recruitment team.
import { Requests, Candidates, Users } from './models.js';
import { notifyEvent } from './notify.js';
import { hasFullPipelineAccess } from './pipeline-visibility.js';

export const STAKEHOLDER_EVENTS = {
  decision: 'stakeholder.decision',
  reply: 'stakeholder.reply',
  feedback: 'stakeholder.feedback',
  recommendation: 'stakeholder.recommendation',
};

/** True when `user` is outside the recruitment roles — a hiring manager, interviewer, PM… */
export const isStakeholderActor = (user) => !!user && !hasFullPipelineAccess(user);

const safe = (fn) => { try { return fn(); } catch { return null; } };
const roleWord = (user) => {
  const roles = user?.roles || [];
  if (roles.includes('hiring_manager')) return 'Hiring manager';
  if (roles.includes('interviewer') || roles.includes('technical_interviewer')) return 'Interviewer';
  if (roles.includes('project_manager')) return 'Project manager';
  return 'Stakeholder';
};

/**
 * Notify the request's recruiter and the recruitment team about something a
 * stakeholder did. Returns notifyEvent's result, or null when the actor is a
 * recruitment user (nothing to announce) or the request is unknown.
 *
 * @param {'decision'|'reply'|'feedback'} kind
 * @param {object} o  { req, requestId, candidateId?, applicationId?, what, detail?, linkType?, linkId? }
 *   what    — short verb phrase, e.g. "moved Ali Hassan to Interview", "replied in the conversation"
 *   detail  — optional second sentence (the message excerpt, the reason, the recommendation)
 */
export function notifyRecruitment(kind, o) {
  const user = o?.req?.user;
  if (!isStakeholderActor(user)) return null;
  const eventKey = STAKEHOLDER_EVENTS[kind];
  if (!eventKey) return null;
  const r = safe(() => (o.request || (o.requestId ? Requests.byId(Number(o.requestId)) : null)));
  if (!r) return null;
  const candidate = o.candidateId ? safe(() => Candidates.byId(Number(o.candidateId))) : null;
  const who = `${roleWord(user)} ${user.fullName || ''}`.trim();
  const title = `${who} ${o.what} — ${r.ticket_no}`;
  const body = [`${who} ${o.what} on ${r.title} (${r.ticket_no}).`, o.detail ? String(o.detail).slice(0, 400) : null].filter(Boolean).join(' ');
  return safe(() => notifyEvent(eventKey, {
    actor: user,
    owner: r.owner_id ? Users.byId(r.owner_id) : null,
    requester: r.requester_id ? Users.byId(r.requester_id) : null,
    hiringManager: r.hiring_manager_id ? Users.byId(r.hiring_manager_id) : null,
    candidate: null,                       // never the candidate: this is internal
    linkType: o.linkType || 'request', linkId: o.linkId || r.id,
    vars: { ticketNo: r.ticket_no, position: r.title, candidateName: candidate ? candidate.full_name : null, actorName: user.fullName, what: o.what },
    title, body,
  }));
}
