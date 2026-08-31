import { Router } from 'express';
import {
  Offers, OfferApprovals, OfferActivity,
  Applications, Candidates, Requests, Projects, Users, SystemSettings, StageHistory, CandidateActivity,
} from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { notifyEvent } from '../lib/notify.js';
import { hasOpenSeat, applicationAlreadyFilledSeat } from '../lib/vacancy.js';
import { joinApplication, blockingJoinedApplication, JoinConflict, JOIN_CONFLICT, ALREADY_JOINED_MESSAGE } from '../lib/join.js';
import { APP, appNorm } from '../lib/stages.js';
import { sendMail } from '../lib/mailer.js';
import { offerSent as offerSentTpl, offerLetterHtml } from '../lib/email_templates.js';

const router = Router();
router.use(requireAuth);

// Offer statuses
const OFFER_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected_by_approver', 'sent', 'accepted', 'rejected_by_candidate', 'withdrawn', 'joined'];
const TERMINAL_APP = [APP.REJECTED, APP.OFFER_DECLINED, APP.JOINED];

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
  if (![APP.ISSUING_OFFER, APP.OFFER_SENT, APP.JOINED].includes(appNorm(app.status))) {
    StageHistory.add(app.id, app.status, APP.ISSUING_OFFER, req.user, 'Auto on offer creation');
    Applications.setStatus(app.id, APP.ISSUING_OFFER);
    CandidateActivity.add({ candidateId: app.candidate_id, applicationId: app.id, actorId: req.user.id, actorName: req.user.fullName, type: 'application_status_changed', note: `→ issuing_offer` });
    writeAudit(req, { action: 'application.status_changed', entityType: 'application', entityId: app.id, oldValue: { status: app.status }, newValue: { status: APP.ISSUING_OFFER }, comments: 'Auto on offer creation' });
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
  notifyEvent('offer.pending_approval', {
    ...offerNotifyCtx(o, req.user),
    title: `Offer approval needed: ${o.offer_no}`,
    body: 'An offer is waiting on your decision before it can be sent.',
  });
  res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }) });
});

/**
 * Assemble the people an offer notification can reach. The offer's own request
 * supplies requester / owner / hiring manager, so the same symbolic recipients
 * an administrator ticks for a hiring request mean the same thing here.
 *
 * Salary is deliberately NOT passed to any internal template: an alert reaches
 * more inboxes than the offer record is visible to, and offer.salary_view exists
 * precisely to keep that figure on the record.
 */
function offerNotifyCtx(o, actor, extraVars = {}) {
  const originList = String(process.env.CORS_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const origin = originList.find((x) => /^https?:\/\//.test(x) && !/localhost|127\.0\.0\.1/.test(x));
  const request = (() => { try { return Requests.byId(o.request_id); } catch { return null; } })();
  const cand = (() => { try { return Candidates.byId(o.candidate_id); } catch { return null; } })();
  const u = (id) => { try { return id ? Users.byId(id) : null; } catch { return null; } };
  return {
    actor,
    candidate: cand,
    requester: request ? u(request.requester_id) : null,
    owner: request ? u(request.owner_id) : null,
    hiringManager: request ? u(request.hiring_manager_id) : null,
    linkType: 'offer', linkId: o.id,
    vars: {
      offerNo: o.offer_no, candidateName: cand ? cand.full_name : null,
      position: o.position_title, ticketNo: request ? request.ticket_no : null,
      appUrl: origin ? `${origin}/` : null,
      ...extraVars,
    },
  };
}

/* ---------------- APPROVE / REJECT (approver) ---------------- */
router.post('/:id/approve', requirePermission('offer.approve'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  if (o.status !== 'pending_approval') return res.status(409).json({ error: 'Offer is not pending approval.' });
  const pending = OfferApprovals.currentPending(o.id);
  if (!pending) return res.status(409).json({ error: 'No pending approval step.' });
  // Enforce separation of duties: a Director-level step (level >= 2, or one whose
  // chain role demands it) requires the distinct offer.approve_director permission.
  const needsDirector = pending.level >= 2 || pending.role_code === 'offer.approve_director';
  if (needsDirector && !req.user.permissions.includes('offer.approve_director')) {
    return res.status(403).json({ error: 'This approval step requires HR Director authority.' });
  }
  // Don't let the same person approve a step they earlier approved at a different level.
  OfferApprovals.decide(pending.id, { decision: 'approved', approverId: req.user.id, comment: (req.body || {}).comment });
  OfferActivity.add(o.id, req.user, 'approved', { note: `Approved: ${pending.name}` });
  writeAudit(req, { action: 'offer.approval_decision', entityType: 'offer', entityId: o.id, newValue: { level: pending.level, decision: 'approved' } });
  if (OfferApprovals.allApproved(o.id)) {
    Offers.setStatus(o.id, 'approved');
    Offers.setApprovedBy(o.id, req.user.id);
    OfferActivity.add(o.id, req.user, 'status_changed', { toStatus: 'approved', note: 'All approvals complete' });
    writeAudit(req, { action: 'offer.approved', entityType: 'offer', entityId: o.id });
    notifyEvent('offer.approved', {
      ...offerNotifyCtx(o, req.user, { approverName: req.user.fullName }),
      title: `Offer approved: ${o.offer_no}`,
      body: 'The offer cleared approval and can now be sent.',
    });
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
  if (app && appNorm(app.status) !== APP.OFFER_SENT) {
    StageHistory.add(app.id, app.status, APP.OFFER_SENT, req.user, 'Offer sent');
    Applications.setStatus(app.id, APP.OFFER_SENT);
    writeAudit(req, { action: 'application.status_changed', entityType: 'application', entityId: app.id, oldValue: { status: app.status }, newValue: { status: APP.OFFER_SENT }, comments: 'Offer sent' });
  }
  OfferActivity.add(o.id, req.user, 'sent', { toStatus: 'sent' });
  writeAudit(req, { action: 'offer.sent', entityType: 'offer', entityId: o.id });
  // Email the candidate (best-effort, non-blocking; no-ops until email is configured).
  const cand = Candidates.byId(o.candidate_id);
  // Routed through the console so an administrator can see and control the one
  // email in this product that goes to a candidate with money in it. The salary
  // IS included here — unlike the internal alerts — because this is the offer
  // letter itself, addressed to the person it concerns.
  const sentOut = notifyEvent('offer.sent', {
    ...offerNotifyCtx(o, req.user, {
      salary: o.salary_offered, allowances: 0,
      offerDate: o.created_at, totalSalary: o.salary_offered,
    }),
    title: `Offer sent: ${o.offer_no}`,
    body: `The offer letter went to ${cand ? cand.full_name : 'the candidate'}.`,
  });
  if (sentOut.sent && cand) {
    try {
      CandidateActivity.add({ candidateId: cand.id, applicationId: o.application_id,
        actorId: req.user.id, actorName: 'System', type: 'email_sent', note: 'Offer email sent' });
    } catch { /* the activity note must never fail the send */ }
  }
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
    // Application stays at Offer Sent on acceptance; it advances to Joined on the join step.
    OfferActivity.add(o.id, req.user, 'accepted', { toStatus: 'accepted' });
    writeAudit(req, { action: 'offer.accepted', entityType: 'offer', entityId: o.id });
    notifyEvent('offer.accepted', {
      ...offerNotifyCtx(o, req.user, { accepted: true, joiningDate: o.joining_date }),
      title: `Offer accepted: ${o.offer_no}`,
      body: 'The candidate accepted. Joining formalities follow.',
    });
  } else if (result === 'rejected_by_candidate') {
    if (!['sent', 'accepted'].includes(o.status)) return res.status(409).json({ error: 'Offer is not in a state the candidate can reject.' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required.' });
    Offers.setStatus(o.id, 'rejected_by_candidate', { rejected_at: new Date().toISOString(), rejection_reason: reason });
    // Controlled: application → offer_declined (candidate declined the offer).
    if (app && appNorm(app.status) !== APP.OFFER_DECLINED) {
      StageHistory.add(app.id, app.status, APP.OFFER_DECLINED, req.user, 'Candidate declined offer');
      Applications.setStatus(app.id, APP.OFFER_DECLINED, 'rejection_reason', reason);
      writeAudit(req, { action: 'application.status_changed', entityType: 'application', entityId: app.id, oldValue: { status: app.status }, newValue: { status: APP.OFFER_DECLINED }, comments: reason });
    }
    OfferActivity.add(o.id, req.user, 'rejected_by_candidate', { toStatus: 'rejected_by_candidate', note: reason });
    writeAudit(req, { action: 'offer.rejected_by_candidate', entityType: 'offer', entityId: o.id, comments: reason });
    notifyEvent('offer.declined', {
      ...offerNotifyCtx(o, req.user, { accepted: false, reason }),
      title: `Offer declined: ${o.offer_no}`,
      body: reason,
    });
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
    // BL-27. One joined application per candidate, globally — the offer flow is
    // no more privileged than a manual move. Checked here for the message,
    // decided inside the shared transaction and by the database index.
    const blocker = blockingJoinedApplication(app.candidate_id, app.id);
    if (blocker) {
      return res.status(409).json({
        error: ALREADY_JOINED_MESSAGE, code: JOIN_CONFLICT.ALREADY_JOINED_ELSEWHERE,
        blockingApplicationId: blocker.applicationId, blockingRequestId: blocker.requestId,
      });
    }

    // Application → joined, seat, counters, activity, offer settlement and audit
    // all commit together (lib/join.js). Previously this ran unwrapped: only the
    // seat fill was transactional, so a failure after it left an application
    // marked joined against a requisition whose counters never moved.
    try {
      joinApplication({ app, req, reason: 'Joined via offer', offer: o });
    } catch (e) {
      if (e instanceof JoinConflict) return res.status(e.status).json(e.toBody());
      throw e;
    }
  } else {
    return res.status(400).json({ error: 'Invalid result.' });
  }
  res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }) });
});

/* ---------------- form meta ---------------- */
router.get('/meta/form', requirePermission('offer.view'), (req, res) => {
  res.json({ canSeeSalary: canSeeOfferSalary(req.user), canEditSalary: canEditOfferSalary(req.user), statuses: OFFER_STATUSES });
});

// Preview printable offer letter (HTML — open in browser, Ctrl+P to save as PDF)
router.get('/:id/preview', requirePermission('offer.view'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  const cand = Candidates.byId(o.candidate_id);
  // The salary BREAKDOWN (basic / accommodation / transportation / others, and
  // an area allowance on some offers) is what the signed letters actually show,
  // and it varies per offer. It is held in `benefits`, which the schema already
  // documents as "JSON or text". A plain-text or absent value falls back to the
  // single salary figure rather than rendering an empty table.
  let components = null;
  try {
    const parsed = o.benefits ? JSON.parse(o.benefits) : null;
    if (Array.isArray(parsed?.components)) components = parsed.components;
    else if (Array.isArray(parsed)) components = parsed;
  } catch { components = null; }

  const html = offerLetterHtml({
    refNo: o.offer_no,
    offerDate: o.created_at,
    candidateName: cand?.full_name,
    titlePrefix: cand?.title || null,
    position: o.position_title,
    currency: o.currency || 'EGP',
    components,
    totalNet: components ? null : o.salary_offered,
    salary: o.salary_offered,
    allowances: 0,
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

export default router;
