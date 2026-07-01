import { Router } from 'express';
import {
  Requests, Seats, Approvals, RequestActivity, CustomFields,
  Projects, Sites, Departments, BusinessUnits, Users, SystemSettings, Posts, Applications,
} from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { all } from '../lib/db.js';
import { multipart, streamFile } from '../lib/upload.js';
import { REQ, reqNorm, REQ_LABELS } from '../lib/stages.js';
import { notifyUser, notifyByPermission } from '../lib/notify.js';
import fs from 'node:fs';

const router = Router();
router.use(requireAuth);

/* ---------------- Status workflow definition ---------------- */
// Simplified workflow (Phase 0). Symbolic names retained for readability;
// DRAFT and APPROVED now alias to the new canonical states (no separate draft /
// approved / budget stages). New requests start at Pending Approval; approval
// flows straight into Sourcing.
const STATUS = {
  DRAFT: REQ.PENDING, PENDING: REQ.PENDING, APPROVED: REQ.SOURCING,
  SOURCING: REQ.SOURCING, IN_PROGRESS: REQ.IN_PROGRESS,
  PARTIAL: REQ.PARTIAL, FILLED: REQ.FILLED, CLOSED: REQ.CLOSED,
  ON_HOLD: REQ.ON_HOLD, REJECTED: REQ.REJECTED, CANCELLED: REQ.CANCELLED,
  EXPIRED: REQ.EXPIRED, REOPENED: REQ.REOPENED,
};
const NON_TERMINAL = [STATUS.PENDING, STATUS.SOURCING, STATUS.IN_PROGRESS, STATUS.PARTIAL, STATUS.ON_HOLD, STATUS.REOPENED];

/* ---------------- Salary field-level visibility ---------------- */
function canSeeSalary(user) { return user.permissions.includes('salary.view'); }

const DAY = 86400000;
const daysBetween = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY)) : null);
const daysSince = (a) => (a ? Math.max(0, Math.round((Date.now() - new Date(a).getTime()) / DAY)) : null);
const daysUntil = (a) => (a ? Math.round((new Date(a).getTime() - Date.now()) / DAY) : null);

// Derived presentation label — now simply the canonical label of the stored
// status (single vocabulary; no second derived layer). Normalised for any
// legacy rows that predate the simplification.
function derivedStatus(r) {
  return REQ_LABELS[reqNorm(r.status)] || reqNorm(r.status);
}

// Health: green/amber/red from days-open vs configurable thresholds + target-join overrun.
function requestHealth(r) {
  if ([STATUS.CLOSED, STATUS.FILLED, STATUS.CANCELLED, STATUS.REJECTED, STATUS.EXPIRED].includes(reqNorm(r.status))) return { level: 'green', label: 'Closed' };
  const s = SystemSettings.all();
  const amber = parseInt(s.health_amber_days || '30', 10);
  const red = parseInt(s.health_red_days || '45', 10);
  const open = daysSince(r.opened_at || r.created_at) ?? 0;
  const untilTarget = daysUntil(r.target_join_date);
  let level = 'green', label = 'Healthy';
  if (open >= red) { level = 'red'; label = 'Overdue'; }
  else if (open >= amber) { level = 'amber'; label = 'Attention'; }
  if (untilTarget != null && untilTarget < 0 && level !== 'red') { level = 'red'; label = 'Past target join'; }
  return { level, label, daysOpen: open, daysToTarget: untilTarget };
}

// Persist admin-defined custom field values posted with a request.
function saveRequestCustomFields(recordId, body) {
  const vals = body && body.customFields;
  if (!vals || typeof vals !== 'object') return;
  const defined = new Set(CustomFields.forEntity('request').map((f) => f.field_key));
  for (const [k, v] of Object.entries(vals)) if (defined.has(k)) CustomFields.setValue('request', recordId, k, v);
}

function serialize(r, user, { withDetail = false } = {}) {
  const seeSalary = canSeeSalary(user);
  const out = {
    id: r.id, ticketNo: r.ticket_no, title: r.title,
    businessUnitId: r.business_unit_id, projectId: r.project_id, siteId: r.site_id, departmentId: r.department_id,
    requesterId: r.requester_id, ownerId: r.owner_id,
    headcount: r.headcount, headcountFilled: r.headcount_filled, priority: r.priority, grade: r.grade,
    status: r.status, slaDueAt: r.sla_due_at, slaBreached: !!r.sla_breached,
    closeReason: r.close_reason, targetJoinDate: r.target_join_date,
    openedAt: r.opened_at, closedAt: r.closed_at, createdAt: r.created_at, updatedAt: r.updated_at,
    version: r.version,
    // Workspace enhancement: derived presentation status + lifecycle + health
    displayStatus: derivedStatus(r),
    health: requestHealth(r),
    lifecycle: {
      createdAt: r.created_at,
      approvedAt: r.opened_at,            // approval/active date
      postingDate: r.posting_date,
      firstCandidateAt: r.first_candidate_at,
      firstShortlistAt: r.first_shortlist_at,
      firstInterviewAt: r.first_interview_at,
      firstOfferAt: r.first_offer_at,
      closingDate: r.closed_at,
      daysOpen: daysSince(r.opened_at || r.created_at),
      daysSinceApproval: daysSince(r.opened_at),
      daysToTargetJoin: daysUntil(r.target_join_date),
    },
  };
  // Simplified intake fields (restructure)
  out.justification = r.justification;
  out.location = r.location;
  out.customFields = CustomFields.valuesFor('request', r.id);
  // Lightweight names so the requests board cards render without a detail fetch.
  const deptLite = r.department_id ? Departments.byId(r.department_id) : null;
  const siteLite = r.site_id ? Sites.byId(r.site_id) : null;
  const projLite = r.project_id ? Projects.byId(r.project_id) : null;
  out.department = deptLite ? { id: deptLite.id, name: deptLite.name } : null;
  out.site = siteLite ? { id: siteLite.id, name: siteLite.name } : null;
  out.project = projLite ? { id: projLite.id, name: projLite.name } : null;
  if (withDetail) {
    out.jobDescription = r.job_description;
    out.keyRequirements = r.key_requirements;
    out.keyResponsibilities = r.key_responsibilities;
    out.hiringManagerNotes = r.hiring_manager_notes;
    out.attachmentName = r.attachment_name;
    out.hasAttachment = !!r.attachment_path;
    out.requiredSkills = r.required_skills ? JSON.parse(r.required_skills) : [];
    const proj = r.project_id ? Projects.byId(r.project_id) : null;
    const site = r.site_id ? Sites.byId(r.site_id) : null;
    const dept = r.department_id ? Departments.byId(r.department_id) : null;
    const requester = r.requester_id ? Users.byId(r.requester_id) : null;
    const owner = r.owner_id ? Users.byId(r.owner_id) : null;
    const hm = r.hiring_manager_id ? Users.byId(r.hiring_manager_id) : null;
    out.project = proj ? { id: proj.id, name: proj.name, code: proj.code } : null;
    out.site = site ? { id: site.id, name: site.name } : null;
    out.department = dept ? { id: dept.id, name: dept.name } : null;
    out.requester = requester ? { id: requester.id, name: requester.full_name } : null;
    out.owner = owner ? { id: owner.id, name: owner.full_name } : null;
    out.hiringManager = hm ? { id: hm.id, name: hm.full_name } : null;
    out.seats = Seats.forRequest(r.id);
    out.approvals = Approvals.forRequest(r.id);
    out.activity = RequestActivity.forRequest(r.id);
  }
  return out;
}

/* ---------------- Scope helper: can this user view this request? ---------------- */
function canView(user, r) {
  if (user.permissions.includes('request.view_all')) return true;
  if (user.permissions.includes('request.view_own')) {
    return r.owner_id === user.id || r.requester_id === user.id || r.created_by === user.id;
  }
  return false;
}

/* ===================== LIST ===================== */
router.get('/', (req, res) => {
  if (!req.user.permissions.includes('request.view_all') && !req.user.permissions.includes('request.view_own')) {
    return res.status(403).json({ error: 'Insufficient permissions.' });
  }
  const ownedOnly = !req.user.permissions.includes('request.view_all');
  const rows = Requests.list({
    status: req.query.status, priority: req.query.priority, projectId: req.query.projectId,
    departmentId: req.query.departmentId, ownerId: req.query.ownerId, q: req.query.q,
    sort: req.query.sort, dir: req.query.dir, ownedOnly, userId: req.user.id,
  });
  // Pipeline summary per request → inline funnel mini-bar on the board cards.
  const pipeline = Applications.stageCountsByRequest(rows.map((r) => r.id));
  const out = rows.map((r) => { const s = serialize(r, req.user); s.pipeline = pipeline[r.id] || { total: 0, byStage: {} }; return s; });
  res.json({ requests: out, counts: Requests.counts() });
});

/* ===================== DETAIL ===================== */
router.get('/:id', (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (!canView(req.user, r)) return res.status(403).json({ error: 'You cannot view this request.' });
  res.json({ request: serialize(r, req.user, { withDetail: true }) });
});

/* ===================== CREATE ===================== */
// Single-step approval: HR Director only (restructure — budget validation removed).
function defaultApprovalChain() {
  return [{ level: 1, name: 'HR Director', roleCode: 'hr_director' }];
}

router.post('/', requirePermission('request.create'), (req, res) => {
  const d = req.body || {};
  // Validation (simplified intake — no salary band / employment type / discipline / staff category)
  if (!d.title || !d.projectId || !d.departmentId) {
    return res.status(400).json({ error: 'Position, project and department are required.' });
  }
  const JUSTIFICATIONS = ['replacement', 'hiring_plan', 'new_hire', 'backfill', 'project_ramp_up'];
  if (d.justification && !JUSTIFICATIONS.includes(d.justification)) return res.status(400).json({ error: 'Invalid justification.' });
  if (d.headcount !== undefined && d.headcount !== '' && (parseInt(d.headcount, 10) < 1 || isNaN(parseInt(d.headcount, 10)))) {
    return res.status(400).json({ error: 'Headcount must be at least 1.' });
  }
  const headcount = parseInt(d.headcount, 10) || 1;
  if (!Projects.byId(Number(d.projectId))) return res.status(400).json({ error: 'Selected project does not exist.' });
  if (!Departments.byId(Number(d.departmentId))) return res.status(400).json({ error: 'Selected department does not exist.' });
  if (d.targetJoinDate && new Date(d.targetJoinDate) < new Date(new Date().toDateString())) {
    return res.status(400).json({ error: 'Target join date cannot be in the past.' });
  }
  const project = Projects.byId(Number(d.projectId));

  const ticketNo = Requests.nextTicketNo();
  const created = Requests.create({
    ticketNo, title: d.title,
    businessUnitId: project?.business_unit_id || null,
    projectId: Number(d.projectId),
    siteId: d.siteId ? Number(d.siteId) : null,
    departmentId: Number(d.departmentId),
    requesterId: req.user.id, ownerId: null,
    headcount, priority: d.priority || 'medium', grade: d.grade,
    justification: d.justification, jobDescription: d.jobDescription,
    targetJoinDate: d.targetJoinDate, status: STATUS.DRAFT, createdBy: req.user.id,
  });
  Seats.createMany(created.id, headcount, d.siteId ? Number(d.siteId) : null);
  // Persist simplified intake extras.
  Requests.update(created.id, { ...created,
    location: d.location ?? null, key_responsibilities: d.keyResponsibilities ?? null,
    key_requirements: d.keyRequirements ?? null, hiring_manager_notes: d.hiringManagerNotes ?? null,
    hiring_manager_id: d.hiringManagerId ? Number(d.hiringManagerId) : null,
  });
  saveRequestCustomFields(created.id, d);
  RequestActivity.add(created.id, req.user, 'created', { toStatus: STATUS.DRAFT, note: `Created ${ticketNo}` });
  writeAudit(req, { action: 'request.created', entityType: 'recruitment_request', entityId: created.id, newValue: { ticketNo, title: d.title } });
  res.status(201).json({ request: serialize(Requests.byId(created.id), req.user, { withDetail: true }) });
});

/* ===================== EDIT ===================== */
router.put('/:id', requirePermission('request.edit'), (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (![STATUS.DRAFT, STATUS.PENDING, STATUS.APPROVED, STATUS.REOPENED].includes(r.status)) {
    return res.status(409).json({ error: `Cannot edit a request in '${r.status}' state.` });
  }
  const d = req.body || {};
  if (d.salaryBandMin != null && d.salaryBandMax != null && Number(d.salaryBandMin) > Number(d.salaryBandMax)) {
    return res.status(400).json({ error: 'Salary band minimum cannot exceed maximum.' });
  }
  const before = { title: r.title, headcount: r.headcount, priority: r.priority, salaryBandMax: r.salary_band_max };
  const canSalary = canSeeSalary(req.user);
  const patch = {
    title: d.title ?? r.title,
    business_unit_id: r.business_unit_id,
    project_id: d.projectId ? Number(d.projectId) : r.project_id,
    site_id: d.siteId !== undefined ? (d.siteId ? Number(d.siteId) : null) : r.site_id,
    department_id: d.departmentId ? Number(d.departmentId) : r.department_id,
    employment_type: d.employmentType ?? r.employment_type,
    discipline: d.discipline ?? r.discipline,
    staff_category: d.staffCategory ?? r.staff_category,
    headcount: d.headcount ? parseInt(d.headcount, 10) : r.headcount,
    priority: d.priority ?? r.priority,
    grade: d.grade ?? r.grade,
    currency: d.currency ?? r.currency,
    justification: d.justification ?? r.justification,
    job_description: d.jobDescription ?? r.job_description,
    required_skills: d.requiredSkills !== undefined ? (Array.isArray(d.requiredSkills) ? d.requiredSkills : String(d.requiredSkills).split(',').map((s) => s.trim()).filter(Boolean)) : (r.required_skills ? JSON.parse(r.required_skills) : []),
    target_join_date: d.targetJoinDate ?? r.target_join_date,
  };
  if (canSalary) {
    patch.salary_band_min = d.salaryBandMin != null ? Number(d.salaryBandMin) : r.salary_band_min;
    patch.salary_band_max = d.salaryBandMax != null ? Number(d.salaryBandMax) : r.salary_band_max;
  } else { patch.salary_band_min = r.salary_band_min; patch.salary_band_max = r.salary_band_max; }

  // Material change after approval forces re-approval.
  const materialChange = r.status === STATUS.APPROVED
    && (patch.headcount !== r.headcount || patch.salary_band_max !== r.salary_band_max || patch.grade !== r.grade);
  const updated = Requests.update(r.id, patch);
  saveRequestCustomFields(r.id, req.body || {});
  if (materialChange) {
    Approvals.resetChain(r.id);
    Requests.setStatus(r.id, STATUS.PENDING);
    RequestActivity.add(r.id, req.user, 'reapproval_required', { fromStatus: STATUS.APPROVED, toStatus: STATUS.PENDING, note: 'Material change — re-approval required' });
  }
  RequestActivity.add(r.id, req.user, 'edited', { note: 'Request edited' });
  writeAudit(req, { action: 'request.updated', entityType: 'recruitment_request', entityId: r.id, oldValue: before, newValue: { title: patch.title, headcount: patch.headcount } });
  res.json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

/* ===================== SUBMIT ===================== */
router.post('/:id/submit', requirePermission('request.submit'), (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (r.status !== STATUS.DRAFT && r.status !== STATUS.REOPENED) {
    return res.status(409).json({ error: 'Only draft requests can be submitted.' });
  }
  // Build approval chain on first submit.
  if (Approvals.forRequest(r.id).length === 0) Approvals.createChain(r.id, defaultApprovalChain(r));
  else Approvals.resetChain(r.id);
  const hours = parseInt(SystemSettings.all().sla_approval_hours || '48', 10);
  const due = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  Requests.setStatus(r.id, STATUS.PENDING, { opened_at: r.opened_at || new Date().toISOString(), sla_due_at: due });
  RequestActivity.add(r.id, req.user, 'submitted', { fromStatus: r.status, toStatus: STATUS.PENDING, note: 'Submitted for approval' });
  Posts.system(r.id, 'Request submitted for HR Director approval.', { event: 'submitted' }, req.user);
  writeAudit(req, { action: 'request.submitted', entityType: 'recruitment_request', entityId: r.id });
  // Notify everyone who can approve (in-app + email), except the submitter.
  notifyByPermission('request.approve', {
    type: 'approval_needed', title: `Approval needed: ${r.ticket_no} — ${r.title}`,
    body: `${req.user.fullName} submitted a recruitment request that needs your approval.`,
    linkType: 'request', linkId: r.id,
  }, { excludeUserId: req.user.id });
  res.json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

/* ===================== APPROVE / REJECT (approval chain) ===================== */
router.post('/:id/approve', requirePermission('request.approve'), (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (r.status !== STATUS.PENDING) return res.status(409).json({ error: 'Request is not pending approval.' });
  const pending = Approvals.currentPending(r.id);
  if (!pending) return res.status(409).json({ error: 'No pending approval step.' });
  Approvals.decide(pending.id, { decision: 'approved', approverId: req.user.id, comment: (req.body || {}).comment });
  RequestActivity.add(r.id, req.user, 'approved', { note: `Approved: ${pending.name}` });
  writeAudit(req, { action: 'request.approval_decision', entityType: 'recruitment_request', entityId: r.id, newValue: { level: pending.level, decision: 'approved' } });
  // Single-step approval (HR Director only): completing it approves the request.
  if (!Approvals.currentPending(r.id)) {
    Requests.setStatus(r.id, STATUS.APPROVED);
    RequestActivity.add(r.id, req.user, 'status_changed', { toStatus: STATUS.APPROVED, note: 'Approved by HR Director' });
    Posts.system(r.id, 'Request approved by HR Director.', { event: 'approved' }, req.user);
  }
  res.json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

router.post('/:id/reject', requirePermission('request.reject'), (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  const reason = (req.body || {}).reason;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to reject.' });
  if (r.status !== STATUS.PENDING) return res.status(409).json({ error: 'Request is not in an approvable state.' });
  const pending = Approvals.currentPending(r.id);
  if (pending) Approvals.decide(pending.id, { decision: 'rejected', approverId: req.user.id, comment: reason });
  Requests.setStatus(r.id, STATUS.REJECTED, { closed_at: new Date().toISOString(), close_reason: 'rejected' });
  RequestActivity.add(r.id, req.user, 'rejected', { fromStatus: r.status, toStatus: STATUS.REJECTED, note: reason });
  Posts.system(r.id, `Request rejected: ${reason}`, { event: 'rejected' }, req.user);
  writeAudit(req, { action: 'request.rejected', entityType: 'recruitment_request', entityId: r.id, comments: reason });
  res.json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

/* (Budget validation removed in restructure — approval is a single HR Director step.) */

/* ===================== ASSIGN RECRUITER ===================== */
router.post('/:id/assign', requirePermission('request.assign_recruiter'), (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (![STATUS.APPROVED, STATUS.SOURCING, STATUS.IN_PROGRESS, STATUS.REOPENED, STATUS.PARTIAL].includes(r.status)) {
    return res.status(409).json({ error: 'Request must be approved before assigning a recruiter.' });
  }
  const ownerId = Number((req.body || {}).ownerId);
  const owner = Users.byId(ownerId);
  if (!owner) return res.status(400).json({ error: 'Selected recruiter does not exist.' });
  Requests.setOwner(r.id, ownerId);
  if (r.status === STATUS.APPROVED) Requests.setStatus(r.id, STATUS.SOURCING);
  RequestActivity.add(r.id, req.user, 'assigned', { note: `Assigned to ${owner.full_name}` });
  Posts.system(r.id, `Recruiter assigned: ${owner.full_name}.`, { event: 'assigned', ownerId }, req.user);
  writeAudit(req, { action: 'request.recruiter_assigned', entityType: 'recruitment_request', entityId: r.id, newValue: { ownerId } });
  // Notify the assigned recruiter (in-app + email).
  if (owner.id !== req.user.id) notifyUser(owner, {
    type: 'recruiter_assigned', title: `You’ve been assigned: ${r.ticket_no} — ${r.title}`,
    body: `${req.user.fullName} assigned you as the recruiter for this request. Start sourcing candidates.`,
    linkType: 'request', linkId: r.id,
  });
  res.json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

/* ===================== HOLD / RESUME ===================== */
router.post('/:id/hold', requirePermission('request.hold'), (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  const reason = (req.body || {}).reason;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to put on hold.' });
  if (!NON_TERMINAL.includes(r.status) || r.status === STATUS.ON_HOLD) return res.status(409).json({ error: 'Request cannot be held in its current state.' });
  // Remember the current state in a proper column so resume restores it exactly.
  Requests.setStatus(r.id, STATUS.ON_HOLD, { close_reason: null, prev_status: r.status });
  RequestActivity.add(r.id, req.user, 'on_hold', { fromStatus: r.status, toStatus: STATUS.ON_HOLD, note: reason });
  writeAudit(req, { action: 'request.on_hold', entityType: 'recruitment_request', entityId: r.id, comments: reason });
  res.json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

router.post('/:id/resume', requirePermission('request.hold'), (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (r.status !== STATUS.ON_HOLD) return res.status(409).json({ error: 'Request is not on hold.' });
  // Restore the remembered previous state (proper column; defaults to Sourcing).
  const prev = reqNorm(r.prev_status) || STATUS.SOURCING;
  Requests.setStatus(r.id, prev, { prev_status: null });
  RequestActivity.add(r.id, req.user, 'resumed', { fromStatus: STATUS.ON_HOLD, toStatus: prev, note: 'Resumed' });
  writeAudit(req, { action: 'request.resumed', entityType: 'recruitment_request', entityId: r.id });
  res.json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

/* ===================== CANCEL ===================== */
router.post('/:id/cancel', requirePermission('request.cancel'), (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  const reason = (req.body || {}).reason;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to cancel.' });
  if (!NON_TERMINAL.includes(r.status)) return res.status(409).json({ error: 'Request is already in a terminal state.' });
  Seats.cancelOpen(r.id, reason);
  Requests.setStatus(r.id, STATUS.CANCELLED, { closed_at: new Date().toISOString(), close_reason: 'cancelled' });
  RequestActivity.add(r.id, req.user, 'cancelled', { fromStatus: r.status, toStatus: STATUS.CANCELLED, note: reason });
  writeAudit(req, { action: 'request.cancelled', entityType: 'recruitment_request', entityId: r.id, comments: reason });
  res.json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

/* ===================== CLOSE ===================== */
router.post('/:id/close', requirePermission('request.close'), (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  const reason = (req.body || {}).reason;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to close.' });
  if (!NON_TERMINAL.includes(r.status) && r.status !== STATUS.FILLED) return res.status(409).json({ error: 'Request is already closed.' });
  const filled = Seats.filledCount(r.id);
  Seats.cancelOpen(r.id, reason);
  const closeReason = filled > 0 && filled < r.headcount ? 'partially_filled_closed' : (filled >= r.headcount ? 'filled' : 'cancelled');
  Requests.setStatus(r.id, STATUS.CLOSED, { closed_at: new Date().toISOString(), close_reason: closeReason });
  RequestActivity.add(r.id, req.user, 'closed', { fromStatus: r.status, toStatus: STATUS.CLOSED, note: `${reason} (${closeReason})` });
  writeAudit(req, { action: 'request.closed', entityType: 'recruitment_request', entityId: r.id, comments: reason, newValue: { closeReason } });
  res.json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

/* ===================== REOPEN ===================== */
router.post('/:id/reopen', requirePermission('request.reopen'), (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  const reason = (req.body || {}).reason;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to reopen.' });
  if (![STATUS.CLOSED, STATUS.FILLED, STATUS.CANCELLED].includes(r.status)) return res.status(409).json({ error: 'Only closed/filled/cancelled requests can be reopened.' });
  Requests.setStatus(r.id, STATUS.REOPENED, { closed_at: null, close_reason: null });
  RequestActivity.add(r.id, req.user, 'reopened', { fromStatus: r.status, toStatus: STATUS.REOPENED, note: reason });
  writeAudit(req, { action: 'request.reopened', entityType: 'recruitment_request', entityId: r.id, comments: reason });
  res.json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

/* ===================== Form metadata (selectors) ===================== */
router.get('/meta/form', (req, res) => {
  res.json({
    projects: Projects.all().map((p) => ({ id: p.id, name: p.name, code: p.code, businessUnitId: p.business_unit_id })),
    sites: Sites.all().map((s) => ({ id: s.id, name: s.name, projectId: s.project_id })),
    departments: Departments.all().map((d) => ({ id: d.id, name: d.name })),
    businessUnits: BusinessUnits.all().map((b) => ({ id: b.id, name: b.name })),
    recruiters: Users.list({}).map((u) => ({ id: u.id, name: u.full_name })),
    hiringManagers: Users.list({}).map((u) => ({ id: u.id, name: u.full_name })),
    justifications: [
      { value: 'replacement', label: 'Replacement' },
      { value: 'hiring_plan', label: 'Hiring Plan' },
      { value: 'new_hire', label: 'New Hire' },
      { value: 'backfill', label: 'Backfill' },
      { value: 'project_ramp_up', label: 'Project Ramp-up' },
    ],
  });
});

/* ===================== ATTACHMENT upload / download ===================== */
router.post('/:id/attachment', requirePermission('request.edit'), multipart, (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (!req.uploadedFile) return res.status(400).json({ error: 'No file uploaded.' });
  Requests.update(r.id, { ...r, attachment_path: req.uploadedFile.storedName, attachment_name: req.uploadedFile.originalName });
  RequestActivity.add(r.id, req.user, 'attachment_uploaded', { note: req.uploadedFile.originalName });
  writeAudit(req, { action: 'request.attachment_uploaded', entityType: 'recruitment_request', entityId: r.id, newValue: { fileName: req.uploadedFile.originalName } });
  res.status(201).json({ request: serialize(Requests.byId(r.id), req.user, { withDetail: true }) });
});

router.get('/:id/attachment', (req, res) => {
  const r = Requests.byId(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (!canView(req.user, r)) return res.status(403).json({ error: 'You cannot view this request.' });
  if (!r.attachment_path) return res.status(404).json({ error: 'No attachment.' });
  streamFile(r.attachment_path, res, r.attachment_name || 'attachment');
});

export default router;
