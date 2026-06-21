import { Router } from 'express';
import {
  Offers, OfferApprovals, OfferActivity,
  Applications, Candidates, Requests, Projects, Users, SystemSettings, StageHistory, CandidateActivity, RequestActivity,
} from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { hasOpenSeat, fillSeatAndCount, applicationAlreadyFilledSeat } from '../lib/vacancy.js';

const router = Router();
router.use(requireAuth);

// Offer statuses
const OFFER_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected_by_approver', 'sent', 'accepted', 'rejected_by_candidate', 'withdrawn', 'joined'];
const TERMINAL_APP = ['rejected', 'withdrawn', 'on_hold', 'joined'];

// Salary visibility for offers is gated by offer.salary_view (separate from general salary.view).
const canSeeOfferSalary = (u) => u.permissions.includes('offer.salary_view');
const canEditOfferSalary = (u) => u.permissions.includes('offer.salary_edit');

function serialize(o, user, { detail = false } = {}) {
  const seeSalary = canSeeOfferSalary(user);
  const cand = Candidates.byId(o.candidate_id);
  const req = Requests.byId(o.request_id);
  const proj = req?.project_id ? Projects.byId(req.project_id) : null;
  const preparedBy = o.prepared_by ? Users.byId(o.prepared_by) : null;
  const approvedBy = o.approved_by ? Users.byId(o.approved_by) : null;
  const out = {
    id: o.id, offerNo: o.offer_no,
    applicationId: o.application_id, candidateId: o.candidate_id, requestId: o.request_id,
    positionTitle: o.position_title, currency: o.currency, joiningDate: o.joining_date,
    status: o.status,
    preparedBy: preparedBy ? { id: preparedBy.id, name: preparedBy.full_name } : null,
    approvedBy: approvedBy ? { id: approvedBy.id, name: approvedBy.full_name } : null,
    sentAt: o.sent_at, acceptedAt: o.accepted_at, rejectedAt: o.rejected_at,
    rejectionReason: o.rejection_reason, withdrawalReason: o.withdrawal_reason, joinedAt: o.joined_at,
    createdAt: o.created_at, updatedAt: o.updated_at, version: o.version,
    // Field-level salary control:
    salaryVisible: seeSalary,
    salaryOffered: seeSalary ? o.salary_offered : null,
    benefits: seeSalary ? o.benefits : null,
    candidate: cand ? { id: cand.id, candidateNo: cand.candidate_no, fullName: cand.full_name, currentPosition: cand.current_position } : null,
    request: req ? { id: req.id, ticketNo: req.ticket_no, title: req.title } : null,
    project: proj ? { id: proj.id, name: proj.name } : null,
    application: (() => { const a = Applications.byId(o.application_id); return a ? { id: a.id, applicationNo: a.application_no, status: a.status } : null; })(),
  };
  if (detail) {
    out.notes = o.notes;
    out.approvals = OfferApprovals.forOffer(o.id);
    out.activity = OfferActivity.forOffer(o.id);
  }
  return out;
}

// Build the offer approval chain. HR Manager always; HR Director if salary > threshold.
function buildChain(salaryOffered) {
  const levels = [{ level: 1, name: 'HR Manager', roleCode: 'offer.approve' }];
  const threshold = parseFloat(SystemSettings.all().offer_director_threshold || '50000');
  if (salaryOffered != null && Number(salaryOffered) > threshold) {
    levels.push({ level: 2, name: 'HR Director (high-value)', roleCode: 'offer.approve_director' });
  }
  return levels;
}

/* ---------------- LIST ---------------- */
router.get('/', requirePermission('offer.view'), (req, res) => {
  const rows = Offers.list({
    status: req.query.status, requestId: req.query.requestId, preparedBy: req.query.preparedBy,
    q: req.query.q, joiningFrom: req.query.joiningFrom, joiningTo: req.query.joiningTo,
  });
  res.json({ offers: rows.map((o) => serialize(o, req.user)) });
});

/* ---------------- DETAIL ---------------- */
router.get('/:id', requirePermission('offer.view'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  res.json({ offer: serialize(o, req.user, { detail: true }) });
});

/* ---------------- offers for an application ---------------- */
router.get('/application/:applicationId', requirePermission('offer.view'), (req, res) => {
  const offers = Offers.forApplication(Number(req.params.applicationId)).map((o) => serialize(o, req.user));
  res.json({ offers });
});

/* ---------------- CREATE ---------------- */
router.post('/', requirePermission('offer.create'), (req, res) => {
  const d = req.body || {};
  const app = Applications.byId(Number(d.applicationId));
  if (!app) return res.status(404).json({ error: 'Application not found.' });

  // Cannot create for a terminal/on-hold application unless authorized override.
  if (TERMINAL_APP.includes(app.status)) {
    if (!d.overrideTerminal) return res.status(409).json({ error: `Cannot create an offer for a ${app.status} application.`, applicationStatus: app.status });
    if (!req.user.permissions.includes('candidate.merge')) return res.status(403).json({ error: 'You are not permitted to override offer creation for this application.' });
    if (!d.overrideReason || !d.overrideReason.trim()) return res.status(400).json({ error: 'A reason is required to override.' });
  }
  // One active offer per application.
  if (Offers.activeForApplication(app.id)) return res.status(409).json({ error: 'An active offer already exists for this application.' });

  if (d.joiningDate && new Date(d.joiningDate) < new Date(new Date().toDateString())) {
    return res.status(400).json({ error: 'Joining date cannot be in the past.' });
  }
  // Salary only settable by authorized roles.
  const salaryOffered = canEditOfferSalary(req.user) && d.salaryOffered != null && d.salaryOffered !== '' ? Number(d.salaryOffered) : null;

  const req2 = Requests.byId(app.request_id);
  const offerNo = Offers.nextNo();
  const created = Offers.create({
    offerNo, applicationId: app.id, candidateId: app.candidate_id, requestId: app.request_id,
    positionTitle: d.positionTitle || req2?.title, salaryOffered, currency: d.currency || req2?.currency || 'EGP',
    benefits: d.benefits, joiningDate: d.joiningDate, notes: d.notes, status: 'draft',
    preparedBy: req.user.id, createdBy: req.user.id,
  });
  OfferActivity.add(created.id, req.user, 'created', { toStatus: 'draft', note: `Offer ${offerNo} prepared` });
  CandidateActivity.add({ candidateId: app.candidate_id, applicationId: app.id, actorId: req.user.id, actorName: req.user.fullName, type: 'offer_created', note: offerNo });

  // Move application to Offer Preparation if it's not already past it (controlled workflow step).
  if (!['offer_preparation', 'offer_sent', 'offer_accepted', 'joined'].includes(app.status)) {
    StageHistory.add(app.id, app.status, 'offer_preparation', req.user, 'Auto on offer creation');
    Applications.setStatus(app.id, 'offer_preparation');
    CandidateActivity.add({ candidateId: app.candidate_id, applicationId: app.id, actorId: req.user.id, actorName: req.user.fullName, type: 'application_status_changed', note: `→ offer_preparation` });
    writeAudit(req, { action: 'application.status_changed', entityType: 'application', entityId: app.id, oldValue: { status: app.status }, newValue: { status: 'offer_preparation' }, comments: 'Auto on offer creation' });
  }
  Requests.stampLifecycle(app.request_id, 'first_offer_at'); // lifecycle: first offer created
  writeAudit(req, { action: 'offer.created', entityType: 'offer', entityId: created.id, newValue: { offerNo, applicationId: app.id, candidateId: app.candidate_id, requestId: app.request_id }, comments: d.overrideTerminal ? `Override: ${d.overrideReason}` : null });
  res.status(201).json({ offer: serialize(created, req.user, { detail: true }) });
});

/* ---------------- EDIT (salary change triggers re-approval) ---------------- */
router.put('/:id', requirePermission('offer.edit'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  if (['accepted', 'joined', 'withdrawn', 'rejected_by_candidate', 'rejected_by_approver'].includes(o.status)) {
    return res.status(409).json({ error: `Cannot edit a ${o.status} offer.` });
  }
  const d = req.body || {};
  if (d.joiningDate && new Date(d.joiningDate) < new Date(new Date().toDateString())) return res.status(400).json({ error: 'Joining date cannot be in the past.' });
  const salaryAllowed = canEditOfferSalary(req.user);
  if (d.salaryOffered !== undefined && !salaryAllowed) return res.status(403).json({ error: 'You are not permitted to edit offer salary.' });

  const before = { salary: o.salary_offered, status: o.status };
  const salaryChanged = salaryAllowed && d.salaryOffered !== undefined && Number(d.salaryOffered) !== o.salary_offered;
  const updated = Offers.update(o.id, d, { salaryAllowed });
  OfferActivity.add(o.id, req.user, 'edited');
  if (salaryChanged) {
    writeAudit(req, { action: 'offer.salary_changed', entityType: 'offer', entityId: o.id, oldValue: { salary: before.salary }, newValue: { salary: updated.salary_offered } });
    // Salary change after approval/submission forces re-approval.
    if (['pending_approval', 'approved'].includes(o.status)) {
      OfferApprovals.clear(o.id);
      OfferApprovals.createChain(o.id, buildChain(updated.salary_offered));
      Offers.setStatus(o.id, 'pending_approval', { approved_by: null });
      OfferActivity.add(o.id, req.user, 'reapproval_required', { fromStatus: o.status, toStatus: 'pending_approval', note: 'Salary changed — re-approval required' });
    }
  }
  writeAudit(req, { action: 'offer.edited', entityType: 'offer', entityId: o.id, oldValue: before, newValue: { status: Offers.byId(o.id).status } });
  res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }) });
});

/* ---------------- SUBMIT for approval ---------------- */
router.post('/:id/submit', requirePermission('offer.create'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  if (o.status !== 'draft') return res.status(409).json({ error: 'Only draft offers can be submitted.' });
  OfferApprovals.clear(o.id);
  OfferApprovals.createChain(o.id, buildChain(o.salary_offered));
  Offers.setStatus(o.id, 'pending_approval');
  OfferActivity.add(o.id, req.user, 'submitted', { fromStatus: 'draft', toStatus: 'pending_approval', note: 'Submitted for approval' });
  writeAudit(req, { action: 'offer.submitted', entityType: 'offer', entityId: o.id });
  res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }) });
});

/* ---------------- APPROVE / REJECT (approver) ---------------- */
router.post('/:id/approve', requirePermission('offer.approve'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  if (o.status !== 'pending_approval') return res.status(409).json({ error: 'Offer is not pending approval.' });
  const pending = OfferApprovals.currentPending(o.id);
  if (!pending) return res.status(409).json({ error: 'No pending approval step.' });
  // Director-level step requires elevated approval; in this build any offer.approve holder
  // may action it, but we record who approved. (Configurable later.)
  OfferApprovals.decide(pending.id, { decision: 'approved', approverId: req.user.id, comment: (req.body || {}).comment });
  OfferActivity.add(o.id, req.user, 'approved', { note: `Approved: ${pending.name}` });
  writeAudit(req, { action: 'offer.approval_decision', entityType: 'offer', entityId: o.id, newValue: { level: pending.level, decision: 'approved' } });
  if (OfferApprovals.allApproved(o.id)) {
    Offers.setStatus(o.id, 'approved');
    Offers.setApprovedBy(o.id, req.user.id);
    OfferActivity.add(o.id, req.user, 'status_changed', { toStatus: 'approved', note: 'All approvals complete' });
    writeAudit(req, { action: 'offer.approved', entityType: 'offer', entityId: o.id });
  }
  res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }) });
});

router.post('/:id/reject-approval', requirePermission('offer.approve'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  if (o.status !== 'pending_approval') return res.status(409).json({ error: 'Offer is not pending approval.' });
  const reason = (req.body || {}).reason;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to reject offer approval.' });
  const pending = OfferApprovals.currentPending(o.id);
  if (pending) OfferApprovals.decide(pending.id, { decision: 'rejected', approverId: req.user.id, comment: reason });
  Offers.setStatus(o.id, 'rejected_by_approver');
  OfferActivity.add(o.id, req.user, 'rejected_by_approver', { fromStatus: 'pending_approval', toStatus: 'rejected_by_approver', note: reason });
  writeAudit(req, { action: 'offer.rejected_by_approver', entityType: 'offer', entityId: o.id, comments: reason });
  res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }) });
});

/* ---------------- SEND ---------------- */
router.post('/:id/send', requirePermission('offer.send'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  if (o.status !== 'approved') return res.status(409).json({ error: 'Only approved offers can be sent.' });
  Offers.setStatus(o.id, 'sent', { sent_at: new Date().toISOString() });
  // Controlled application stage move: → offer_sent
  const app = Applications.byId(o.application_id);
  if (app && app.status !== 'offer_sent') {
    StageHistory.add(app.id, app.status, 'offer_sent', req.user, 'Offer sent');
    Applications.setStatus(app.id, 'offer_sent');
    writeAudit(req, { action: 'application.status_changed', entityType: 'application', entityId: app.id, oldValue: { status: app.status }, newValue: { status: 'offer_sent' }, comments: 'Offer sent' });
  }
  OfferActivity.add(o.id, req.user, 'sent', { toStatus: 'sent' });
  writeAudit(req, { action: 'offer.sent', entityType: 'offer', entityId: o.id });
  res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }) });
});

/* ---------------- RESULT: accept / reject-candidate / withdraw / join ---------------- */
router.post('/:id/result', requirePermission('offer.result_update'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  const { result, reason } = req.body || {};
  const app = Applications.byId(o.application_id);

  if (result === 'accepted') {
    if (o.status !== 'sent') return res.status(409).json({ error: 'Only a sent offer can be accepted.' });
    Offers.setStatus(o.id, 'accepted', { accepted_at: new Date().toISOString() });
    // Controlled: application → offer_accepted
    if (app && app.status !== 'offer_accepted') {
      StageHistory.add(app.id, app.status, 'offer_accepted', req.user, 'Offer accepted');
      Applications.setStatus(app.id, 'offer_accepted');
      writeAudit(req, { action: 'application.status_changed', entityType: 'application', entityId: app.id, oldValue: { status: app.status }, newValue: { status: 'offer_accepted' }, comments: 'Offer accepted' });
    }
    OfferActivity.add(o.id, req.user, 'accepted', { toStatus: 'accepted' });
    writeAudit(req, { action: 'offer.accepted', entityType: 'offer', entityId: o.id });
  } else if (result === 'rejected_by_candidate') {
    if (!['sent', 'accepted'].includes(o.status)) return res.status(409).json({ error: 'Offer is not in a state the candidate can reject.' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required.' });
    Offers.setStatus(o.id, 'rejected_by_candidate', { rejected_at: new Date().toISOString(), rejection_reason: reason });
    OfferActivity.add(o.id, req.user, 'rejected_by_candidate', { toStatus: 'rejected_by_candidate', note: reason });
    writeAudit(req, { action: 'offer.rejected_by_candidate', entityType: 'offer', entityId: o.id, comments: reason });
  } else if (result === 'withdrawn') {
    if (['joined', 'withdrawn', 'rejected_by_candidate'].includes(o.status)) return res.status(409).json({ error: 'Offer cannot be withdrawn in its current state.' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required.' });
    Offers.setStatus(o.id, 'withdrawn', { withdrawal_reason: reason });
    OfferActivity.add(o.id, req.user, 'withdrawn', { toStatus: 'withdrawn', note: reason });
    writeAudit(req, { action: 'offer.withdrawn', entityType: 'offer', entityId: o.id, comments: reason });
  } else if (result === 'joined') {
    if (o.status !== 'accepted') return res.status(409).json({ error: 'Only an accepted offer can be marked joined.' });
    if (!app) return res.status(404).json({ error: 'Application missing.' });
    // Safe joining: prevent double-count + overfill, transactional seat fill (shared Phase 3 logic).
    if (applicationAlreadyFilledSeat(app.id) || app.status === 'joined') {
      return res.status(409).json({ error: 'This candidate has already joined (seat already filled).' });
    }
    const request = Requests.byId(o.request_id);
    if (!hasOpenSeat(request.id)) return res.status(409).json({ error: 'All vacancies for this request are already filled.' });

    // Move application → joined and fill a seat atomically.
    const beforeFilled = request.headcount_filled;
    StageHistory.add(app.id, app.status, 'joined', req.user, 'Joined via offer');
    Applications.setStatus(app.id, 'joined');
    const result2 = fillSeatAndCount(request, app.id);
    Offers.setStatus(o.id, 'joined', { joined_at: new Date().toISOString() });

    OfferActivity.add(o.id, req.user, 'joined', { toStatus: 'joined' });
    CandidateActivity.add({ candidateId: o.candidate_id, applicationId: app.id, actorId: req.user.id, actorName: req.user.fullName, type: 'candidate_joined' });
    RequestActivity.add(request.id, req.user, 'seat_filled', { note: `${result2.filled}/${request.headcount} filled${result2.newStatus === 'filled' ? ' — request Filled' : ''}` });
    writeAudit(req, { action: 'application.status_changed', entityType: 'application', entityId: app.id, oldValue: { status: app.status }, newValue: { status: 'joined' }, comments: 'Joined via offer' });
    writeAudit(req, { action: 'offer.joined', entityType: 'offer', entityId: o.id });
    writeAudit(req, { action: 'request.seat_filled', entityType: 'recruitment_request', entityId: request.id, newValue: { filled: result2.filled, status: result2.newStatus } });
    writeAudit(req, { action: 'request.vacancy_changed', entityType: 'recruitment_request', entityId: request.id, oldValue: { headcountFilled: beforeFilled }, newValue: { headcountFilled: result2.filled, remaining: request.headcount - result2.filled, status: result2.newStatus } });
  } else {
    return res.status(400).json({ error: 'Invalid result.' });
  }
  res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }) });
});

/* ---------------- form meta ---------------- */
router.get('/meta/form', requirePermission('offer.view'), (req, res) => {
  res.json({ canSeeSalary: canSeeOfferSalary(req.user), canEditSalary: canEditOfferSalary(req.user), statuses: OFFER_STATUSES });
});

export default router;
