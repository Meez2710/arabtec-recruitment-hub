// Phase 6 — Dashboards (read-only analytics).
// Aggregates KPIs from requests/applications/interviews/offers built in prior phases.
// Role-scoped: request.view_all → org-wide; request.view_own → only the user's own
// requests (owned/requested/created). NO salary or other restricted field is ever returned.
import { Router } from 'express';
import { all, get } from '../lib/db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requirePermission('dashboard.view'));

// Build a WHERE fragment + params restricting to the user's request scope.
function requestScope(user, col = 'id') {
  if (user.permissions.includes('request.view_all')) return { where: '1=1', params: [] };
  // own scope
  return {
    where: `${col} IN (SELECT id FROM recruitment_request WHERE owner_id=? OR requester_id=? OR created_by=?)`,
    params: [user.id, user.id, user.id],
  };
}

// Simplified workflow (Phase 0). Legacy values kept too so any un-migrated rows still count.
const NON_TERMINAL_REQ = ['pending_approval', 'sourcing', 'in_progress', 'partially_filled', 'on_hold', 'reopened',
  'draft', 'budget_validation', 'approved', 'in_sourcing'];

router.get('/', (req, res) => {
  const user = req.user;
  const viewAll = user.permissions.includes('request.view_all');
  const scope = requestScope(user, 'id');           // for recruitment_request.id
  const appScope = requestScope(user, 'request_id'); // for application.request_id
  const ivScope = requestScope(user, 'request_id');
  const offScope = requestScope(user, 'request_id');

  // ---- Requests ----
  const reqByStatus = all(`SELECT status, COUNT(*) c FROM recruitment_request WHERE ${scope.where} GROUP BY status`, scope.params);
  const totalRequests = reqByStatus.reduce((s, r) => s + r.c, 0);
  const openRequests = reqByStatus.filter((r) => NON_TERMINAL_REQ.includes(r.status)).reduce((s, r) => s + r.c, 0);
  const filledRequests = reqByStatus.filter((r) => r.status === 'filled').reduce((s, r) => s + r.c, 0);
  const headcount = get(`SELECT COALESCE(SUM(headcount),0) h, COALESCE(SUM(headcount_filled),0) f FROM recruitment_request WHERE ${scope.where}`, scope.params);
  const fillRate = headcount.h > 0 ? Math.round((headcount.f / headcount.h) * 100) : 0;

  // Aging buckets (open requests by age of opened_at/created_at)
  const agingRows = all(`SELECT opened_at, created_at FROM recruitment_request WHERE ${scope.where} AND status IN (${NON_TERMINAL_REQ.map(() => '?').join(',')})`, [...scope.params, ...NON_TERMINAL_REQ]);
  const now = Date.now();
  const aging = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of agingRows) {
    const t = new Date(r.opened_at || r.created_at).getTime();
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
    recruiterLoad = all(`SELECT u.full_name name, COUNT(*) c
      FROM recruitment_request r JOIN users u ON u.id=r.owner_id
      WHERE r.status IN (${NON_TERMINAL_REQ.map(() => '?').join(',')}) GROUP BY u.id, u.full_name ORDER BY c DESC LIMIT 8`, NON_TERMINAL_REQ);
  }

  // ---- My work (always scoped to the user) ----
  const myOpenRequests = get(`SELECT COUNT(*) c FROM recruitment_request WHERE (owner_id=? OR requester_id=?) AND status IN (${NON_TERMINAL_REQ.map(() => '?').join(',')})`, [user.id, user.id, ...NON_TERMINAL_REQ]).c;
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
    applicationsByStatus: appByStatus.map((r) => ({ status: r.status, count: r.c })),
    interviewsByStatus: ivByStatus.map((r) => ({ status: r.status, count: r.c })),
    offersByStatus: offByStatus.map((r) => ({ status: r.status, count: r.c })),
    recruiterLoad,
    myWork: { myOpenRequests, myInterviews, myPendingOfferApprovals },
  });
});

export default router;
