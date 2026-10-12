// Assessment field policy — the ONE place that decides who may see or change
// each part of the interview assessment. API serialization, API writes, the
// form, and the printable preview all ask resolveAssessmentPermission (or
// resolveAllAssessmentPermissions); none of them carry their own role checks.
//
// A permission is the AND of two layers:
//   1. Existing access (unchanged from before this module): candidate.view plus
//      application scope to view; interview.feedback, scope and an unlocked
//      interview stage to edit; salary.view for compensation fields.
//   2. The audience policy below: what each stakeholder group may view/edit.
// The policy can only narrow existing access, never widen it.
//
// Policy resolution: SYSTEM DEFAULT → stored ROLE POLICY override. A field with
// no entry of its own inherits its section's entry. (A per-interview override
// layer is deliberately not implemented yet; see the Packet 02 report.)
import { Interviews, Requests, SystemSettings } from './models.js';
import { HR_CRITERIA, TECHNICAL_CRITERIA, CANDIDATE_FIELDS } from './assessment.js';
import { appNorm } from './stages.js';

export const ASSESSMENT_POLICY_SETTING = 'assessment.field_policy';
export const POLICY_MANAGE_PERMISSION = 'interview.assessment_policy';

// Stakeholder audiences, derived from existing ATS roles (no new roles). A user
// holding several roles gets the union of their audiences' grants; a user with
// none of these roles falls into "other".
export const AUDIENCES = [
  { key: 'hr', label: 'HR / Recruitment', roles: ['system_admin', 'hr_director', 'hr_manager', 'recruitment_manager', 'recruiter'] },
  { key: 'technical', label: 'Technical Interviewer', roles: ['interviewer'] },
  { key: 'hiring_manager', label: 'Hiring Manager', roles: ['hiring_manager'] },
  { key: 'other', label: 'Other roles', roles: [] },
];
const AUDIENCE_KEYS = AUDIENCES.map((a) => a.key);

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// The policy tree. `editable: false` marks parts the assessment never writes
// (candidate details are edited on the candidate record, under its own rules).
export const POLICY_SECTIONS = [
  {
    key: 'assessment.candidate', label: 'Candidate Personal Information', editable: false,
    fields: CANDIDATE_FIELDS.map((f) => ({ key: f.policy, label: f.label, context: f.context, confidential: f.confidential })),
  },
  {
    key: 'assessment.behavioral', label: 'HR Assessment — Behavioral', editable: true,
    fields: HR_CRITERIA.map((c) => ({ key: `assessment.behavioral.${camel(c.key)}`, label: c.label, criterion: c.key })),
  },
  {
    key: 'assessment.technical', label: 'Technical Assessment — Role Competency', editable: true,
    fields: TECHNICAL_CRITERIA.map((c) => ({ key: `assessment.technical.${camel(c.key)}`, label: c.label, criterion: c.key })),
  },
  { key: 'assessment.criticalFlags', label: 'Critical Flags', editable: true, fields: [] },
  {
    key: 'assessment.finalRecommendation', label: 'Final Recommendation', editable: true,
    fields: [
      { key: 'assessment.finalRecommendation.behavioralJustification', label: 'Behavioral Justification' },
      { key: 'assessment.finalRecommendation.technicalJustification', label: 'Technical Justification' },
    ],
  },
];

const SECTION_OF = new Map();
const FIELD_DEF = new Map();
for (const s of POLICY_SECTIONS) {
  FIELD_DEF.set(s.key, { ...s, section: null });
  for (const f of s.fields) { SECTION_OF.set(f.key, s.key); FIELD_DEF.set(f.key, { ...f, section: s.key, editable: s.editable }); }
}
export const POLICY_KEYS = [...FIELD_DEF.keys()];
export const criterionPolicyKey = (type, criterion) =>
  `assessment.${type === 'hr' ? 'behavioral' : 'technical'}.${camel(criterion)}`;

// ── System defaults ─────────────────────────────────────────────────────
const V = { view: true, edit: false };
const VE = { view: true, edit: true };
const H = { view: false, edit: false };
const candidateDefaults = (salary) => Object.fromEntries(POLICY_SECTIONS[0].fields.map((f) => [f.key, f.confidential ? (salary ? V : H) : V]));
export const DEFAULT_POLICY = {
  // Owner decision, 5 Oct 2026: the recruitment team controls the whole
  // assessment — both sections, their justifications, the flags and the final
  // decision. Editing still needs interview.feedback and scope (layer 1), so
  // in practice this is the System Administrator, HR Manager, Recruitment
  // Manager and Recruiter; the HR Director (no interview.feedback) views only.
  // Technical interviewers and hiring managers keep their narrower defaults.
  hr: {
    ...candidateDefaults(true),
    'assessment.behavioral': VE,
    'assessment.technical': VE,
    'assessment.criticalFlags': VE,
    'assessment.finalRecommendation': VE,
    'assessment.finalRecommendation.technicalJustification': VE,
  },
  technical: {
    ...candidateDefaults(false),
    'assessment.behavioral': H,
    'assessment.technical': VE,
    'assessment.criticalFlags': VE,
    'assessment.finalRecommendation': V,
    'assessment.finalRecommendation.behavioralJustification': H,
    'assessment.finalRecommendation.technicalJustification': VE,
  },
  hiring_manager: {
    ...candidateDefaults(false),
    'assessment.behavioral': V,
    'assessment.technical': VE,
    'assessment.criticalFlags': VE,
    'assessment.finalRecommendation': V,
    'assessment.finalRecommendation.technicalJustification': VE,
  },
  other: {
    ...candidateDefaults(false),
    'assessment.behavioral': V,
    'assessment.technical': V,
    'assessment.criticalFlags': V,
    'assessment.finalRecommendation': V,
  },
};

// ── Stored overrides ────────────────────────────────────────────────────

/** Validate a client-sent overrides object. Returns { overrides } or { error }. */
export function validatePolicyOverrides(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return { error: 'Overrides must be an object keyed by audience.' };
  const out = {};
  for (const [aud, rules] of Object.entries(input)) {
    if (!AUDIENCE_KEYS.includes(aud)) return { error: `Unknown audience "${aud}".` };
    if (rules == null || typeof rules !== 'object' || Array.isArray(rules)) return { error: `Rules for "${aud}" must be an object.` };
    out[aud] = {};
    for (const [key, rule] of Object.entries(rules)) {
      const def = FIELD_DEF.get(key);
      if (!def) return { error: `Unknown assessment field "${key}".` };
      if (rule == null || typeof rule !== 'object' || Array.isArray(rule) || typeof rule.view !== 'boolean' || typeof rule.edit !== 'boolean'
        || Object.keys(rule).some((k) => k !== 'view' && k !== 'edit')) {
        return { error: `Rule for "${key}" must be { view: boolean, edit: boolean }.` };
      }
      if (rule.edit && !rule.view) return { error: `"${key}" cannot be editable while hidden.` };
      if (rule.edit && def.editable === false) return { error: `"${key}" is not editable from the assessment.` };
      out[aud][key] = { view: rule.view, edit: rule.edit };
    }
  }
  // A field may not grant what its section withholds; refuse instead of
  // storing a setting that would silently have no effect (AR-03).
  for (const aud of Object.keys(out)) {
    for (const [key, rule] of Object.entries(out[aud])) {
      const section = SECTION_OF.get(key);
      if (!section || !GATING_SECTIONS.has(section)) continue;
      const parent = rawRule(aud, section, out);
      const label = FIELD_DEF.get(key).label;
      const sectionLabel = FIELD_DEF.get(section).label;
      if (rule.view && !parent.view) return { error: `“${label}” cannot be visible while “${sectionLabel}” is hidden for this audience.` };
      if (rule.edit && EVALUATION_SECTIONS.has(section) && !parent.edit) return { error: `“${label}” cannot be editable while “${sectionLabel}” is read-only for this audience.` };
    }
  }
  return { overrides: out };
}

export function storedOverrides() {
  const raw = SystemSettings.get(ASSESSMENT_POLICY_SETTING);
  if (!raw) return {};
  try {
    const v = validatePolicyOverrides(JSON.parse(raw));
    // A stored value that no longer validates is ignored in full (defaults
    // apply) rather than partially trusted.
    return v.error ? {} : v.overrides;
  } catch { return {}; }
}

// Sections whose children are parts of one evaluator's record: writing any
// child requires being able to write the section.
const EVALUATION_SECTIONS = new Set(['assessment.behavioral', 'assessment.technical']);
// Sections that are themselves configurable and therefore gate their fields.
// "Candidate Personal Information" is only a grouping: each of its fields is
// configured on its own.
const GATING_SECTIONS = new Set(['assessment.behavioral', 'assessment.technical', 'assessment.criticalFlags', 'assessment.finalRecommendation']);

/** Configured (ungated) rule for one audience and key: override → default; field → section. */
function rawRule(audience, key, overrides) {
  const own = overrides[audience]?.[key] ?? DEFAULT_POLICY[audience]?.[key];
  if (own) return own;
  const section = SECTION_OF.get(key);
  if (section) return overrides[audience]?.[section] ?? DEFAULT_POLICY[audience]?.[section] ?? H;
  return H;
}

/**
 * Effective rule — THE parent/child semantics, used by every consumer (AR-03):
 * a field is visible only if its section is visible, and a part of an
 * evaluation is editable only if that evaluation section is editable.
 */
function ruleFor(audience, key, overrides) {
  const own = rawRule(audience, key, overrides);
  const section = SECTION_OF.get(key);
  if (!section || !GATING_SECTIONS.has(section)) return own;
  const parent = rawRule(audience, section, overrides);
  const view = own.view && parent.view;
  const edit = view && own.edit && (!EVALUATION_SECTIONS.has(section) || parent.edit);
  return { view, edit };
}

/** Effective matrix for the settings screen: { audience: { key: {view, edit, overridden} } } */
export function effectivePolicy(overrides = storedOverrides()) {
  const out = {};
  for (const a of AUDIENCE_KEYS) {
    out[a] = {};
    for (const key of POLICY_KEYS) {
      const r = ruleFor(a, key, overrides);
      const configured = rawRule(a, key, overrides);
      // view/edit are what the server enforces; `configured` is what is set,
      // so the settings screen can show a grant its section blocks (AR-03).
      out[a][key] = { view: r.view, edit: r.edit, configured: { view: configured.view, edit: configured.edit },
        overridden: !!overrides[a]?.[key], explicit: !!(overrides[a]?.[key] || DEFAULT_POLICY[a]?.[key]) };
    }
  }
  return out;
}

// ── Existing access (layer 1) ───────────────────────────────────────────

const INTERVIEW_STAGES = ['interviewing', 'waiting_feedback', 'issuing_offer', 'offer_sent', 'joined'];
// Unlocked once the candidate is at an interview stage, or as soon as an
// interview for this application exists and is not cancelled — scheduling the
// interview is what makes the assessment relevant, whether or not the pipeline
// card was moved by hand.
const UNLOCK_MEMO = new WeakMap(); // per application row, so one request queries once
export const isAssessmentUnlocked = (app) => {
  if (INTERVIEW_STAGES.includes(appNorm(app.status))) return true;
  if (app.id == null) return false;
  if (!UNLOCK_MEMO.has(app)) UNLOCK_MEMO.set(app, Interviews.forApplication(app.id).some((iv) => iv.status !== 'cancelled'));
  return UNLOCK_MEMO.get(app);
};
const has = (user, p) => (user.permissions || []).includes(p);

// Same rules as routes/interviews.js, applied to an application: full-view roles
// see all; scoped roles need interview.view_assigned AND organizer/panel
// membership on an interview of this application, or a requester/owner/creator
// relationship to its recruitment request.
export function canAccessApplication(user, app) {
  if (has(user, 'interview.view_all')) return true;
  if (!has(user, 'interview.view_assigned')) return false;
  for (const iv of Interviews.forApplication(app.id)) {
    if (iv.organizer_id === user.id || Interviews.isPanelist(iv.id, user.id)) return true;
  }
  const r = app.request_id ? Requests.byId(app.request_id) : null;
  return !!r && (r.requester_id === user.id || r.owner_id === user.id || r.created_by === user.id);
}

/** Layer-1 access for one user on one application. */
export function assessmentAccess(user, application) {
  const view = has(user, 'candidate.view') && canAccessApplication(user, application);
  return { view, edit: view && has(user, 'interview.feedback') && isAssessmentUnlocked(application) };
}

export function audiencesFor(user) {
  const roles = user.roles || [];
  const found = AUDIENCES.filter((a) => a.roles.some((r) => roles.includes(r))).map((a) => a.key);
  return found.length ? found : ['other'];
}

// ── The resolver ────────────────────────────────────────────────────────

/**
 * { canView, canEdit } for one assessment field or section.
 * `access` and `overrides` may be passed in when resolving many keys at once.
 */
export function resolveAssessmentPermission({ user, application, fieldKey, access, overrides }) {
  const def = FIELD_DEF.get(fieldKey);
  if (!def || !user || !application) return { canView: false, canEdit: false };
  const base = access || assessmentAccess(user, application);
  const ov = overrides || storedOverrides();
  let view = false, edit = false;
  for (const a of audiencesFor(user)) {
    const r = ruleFor(a, fieldKey, ov);
    view = view || r.view;
    edit = edit || (r.view && r.edit);
  }
  let canView = base.view && view;
  if (def.confidential && !has(user, def.confidential)) canView = false;
  const canEdit = canView && base.edit && edit && def.editable !== false;
  return { canView, canEdit };
}

/** Every key at once (one policy read, one scope check). */
export function resolveAllAssessmentPermissions(user, application) {
  const access = assessmentAccess(user, application);
  const overrides = storedOverrides();
  return Object.fromEntries(POLICY_KEYS.map((fieldKey) => [fieldKey, resolveAssessmentPermission({ user, application, fieldKey, access, overrides })]));
}

/** Field definitions for clients (labels and structure only — no data). */
export function policyDefinition() {
  return {
    audiences: AUDIENCES.map(({ key, label }) => ({ key, label })),
    sections: POLICY_SECTIONS.map((s) => ({
      key: s.key, label: s.label, editable: s.editable,
      // Structure only: whether the section's own setting limits its fields.
      gatesView: GATING_SECTIONS.has(s.key), gatesEdit: EVALUATION_SECTIONS.has(s.key),
      fields: s.fields.map((f) => ({ key: f.key, label: f.label, confidential: !!f.confidential })),
    })),
  };
}
