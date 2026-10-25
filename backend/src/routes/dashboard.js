// Phase 6 — Dashboards (read-only analytics).
// Aggregates KPIs from requests/applications/interviews/offers built in prior phases.
// Role-scoped: request.view_all → org-wide; request.view_own → only the user's own
// requests (owned/requested/created). NO salary or other restricted field is ever returned.
import { Router } from 'express';
import { all, get } from '../lib/db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { applicationVisibilitySql } from '../lib/pipeline-visibility.js';

const router = Router();
router.use(requireAuth, requirePermission('dashboard.view'));

// Build a WHERE fragment + params restricting to the user's request scope.
function requestScope(user, col = 'id') {
  if (user.permissions.includes('request.view_all')) return { where: '1=1', params: [] };
  // own scope
  return {
    where: `${col} IN (SELECT id FROM recruitment_request WHERE owner_id=? OR requester_id=? OR created_by=? OR hiring_manager_id=?)`,
    params: [user.id, user.id, user.id, user.id],
  };
}

// Simplified workflow (Phase 0). Legacy values kept too so any un-migrated rows still count.
const NON_TERMINAL_REQ = ['pending_approval', 'sourcing', 'in_progress', 'partially_filled', 'on_hold', 'reopened',
  'draft', 'budget_validation', 'approved', 'in_sourcing'];

// Optional narrowing for the director's "full picture → drill down":
// ?projectId=&departmentId=&ownerId= restrict every figure to the requests that
// match (and to the applications, interviews and offers on those requests).
// Ids only; anything that is not a positive integer is ignored.
function narrowing(q) {
  const parts = []; const params = [];
  for (const [key, col] of [['projectId', 'project_id'], ['departmentId', 'department_id'], ['ownerId', 'owner_id']]) {
    const v = Number(q[key]);
    if (Number.isInteger(v) && v > 0) { parts.push(`${col}=?`); params.push(v); }
  }
  return parts.length ? { sql: parts.join(' AND '), params, applied: true } : { sql: '1=1', params: [], applied: false };
}
function narrowScope(scope, n, col) {
  if (!n.applied) return scope;
  const where = col === 'id'
    ? `(${scope.where}) AND ${n.sql}`
    : `(${scope.where}) AND ${col} IN (SELECT id FROM recruitment_request WHERE ${n.sql})`;
  return { where, params: [...scope.params, ...n.params] };
}
// Approved and running: the clock for "how long has this role been open"
// starts at approval (opened_at), never while a request is still waiting.
const ACTIVE_REQ = NON_TERMINAL_REQ.filter((s) => !['pending_approval', 'draft', 'budget_validation'].includes(s));

router.get('/', (req, res) => {
  const user = req.user;
  const viewAll = user.permissions.includes('request.view_all');
  const n = narrowing(req.query || {});
  const scope = narrowScope(requestScope(user, 'id'), n, 'id');                     // recruitment_request.id
  const appScope = narrowScope(requestScope(user, 'request_id'), n, 'request_id');   // application.request_id
  appScope.where = `(${appScope.where}) AND ${applicationVisibilitySql(user, 'application')}`;
  const ivScope = narrowScope(requestScope(user, 'request_id'), n, 'request_id');
  const offScope = narrowScope(requestScope(user, 'request_id'), n, 'request_id');

  // ---- Requests ----
  const reqByStatus = all(`SELECT status, COUNT(*) c FROM recruitment_request WHERE ${scope.where} GROUP BY status`, scope.params);
  const totalRequests = reqByStatus.reduce((s, r) => s + r.c, 0);
  const openRequests = reqByStatus.filter((r) => NON_TERMINAL_REQ.includes(r.status)).reduce((s, r) => s + r.c, 0);
  const filledRequests = reqByStatus.filter((r) => r.status === 'filled').reduce((s, r) => s + r.c, 0);
  const headcount = get(`SELECT COALESCE(SUM(headcount),0) h, COALESCE(SUM(headcount_filled),0) f FROM recruitment_request WHERE ${scope.where}`, scope.params);
  const fillRate = headcount.h > 0 ? Math.round((headcount.f / headcount.h) * 100) : 0;

  // Aging buckets: approved, running requests by days since approval. A request
  // still waiting for its decision has not started and is counted separately.
  const agingRows = all(`SELECT opened_at FROM recruitment_request WHERE ${scope.where} AND opened_at IS NOT NULL AND status IN (${ACTIVE_REQ.map(() => '?').join(',')})`, [...scope.params, ...ACTIVE_REQ]);
  const now = Date.now();
  const aging = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const waitingRows = all(`SELECT created_at FROM recruitment_request WHERE ${scope.where} AND status IN ('pending_approval','draft','budget_validation')`, scope.params);
  const awaitingApproval = { count: waitingRows.length, oldestDays: waitingRows.length ? Math.floor(Math.max(...waitingRows.map((r) => (now - new Date(r.created_at).getTime()) / 86400000))) : null };
  for (const r of agingRows) {
    const t = new Date(r.opened_at).getTime();
    const days = (now - t) / 86400000;
    if (days <= 30) aging['0-30']++; else if (days <= 60) aging['31-60']++; else if (days <= 90) aging['61-90']++; else aging['90+']++;
  }

  // ---- Applications / pipeline funnel ----
  const appByStatus = all(`SELECT status, COUNT(*) c FROM application WHERE ${appScope.where} GROUP BY status`, appScope.params);
  const totalApplications = appByStatus.reduce((s, r) => s + r.c, 0);

  // ---- Interviews ----
  const ivByStatus = all(`SELECT status, COUNT(*) c FROM interview WHERE ${ivScope.where} GROUP BY status`, ivScope.params);
  const totalInterviews = ivByStatus.reduce((s, r) => s + r.c, 0);
  const upcomingInterviews = get(`SELECT COUNT(*) c FROM interview WHERE ${ivScope.where} AND status='scheduled' AND scheduled_at > ?`, [...ivScope.params, new Date().toISOString()]).c;

  // ---- Offers ----
  const offByStatus = all(`SELECT status, COUNT(*) c FROM offer WHERE ${offScope.where} GROUP BY status`, offScope.params);
  const totalOffers = offByStatus.reduce((s, r) => s + r.c, 0);
  const accepted = offByStatus.filter((r) => ['accepted', 'joined'].includes(r.status)).reduce((s, r) => s + r.c, 0);
  const declined = offByStatus.filter((r) => r.status === 'rejected_by_candidate').reduce((s, r) => s + r.c, 0);
  const offerAcceptanceRate = (accepted + declined) > 0 ? Math.round((accepted / (accepted + declined)) * 100) : null;
  const joined = offByStatus.filter((r) => r.status === 'joined').reduce((s, r) => s + r.c, 0);

  // ---- Time-to-fill (avg days opened_at → all joined): simple approximation ----
  const filled = all(`SELECT opened_at, closed_at, updated_at, status FROM recruitment_request WHERE ${scope.where} AND status IN ('filled')`, scope.params);
  let ttfDays = null;
  if (filled.length) {
    const vals = filled.map((r) => {
      const start = new Date(r.opened_at || r.created_at).getTime();
      const end = new Date(r.closed_at || r.updated_at).getTime();
      return Math.max(0, (end - start) / 86400000);
    });
    ttfDays = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  // ---- Recruiter load (only meaningful org-wide; for own-scope it's just the user) ----
  let recruiterLoad = [];
  if (viewAll) {
    // `u.id` is what lets a workload row link to that recruiter's own filtered
    // request list — without it the row has a name but nothing to filter by.
    recruiterLoad = all(`SELECT u.id id, u.full_name name, COUNT(*) c
      FROM recruitment_request r JOIN users u ON u.id=r.owner_id
      WHERE r.status IN (${NON_TERMINAL_REQ.map(() => '?').join(',')})${n.applied ? ' AND r.' + n.sql.replace(/ AND /g, ' AND r.') : ''} GROUP BY u.id, u.full_name ORDER BY c DESC LIMIT 8`, [...NON_TERMINAL_REQ, ...n.params]);
  }

  // ---- My work (always scoped to the user) ----
  const myOpenRequests = get(`SELECT COUNT(*) c FROM recruitment_request WHERE (owner_id=? OR requester_id=? OR hiring_manager_id=?) AND status IN (${NON_TERMINAL_REQ.map(() => '?').join(',')})`, [user.id, user.id, user.id, ...NON_TERMINAL_REQ]).c;
  const myInterviews = get(`SELECT COUNT(DISTINCT i.id) c FROM interview i LEFT JOIN interview_panel p ON p.interview_id=i.id WHERE (i.organizer_id=? OR p.interviewer_id=?) AND i.status='scheduled' AND i.scheduled_at > ?`, [user.id, user.id, new Date().toISOString()]).c;
  const myPendingOfferApprovals = user.permissions.includes('offer.approve')
    ? get(`SELECT COUNT(*) c FROM offer WHERE status='pending_approval'`).c : null;

  res.json({
    scope: viewAll ? 'all' : 'own',
    generatedAt: new Date().toISOString(),
    kpis: {
      totalRequests, openRequests, filledRequests,
      headcountTotal: headcount.h, headcountFilled: headcount.f, fillRate,
      totalApplications, totalInterviews, upcomingInterviews,
      totalOffers, offerAcceptanceRate, joined,
      timeToFillDays: ttfDays,
    },
    requestsByStatus: reqByStatus.map((r) => ({ status: r.status, count: r.c })),
    aging,
    awaitingApproval,
    filters: n.applied ? Object.fromEntries(['projectId', 'departmentId', 'ownerId'].filter((k) => Number(req.query[k]) > 0).map((k) => [k, Number(req.query[k])])) : null,
    applicationsByStatus: appByStatus.map((r) => ({ status: r.status, count: r.c })),
    interviewsByStatus: ivByStatus.map((r) => ({ status: r.status, count: r.c })),
    offersByStatus: offByStatus.map((r) => ({ status: r.status, count: r.c })),
    recruiterLoad,
    myWork: { myOpenRequests, myInterviews, myPendingOfferApprovals },
  });
});

export default router;
