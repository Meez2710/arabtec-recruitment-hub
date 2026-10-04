// Candidate visibility follows assignment scope (AR-01).
//
// Broad roles — anyone who can see every hiring request or every interview, or
// who adds candidates to the Talent Pool (HR, recruitment, full-view roles) —
// see every candidate, exactly as before.
//
// Everyone else who holds candidate.view (Technical Interviewer, Hiring
// Manager, Project Manager) sees only candidates they are actually connected to:
//   • on a hiring request they requested, own or created; or
//   • in an interview they organise or sit on (requires interview.view_assigned).
// For those candidates, nested request/application metadata is limited to the
// same connections, so one shared candidate cannot reveal an unrelated request.
import { all, get } from './db.js';

const BROAD = ['request.view_all', 'interview.view_all', 'candidate.add'];
const has = (user, p) => (user?.permissions || []).includes(p);

export function hasBroadCandidateAccess(user) {
  return BROAD.some((p) => has(user, p));
}

const OWNS_REQUEST = '(r.requester_id = ? OR r.owner_id = ? OR r.created_by = ?)';
const ON_PANEL = '(i.organizer_id = ? OR EXISTS (SELECT 1 FROM interview_panel ip WHERE ip.interview_id = i.id AND ip.interviewer_id = ?))';

/**
 * The same boundary as a SQL fragment over a candidate id column, for code that
 * queries candidates directly (e.g. the anyhelp assistant tools). Returns
 * [whereSql, params]; broad users get ['1=1', []].
 */
export function candidateScopeClause(user, column = 'id') {
  if (hasBroadCandidateAccess(user)) return ['1=1', []];
  const u = user.id;
  const parts = [`${column} IN (SELECT a.candidate_id FROM application a JOIN recruitment_request r ON r.id = a.request_id WHERE ${OWNS_REQUEST})`];
  const params = [u, u, u];
  if (has(user, 'interview.view_assigned')) {
    parts.push(`${column} IN (SELECT i.candidate_id FROM interview i WHERE ${ON_PANEL})`);
    params.push(u, u);
  }
  return [`(${parts.join(' OR ')})`, params];
}

/** Candidate ids a scoped user may see; null means "all" (broad access). */
export function visibleCandidateIds(user) {
  if (hasBroadCandidateAccess(user)) return null;
  const u = user.id;
  const ids = new Set(all(
    `SELECT DISTINCT a.candidate_id AS id FROM application a JOIN recruitment_request r ON r.id = a.request_id WHERE ${OWNS_REQUEST}`,
    [u, u, u],
  ).map((r) => Number(r.id)));
  if (has(user, 'interview.view_assigned')) {
    for (const r of all(`SELECT DISTINCT i.candidate_id AS id FROM interview i WHERE ${ON_PANEL}`, [u, u])) ids.add(Number(r.id));
  }
  return [...ids];
}

export function canSeeCandidate(user, candidateId) {
  if (hasBroadCandidateAccess(user)) return true;
  const id = Number(candidateId);
  const u = user.id;
  if (get(`SELECT 1 AS ok FROM application a JOIN recruitment_request r ON r.id = a.request_id WHERE a.candidate_id = ? AND ${OWNS_REQUEST} LIMIT 1`, [id, u, u, u])) return true;
  if (has(user, 'interview.view_assigned')
    && get(`SELECT 1 AS ok FROM interview i WHERE i.candidate_id = ? AND ${ON_PANEL} LIMIT 1`, [id, u, u])) return true;
  return false;
}

/**
 * Filter for nested application/request metadata of a visible candidate.
 * Returns (application row) => boolean; broad users see everything.
 */
export function applicationScopeFilter(user) {
  if (hasBroadCandidateAccess(user)) return () => true;
  const u = user.id;
  const ownedRequests = new Set(all(`SELECT r.id AS id FROM recruitment_request r WHERE ${OWNS_REQUEST}`, [u, u, u]).map((r) => Number(r.id)));
  const assignedApps = new Set(has(user, 'interview.view_assigned')
    ? all(`SELECT DISTINCT i.application_id AS id FROM interview i WHERE i.application_id IS NOT NULL AND ${ON_PANEL}`, [u, u]).map((r) => Number(r.id))
    : []);
  return (a) => ownedRequests.has(Number(a.request_id)) || assignedApps.has(Number(a.id));
}
