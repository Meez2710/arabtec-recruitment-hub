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
import { APP, APP_TERMINAL, APP_LABELS, appNorm, appCanMove, REQ_TERMINAL, REQ_LABELS, reqNorm } from '../lib/stages.js';
import { sendMail } from '../lib/mailer.js';
import { applicationScopeFilter } from '../lib/candidate-scope.js';
import { deliveryPlan, candidateEmailReporter } from '../lib/candidate-email.js';
import {
  letterModel, letterHtml, draftModel, normaliseComponents, componentsTotal, parseComponents,
  TITLE_PREFIXES, SALARY_COMPONENTS, DEFAULT_VALIDITY_DAYS, letterDay, addDays, daysBetween,
} from '../lib/offer-letter.js';

const router = Router();
router.use(requireAuth);

// Offer statuses
const OFFER_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected_by_approver', 'sent', 'accepted', 'rejected_by_candidate', 'withdrawn', 'joined'];
// Terminal application stages come from lib/stages.js and are compared after
// alias normalisation, so a legacy 'withdrawn' or 'offer_rejected' row is
// treated exactly like its canonical 'rejected' / 'offer_declined'.
const isTerminalApp = (status) => APP_TERMINAL.includes(appNorm(status));
// A request that is closed, cancelled, rejected or expired has no position to
// offer. (On hold is a pause, not an end — whether a paused request may still
// issue offers is an HR policy question, recorded in the audit findings.)
const closedRequest = (requestId) => {
  const r = requestId ? Requests.byId(requestId) : null;
  return r && REQ_TERMINAL.includes(reqNorm(r.status)) ? r : null;
};
const closedRequestError = (r) => `Hiring request ${r.ticket_no || ''} is ${REQ_LABELS[reqNorm(r.status)] || r.status}, so it has no position to offer.`.replace('  ', ' ');

// The contractual terms of an offer: what the candidate is being offered. A
// change to any of these after submission is a different offer from the one
// the approver decided, so it goes back for approval (when the step is on).
// Notes and the expiry date are administrative and do not.
const CONTRACT_TERMS = [
  ['salaryOffered', 'salary_offered', 'salary'],
  ['salaryComponents', 'salary_components', 'salary breakdown'],
  ['currency', 'currency', 'currency'],
  ['benefits', 'benefits', 'benefits'],
  ['positionTitle', 'position_title', 'position'],
  ['joiningDate', 'joining_date', 'joining date'],
];
const sameTerm = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
const sameComponents = (a, b) => JSON.stringify(parseComponents(a)) === JSON.stringify(parseComponents(b));

// Letter fields shared by create and edit. Returns { error } or the cleaned
// values to merge into the body (salaryComponents also fixes salaryOffered to
// their total, so the stored total can never disagree with the breakdown).
function letterFields(d, user) {
  const out = {};
  if (d.titlePrefix !== undefined && d.titlePrefix !== null && d.titlePrefix !== '') {
    if (!TITLE_PREFIXES.includes(d.titlePrefix)) return { error: `Title must be one of ${TITLE_PREFIXES.join(', ')}.` };
    out.titlePrefix = d.titlePrefix;
  }
  if (d.salutationName !== undefined && d.salutationName !== null) {
    const v = String(d.salutationName).trim();
    if (v.length > 60) return { error: 'The salutation name is too long.' };
    out.salutationName = v;
  }
  if (d.salaryComponents !== undefined) {
    if (!canEditOfferSalary(user)) return { error: 'You are not permitted to edit offer salary.', status: 403 };
    const n = normaliseComponents(d.salaryComponents);
    if (n.error) return { error: n.error };
    out.salaryComponents = n.value;
    if (n.value) out.salaryOffered = componentsTotal(n.value);
  }
  return { values: out };
}
// Offers that can no longer be edited. A sent offer is on record with the
// candidate: its terms are the issued terms, and a correction is a withdrawal
// plus a new offer, never a silent edit.
const LOCKED_OFFER = ['sent', 'accepted', 'joined', 'withdrawn', 'rejected_by_candidate', 'rejected_by_approver'];

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
    positionTitle: o.position_title, currency: o.currency, joiningDate: o.joining_date, expiryDate: o.expiry_date,
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
    salaryComponents: seeSalary ? parseComponents(o.salary_components) : null,
    titlePrefix: o.title_prefix || null, salutationName: o.salutation_name || null,
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

// One approval layer: the HR Director decides every offer, whatever its value.
// There is no HR Manager step and no salary threshold. The step carries the
// director-only permission, so an HR Manager, who prepares and sends offers,
// cannot approve or reject one. (The `offer_director_threshold` system setting
// is no longer read.)
function buildChain() {
  return [{ level: 1, name: 'HR Director', roleCode: 'offer.approve_director' }];
}
// The offer approval step can be switched off from Workflow Settings (the
// offer_approval_required system setting, system.manage, audited). Off means
// a submitted offer is approved at once — recorded as auto-approved, never
// silently. A missing setting means the step is required.
function offerApprovalRequired() {
  return SystemSettings.all().offer_approval_required !== 'false';
}
// Whether the user may decide the pending step. Kept next to the chain so the
// approve and reject routes cannot drift apart.
function mayDecide(user, pending) {
  const needsDirector = pending.level >= 2 || pending.role_code === 'offer.approve_director';
  return !needsDirector || user.permissions.includes('offer.approve_director');
}

// Offer visibility follows candidate assignment scope (AR-01). Broad roles see
// every offer; a scoped offer viewer (e.g. a Hiring Manager) sees only offers
// on their own requests or on applications they interview — the same rule the
// candidate profile already applies to its nested offers.
const offerScope = (user) => { const inScope = applicationScopeFilter(user); return (o) => inScope({ id: o.application_id, request_id: o.request_id }); };
const OFFER_OUT_OF_SCOPE = 'You can only view offers for candidates assigned to you.';

/* ---------------- LIST ---------------- */
router.get('/', requirePermission('offer.view'), (req, res) => {
  const rows = Offers.list({
    status: req.query.status, requestId: req.query.requestId, preparedBy: req.query.preparedBy,
    q: req.query.q, joiningFrom: req.query.joiningFrom, joiningTo: req.query.joiningTo,
  }).filter(offerScope(req.user));
  res.json({ offers: rows.map((o) => serialize(o, req.user)) });
});

/* ---------------- DETAIL ---------------- */
router.get('/:id', requirePermission('offer.view'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  if (!offerScope(req.user)(o)) return res.status(403).json({ error: OFFER_OUT_OF_SCOPE });
  res.json({ offer: serialize(o, req.user, { detail: true }) });
});

/* ---------------- offers for an application ---------------- */
router.get('/application/:applicationId', requirePermission('offer.view'), (req, res) => {
  const offers = Offers.forApplication(Number(req.params.applicationId)).filter(offerScope(req.user)).map((o) => serialize(o, req.user));
  res.json({ offers });
});

/* ---------------- LIVE LETTER (Create offer, nothing saved) ---------------- */
// The Create offer form shows the letter beside it while the recruiter types.
// It is rendered by the same code as the issued letter (lib/offer-letter.js),
// with each empty variable drawn as a blank to fill. It shows salary, so it
// carries the salary-view permission as well as offer.create.
router.post('/letter-draft', requirePermission('offer.create'), (req, res) => {
  if (!canSeeOfferSalary(req.user)) return res.status(403).json({ error: 'You are not permitted to view offer salary.' });
  const d = req.body || {};
  let cand = null; let position = d.positionTitle;
  if (d.applicationId) {
    const app = Applications.byId(Number(d.applicationId));
    if (app) {
      cand = Candidates.byId(app.candidate_id);
      if (!position) position = Requests.byId(app.request_id)?.title || '';
    }
  } else if (d.candidateId) {
    cand = Candidates.byId(Number(d.candidateId));
  }
  if (!position && d.requestId) position = Requests.byId(Number(d.requestId))?.title || '';
  const model = draftModel({ ...d, positionTitle: position }, cand);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(letterHtml(model, { placeholders: true }));
});

/* ---------------- CREATE ---------------- */
router.post('/', requirePermission('offer.create'), (req, res) => {
  const d = req.body || {};
  // From an application (the pipeline), or standalone: a candidate with an
  // optional hiring request. A standalone offer moves no application status
  // and fills no seat; the HR Director approval step applies all the same.
  let app = null;
  let candidateId; let requestId = null;
  if (d.applicationId) {
    app = Applications.byId(Number(d.applicationId));
    if (!app) return res.status(404).json({ error: 'Application not found.' });
    candidateId = app.candidate_id; requestId = app.request_id;
  } else {
    if (!d.candidateId) return res.status(400).json({ error: 'A candidate is required.' });
    if (!Candidates.byId(Number(d.candidateId))) return res.status(404).json({ error: 'Candidate not found.' });
    candidateId = Number(d.candidateId);
    if (d.requestId) {
      if (!Requests.byId(Number(d.requestId))) return res.status(404).json({ error: 'Hiring request not found.' });
      requestId = Number(d.requestId);
    }
    if (!(d.positionTitle || '').trim() && !requestId) return res.status(400).json({ error: 'A position title is required.' });
  }

  // Cannot create for a terminal/on-hold application unless authorized override.
  if (app && isTerminalApp(app.status)) {
    if (!d.overrideTerminal) return res.status(409).json({ error: `Cannot create an offer for a ${app.status} application.`, applicationStatus: app.status });
    if (!req.user.permissions.includes('candidate.merge')) return res.status(403).json({ error: 'You are not permitted to override offer creation for this application.' });
    if (!d.overrideReason || !d.overrideReason.trim()) return res.status(400).json({ error: 'A reason is required to override.' });
  }
  // A closed/cancelled request: same override discipline as a terminal application.
  const deadReq = closedRequest(requestId);
  if (deadReq) {
    if (!d.overrideTerminal) return res.status(409).json({ error: closedRequestError(deadReq), requestStatus: reqNorm(deadReq.status) });
    if (!req.user.permissions.includes('candidate.merge')) return res.status(403).json({ error: 'You are not permitted to override offer creation for this request.' });
    if (!d.overrideReason || !d.overrideReason.trim()) return res.status(400).json({ error: 'A reason is required to override.' });
  }
  // One active offer per application.
  if (app && Offers.activeForApplication(app.id)) return res.status(409).json({ error: 'An active offer already exists for this application.' });

  if (d.joiningDate && new Date(d.joiningDate) < new Date(new Date().toDateString())) {
    return res.status(400).json({ error: 'Joining date cannot be in the past.' });
  }
  if (d.expiryDate && isNaN(new Date(d.expiryDate))) return res.status(400).json({ error: 'Invalid expiry date.' });
  const lf = letterFields(d, req.user);
  if (lf.error) return res.status(lf.status || 400).json({ error: lf.error });
  // Salary only settable by authorized roles; a breakdown fixes the total.
  const salaryOffered = lf.values.salaryOffered != null ? lf.values.salaryOffered
    : (canEditOfferSalary(req.user) && d.salaryOffered != null && d.salaryOffered !== '' ? Number(d.salaryOffered) : null);

  const req2 = requestId ? Requests.byId(requestId) : null;
  const offerNo = Offers.nextNo();
  const created = Offers.create({
    offerNo, applicationId: app ? app.id : null, candidateId, requestId, expiryDate: d.expiryDate,
    positionTitle: d.positionTitle || req2?.title, salaryOffered, currency: d.currency || req2?.currency || 'EGP',
    benefits: d.benefits, joiningDate: d.joiningDate, notes: d.notes, status: 'draft',
    preparedBy: req.user.id, createdBy: req.user.id,
    titlePrefix: lf.values.titlePrefix, salutationName: lf.values.salutationName, salaryComponents: lf.values.salaryComponents,
  });
  OfferActivity.add(created.id, req.user, 'created', { toStatus: 'draft', note: `Offer ${offerNo} prepared` });
  CandidateActivity.add({ candidateId, applicationId: app ? app.id : null, actorId: req.user.id, actorName: req.user.fullName, type: 'offer_created', note: offerNo });

  // Move application to Offer Preparation if it's not already past it (controlled workflow step).
  if (app && ![APP.ISSUING_OFFER, APP.OFFER_SENT, APP.JOINED].includes(appNorm(app.status))) {
    StageHistory.add(app.id, app.status, APP.ISSUING_OFFER, req.user, 'Auto on offer creation');
    Applications.setStatus(app.id, APP.ISSUING_OFFER);
    CandidateActivity.add({ candidateId: app.candidate_id, applicationId: app.id, actorId: req.user.id, actorName: req.user.fullName, type: 'application_status_changed', note: `→ issuing_offer` });
    writeAudit(req, { action: 'application.status_changed', entityType: 'application', entityId: app.id, oldValue: { status: app.status }, newValue: { status: APP.ISSUING_OFFER }, comments: 'Auto on offer creation' });
  }
  if (requestId) Requests.stampLifecycle(requestId, 'first_offer_at'); // lifecycle: first offer created
  writeAudit(req, { action: 'offer.created', entityType: 'offer', entityId: created.id, newValue: { offerNo, applicationId: app ? app.id : null, candidateId, requestId, standalone: !app }, comments: d.overrideTerminal ? `Override: ${d.overrideReason}` : null });
  res.status(201).json({ offer: serialize(created, req.user, { detail: true }) });
});

/* ---------------- EDIT (a change to the contractual terms triggers re-approval) ---------------- */
router.put('/:id', requirePermission('offer.edit'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  if (o.status === 'sent') {
    return res.status(409).json({ error: 'A sent offer cannot be edited: its terms are what the candidate received. Withdraw it and prepare a new offer to change them.', offerStatus: o.status });
  }
  if (LOCKED_OFFER.includes(o.status)) {
    return res.status(409).json({ error: `Cannot edit a ${o.status} offer.`, offerStatus: o.status });
  }
  const lf = letterFields(req.body || {}, req.user);
  if (lf.error) return res.status(lf.status || 400).json({ error: lf.error });
  const d = { ...(req.body || {}), ...lf.values };
  if (d.joiningDate && new Date(d.joiningDate) < new Date(new Date().toDateString())) return res.status(400).json({ error: 'Joining date cannot be in the past.' });
  const salaryAllowed = canEditOfferSalary(req.user);
  if (req.body?.salaryOffered !== undefined && !salaryAllowed) return res.status(403).json({ error: 'You are not permitted to edit offer salary.' });
  // Benefits are shown only to offer.salary_view holders; a user who cannot
  // see them cannot change them either.
  if (d.benefits != null && !sameTerm(d.benefits, o.benefits) && !canSeeOfferSalary(req.user)) {
    return res.status(403).json({ error: 'You are not permitted to edit offer benefits.' });
  }

  // Which contractual terms actually change. `null`/absent means "not sent",
  // exactly as Offers.update reads it, so an untouched hidden field never
  // counts as a change.
  const changed = CONTRACT_TERMS.filter(([key, col]) => {
    if (key === 'salaryComponents') return d[key] !== undefined && !sameComponents(d[key], o[col]);
    if (d[key] == null) return false;
    if (key === 'salaryOffered') return salaryAllowed && Number(d[key]) !== o[col];
    return !sameTerm(d[key], o[col]);
  });
  const before = { salary: o.salary_offered, status: o.status };
  const updated = Offers.update(o.id, d, { salaryAllowed });
  OfferActivity.add(o.id, req.user, 'edited', changed.length ? { note: `Changed: ${changed.map((c) => c[2]).join(', ')}` } : {});
  if (changed.some(([key]) => key === 'salaryOffered')) {
    writeAudit(req, { action: 'offer.salary_changed', entityType: 'offer', entityId: o.id, oldValue: { salary: before.salary }, newValue: { salary: updated.salary_offered } });
  }
  if (changed.length) {
    const terms = changed.filter(([key]) => key !== 'salaryOffered');
    if (terms.length) {
      writeAudit(req, {
        action: 'offer.terms_changed', entityType: 'offer', entityId: o.id,
        oldValue: Object.fromEntries(terms.map(([key, col]) => [key, key === 'salaryComponents' ? parseComponents(o[col]) : o[col]])),
        newValue: Object.fromEntries(terms.map(([key, col]) => [key, key === 'salaryComponents' ? parseComponents(updated[col]) : updated[col]])),
      });
    }
    // A change after submission or approval is a different offer from the one
    // decided, so it is decided again — unless the approval step is switched
    // off, in which case there is nobody to re-approve.
    if (['pending_approval', 'approved'].includes(o.status) && offerApprovalRequired()) {
      OfferApprovals.clear(o.id);
      OfferApprovals.createChain(o.id, buildChain());
      Offers.setStatus(o.id, 'pending_approval', { approved_by: null });
      const what = changed.map((c) => c[2]).join(', ');
      OfferActivity.add(o.id, req.user, 'reapproval_required', { fromStatus: o.status, toStatus: 'pending_approval', note: `Terms changed (${what}) — re-approval required` });
      writeAudit(req, { action: 'offer.reapproval_required', entityType: 'offer', entityId: o.id, oldValue: { status: o.status }, newValue: { status: 'pending_approval', changed: changed.map((c) => c[0]) } });
      if (o.status === 'approved') {
        notifyEvent('offer.pending_approval', {
          ...offerNotifyCtx(o, req.user),
          title: `Offer approval needed again: ${o.offer_no}`,
          body: `The approved terms changed (${what}), so the offer needs your decision again before it can be sent.`,
        });
      }
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
  if (!offerApprovalRequired()) {
    OfferApprovals.clear(o.id);
    Offers.setStatus(o.id, 'approved');
    OfferActivity.add(o.id, req.user, 'auto_approved', { fromStatus: 'draft', toStatus: 'approved', note: 'Approved automatically — the offer approval step is switched off' });
    writeAudit(req, { action: 'offer.auto_approved', entityType: 'offer', entityId: o.id });
    notifyEvent('offer.approved', {
      ...offerNotifyCtx(o, req.user, { approverName: 'Approval step off' }),
      title: `Offer ready to send: ${o.offer_no}`,
      body: 'The offer approval step is switched off, so this offer can be sent.',
    });
    return res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }) });
  }
  OfferApprovals.clear(o.id);
  OfferApprovals.createChain(o.id, buildChain());
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
  // Separation of duties: the director step requires the distinct
  // offer.approve_director permission, not just offer.approve.
  if (!mayDecide(req.user, pending)) {
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
  // The same authority that approves is the one that rejects.
  if (pending && !mayDecide(req.user, pending)) {
    return res.status(403).json({ error: 'This approval step requires HR Director authority.' });
  }
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
  // Issuing binds the company to a position. A request closed or cancelled
  // since approval has none: refuse, change nothing (withdraw the offer, or
  // reopen the request first).
  const deadReq = closedRequest(o.request_id);
  if (deadReq) return res.status(409).json({ error: `${closedRequestError(deadReq)} Reopen the request or withdraw the offer.`, requestStatus: reqNorm(deadReq.status) });
  // The application must still be able to reach Offer Sent. An approved offer
  // can outlive a later decision on the candidate — rejected, put on hold, or
  // a declined offer — and sending it then would silently revive the stopped
  // application. Refuse, and change nothing.
  const app = o.application_id ? Applications.byId(o.application_id) : null;
  if (app && appNorm(app.status) !== APP.OFFER_SENT && !appCanMove(app.status, APP.OFFER_SENT)) {
    const label = APP_LABELS[appNorm(app.status)] || app.status;
    return res.status(409).json({
      error: `The application is ${label}, so this offer cannot be sent. Resume the application to Issuing Offer first, or withdraw the offer.`,
      applicationStatus: appNorm(app.status),
    });
  }
  // The letter states "valid for N days from the document date", N from the
  // expiry date. An expiry already passed would print a nonsensical validity,
  // so it must be corrected first; no expiry means the standard 5 days, and the
  // record is given that date so the letter and the record agree.
  const sentAt = new Date();
  const today = letterDay(sentAt); // the letter's (Cairo) calendar day
  if (o.expiry_date && daysBetween(today, String(o.expiry_date).slice(0, 10)) < 1) {
    return res.status(409).json({ error: 'The offer expiry date is not after today. Set a later expiry date before sending.', expiryDate: o.expiry_date });
  }
  const expiry = o.expiry_date || addDays(today, DEFAULT_VALIDITY_DAYS);
  Offers.setStatus(o.id, 'sent', { sent_at: sentAt.toISOString(), expiry_date: expiry });
  // Controlled application stage move: → offer_sent
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
  // The email and its attached letter are rendered from the same model as the
  // preview (lib/offer-letter.js), from the record as it now stands — sent, so
  // the document date is the issue date.
  const issued = Offers.byId(o.id);
  const model = letterModel(issued, cand);
  const sentOut = notifyEvent('offer.sent', {
    ...offerNotifyCtx(o, req.user, { letter: model }),
    attachments: [{ filename: `Job Offer ${model.reference.replace(/\//g, '-')}.html`, contentType: 'text/html; charset=utf-8', content: letterHtml(model, { screenNotes: false }) }],
    title: `Offer issued: ${o.offer_no}`,
    body: `The offer to ${cand ? cand.full_name : 'the candidate'} is issued.`,
    // The real delivery outcome lands on the candidate's activity when the
    // mailer finishes — never claimed up front.
    onExternalResult: cand ? candidateEmailReporter({ candidateId: cand.id, applicationId: o.application_id, actorId: req.user.id, what: 'Offer letter email' }) : undefined,
  });
  // Issuing (the offer is now Sent, on record) and delivery (did an email go)
  // are separate facts; the response says both, and never more than is known.
  const delivery = deliveryPlan(sentOut, cand);
  OfferActivity.add(o.id, req.user, 'delivery', { note: delivery.state === 'queued' ? `Email queued to ${delivery.to}` : `No email sent — ${delivery.message}` });
  res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }), delivery });
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
    // A terminal application (already rejected or joined) keeps its own
    // outcome; the decline is recorded on the offer.
    if (app && appNorm(app.status) !== APP.OFFER_DECLINED && !isTerminalApp(app.status)) {
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
    if (!app) {
      // Standalone offer: no application and no seat to fill. The offer is
      // settled as joined and nothing else moves.
      Offers.setStatus(o.id, 'joined', { joined_at: new Date().toISOString() });
      OfferActivity.add(o.id, req.user, 'joined', { toStatus: 'joined', note: 'Standalone offer — no seat filled' });
      writeAudit(req, { action: 'offer.joined', entityType: 'offer', entityId: o.id, comments: 'Standalone offer (no application)' });
      return res.json({ offer: serialize(Offers.byId(o.id), req.user, { detail: true }) });
    }
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
  res.json({ canSeeSalary: canSeeOfferSalary(req.user), canEditSalary: canEditOfferSalary(req.user), statuses: OFFER_STATUSES, titlePrefixes: TITLE_PREFIXES, salaryComponents: SALARY_COMPONENTS.map(({ key, label }) => ({ key, label })), defaultValidityDays: DEFAULT_VALIDITY_DAYS });
});

// Preview printable offer letter (HTML — open in browser, Ctrl+P to save as PDF)
router.get('/:id/preview', requirePermission('offer.view'), (req, res) => {
  const o = Offers.byId(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  if (!offerScope(req.user)(o)) return res.status(403).json({ error: OFFER_OUT_OF_SCOPE });
  // The letter shows the salary and its breakdown, so it is held to the same
  // permission as the salary on the record.
  if (!canSeeOfferSalary(req.user)) return res.status(403).json({ error: 'You are not permitted to view offer salary, so you cannot open the offer letter.' });
  const model = letterModel(o, Candidates.byId(o.candidate_id));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(letterHtml(model));
});

export default router;
