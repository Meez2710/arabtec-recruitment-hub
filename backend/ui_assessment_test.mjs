// Assessment UI (Packets 01 + 02): the production assessment components
// (app.jsx) compiled with the vendored React/Babel and driven through their real
// handlers — no DOM, no network. Packet 01 contract: draft/submit/edit
// truthfulness, N/A + notes payloads, retained edits on failure, duplicate-submit
// guard, refresh without data loss, PDF wording, dirty-close guard. Packet 02:
// one PDF-ordered document driven by the server's resolved field policy (hidden
// parts absent, read-only parts not editable), accessible names, the
// interviewer's route in from an assigned interview, and the policy settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const publicDir = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const window = new EventTarget();
window.location = { hash: '', pathname: '/', search: '', reload() {} };
window.history = { replaceState() { window.location.hash = ''; } };
let confirmAnswer = false, confirmCalls = 0;
window.confirm = () => { confirmCalls++; return confirmAnswer; };
const document = Object.assign(new EventTarget(), { getElementById: () => ({}), activeElement: null });
const ctx = vm.createContext({ window, document, Event, CustomEvent, URLSearchParams, console,
  localStorage: { getItem: () => null }, setTimeout, clearTimeout,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  ReactDOM: { createRoot: () => ({ render() {} }) },
  fetch() { throw new Error('UI assessment tests must not use the network'); } });
ctx.self = ctx;
vm.runInContext(fs.readFileSync(publicDir + 'vendor/react.production.min.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(publicDir + 'vendor/babel.min.js', 'utf8'), ctx);
for (const file of ['email-settings.jsx', 'org-structure.jsx', 'app.jsx']) {
  const source = fs.readFileSync(publicDir + file, 'utf8');
  vm.runInContext(ctx.Babel.transform(source, { presets: ['react'] }).code, ctx, { filename: file });
}
const get = (expression) => vm.runInContext(expression, ctx);
const React = ctx.React;
let nextId = 0;
function mount(Component, initialProps = {}) {
  let slots = [], cursor = 0, effects = [], props = initialProps;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const memo = (fn, deps) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; };
  const dispatcher = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, (value) => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
    useRef(initial) { return memo(() => ({ current: initial }), []); },
    useId() { return memo(() => `test-${++nextId}`, []); },
    useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useContext: (context) => context._currentValue,
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  return {
    render(next = props) { props = next; cursor = 0; effects = [];
      React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher;
      let tree; try { tree = Component(props); } finally { React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = null; }
      effects.forEach((run) => run()); return tree; },
    dispose() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? text(tree.props?.children) : String(tree);
}
const button = (tree, label) => nodes(tree).find((n) => n.type === 'button' && text(n) === label);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
// Values cross the vm realm boundary, so compare structure, not prototypes.
const eq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`  ✓ ${name}`); }

const api = window.ARABTEC_API;
const realPost = api.post, realGet = api.get, realDownload = api.download, realPut = api.put;
const EvaluationForm = get('EvaluationForm');
const ScoreRow = get('ScoreRow');
const FinalDecisionBox = get('FinalDecisionBox');
const AssessmentPanel = get('AssessmentPanel');
const AssessmentFlags = get('AssessmentFlags');
const AssessmentFit = get('AssessmentFit');
const AssessmentSaveRow = get('AssessmentSaveRow');
const CandidateQuickView = get('CandidateQuickView');
const InterviewDetail = get('InterviewDetail');
const InterviewAssessmentDrawer = get('InterviewAssessmentDrawer');
const AssessmentPolicyPage = get('AssessmentPolicyPage');
// The document's section components hold no state of their own (the panel
// owns every draft), so they can be rendered in place to inspect the page.
const PURE = new Set([EvaluationForm, ScoreRow, AssessmentFlags, AssessmentFit, AssessmentSaveRow]);
function expand(tree) {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!tree || typeof tree !== 'object') return tree;
  if (PURE.has(tree.type)) return expand(tree.type(tree.props));
  const kids = tree.props?.children;
  return kids === undefined ? tree : { ...tree, props: { ...tree.props, children: expand(kids) } };
}

const HR = [
  ['openness', 'Openness', 'Adaptability, learning agility, response to new systems and processes.'],
  ['conscientiousness', 'Conscientiousness', 'Reliability, follow-through, accountability, documentation discipline.'],
  ['extraversion', 'Extraversion', 'Communication clarity, assertiveness, stakeholder coordination.'],
  ['agreeableness', 'Agreeableness', 'Cooperation, respect, teamwork without passivity.'],
  ['emotional_stability', 'Emotional Stability', 'Composure under pressure, stress tolerance, conflict response.'],
].map(([key, label, description]) => ({ key, label, description }));
const TECH = [['technical_knowledge', 'Technical Knowledge'], ['relevant_experience', 'Relevant Experience'], ['problem_solving', 'Problem-Solving'], ['tools_software', 'Tools & Software'], ['planning_organizing', 'Planning & Organizing']].map(([key, label]) => ({ key, label, description: 'd' }));
const DECISIONS = [['proceed', 'Proceed'], ['proceed_conditions', 'Proceed with Conditions'], ['hold', 'Hold'], ['cv_pool', 'CV Pool'], ['reject', 'Reject']].map(([value, label]) => ({ value, label }));
const META = {
  behavioralCriteria: HR, technicalCriteria: TECH,
  behavioralInstruction: 'Score each trait based on specific examples and observed evidence.',
  criticalFlags: [{ key: 'blaming', label: 'Repeated blaming of others or no ownership' }, { key: 'no_evidence', label: 'No specific examples or evidence provided' }, { key: 'cv_inconsistency', label: 'Inconsistencies between CV and stated experience' }],
  decisions: DECISIONS, finalDecisions: DECISIONS,
  fitLevels: [{ value: 'strong', label: 'Strong', min: 4.2 }, { value: 'acceptable', label: 'Acceptable', min: 3.5 }, { value: 'borderline', label: 'Borderline', min: 3.0 }, { value: 'weak', label: 'Weak', min: 0 }],
  scoreGuide: { 1: 'Unsuitable', 2: 'Below Standard', 3: 'Average', 4: 'Proficient', 5: 'Excellent' }, naLabel: 'Not Applicable',
};
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const KEYS = [
  ...['fullName', 'position', 'department', 'interviewDate', 'education', 'yearsExperience', 'currentEmployer', 'availability', 'currentSalary', 'expectedSalary'].map((k) => 'assessment.candidate.' + k),
  'assessment.behavioral', ...HR.map((c) => 'assessment.behavioral.' + camel(c.key)),
  'assessment.technical', ...TECH.map((c) => 'assessment.technical.' + camel(c.key)),
  'assessment.criticalFlags', 'assessment.finalRecommendation',
  'assessment.finalRecommendation.behavioralJustification', 'assessment.finalRecommendation.technicalJustification',
];
// Resolved permissions as the server sends them. `over` maps key → [view, edit].
const perms = (over = {}, base = [true, true]) => Object.fromEntries(KEYS.map((k) => {
  const [v, e] = over[k] || (k.startsWith('assessment.candidate.') ? [true, false] : base);
  return [k, { canView: v, canEdit: e }];
}));
const submittedHr = (over = {}) => ({ evaluatorType: 'hr', submitted: true, status: 'submitted', evaluatorName: 'Mona Sami', updatedAt: '2026-10-01T09:00:00.000Z',
  rows: { openness: { score: 4, notes: 'a' }, conscientiousness: { score: 'na', notes: '' }, extraversion: { score: 5, notes: '' }, agreeableness: { score: 4, notes: '' }, emotional_stability: { score: 5, notes: '' } },
  criticalFlags: { blaming: false, no_evidence: false, cv_inconsistency: false }, recommendation: 'proceed', justification: 'j', ...over });
const ctxAll = { fullName: '<b>Ali</b>', position: 'Site Engineer', department: 'Planning', interview: null, education: null, yearsExperience: 0, currentEmployer: null, noticePeriod: null, currentSalary: null, expectedSalary: 45123, salaryVisible: true };
const bundleOf = (over = {}) => ({ unlocked: true, canEdit: true, hr: null, technical: null, finalDecision: null, permissions: perms(), context: ctxAll, ...over });

// Mount the real panel against a stubbed API and return helpers to drive it.
async function openPanel(bundle, { canFeedback = true } = {}) {
  const posts = [];
  let next = bundle;
  api.get = async (p) => (p.endsWith('/meta') ? META : { assessment: next });
  api.post = async (path, body) => { posts.push({ path, body }); return { assessment: null }; };
  const panel = mount(AssessmentPanel, { app: { id: 7 }, canFeedback });
  panel.render(); await flush(); panel.render(); panel.render();
  const view = () => expand(panel.render());
  return { panel, posts, view, setBundle: (b) => { next = b; }, dispose: () => { panel.dispose(); api.get = realGet; api.post = realPost; } };
}
const section = (tree, title) => nodes(tree).find((n) => n.type === 'section' && nodes(n).some((h) => h.type === 'h3' && text(h) === title));
const rowsIn = (sec) => nodes(sec).filter((n) => n.type === 'tr' && nodes(n).some((x) => x.type === 'th' && x.props.scope === 'row'));
const rowOf = (sec, label) => rowsIn(sec).find((r) => text(nodes(r).find((x) => x.type === 'th')) === label);
const pick = (row, v) => nodes(row).find((n) => n.type === 'button' && n.props.role === 'radio' && text(n) === v).props.onClick();
const notesOf = (row) => nodes(row).find((n) => n.type === 'textarea');
const byAria = (tree, label) => nodes(tree).find((n) => n.props?.['aria-label'] === label);

// ───────────────────────── Packet 01 contract, on the document ─────────────────────────

await check('score control: 1 2 3 4 5 N/A in the cell with the guide as accessible names; notes labelled', () => {
  const t = mount(ScoreRow, { idBase: 'x', label: 'Openness', description: HR[0].description, value: '', notes: '', onChange() {}, onNotes() {}, scoreGuide: META.scoreGuide, naLabel: 'Not Applicable' }).render();
  assert.ok(text(t).includes(HR[0].description));
  const radios = nodes(t).filter((n) => n.props?.role === 'radio');
  eq(radios.map(text), ['1', '2', '3', '4', '5', 'N/A']);
  eq(radios.map((r) => r.props['aria-label']), ['1 — Unsuitable', '2 — Below Standard', '3 — Average', '4 — Proficient', '5 — Excellent', 'N/A — Not Applicable']);
  assert.equal(nodes(t).find((n) => n.props?.role === 'radiogroup').props['aria-label'], 'Openness score');
  assert.equal(notesOf(t).props['aria-label'], 'Openness notes');
  const ro = mount(ScoreRow, { idBase: 'x', label: 'Openness', value: '4', notes: 'seen', readOnly: true, scoreGuide: META.scoreGuide }).render();
  assert.equal(nodes(ro).some((n) => n.type === 'button' || n.type === 'textarea'), false, 'read-only shows values, not disabled controls');
  assert.ok(text(ro).includes('4') && text(ro).includes('Proficient') && text(ro).includes('seen'));
});

await check('document follows the PDF: title, section order, table columns, instruction, guide, justification label; no fit selector', async () => {
  const p = await openPanel(bundleOf());
  const t = p.view();
  assert.ok(text(t).includes('ARABTEC CONSTRUCTION — ASSESSMENT & EVALUATION'));
  eq(nodes(t).filter((n) => n.type === 'h3').map(text), ['Candidate Personal Information', 'HR Assessment — Behavioral (Big Five Model)', 'Technical Assessment — Role Competency', 'Critical Flags — Review if Any Are True', 'Final Recommendation']);
  const hr = section(t, 'HR Assessment — Behavioral (Big Five Model)');
  eq(nodes(hr).filter((n) => n.type === 'th' && n.props.scope === 'col').map(text), ['Criterion', 'What to Evaluate', 'Score 1–5', 'Notes']);
  eq(rowsIn(hr).map((r) => text(nodes(r).find((x) => x.type === 'th'))), HR.map((h) => h.label));
  assert.ok(text(hr).includes('Score each trait based on specific examples and observed evidence.'));
  assert.ok(text(hr).includes('Score Guide: 5 Excellent • 4 Proficient • 3 Average • 2 Below Standard • 1 Unsuitable • N/A Not Applicable'));
  assert.ok(text(section(t, 'Final Recommendation')).includes('Justification / Key Strengths'));
  assert.equal(nodes(t).some((n) => n.type === 'label' && /Fit$/.test(text(n))), false, 'fit is derived, never chosen');
  assert.equal(nodes(t).filter((n) => n.type === EvaluationForm).length, 0, 'sections are expanded in this view');
  p.dispose();
});

await check('save draft: partial rows, N/A as "na", unanswered as null, per-row notes; no identity or fit fields', async () => {
  const p = await openPanel(bundleOf());
  let hr = section(p.view(), 'HR Assessment — Behavioral (Big Five Model)');
  pick(rowOf(hr, 'Openness'), '4'); hr = section(p.view(), 'HR Assessment — Behavioral (Big Five Model)');
  notesOf(rowOf(hr, 'Openness')).props.onChange({ target: { value: 'Led ERP rollout' } });
  hr = section(p.view(), 'HR Assessment — Behavioral (Big Five Model)');
  pick(rowOf(hr, 'Conscientiousness'), 'N/A'); hr = section(p.view(), 'HR Assessment — Behavioral (Big Five Model)');
  notesOf(rowOf(hr, 'Extraversion')).props.onChange({ target: { value: 'Follow up' } });
  let t = p.view();
  assert.ok(text(section(t, 'HR Assessment — Behavioral (Big Five Model)')).includes('Unsaved changes'));
  await byAria(t, 'Save behavioral draft').props.onClick(); await flush(); t = p.view();
  assert.equal(p.posts.length, 1); assert.equal(p.posts[0].path, '/assessments/application/7');
  const b = p.posts[0].body;
  assert.equal(b.evaluatorType, 'hr'); assert.equal(b.submitted, false);
  eq(b.behavioral.openness, { score: 4, notes: 'Led ERP rollout' });
  eq(b.behavioral.conscientiousness, { score: 'na', notes: '' });
  eq(b.behavioral.extraversion, { score: null, notes: 'Follow up' });
  for (const k of ['applicationId', 'evaluatorId', 'evaluatorName', 'behavioralFit', 'technicalFit', 'technical']) assert.equal(k in b, false, k);
  assert.equal(text(section(t, 'HR Assessment — Behavioral (Big Five Model)')).includes('Unsaved changes'), false);
  p.dispose();
});

await check('live summary: numeric rows only, N/A counted separately; all-N/A is "Not rated" with a warning', async () => {
  const p = await openPanel(bundleOf());
  const T = 'HR Assessment — Behavioral (Big Five Model)';
  for (const [l, v] of [['Openness', '5'], ['Conscientiousness', '4'], ['Extraversion', 'N/A'], ['Agreeableness', '4']]) pick(rowOf(section(p.view(), T), l), v);
  assert.match(text(section(p.view(), T)), /Average: 4\.3 \/ 5 · Fit: Strong · 3 scored · 1 N\/A · 1 unanswered/);
  assert.match(text(section(p.view(), 'Final Recommendation')), /☒ Strong/);
  p.dispose();
  const q = await openPanel(bundleOf());
  for (const h of HR) pick(rowOf(section(q.view(), T), h.label), 'N/A');
  assert.ok(text(section(q.view(), T)).includes('Average: Not rated'));
  assert.ok(text(section(q.view(), T)).includes('No scored evidence'));
  q.dispose();
});

await check('submit: blocked until every row is answered and a recommendation chosen; then sends submitted:true', async () => {
  const p = await openPanel(bundleOf());
  const T = 'HR Assessment — Behavioral (Big Five Model)';
  pick(rowOf(section(p.view(), T), 'Openness'), '4');
  await byAria(p.view(), 'Submit behavioral evaluation').props.onClick();
  assert.equal(p.posts.length, 0);
  assert.match(text(p.view()), /Missing: Conscientiousness, Extraversion, Agreeableness, Emotional Stability/);
  for (const h of HR.slice(1)) pick(rowOf(section(p.view(), T), h.label), '3');
  await byAria(p.view(), 'Submit behavioral evaluation').props.onClick();
  assert.equal(p.posts.length, 0); assert.ok(text(p.view()).includes('Choose a recommendation'));
  byAria(p.view(), 'Behavioral recommendation').props.onChange({ target: { value: 'proceed_conditions' } });
  await byAria(p.view(), 'Submit behavioral evaluation').props.onClick(); await flush();
  assert.equal(p.posts.length, 1); assert.equal(p.posts[0].body.submitted, true); assert.equal(p.posts[0].body.recommendation, 'proceed_conditions');
  p.dispose();
});

await check('failed save keeps every edit, reports the error and retries the same save', async () => {
  const p = await openPanel(bundleOf());
  const T = 'HR Assessment — Behavioral (Big Five Model)';
  let fail = true; const calls = [];
  api.post = async (path, body) => { calls.push(body); if (fail) throw new Error('Network down'); return { assessment: null }; };
  pick(rowOf(section(p.view(), T), 'Openness'), '2');
  notesOf(rowOf(section(p.view(), T), 'Openness')).props.onChange({ target: { value: 'kept' } });
  await byAria(p.view(), 'Save behavioral draft').props.onClick(); await flush();
  let t = p.view();
  const row = rowOf(section(t, T), 'Openness');
  assert.equal(nodes(row).find((n) => n.props?.['aria-checked'] === true && n.props.role === 'radio') && text(nodes(row).find((n) => n.props?.['aria-checked'] === true)), '2');
  assert.equal(notesOf(row).props.value, 'kept');
  assert.ok(text(t).includes('Network down') && text(t).includes('not been lost'));
  assert.ok(text(t).includes('Unsaved changes'));
  fail = false;
  await button(t, 'Retry').props.onClick(); await flush(); t = p.view();
  assert.equal(calls.length, 2); eq(calls[1], calls[0]);
  assert.equal(text(section(t, T)).includes('Unsaved changes'), false);
  p.dispose();
});

await check('a second click while saving never sends a duplicate submission', async () => {
  const p = await openPanel(bundleOf());
  const d = deferred(); let n = 0; api.post = () => { n++; return d.promise; };
  pick(rowOf(section(p.view(), 'HR Assessment — Behavioral (Big Five Model)'), 'Openness'), '3');
  const first = byAria(p.view(), 'Save behavioral draft').props.onClick();
  const t = p.view();
  assert.ok(byAria(t, 'Save behavioral draft').props.disabled && byAria(t, 'Submit behavioral evaluation').props.disabled);
  byAria(t, 'Save behavioral draft').props.onClick(); byAria(t, 'Submit behavioral evaluation').props.onClick();
  assert.equal(n, 1);
  d.resolve({ assessment: null }); await first; p.dispose();
});

await check('a submitted evaluation opens read-only; "Edit evaluation" enters edit mode with truthful draft wording', async () => {
  const p = await openPanel(bundleOf({ hr: submittedHr() }));
  const T = 'HR Assessment — Behavioral (Big Five Model)';
  let t = p.view();
  assert.ok(text(section(t, T)).includes('Status: Submitted · Completed by Mona Sami'));
  assert.equal(nodes(section(t, T)).some((n) => n.props?.role === 'radio'), false, 'no live controls until Edit');
  assert.ok(text(rowOf(section(t, T), 'Conscientiousness')).includes('N/A'), 'N/A reopens as N/A, not blank');
  byAria(t, 'Edit behavioral evaluation').props.onClick(); t = p.view();
  assert.ok(nodes(section(t, T)).some((n) => n.props?.role === 'radio'));
  assert.ok(button(t, 'Save as draft (withdraws submission)') && byAria(t, 'Submit behavioral evaluation') && button(t, 'Cancel edit'));
  pick(rowOf(section(t, T), 'Openness'), '1'); t = p.view();
  confirmAnswer = false; button(t, 'Cancel edit').props.onClick(); t = p.view();
  assert.equal(text(nodes(rowOf(section(t, T), 'Openness')).find((n) => n.props?.['aria-checked'] === true)), '1', 'declining the discard keeps the edit');
  confirmAnswer = true; button(t, 'Cancel edit').props.onClick(); t = p.view();
  assert.ok(text(rowOf(section(t, T), 'Openness')).includes('Proficient')); assert.ok(byAria(t, 'Edit behavioral evaluation'));
  confirmAnswer = false; p.dispose();
});

await check('a refresh never discards unsaved edits; a clean form follows the refreshed record', async () => {
  const T = 'HR Assessment — Behavioral (Big Five Model)';
  const theirs = bundleOf({ hr: submittedHr({ evaluatorName: 'Karim Adel', rows: { ...submittedHr().rows, openness: { score: 2, notes: 'theirs' } } }) });
  const p = await openPanel(bundleOf({ hr: submittedHr() }));
  byAria(p.view(), 'Edit behavioral evaluation').props.onClick();
  notesOf(rowOf(section(p.view(), T), 'Openness')).props.onChange({ target: { value: 'my unsaved evidence' } });
  // Another editor saved meanwhile; the panel receives their version (as a save answer or refresh would deliver it).
  nodes(p.panel.render()).find((n) => n.type === FinalDecisionBox).props.onSaved(theirs);
  let t = p.view(); t = p.view();
  assert.equal(notesOf(rowOf(section(t, T), 'Openness')).props.value, 'my unsaved evidence');
  assert.ok(text(t).includes('saved by someone else'));
  p.dispose();
  const q = await openPanel(bundleOf({ hr: submittedHr() }));
  nodes(q.panel.render()).find((n) => n.type === FinalDecisionBox).props.onSaved(theirs);
  let u = q.view(); u = q.view();
  assert.ok(text(rowOf(section(u, T), 'Openness')).includes('Below Standard'));
  assert.ok(text(section(u, T)).includes('Completed by Karim Adel'));
  q.dispose();
});

await check('critical flag shows "Review required" and never rejects; historical manual fit stays visible', async () => {
  const p = await openPanel(bundleOf({ hr: submittedHr({ submitted: false, status: 'draft', savedFit: 'strong', fitHistorical: true }) }));
  let t = p.view();
  assert.ok(text(t).includes('Status: Draft · Last saved by Mona Sami'));
  assert.ok(text(t).includes('Previously recorded fit (manual, historical): Strong'));
  byAria(t, 'Repeated blaming of others or no ownership').props.onChange({ target: { checked: true } }); t = p.view();
  assert.ok(text(t).includes('Review required') && text(t).includes('does not reject'));
  p.dispose();
});

await check('a user without edit rights gets no save controls', async () => {
  const p = await openPanel(bundleOf(), { canFeedback: false });
  const t = p.view();
  assert.equal(nodes(t).some((n) => n.type === 'button' && /Save|Submit|Record Final/.test(text(n))), false);
  assert.equal(nodes(t).some((n) => n.props?.role === 'radio'), false);
  p.dispose();
});

await check('final decision: PDF choices as boxes, historical "hired" shown but not selected, failure keeps the choice', async () => {
  const bundle = { finalDecision: { decision: 'hired', historical: true, decisionLabel: 'Hired (historical)', decidedByName: 'Old Admin', decidedAt: '2026-01-01T00:00:00Z' } };
  let fail = true; const sent = [];
  api.post = async (p, b) => { sent.push(b); if (fail) throw new Error('Server busy'); return { assessment: null }; };
  const f = mount(FinalDecisionBox, { bundle, meta: META, canFeedback: true, appId: 7, onSaved() {}, onDirtyChange() {} }); let t = f.render();
  const radios = nodes(t).filter((n) => n.type === 'input' && n.props.type === 'radio');
  eq(radios.map((r) => r.props.value), ['proceed', 'proceed_conditions', 'hold', 'cv_pool', 'reject']);
  eq(nodes(t).filter((n) => n.type === 'label').map(text).slice(0, 5), ['Proceed', 'Proceed with Conditions', 'Hold', 'CV Pool', 'Reject']);
  assert.equal(radios.some((r) => r.props.checked), false);
  assert.equal(nodes(t).find((n) => n.props?.role === 'radiogroup').props['aria-label'], 'Final decision');
  assert.ok(text(t).includes('Hired (historical)') && text(t).includes('Decided by Old Admin'));
  assert.ok(text(t).includes('does not move the candidate'));
  radios[1].props.onChange(); t = f.render();
  await button(t, 'Record Final Decision').props.onClick(); await flush(); t = f.render();
  assert.equal(nodes(t).find((n) => n.type === 'input' && n.props.value === 'proceed_conditions').props.checked, true);
  assert.ok(text(t).includes('Server busy'));
  fail = false; await button(t, 'Retry').props.onClick(); await flush();
  eq(sent[1], { decision: 'proceed_conditions', notes: '' });
  f.dispose(); api.post = realPost;
});

await check('a save answer replaces the bundle without a second read; preview opens the scoped server render', async () => {
  let reads = 0;
  api.get = async (p) => { if (!p.endsWith('/meta')) reads++; return p.endsWith('/meta') ? META : { assessment: bundleOf() }; };
  const opened = []; api.download = async (p) => { opened.push(p); };
  const panel = mount(AssessmentPanel, { app: { id: 7 }, canFeedback: true }); panel.render(); await flush(); panel.render();
  const before = reads;
  nodes(panel.render()).find((n) => n.type === EvaluationForm).props.onSaved(bundleOf({ hr: submittedHr() }));
  const t = expand(panel.render());
  assert.equal(reads, before);
  assert.ok(text(t).includes('Completed by Mona Sami'));
  button(t, 'Preview printable form').props.onClick();
  eq(opened, ['/assessments/application/7/preview']);
  panel.dispose(); api.get = realGet; api.download = realDownload;
});

await check('drawer: unsaved assessment edits ask before closing; nothing is discarded silently', async () => {
  let closed = 0;
  const qv = mount(CandidateQuickView, { app: { id: 7, candidate: { id: 1, fullName: 'C' }, status: 'interviewing' }, user: { permissions: ['interview.feedback'] }, onClose: () => { closed++; }, onChanged() {} });
  let t = qv.render();
  nodes(t).find((n) => n.type === 'button' && text(n) === 'Interview Assessment').props.onClick(); t = qv.render();
  const panel = nodes(t).find((n) => n.type === AssessmentPanel);
  assert.ok(panel, 'assessment panel mounted');
  panel.props.onDirtyChange(true);
  const close = nodes(t).find((n) => n.type === 'button' && n.props['aria-label'] === 'Close candidate details');
  confirmCalls = 0; confirmAnswer = false; close.props.onClick();
  assert.equal(confirmCalls, 1); assert.equal(closed, 0);
  confirmAnswer = true; close.props.onClick(); assert.equal(closed, 1);
  nodes(t).find((n) => n.type === 'button' && text(n) === 'Candidate').props.onClick(); t = qv.render();
  assert.ok(nodes(t).find((n) => n.type === AssessmentPanel), 'switching to the Candidate tab keeps the assessment mounted');
  panel.props.onDirtyChange(false); confirmCalls = 0;
  nodes(t).find((n) => n.type === 'button' && n.props['aria-label'] === 'Close candidate details').props.onClick();
  assert.equal(confirmCalls, 0); assert.equal(closed, 2);
  confirmAnswer = false; qv.dispose();
});

// ───────────────────────── Packet 02: policy-driven document ─────────────────────────

await check('candidate grid: zero years kept, missing shown as "Not recorded"; a withheld field is absent and the grid reflows', async () => {
  const p = await openPanel(bundleOf());
  const cells = (t) => nodes(section(t, 'Candidate Personal Information')).filter((n) => n.type === 'dt').map(text);
  const val = (t, label) => text(nodes(section(t, 'Candidate Personal Information')).find((n) => n.type === 'div' && n.props.className === 'assess-info-cell' && text(nodes(n).find((x) => x.type === 'dt')) === label)).replace(label, '');
  let t = p.view();
  eq(cells(t), ['Full Name', 'Position', 'Department', 'Interview Date', 'Education', 'Years of Experience', 'Current Employer', 'Notice / Availability', 'Current Salary', 'Expected Salary']);
  assert.equal(val(t, 'Full Name'), '<b>Ali</b>', 'rendered as text by React, never as markup');
  assert.equal(val(t, 'Years of Experience'), '0 years');
  assert.equal(val(t, 'Interview Date'), 'Not recorded');
  assert.equal(val(t, 'Expected Salary'), '45,123');
  p.dispose();
  const { currentSalary, expectedSalary, ...restricted } = ctxAll;
  const q = await openPanel(bundleOf({ context: { ...restricted, salaryVisible: false }, permissions: perms({ 'assessment.candidate.currentSalary': [false, false], 'assessment.candidate.expectedSalary': [false, false] }) }));
  t = q.view();
  eq(cells(t), ['Full Name', 'Position', 'Department', 'Interview Date', 'Education', 'Years of Experience', 'Current Employer', 'Notice / Availability']);
  assert.equal(/Salary|Restricted/.test(text(t)), false, 'no salary label and no "Restricted" placeholder');
  q.dispose();
});

await check('hidden section is absent; view-only section renders values without controls and has no save row', async () => {
  const technicalView = perms({ 'assessment.behavioral': [false, false], 'assessment.finalRecommendation': [true, false], 'assessment.finalRecommendation.behavioralJustification': [false, false] });
  const p = await openPanel(bundleOf({ permissions: technicalView, technical: { ...submittedHr(), evaluatorType: 'technical', rows: Object.fromEntries(TECH.map((c) => [c.key, { score: 4, notes: '' }])) } }));
  let t = p.view();
  eq(nodes(t).filter((n) => n.type === 'h3').map(text), ['Candidate Personal Information', 'Technical Assessment — Role Competency', 'Critical Flags — Review if Any Are True', 'Final Recommendation']);
  assert.equal(text(t).includes('Behavioral Fit'), false);
  assert.equal(nodes(t).some((n) => n.props?.['aria-label'] === 'Behavioral recommendation'), false);
  const fdEl = nodes(t).find((n) => n.type === FinalDecisionBox);
  assert.equal(fdEl.props.canFeedback, false, 'final decision handed over as view-only');
  const fd = mount(FinalDecisionBox, { ...fdEl.props, bundle: { ...fdEl.props.bundle, finalDecision: { decision: 'cv_pool', decidedByName: 'Omar Khalil' } } }); const ft = fd.render();
  assert.equal(nodes(ft).some((n) => n.type === 'input' || n.type === 'textarea' || n.type === 'button'), false, 'view-only final decision has no controls');
  assert.ok(nodes(ft).some((n) => n.props?.role === 'group' && n.props['aria-label'] === 'Final decision: CV Pool'), 'the recorded decision is named for assistive technology');
  assert.ok(text(ft).includes('☒ CV Pool') && text(ft).includes('☐ Proceed'), 'marked like the sheet');
  fd.dispose();
  assert.equal(button(t, 'Record Final Decision'), undefined);
  assert.ok(byAria(t, 'Edit technical evaluation'), 'the technical section is the one this user owns');
  p.dispose();
  const ro = await openPanel(bundleOf({ permissions: perms({ 'assessment.behavioral': [true, false] }), hr: submittedHr() }));
  t = ro.view();
  const hr = section(t, 'HR Assessment — Behavioral (Big Five Model)');
  assert.ok(text(hr).includes('View only'));
  assert.equal(nodes(hr).some((n) => n.type === 'button' || n.type === 'textarea'), false);
  assert.equal(byAria(t, 'Edit behavioral evaluation'), undefined);
  assert.ok(text(rowOf(hr, 'Openness')).includes('Proficient'), 'read-only values stay legible');
  ro.dispose();
});

await check('field override: a hidden criterion row and the average it would reveal are absent; a read-only row is not sent', async () => {
  const p = await openPanel(bundleOf({ permissions: perms({ 'assessment.behavioral.agreeableness': [false, false], 'assessment.behavioral.openness': [true, false] }), hr: { ...submittedHr({ submitted: false, status: 'draft' }), rows: { openness: { score: 4, notes: 'a' } } } }));
  const T = 'HR Assessment — Behavioral (Big Five Model)';
  let t = p.view();
  eq(rowsIn(section(t, T)).map((r) => text(nodes(r).find((x) => x.type === 'th'))), ['Openness', 'Conscientiousness', 'Extraversion', 'Emotional Stability']);
  assert.equal(/Average:/.test(text(section(t, T))), false);
  assert.equal(nodes(rowOf(section(t, T), 'Openness')).some((n) => n.props?.role === 'radio'), false, 'read-only row has no controls');
  pick(rowOf(section(t, T), 'Extraversion'), '5');
  await byAria(p.view(), 'Save behavioral draft').props.onClick(); await flush();
  eq(Object.keys(p.posts[0].body.behavioral), ['conscientiousness', 'extraversion', 'emotional_stability']);
  p.dispose();
});

await check('flags and justification follow their own policies in the payload', async () => {
  const p = await openPanel(bundleOf({ permissions: perms({ 'assessment.criticalFlags': [true, false], 'assessment.finalRecommendation.behavioralJustification': [false, false] }) }));
  const t = p.view();
  const flagSec = section(t, 'Critical Flags — Review if Any Are True');
  assert.equal(nodes(flagSec).some((n) => n.type === 'input'), false, 'view-only flags have no controls');
  assert.equal(nodes(flagSec).filter((n) => /: not flagged$/.test(n.props?.['aria-label'] || '')).length, 6, 'each flag is still named with its text and state');
  assert.equal(text(section(t, 'Final Recommendation')).includes('Justification'), true, 'technical justification still shown');
  assert.equal(nodes(t).some((n) => n.props?.id === 'assess-7-hr-just'), false, 'behavioral justification absent');
  pick(rowOf(section(t, 'HR Assessment — Behavioral (Big Five Model)'), 'Openness'), '3');
  await byAria(p.view(), 'Save behavioral draft').props.onClick(); await flush();
  const b = p.posts[0].body;
  assert.equal('criticalFlags' in b, false); assert.equal('behavioralJustification' in b, false);
  p.dispose();
});

await check('both evaluations live on one document and keep independent drafts', async () => {
  const p = await openPanel(bundleOf());
  pick(rowOf(section(p.view(), 'HR Assessment — Behavioral (Big Five Model)'), 'Openness'), '5');
  pick(rowOf(section(p.view(), 'Technical Assessment — Role Competency'), 'Technical Knowledge'), '2');
  const t = p.view();
  assert.ok(text(t).includes('Behavioral assessment') && text(t).includes('Technical assessment'));
  await byAria(t, 'Save technical draft').props.onClick(); await flush();
  eq(Object.keys(p.posts[0].body), ['evaluatorType', 'submitted', 'recommendation', 'technical', 'criticalFlags', 'technicalJustification']);
  assert.equal(p.posts[0].body.evaluatorType, 'technical');
  eq(p.posts[0].body.technical.technical_knowledge, { score: 2, notes: '' });
  assert.ok(text(section(p.view(), 'HR Assessment — Behavioral (Big Five Model)')).includes('Unsaved changes'), 'the HR draft is untouched by the technical save');
  p.dispose();
});

await check('accessibility: every recommendation, justification, flag, score group and save button has a real name', async () => {
  const p = await openPanel(bundleOf());
  const t = p.view();
  for (const sel of nodes(t).filter((n) => n.type === 'select')) {
    const label = nodes(t).find((n) => n.type === 'label' && n.props.htmlFor === sel.props.id);
    assert.ok(sel.props.id && label && sel.props['aria-label'], 'select has an id, a <label for> and an aria-label');
  }
  eq(nodes(t).filter((n) => n.type === 'select').map((s) => s.props['aria-label']), ['Behavioral recommendation', 'Technical recommendation']);
  const flags = nodes(section(t, 'Critical Flags — Review if Any Are True')).filter((n) => n.type === 'input');
  eq(flags.map((f) => f.props['aria-label']), [...META.criticalFlags.map((f) => f.label), ...META.criticalFlags.map((f) => f.label)]);
  for (const f of flags) assert.ok(nodes(t).some((n) => n.type === 'label' && n.props.htmlFor === f.props.id), 'flag has <label for>');
  assert.equal(nodes(t).filter((n) => n.props?.role === 'radiogroup' && / score$/.test(n.props['aria-label'])).length, 10);
  assert.equal(nodes(t).filter((n) => n.type === 'textarea' && / notes$/.test(n.props['aria-label'] || '')).length, 10);
  for (const name of ['Save behavioral draft', 'Submit behavioral evaluation', 'Save technical draft', 'Submit technical evaluation']) assert.ok(byAria(t, name), name);
  for (const j of nodes(t).filter((n) => n.type === 'textarea' && /-just$/.test(n.props.id || ''))) assert.ok(nodes(t).some((n) => n.type === 'label' && n.props.htmlFor === j.props.id && text(n) === 'Justification / Key Strengths'));
  p.dispose();
});

await check('interviewer route: an assigned interview offers "Open assessment", which opens the panel for that application', async () => {
  const user = { id: 8, roles: ['interviewer'], permissions: ['candidate.view', 'interview.view_assigned', 'interview.feedback'] };
  api.get = async (p) => {
    if (p.startsWith('/interviews/')) return { interview: { id: 3, interviewNo: 'INT-00003', interviewType: 'technical', status: 'scheduled', scheduledAt: '2026-10-05T09:00:00Z', candidate: { fullName: 'Ali' }, application: { id: 7, applicationNo: 'APP-7', status: 'interviewing' }, request: null, panel: [], feedback: [], activity: [], organizer: { name: 'R' } } };
    if (p.includes('/buttons')) return { buttons: {} };
    return {};
  };
  const page = mount(InterviewDetail, { id: 3, user, onBack() {} }); page.render(); await flush(); let t = page.render();
  const headActions = (tree) => nodes(nodes(tree).find((n) => n.props && 'actions' in n.props)?.props.actions);
  const open = headActions(t).find((n) => n.type === 'button' && text(n) === 'Open assessment');
  assert.ok(open, 'the assigned interviewer has a way in');
  open.props.onClick(); t = page.render();
  const drawer = nodes(t).find((n) => n.type === InterviewAssessmentDrawer);
  assert.ok(drawer && drawer.props.applicationId === 7);
  const d = mount(InterviewAssessmentDrawer, drawer.props); const dt = d.render();
  const panel = nodes(dt).find((n) => n.type === AssessmentPanel);
  assert.ok(panel && panel.props.app.id === 7 && panel.props.canFeedback === true);
  d.dispose(); page.dispose();
  const viewer = mount(InterviewDetail, { id: 3, user: { ...user, permissions: ['interview.view_assigned'] }, onBack() {} }); viewer.render(); await flush();
  const vt = viewer.render();
  assert.ok(headActions(vt).length >= 0 && nodes(vt).some((n) => n.props && 'actions' in n.props), 'page head rendered');
  assert.equal(headActions(vt).some((n) => n.type === 'button' && text(n) === 'Open assessment'), false, 'no candidate.view, no button');
  viewer.dispose(); api.get = realGet;
});

await check('settings: the matrix shows each audience, toggles cascade, and Save sends the overrides the server will enforce', async () => {
  const policy = {
    audiences: [{ key: 'hr', label: 'HR / Recruitment' }, { key: 'technical', label: 'Technical Interviewer' }],
    sections: [
      { key: 'assessment.candidate', label: 'Candidate Personal Information', editable: false, fields: [{ key: 'assessment.candidate.currentSalary', label: 'Current Salary' }] },
      { key: 'assessment.behavioral', label: 'HR Assessment — Behavioral', editable: true, fields: [{ key: 'assessment.behavioral.openness', label: 'Openness' }] },
    ],
    defaults: { hr: { 'assessment.candidate.currentSalary': { view: true, edit: false }, 'assessment.behavioral': { view: true, edit: true } }, technical: { 'assessment.candidate.currentSalary': { view: false, edit: false }, 'assessment.behavioral': { view: false, edit: false } } },
    overrides: {},
  };
  const puts = [];
  api.get = async () => ({ policy });
  api.put = async (p, body) => { puts.push({ p, body }); return { policy: { ...policy, overrides: body.overrides } }; };
  const page = mount(AssessmentPolicyPage, { user: {} }); page.render(); await flush(); let t = page.render();
  const box = (name) => nodes(t).find((n) => n.type === 'input' && n.props['aria-label'] === name);
  assert.equal(box('Technical Interviewer: view Current Salary').props.checked, false);
  assert.equal(box('Technical Interviewer: edit Current Salary'), undefined, 'candidate details are never editable here');
  assert.equal(box('Technical Interviewer: view HR Assessment — Behavioral').props.checked, false);
  box('Technical Interviewer: view HR Assessment — Behavioral').props.onChange({ target: { checked: true } }); t = page.render();
  assert.equal(box('Technical Interviewer: view HR Assessment — Behavioral').props.checked, true);
  assert.equal(box('Technical Interviewer: edit HR Assessment — Behavioral').props.checked, false, 'read-only, not editable');
  box('HR / Recruitment: view HR Assessment — Behavioral').props.onChange({ target: { checked: false } }); t = page.render();
  assert.equal(box('HR / Recruitment: edit HR Assessment — Behavioral').props.checked, false, 'hiding also removes edit');
  const headBtn = (tree, label) => nodes(nodes(tree).find((n) => n.props && 'actions' in n.props)?.props.actions).find((n) => n.type === 'button' && text(n) === label);
  assert.equal(headBtn(t, 'Save changes').props.disabled, false, 'unsaved changes enable Save');
  await headBtn(t, 'Save changes').props.onClick(); await flush();
  eq(puts[0], { p: '/assessments/policy', body: { overrides: { technical: { 'assessment.behavioral': { view: true, edit: false } }, hr: { 'assessment.behavioral': { view: false, edit: false } } } } });
  t = page.render();
  assert.equal(headBtn(t, 'Save changes').props.disabled, true, 'saved state is clean');
  confirmAnswer = true; await headBtn(t, 'Restore defaults').props.onClick(); await flush(); confirmAnswer = false;
  eq(puts[1].body, { overrides: {} });
  page.dispose(); api.get = realGet; api.put = realPut;
});

console.log(`\n=== UI ASSESSMENT: ${passed} passed ===\n`);
