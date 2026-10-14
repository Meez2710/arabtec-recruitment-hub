import { canSeeApplicationStage } from '../lib/pipeline-visibility.js';
// Arabtec Interview Assessment Form — Big Five (HR) + Role Competency (Technical)
// Implements the finalized Arabtec assessment PDF: two evaluations per
// application (each saved as a draft or submitted), critical flags, server-derived
// fit, per-evaluator recommendation, and one shared final human decision.
//
// Trust boundary: the application comes only from the route, the evaluator only
// from the session, and every read/write is limited to applications the caller
// may see under the existing interview scope rules. WHICH PARTS of the
// assessment a caller may see or change is decided only by
// lib/assessment-policy.js — serialization, writes and the preview all ask it.
import { Router } from 'express';
import { Assessments, Applications, Candidates, Requests, Departments, Interviews, SystemSettings, Audit } from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { tx } from '../lib/db.js';
import {
  HR_CRITERIA, TECHNICAL_CRITERIA, CRITICAL_FLAGS, BEHAVIORAL_INSTRUCTION,
  DECISIONS, LEGACY_FINAL_DECISIONS, FIT_LEVELS, SCORE_GUIDE, NA_LABEL, CANDIDATE_FIELDS,
  JUSTIFICATION_MAX, FINAL_NOTES_MAX,
  summarize, parseStored, normalizeStoredSection, normalizeStoredFlags,
  validateSection, storableSection, validateFlags, decisionLabel,
  assessmentHtml,
} from '../lib/assessment.js';
import {
  canAccessApplication, isAssessmentUnlocked, resolveAllAssessmentPermissions, criterionPolicyKey,
  ASSESSMENT_POLICY_SETTING, POLICY_MANAGE_PERMISSION, policyDefinition, effectivePolicy,
  storedOverrides, validatePolicyOverrides, DEFAULT_POLICY,
} from '../lib/assessment-policy.js';

const router = Router();
router.use(requireAuth);

const DECISION_VALUES = DECISIONS.map((d) => d.value);

const SECTION = {
  hr: { field: 'behavioral', policy: 'assessment.behavioral', criteria: HR_CRITERIA, fitCol: 'behavioralFit', justification: 'behavioralJustification', justificationPolicy: 'assessment.finalRecommendation.behavioralJustification' },
  technical: { field: 'technical', policy: 'assessment.technical', criteria: TECHNICAL_CRITERIA, fitCol: 'technicalFit', justification: 'technicalJustification', justificationPolicy: 'assessment.finalRecommendation.technicalJustification' },
};

const has = (user, p) => user.permissions.includes(p);
const FLAGS = 'assessment.criticalFlags';
const FINAL = 'assessment.finalRecommendation';

/** Load the route's application and enforce scope; sends the error itself. */
function scopedApplication(req, res) {
  const id = Number(req.params.applicationId);
  const app = Number.isInteger(id) && id > 0 ? Applications.byId(id) : null;
  if (!app) { res.status(404).json({ error: 'Application not found.' }); return null; }
  if (!canSeeApplicationStage(req.user, app) || !canAccessApplication(req.user, app)) {
    res.status(403).json({ error: 'You can only access assessments for applications assigned to you.' });
    return null;
  }
  return app;
}

// ── Read model ───────────────────────────────────────────────────────────

// SQLite's datetime('now') default has no zone marker ("2026-10-01 09:00:00")
// but is UTC; mark it so clients do not read it as local time.
function utcIso(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts.toISOString();
  const s = String(ts);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d) ? s : d.toISOString();
}

// Full (unfiltered) evaluation — used for writes and audit, never sent as-is.
function presentEvaluation(row, type) {
  if (!row) return null;
  const sec = SECTION[type];
  const { rows, legacy } = normalizeStoredSection(parseStored(row[sec.field]), sec.criteria);
  const summary = summarize(rows, sec.criteria);
  const savedFit = (type === 'hr' ? row.behavioral_fit : row.technical_fit) || null;
  const criticalFlags = normalizeStoredFlags(parseStored(row.critical_flags));
  const justification = (type === 'hr' ? row.behavioral_justification : row.technical_justification) || '';
  const submitted = row.submitted === 1 || row.submitted === true;
  return {
    id: row.id, evaluatorType: type,
    evaluatorId: row.evaluator_id, evaluatorName: row.evaluator_name,
    status: submitted ? 'submitted' : 'draft', submitted,
    rows, summary, legacyKeys: legacy,
    criticalFlags, reviewRequired: Object.values(criticalFlags).some(Boolean),
    recommendation: row.recommendation || null,
    justification,
    computedFit: summary.fit,
    savedFit,
    // A manually chosen fit from the previous form stays visible as history
    // until the evaluation is edited; viewing never rewrites it.
    fitHistorical: !!savedFit && savedFit !== summary.fit,
    createdAt: utcIso(row.created_at), updatedAt: utcIso(row.updated_at),
  };
}

// What this caller may receive of one evaluation, per the field policy. A
// hidden section is absent (null); hidden parts of a visible section are
// removed, not blanked — and so is anything derived from them (a section
// average would reveal a hidden criterion's score).
function filterEvaluation(ev, type, perms) {
  const sec = SECTION[type];
  if (!ev || !perms[sec.policy].canView) return null;
  const rows = {};
  let allRows = true;
  for (const c of sec.criteria) {
    if (perms[criterionPolicyKey(type, c.key)].canView) rows[c.key] = ev.rows[c.key];
    else allRows = false;
  }
  const out = {
    id: ev.id, evaluatorType: type, evaluatorId: ev.evaluatorId, evaluatorName: ev.evaluatorName,
    status: ev.status, submitted: ev.submitted, rows, legacyKeys: ev.legacyKeys.filter((k) => k in rows),
    recommendation: ev.recommendation, createdAt: ev.createdAt, updatedAt: ev.updatedAt,
    [sec.field]: rows,
  };
  if (allRows) {
    Object.assign(out, { summary: ev.summary, computedFit: ev.computedFit, savedFit: ev.savedFit, fitHistorical: ev.fitHistorical, [sec.fitCol]: ev.savedFit });
  }
  if (perms[FLAGS].canView) Object.assign(out, { criticalFlags: ev.criticalFlags, reviewRequired: ev.reviewRequired });
  if (perms[sec.justificationPolicy].canView) Object.assign(out, { justification: ev.justification, [sec.justification]: ev.justification });
  return out;
}

function latestInterview(appId) {
  const live = Interviews.forApplication(appId).filter((iv) => iv.status !== 'cancelled' && iv.scheduled_at);
  live.sort((a, b) => String(b.scheduled_at).localeCompare(String(a.scheduled_at)));
  const iv = live[0];
  return iv ? { id: iv.id, interviewNo: iv.interview_no, scheduledAt: utcIso(iv.scheduled_at), status: iv.status, type: iv.interview_type } : null;
}

function education(c) {
  const main = [c.major, c.university].filter((x) => x != null && String(x).trim() !== '').join(', ');
  if (!main) return c.graduation_year ? `Graduated ${c.graduation_year}` : null;
  return c.graduation_year ? `${main} (${c.graduation_year})` : main;
}

// Candidate Personal Information: only the fields this caller may view are
// computed and returned at all — a withheld value never leaves the server.
function context(app, cand, reqRow, perms) {
  const value = {
    fullName: () => cand?.full_name || null,
    position: () => app.position_applied || reqRow?.title || null,
    department: () => { const d = reqRow?.department_id ? Departments.byId(reqRow.department_id) : null; return d?.name || null; },
    interview: () => latestInterview(app.id),
    education: () => (cand ? education(cand) : null),
    yearsExperience: () => cand?.years_experience ?? null,
    currentEmployer: () => (cand ? (cand.employer || cand.current_company || null) : null),
    noticePeriod: () => cand?.notice_period || null,
    // No current-salary field exists on the candidate record.
    currentSalary: () => null,
    expectedSalary: () => cand?.expected_salary ?? null,
  };
  const out = {};
  for (const f of CANDIDATE_FIELDS) if (perms[f.policy].canView) out[f.context] = value[f.context]();
  out.salaryVisible = perms['assessment.candidate.expectedSalary'].canView;
  return out;
}

function presentFinal(appId) {
  const f = Assessments.finalDecision(appId);
  if (!f) return null;
  return {
    decision: f.decision, decisionLabel: decisionLabel(f.decision),
    historical: LEGACY_FINAL_DECISIONS.some((d) => d.value === f.decision),
    decidedById: f.decided_by, decidedByName: f.decided_by_name,
    notes: f.notes, decidedAt: utcIso(f.decided_at),
  };
}

function bundle(app, user) {
  const perms = resolveAllAssessmentPermissions(user, app);
  const cand = Candidates.byId(app.candidate_id);
  const reqRow = app.request_id ? Requests.byId(app.request_id) : null;
  const unlocked = isAssessmentUnlocked(app);
  const out = {
    applicationId: app.id,
    applicationNo: app.application_no,
    unlocked,
    // Scope was enforced before building the bundle.
    canEdit: unlocked && has(user, 'interview.feedback'),
    permissions: perms,
    context: context(app, cand, reqRow, perms),
    candidate: cand && perms['assessment.candidate.fullName'].canView ? { id: cand.id, fullName: cand.full_name } : null,
    request: reqRow ? { id: reqRow.id, ticketNo: reqRow.ticket_no, title: reqRow.title } : null,
    hr: filterEvaluation(presentEvaluation(Assessments.byType(app.id, 'hr'), 'hr'), 'hr', perms),
    technical: filterEvaluation(presentEvaluation(Assessments.byType(app.id, 'technical'), 'technical'), 'technical', perms),
  };
  if (perms[FINAL].canView) out.finalDecision = presentFinal(app.id);
  return out;
}

// What the audit trail records for one evaluation. No candidate or salary data.
function auditView(ev) {
  if (!ev) return null;
  return {
    evaluatorType: ev.evaluatorType, state: ev.status,
    evaluatorId: ev.evaluatorId, evaluatorName: ev.evaluatorName,
    scores: ev.rows, criticalFlags: ev.criticalFlags, recommendation: ev.recommendation,
    justification: ev.justification,
    average: ev.summary.average, scoredCount: ev.summary.scoredCount, naCount: ev.summary.naCount,
    fit: ev.computedFit, savedAt: ev.updatedAt,
  };
}

// ── Write validation ─────────────────────────────────────────────────────

// Candidate details have assessment policy keys but are never written from the
// assessment: a request naming one is refused by the policy (403), not
// mistaken for a typo (400).
const CANDIDATE_BODY_FIELDS = {
  fullName: 'assessment.candidate.fullName', position: 'assessment.candidate.position',
  department: 'assessment.candidate.department', interviewDate: 'assessment.candidate.interviewDate',
  education: 'assessment.candidate.education', yearsExperience: 'assessment.candidate.yearsExperience',
  currentEmployer: 'assessment.candidate.currentEmployer', availability: 'assessment.candidate.availability',
  noticePeriod: 'assessment.candidate.availability',
  currentSalary: 'assessment.candidate.currentSalary', expectedSalary: 'assessment.candidate.expectedSalary',
};
const denied = (res, field, what) => res.status(403).json({ error: `You do not have permission to change ${what}.`, field });

// Fields a client may send for an evaluation. Anything else — including any
// attempt to name the application, evaluator or timestamps — is rejected.
// The previous form's discretionary fit is accepted and ignored: fit is derived.
// Returns which parts were actually sent, so absent parts keep their stored
// value and one stakeholder's save never clears another's work.
function parseEvaluationBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be an object.' };
  const type = body.evaluatorType;
  if (!SECTION[type]) return { error: 'evaluatorType must be hr or technical.' };
  const sec = SECTION[type];
  // editReason: why a SUBMITTED evaluation is being changed — recorded on the
  // audit entry and shown in the history. The form requires it; the API keeps
  // accepting an update without one (AR-02), so nothing that worked breaks.
  const allowed = new Set(['evaluatorType', 'submitted', sec.field, 'criticalFlags', 'recommendation', sec.justification, sec.fitCol, 'editReason']);
  for (const k of Object.keys(body)) {
    if (CANDIDATE_BODY_FIELDS[k]) return { forbidden: CANDIDATE_BODY_FIELDS[k] };
    if (!allowed.has(k)) return { error: `Field "${k}" is not accepted on a ${type} evaluation.` };
  }

  if (body.submitted !== undefined && typeof body.submitted !== 'boolean') return { error: 'submitted must be true or false.' };
  const scores = validateSection(body[sec.field], sec.criteria);
  if (scores.error) return { error: scores.error };
  const flags = body.criticalFlags === undefined ? null : validateFlags(body.criticalFlags);
  if (flags?.error) return { error: flags.error };
  const rec = body.recommendation;
  if (rec !== undefined && rec !== null && rec !== '' && !DECISION_VALUES.includes(rec)) return { error: 'Invalid recommendation.' };
  const just = body[sec.justification];
  if (just !== undefined && just !== null && typeof just !== 'string') return { error: 'Justification must be text.' };
  if (typeof just === 'string' && just.length > JUSTIFICATION_MAX) return { error: `Justification exceeds ${JUSTIFICATION_MAX} characters.` };
  const why = body.editReason;
  if (why !== undefined && why !== null && typeof why !== 'string') return { error: 'editReason must be text.' };
  if (typeof why === 'string' && why.length > JUSTIFICATION_MAX) return { error: `editReason exceeds ${JUSTIFICATION_MAX} characters.` };
  return {
    editReason: typeof why === 'string' && why.trim() ? why.trim() : null,
    // Absent `submitted` means "keep the current state" (AR-02); only an explicit false withdraws.
    type, submitted: body.submitted === undefined ? undefined : body.submitted, rows: scores.rows, provided: scores.provided,
    flags: flags ? flags.flags : undefined,
    recommendation: rec === undefined ? undefined : (rec || null),
    justification: just === undefined ? undefined : (typeof just === 'string' ? just : ''),
  };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Routes ───────────────────────────────────────────────────────────────

/* GET assessment bundle for an application */
router.get('/application/:applicationId', requirePermission('candidate.view'), (req, res) => {
  const app = scopedApplication(req, res); if (!app) return;
  res.json({ assessment: bundle(app, req.user) });
});

/* Save a draft of, or submit, an evaluation (hr or technical) */
router.post('/application/:applicationId', requirePermission('interview.feedback'), (req, res) => {
  const app = scopedApplication(req, res); if (!app) return;
  if (!isAssessmentUnlocked(app)) return res.status(409).json({ error: 'Assessment is available once the candidate reaches an interview stage.' });
  const p = parseEvaluationBody(req.body);
  if (p.forbidden) return denied(res, p.forbidden, 'candidate details from the assessment');
  if (p.error) return res.status(400).json({ error: p.error });
  const sec = SECTION[p.type];
  const perms = resolveAllAssessmentPermissions(req.user, app);
  if (!perms[sec.policy].canEdit) return denied(res, sec.policy, `the ${p.type === 'hr' ? 'behavioral' : 'technical'} assessment`);

  // Field scope, BEFORE anything is persisted: a part the caller may not edit
  // may be omitted or sent back unchanged, but never changed.
  const prev = presentEvaluation(Assessments.byType(app.id, p.type), p.type);
  const stored = prev?.rows || normalizeStoredSection(null, sec.criteria).rows;
  const storedFlags = prev?.criticalFlags || normalizeStoredFlags(null);
  const rows = { ...stored };
  for (const key of p.provided) {
    const k = criterionPolicyKey(p.type, key);
    if (!perms[k].canEdit && !same(p.rows[key], stored[key])) return denied(res, k, `“${sec.criteria.find((c) => c.key === key).label}”`);
    rows[key] = p.rows[key];
  }
  if (p.flags !== undefined && !perms[FLAGS].canEdit && !same(p.flags, storedFlags)) return denied(res, FLAGS, 'the critical flags');
  if (p.justification !== undefined && !perms[sec.justificationPolicy].canEdit && p.justification !== (prev?.justification || '')) return denied(res, sec.justificationPolicy, 'this justification');
  const flags = p.flags !== undefined ? p.flags : storedFlags;
  const justification = p.justification !== undefined ? p.justification : (prev?.justification || '');
  const recommendation = p.recommendation !== undefined ? p.recommendation : (prev?.recommendation || null);
  const summary = summarize(rows, sec.criteria);
  const submitted = p.submitted !== undefined ? p.submitted : !!prev?.submitted;

  if (submitted) {
    const missing = sec.criteria.filter((c) => rows[c.key].score == null).map((c) => c.label);
    if (missing.length) return res.status(400).json({ error: `Answer every criterion (a score or N/A) before submitting. Missing: ${missing.join(', ')}.`, missing });
    if (!recommendation) return res.status(400).json({ error: 'Choose a recommendation before submitting.' });
  }

  const action = submitted
    ? (prev?.submitted ? 'assessment.updated' : 'assessment.submitted')
    : (prev?.submitted ? 'assessment.updated' : 'assessment.draft_saved');

  tx(() => {
    const saved = Assessments.upsert({
      applicationId: app.id, evaluatorType: p.type,
      evaluatorId: req.user.id, evaluatorName: req.user.fullName,
      [sec.field]: storableSection(rows, sec.criteria),
      criticalFlags: flags,
      recommendation,
      [sec.fitCol]: summary.fit,
      [sec.justification]: justification,
      submitted,
    });
    writeAudit(req, {
      action, entityType: 'application', entityId: app.id,
      oldValue: auditView(prev),
      newValue: { ...auditView(presentEvaluation(saved, p.type)), previousState: prev ? prev.status : null },
      comments: prev?.submitted ? p.editReason : null,
    }, { strict: true });
  });
  res.status(201).json({ assessment: bundle(app, req.user) });
});

/* Shared final decision — a human record only; never moves the application */
router.post('/application/:applicationId/final', requirePermission('interview.feedback'), (req, res) => {
  const app = scopedApplication(req, res); if (!app) return;
  if (!isAssessmentUnlocked(app)) return res.status(409).json({ error: 'The final decision is available once the candidate reaches an interview stage.' });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Request body must be an object.' });
  for (const k of Object.keys(body)) if (k !== 'decision' && k !== 'notes') return res.status(400).json({ error: `Field "${k}" is not accepted on a final decision.` });
  const { decision, notes } = body;
  if (!DECISION_VALUES.includes(decision)) return res.status(400).json({ error: 'Invalid final decision.' });
  if (notes !== undefined && notes !== null && typeof notes !== 'string') return res.status(400).json({ error: 'Notes must be text.' });
  if (typeof notes === 'string' && notes.length > FINAL_NOTES_MAX) return res.status(400).json({ error: `Notes exceed ${FINAL_NOTES_MAX} characters.` });
  const perms = resolveAllAssessmentPermissions(req.user, app);
  if (!perms[FINAL].canEdit) return denied(res, FINAL, 'the final recommendation');

  const prev = presentFinal(app.id);
  tx(() => {
    Assessments.setFinalDecision({ applicationId: app.id, decision, decidedBy: req.user.id, decidedByName: req.user.fullName, notes: notes || null });
    writeAudit(req, {
      action: 'assessment.final_decision', entityType: 'application', entityId: app.id,
      oldValue: prev ? { decision: prev.decision, decidedById: prev.decidedById, decidedByName: prev.decidedByName, notes: prev.notes, decidedAt: prev.decidedAt } : null,
      newValue: { decision, decidedById: req.user.id, decidedByName: req.user.fullName },
      comments: notes || null,
    }, { strict: true });
  });
  res.status(201).json({ assessment: bundle(app, req.user) });
});

/* Reopen a submitted evaluation — the explicit way to change a submission.
   Returns the section to draft with a recorded reason. Allowed to whoever may
   edit that section under the field policy (the same gate as saving), so no
   one gains a right they did not have; what changes is that it is deliberate,
   explained and audited. The scores stay as they were. */
router.post('/application/:applicationId/reopen', requirePermission('interview.feedback'), (req, res) => {
  const app = scopedApplication(req, res); if (!app) return;
  if (!isAssessmentUnlocked(app)) return res.status(409).json({ error: 'Assessment is available once the candidate reaches an interview stage.' });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Request body must be an object.' });
  for (const k of Object.keys(body)) if (k !== 'evaluatorType' && k !== 'reason') return res.status(400).json({ error: `Field "${k}" is not accepted on a reopen.` });
  const sec = SECTION[body.evaluatorType];
  if (!sec) return res.status(400).json({ error: 'evaluatorType must be hr or technical.' });
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return res.status(400).json({ error: 'A reason is required to reopen a submitted assessment.' });
  if (reason.length > JUSTIFICATION_MAX) return res.status(400).json({ error: `Reason exceeds ${JUSTIFICATION_MAX} characters.` });
  const perms = resolveAllAssessmentPermissions(req.user, app);
  if (!perms[sec.policy].canEdit) return denied(res, sec.policy, `the ${body.evaluatorType === 'hr' ? 'behavioral' : 'technical'} assessment`);
  const prev = presentEvaluation(Assessments.byType(app.id, body.evaluatorType), body.evaluatorType);
  if (!prev) return res.status(404).json({ error: 'There is no saved evaluation to reopen.' });
  if (!prev.submitted) return res.status(409).json({ error: 'This evaluation is already a draft.' });
  tx(() => {
    Assessments.setSubmitted(app.id, body.evaluatorType, false);
    writeAudit(req, {
      action: 'assessment.reopened', entityType: 'application', entityId: app.id,
      oldValue: { evaluatorType: body.evaluatorType, state: 'submitted', evaluatorName: prev.evaluatorName, savedAt: prev.updatedAt },
      newValue: { evaluatorType: body.evaluatorType, state: 'draft', reopenedBy: req.user.fullName },
      comments: reason,
    }, { strict: true });
  });
  res.status(201).json({ assessment: bundle(app, req.user) });
});

/* History: who saved, submitted or reopened each part, when, and why.
   Only the parts this caller may see are listed, and never the scores. */
const HISTORY_ACTIONS = new Set(['assessment.draft_saved', 'assessment.submitted', 'assessment.updated', 'assessment.reopened', 'assessment.final_decision']);
router.get('/application/:applicationId/history', requirePermission('candidate.view'), (req, res) => {
  const app = scopedApplication(req, res); if (!app) return;
  const perms = resolveAllAssessmentPermissions(req.user, app);
  const rows = Audit.forEntity('application', app.id).filter((l) => HISTORY_ACTIONS.has(l.action));
  const out = [];
  for (const l of rows) {
    const nv = l.newValue || {}; const ov = l.oldValue || {};
    if (l.action === 'assessment.final_decision') {
      if (!perms[FINAL].canView) continue;
      out.push({ at: utcIso(l.at), actor: l.actorName, action: l.action, part: 'final', decision: nv.decision ? decisionLabel(nv.decision) : null, previous: ov.decision ? decisionLabel(ov.decision) : null });
      continue;
    }
    const type = nv.evaluatorType || ov.evaluatorType;
    if (!SECTION[type] || !perms[SECTION[type].policy].canView) continue;
    out.push({ at: utcIso(l.at), actor: l.actorName, action: l.action, part: type, state: nv.state || null, previousState: nv.previousState || ov.state || null, reason: l.comments || null });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  res.json({ history: out });
});

/* Form metadata (criteria + option lists matching the PDF) */
router.get('/meta', (req, res) => {
  res.json({
    behavioralCriteria: HR_CRITERIA,
    technicalCriteria: TECHNICAL_CRITERIA,
    behavioralInstruction: BEHAVIORAL_INSTRUCTION,
    criticalFlags: CRITICAL_FLAGS,
    decisions: DECISIONS,
    finalDecisions: DECISIONS,
    legacyFinalDecisions: LEGACY_FINAL_DECISIONS,
    fitLevels: FIT_LEVELS,
    scoreGuide: SCORE_GUIDE,
    naLabel: NA_LABEL,
    candidateFields: CANDIDATE_FIELDS.map(({ policy, label, context: key }) => ({ policy, label, key })),
  });
});

// ── Assessment Visibility & Permissions (settings) ──────────────────────

function policyPayload() {
  return { ...policyDefinition(), defaults: DEFAULT_POLICY, overrides: storedOverrides(), effective: effectivePolicy() };
}

router.get('/policy', requirePermission(POLICY_MANAGE_PERMISSION), (req, res) => res.json({ policy: policyPayload() }));

// Effective result of UNSAVED overrides, computed by the same resolver that
// enforces them, so the settings screen never interprets the policy itself.
router.post('/policy/preview', requirePermission(POLICY_MANAGE_PERMISSION), (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'overrides')) {
    return res.status(400).json({ error: 'Send { overrides }.' });
  }
  const v = validatePolicyOverrides(body.overrides);
  if (v.error) return res.json({ valid: false, error: v.error });
  res.json({ valid: true, effective: effectivePolicy(v.overrides) });
});

// Replaces the stored overrides (an empty object restores the defaults).
router.put('/policy', requirePermission(POLICY_MANAGE_PERMISSION), (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'overrides')) {
    return res.status(400).json({ error: 'Send { overrides }.' });
  }
  const v = validatePolicyOverrides(body.overrides);
  if (v.error) return res.status(400).json({ error: v.error });
  const before = storedOverrides();
  tx(() => {
    SystemSettings.upsert(ASSESSMENT_POLICY_SETTING, JSON.stringify(v.overrides));
    writeAudit(req, { action: 'assessment.policy_changed', entityType: 'system', entityId: ASSESSMENT_POLICY_SETTING, oldValue: before, newValue: v.overrides }, { strict: true });
  });
  res.json({ policy: policyPayload() });
});

// Printable assessment form (HTML — open in browser, Ctrl+P to save as PDF).
// Built from the same scoped, policy-filtered bundle as the JSON read.
router.get('/application/:applicationId/preview', requirePermission('candidate.view'), (req, res) => {
  const app = scopedApplication(req, res); if (!app) return;
  const html = assessmentHtml(bundle(app, req.user));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // The page carries no script; forbid any, even if escaping were ever bypassed.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:");
  res.send(html);
});

export default router;
