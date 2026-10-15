// Candidate visibility follows assignment scope (AR-01).
//
// CV RULE (owner direction, 15 Oct 2026): CVs are for HR. Outside HR, a person
// sees a candidate — profile, CV, thread CV posts — only when BOTH hold:
//   • they are on that specific hiring request: the named hiring manager, the
//     requester / owner / creator, or the panel of that candidate's interview;
//   • recruitment has released the candidate on it: Shortlisted or later
//     (pipeline-visibility.js). Sourcing stays private.
//
// Broad (every request): the full-pipeline roles — System Admin, CEO (view
// only), HR Director, Recruitment Manager, Recruiter — and HR roles that source
// candidates (candidate.add: HR Manager). Seeing every request
// (request.view_all / interview.view_all) no longer counts on its own: it made a
// read-only Viewer broad, which exposed every shortlisted CV on every request.
// For those candidates, nested request/application metadata is limited to the
// same connections, so one shared candidate cannot reveal an unrelated request.
import { all, get } from './db.js';
import { applicationVisibilitySql, canSeeApplicationStage, hasFullPipelineAccess } from './pipeline-visibility.js';

const BROAD = ['candidate.add'];
const has = (user, p) => (user?.permissions || []).includes(p);

export function hasBroadCandidateAccess(user) {
  return hasFullPipelineAccess(user) || BROAD.some((p) => has(user, p));
}

// "On the request": the named hiring manager counts too (it already did for the
// request thread; candidate scope had left it out).
const OWNS_REQUEST = '(r.requester_id = ? OR r.owner_id = ? OR r.created_by = ? OR r.hiring_manager_id = ?)';
const ON_PANEL = '(i.organizer_id = ? OR EXISTS (SELECT 1 FROM interview_panel ip WHERE ip.interview_id = i.id AND ip.interviewer_id = ?))';

export function applicationScopeClause(user, alias = 'a') {
  const stage = applicationVisibilitySql(user, alias);
  if (hasBroadCandidateAccess(user)) return [stage, []];
  const parts = [`${alias}.request_id IN (SELECT r.id FROM recruitment_request r WHERE ${OWNS_REQUEST})`];
  const params = [user.id, user.id, user.id, user.id];
  if (has(user, 'interview.view_assigned')) {
    parts.push(`${alias}.id IN (SELECT i.application_id FROM interview i WHERE ${ON_PANEL})`);
    params.push(user.id, user.id);
  }
  return [`((${parts.join(' OR ')}) AND ${stage})`, params];
}

/**
 * The same boundary as a SQL fragment over a candidate id column, for code that
 * queries candidates directly (e.g. the anyhelp assistant tools). Returns
 * [whereSql, params]; broad users get ['1=1', []].
 */
export function candidateScopeClause(user, column = 'id') {
  const broad = hasBroadCandidateAccess(user);
  if (broad && hasFullPipelineAccess(user)) return ['1=1', []];
  const u = user.id;
  const stage = applicationVisibilitySql(user);
  const parts = [`${column} IN (SELECT a.candidate_id FROM application a JOIN recruitment_request r ON r.id = a.request_id WHERE ${broad ? '1=1' : OWNS_REQUEST} AND ${stage})`];
  const params = broad ? [] : [u, u, u, u];
  if (has(user, 'interview.view_assigned')) {
    parts.push(`${column} IN (SELECT i.candidate_id FROM interview i JOIN application a ON a.id=i.application_id WHERE ${ON_PANEL} AND ${stage})`);
    params.push(u, u);
  }
  return [`(${parts.join(' OR ')})`, params];
}

/** Candidate ids a scoped user may see; null means "all" (broad access). */
export function visibleCandidateIds(user) {
  const [where, params] = candidateScopeClause(user, 'c.id');
  if (where === '1=1') return null;
  return all(`SELECT c.id FROM candidate c WHERE ${where}`, params).map((r) => Number(r.id));
}

export function canSeeCandidate(user, candidateId) {
  const [where, params] = candidateScopeClause(user, 'c.id');
  return !!get(`SELECT 1 AS ok FROM candidate c WHERE c.id=? AND ${where} LIMIT 1`, [Number(candidateId), ...params]);
}

/**
 * Filter for nested application/request metadata of a visible candidate.
 * Returns (application row) => boolean; broad users see everything.
 */
export function applicationScopeFilter(user) {
  if (hasBroadCandidateAccess(user)) return (a) => !a.id || canSeeApplicationStage(user, a);
  const u = user.id;
  const ownedRequests = new Set(all(`SELECT r.id AS id FROM recruitment_request r WHERE ${OWNS_REQUEST}`, [u, u, u, u]).map((r) => Number(r.id)));
  const assignedApps = new Set(has(user, 'interview.view_assigned')
    ? all(`SELECT DISTINCT i.application_id AS id FROM interview i WHERE i.application_id IS NOT NULL AND ${ON_PANEL}`, [u, u]).map((r) => Number(r.id))
    : []);
  return (a) => (ownedRequests.has(Number(a.request_id)) || assignedApps.has(Number(a.id)))
    && (!a.id || canSeeApplicationStage(user, a));
}
