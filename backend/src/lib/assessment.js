// Arabtec Construction — Interview Assessment Form
// Reproduces the finalized Arabtec assessment PDF ("arabtec assesment finalized.pdf",
// 2 pages): HR Assessment — Behavioral (Big Five Model) and Technical Assessment —
// Role Competency, Critical Flags, and Final Recommendation.
//
// Two evaluations per application: one HR (behavioral) + one Technical (competency),
// plus one shared final human decision. Nothing here derives an overall score or a
// pipeline move: the PDF has neither.
//
// SCORE CONTRACT (canonical, written by this module's validator):
//   section JSON = { <criterionKey>: { score: 1..5 | "na", notes: string } }
//   An unanswered row is either absent or stored as { notes } with NO `score`
//   property (so a draft can keep evidence notes before a score is chosen).
//
// LEGACY READS (no stored history is rewritten):
//   - { score: null }  The previous form saved N/A as an explicit null score (it
//                      never stored unanswered rows at all), so a stored `score`
//                      property whose value is null means N/A. New writes never
//                      store `score: null`, which keeps the two meanings apart.
//   - 4                A bare integer 1..5 is a valid historical scalar score.
//   - anything else    Read as unanswered; it is never counted in an average.

// ── Criteria Definitions (exact PDF wording) ──────────────────────────────

export const HR_CRITERIA = [
  { key: 'openness', label: 'Openness', description: 'Adaptability, learning agility, response to new systems and processes.' },
  { key: 'conscientiousness', label: 'Conscientiousness', description: 'Reliability, follow-through, accountability, documentation discipline.' },
  { key: 'extraversion', label: 'Extraversion', description: 'Communication clarity, assertiveness, stakeholder coordination.' },
  { key: 'agreeableness', label: 'Agreeableness', description: 'Cooperation, respect, teamwork without passivity.' },
  { key: 'emotional_stability', label: 'Emotional Stability', description: 'Composure under pressure, stress tolerance, conflict response.' },
];

export const TECHNICAL_CRITERIA = [
  { key: 'technical_knowledge', label: 'Technical Knowledge', description: 'Role-specific expertise and depth of knowledge for the position.' },
  { key: 'relevant_experience', label: 'Relevant Experience', description: 'Years, project complexity and similarity to current scope.' },
  { key: 'problem_solving', label: 'Problem-Solving', description: 'Critical thinking, structured approach, sound decision-making.' },
  { key: 'tools_software', label: 'Tools & Software', description: 'Proficiency with role-required software, systems and tools.' },
  { key: 'planning_organizing', label: 'Planning & Organizing', description: 'Prioritization, scheduling, resource and risk management.' },
];

export const BEHAVIORAL_INSTRUCTION = 'Score each trait based on specific examples and observed evidence.';

// ── Score Guide ───────────────────────────────────────────────────────────

export const NA = 'na';
export const SCORE_GUIDE = {
  5: 'Excellent',
  4: 'Proficient',
  3: 'Average',
  2: 'Below Standard',
  1: 'Unsuitable',
};
export const NA_LABEL = 'Not Applicable';
export const SCORE_OPTIONS = [1, 2, 3, 4, 5];

// ── Critical Flags (exact PDF wording) ────────────────────────────────────

export const CRITICAL_FLAGS = [
  { key: 'blaming', label: 'Repeated blaming of others or no ownership' },
  { key: 'no_evidence', label: 'No specific examples or evidence provided' },
  { key: 'cv_inconsistency', label: 'Inconsistencies between CV and stated experience' },
];

// ── Decision Options (PDF Final Recommendation) ───────────────────────────
// Used for each evaluator's recommendation AND the shared final decision.

export const DECISIONS = [
  { value: 'proceed', label: 'Proceed' },
  { value: 'proceed_conditions', label: 'Proceed with Conditions' },
  { value: 'hold', label: 'Hold' },
  { value: 'cv_pool', label: 'CV Pool' },
  { value: 'reject', label: 'Reject' },
];
// Final decisions recorded before the PDF vocabulary. Read and shown as
// historical; never accepted on a new write and never converted.
export const LEGACY_FINAL_DECISIONS = [{ value: 'hired', label: 'Hired (historical)' }];

// ── Fit Ratings ───────────────────────────────────────────────────────────
// Classification applies to the DISPLAYED one-decimal average, which closes the
// PDF's fractional gaps (4.1 vs 4.2 etc.). That is a product rule, not PDF text.

export const FIT_LEVELS = [
  { value: 'strong', label: 'Strong', min: 4.2, range: '4.2 – 5.0', color: '#1f7a44' },
  { value: 'acceptable', label: 'Acceptable', min: 3.5, range: '3.5 – 4.1', color: '#b7791f' },
  { value: 'borderline', label: 'Borderline', min: 3.0, range: '3.0 – 3.4', color: '#b7791f' },
  { value: 'weak', label: 'Weak', min: 0, range: 'Below 3.0', color: '#c0392b' },
];

export const NOTES_MAX = 2000;
export const JUSTIFICATION_MAX = 4000;
export const FINAL_NOTES_MAX = 4000;

// ── Scoring Helpers ───────────────────────────────────────────────────────

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isScore = (v) => Number.isInteger(v) && v >= 1 && v <= 5;

/** Round a raw positive average once, half-up, to one decimal. */
export function roundAverage(raw) {
  if (raw == null || !Number.isFinite(raw)) return null;
  return Math.round(raw * 10) / 10;
}

/** Fit band object for an already-rounded average, or null when not rated. */
export function fitLevel(avg) {
  if (avg == null || !Number.isFinite(avg)) return null;
  for (const f of FIT_LEVELS) if (avg >= f.min) return f;
  return FIT_LEVELS[FIT_LEVELS.length - 1];
}

// A score from a normalized row, a legacy scalar, or a legacy {score} object.
function numericScore(v) {
  if (isScore(v)) return v;
  if (isPlainObject(v) && isScore(v.score)) return v.score;
  return null;
}

/** Rounded average of the numeric scores only (N/A and unanswered excluded). */
export function averageScore(scores) {
  if (!isPlainObject(scores)) return null;
  const vals = Object.values(scores).map(numericScore).filter((v) => v != null);
  if (!vals.length) return null;
  return roundAverage(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** Section summary from normalized rows for the given criteria. */
export function summarize(rows, criteria) {
  let sum = 0, scoredCount = 0, naCount = 0, unansweredCount = 0;
  for (const c of criteria) {
    const s = rows?.[c.key]?.score;
    if (isScore(s)) { sum += s; scoredCount++; }
    else if (s === NA) naCount++;
    else unansweredCount++;
  }
  const average = scoredCount ? roundAverage(sum / scoredCount) : null;
  const fit = fitLevel(average);
  return { average, scoredCount, naCount, unansweredCount, complete: unansweredCount === 0, fit: fit ? fit.value : null };
}

// ── Read normalization (stored JSON → canonical rows) ─────────────────────

/** Parse a stored JSON column without ever throwing. */
export function parseStored(text) {
  if (text == null || text === '') return null;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Canonical rows for every criterion from a stored section (see LEGACY READS).
 * Returns { rows, legacy } where `legacy` lists criterion keys read through a
 * historical representation (scalar score or `score: null` = N/A).
 */
export function normalizeStoredSection(raw, criteria) {
  const src = isPlainObject(raw) ? raw : {};
  const rows = {};
  const legacy = [];
  for (const c of criteria) {
    const v = src[c.key];
    let score = null, notes = '';
    if (isScore(v)) { score = v; legacy.push(c.key); }
    else if (isPlainObject(v)) {
      if (Object.prototype.hasOwnProperty.call(v, 'score')) {
        if (v.score === null) { score = NA; legacy.push(c.key); }
        else if (v.score === NA) score = NA;
        else if (isScore(v.score)) score = v.score;
      }
      if (typeof v.notes === 'string') notes = v.notes;
    }
    rows[c.key] = { score, notes };
  }
  return { rows, legacy };
}

export function normalizeStoredFlags(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const f of CRITICAL_FLAGS) out[f.key] = src[f.key] === true;
  return out;
}

// ── Write validation (request body → canonical, or an error) ──────────────

/**
 * Validate a client-sent section. Unanswered rows (score absent or null) are
 * allowed here — completeness is a separate submit rule.
 * Returns { rows, provided } (rows has every criterion; `provided` lists the
 * criterion keys the client actually sent) or { error }.
 */
export function validateSection(input, criteria) {
  const rows = {};
  const provided = [];
  for (const c of criteria) rows[c.key] = { score: null, notes: '' };
  if (input === undefined || input === null) return { rows, provided };
  if (!isPlainObject(input)) return { error: 'Scores must be an object keyed by criterion.' };
  const known = new Set(criteria.map((c) => c.key));
  for (const [key, val] of Object.entries(input)) {
    if (!known.has(key)) return { error: `Unknown criterion "${key}".` };
    if (!isPlainObject(val)) return { error: `Criterion "${key}" must be an object with score and notes.` };
    for (const prop of Object.keys(val)) {
      if (prop !== 'score' && prop !== 'notes') return { error: `Criterion "${key}" has an unknown field "${prop}".` };
    }
    let score = null;
    if (val.score === undefined || val.score === null) score = null;
    else if (val.score === NA) score = NA;
    else if (isScore(val.score)) score = val.score;
    else return { error: `Criterion "${key}" score must be a whole number from 1 to 5, or "na".` };
    let notes = '';
    if (val.notes !== undefined && val.notes !== null) {
      if (typeof val.notes !== 'string') return { error: `Criterion "${key}" notes must be text.` };
      if (val.notes.length > NOTES_MAX) return { error: `Criterion "${key}" notes exceed ${NOTES_MAX} characters.` };
      notes = val.notes;
    }
    rows[key] = { score, notes };
    provided.push(key);
  }
  return { rows, provided };
}

/** Canonical rows → the JSON object persisted (see SCORE CONTRACT). */
export function storableSection(rows, criteria) {
  const out = {};
  for (const c of criteria) {
    const r = rows[c.key];
    if (!r) continue;
    if (r.score != null) out[c.key] = { score: r.score, notes: r.notes || '' };
    else if (r.notes) out[c.key] = { notes: r.notes };
  }
  return out;
}

export function validateFlags(input) {
  const out = {};
  for (const f of CRITICAL_FLAGS) out[f.key] = false;
  if (input === undefined || input === null) return { flags: out };
  if (!isPlainObject(input)) return { error: 'Critical flags must be an object.' };
  const known = new Set(CRITICAL_FLAGS.map((f) => f.key));
  for (const [key, val] of Object.entries(input)) {
    if (!known.has(key)) return { error: `Unknown critical flag "${key}".` };
    if (typeof val !== 'boolean') return { error: `Critical flag "${key}" must be true or false.` };
    out[key] = val;
  }
  return { flags: out };
}

export const decisionLabel = (v) => [...DECISIONS, ...LEGACY_FINAL_DECISIONS].find((d) => d.value === v)?.label || null;
export const fitLabel = (v) => FIT_LEVELS.find((f) => f.value === v)?.label || null;

// ── Candidate Personal Information (PDF page 2 order and labels) ──────────
// `policy` is the assessment field-policy key that decides who sees each one.
export const CANDIDATE_FIELDS = [
  { policy: 'assessment.candidate.fullName', label: 'Full Name', context: 'fullName' },
  { policy: 'assessment.candidate.position', label: 'Position', context: 'position' },
  { policy: 'assessment.candidate.department', label: 'Department', context: 'department' },
  { policy: 'assessment.candidate.interviewDate', label: 'Interview Date', context: 'interview' },
  { policy: 'assessment.candidate.education', label: 'Education', context: 'education' },
  { policy: 'assessment.candidate.yearsExperience', label: 'Years of Experience', context: 'yearsExperience' },
  { policy: 'assessment.candidate.currentEmployer', label: 'Current Employer', context: 'currentEmployer' },
  { policy: 'assessment.candidate.availability', label: 'Notice / Availability', context: 'noticePeriod' },
  { policy: 'assessment.candidate.currentSalary', label: 'Current Salary', context: 'currentSalary', confidential: 'salary.view' },
  { policy: 'assessment.candidate.expectedSalary', label: 'Expected Salary', context: 'expectedSalary', confidential: 'salary.view' },
];

// ── Printable Assessment HTML ─────────────────────────────────────────────
// Rendered from the SAME policy-filtered, scope-checked bundle the UI
// receives: a field or section the viewer may not see is simply absent from
// the bundle, and absent here too — the layout reflows; nothing reads
// "Restricted". Every interpolated value goes through esc(); no supplied text is
// ever treated as markup. Signatures are blank lines — nothing is fabricated.

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const NOT_RECORDED = 'Not recorded';

function fmtUtc(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function scoreText(score) {
  if (score === NA) return `N/A — ${NA_LABEL}`;
  if (isScore(score)) return `${score} — ${SCORE_GUIDE[score]}`;
  return 'Not answered';
}

function statusText(ev) {
  if (!ev) return 'Not started';
  return ev.submitted ? 'Submitted' : 'Draft';
}

const SCORE_GUIDE_LINE = 'Score Guide: 5 Excellent • 4 Proficient • 3 Average • 2 Below Standard • 1 Unsuitable • N/A Not Applicable';
const box = (on, label) => `<span class="box${on ? ' on' : ''}">${on ? '☒' : '☐'} ${esc(label)}</span>`;

export function assessmentHtml(bundle) {
  const perms = bundle.permissions || null;
  const can = (key) => !perms || !!perms[key]?.canView;
  const ctx = bundle.context || {};
  const hr = bundle.hr;
  const tech = bundle.technical;
  const fd = bundle.finalDecision;
  const showHr = can('assessment.behavioral');
  const showTech = can('assessment.technical');
  const showFinal = can('assessment.finalRecommendation');
  const isDraft = (showHr && !hr?.submitted) || (showTech && !tech?.submitted);

  const valueOf = (f) => {
    const v = ctx[f.context];
    if (f.context === 'interview') return v ? `${fmtUtc(v.scheduledAt) || NOT_RECORDED} (${v.interviewNo}${v.status ? ', ' + v.status : ''})` : NOT_RECORDED;
    if (f.context === 'yearsExperience') return v == null ? NOT_RECORDED : `${v} years`;
    return v == null || v === '' ? NOT_RECORDED : v;
  };
  // Only fields present in the bundle AND visible under the policy are printed.
  const infoFields = CANDIDATE_FIELDS.filter((f) => can(f.policy) && Object.prototype.hasOwnProperty.call(ctx, f.context));
  const COVER = { fullName: 'Full Name', position: 'Position Applied For', department: 'Department', interview: 'Interview Date' };
  const coverFields = infoFields.filter((f) => COVER[f.context]).map((f) => ({ ...f, coverLabel: COVER[f.context] }));

  function section(title, criteria, ev, instruction, type) {
    const rows = ev?.rows || {};
    const visible = criteria.filter((c) => can(`assessment.${type}.${c.key.replace(/_([a-z])/g, (_, x) => x.toUpperCase())}`));
    const sum = ev?.summary;
    const meta = ev
      ? `${esc(statusText(ev))} · ${ev.submitted ? 'Completed' : 'Last saved'} by ${esc(ev.evaluatorName || NOT_RECORDED)} · ${esc(fmtUtc(ev.updatedAt) || NOT_RECORDED)}`
      : 'Not started';
    return `
<h2>${esc(title)}</h2>
<p class="meta">${meta}</p>
${instruction ? `<p class="muted">${esc(instruction)}</p>` : ''}
<table class="crit">
  <colgroup><col style="width:17%"><col style="width:35%"><col style="width:13%"><col style="width:35%"></colgroup>
  <thead><tr><th>Criterion</th><th>What to Evaluate</th><th>Score 1–5</th><th>Notes</th></tr></thead>
  <tbody>${visible.map((c) => `
    <tr><td>${esc(c.label)}</td><td>${esc(c.description)}</td>
      <td class="score">${esc(scoreText(rows[c.key]?.score))}</td>
      <td class="notes">${esc(rows[c.key]?.notes || '')}</td></tr>`).join('')}
  </tbody>
</table>
<p class="guide">${esc(SCORE_GUIDE_LINE)}</p>
${sum ? `<p class="summary">Average: ${sum.average != null ? esc(sum.average.toFixed(1)) + ' / 5' : 'Not rated'} · Scored: ${esc(sum.scoredCount)} · N/A: ${esc(sum.naCount)}${sum.unansweredCount ? ' · Unanswered: ' + esc(sum.unansweredCount) : ''}</p>` : ''}
${ev && sum && sum.scoredCount === 0 && sum.naCount > 0 ? '<p class="warn">No scored evidence — every answered criterion is N/A.</p>' : ''}`;
  }

  function flagsHtml() {
    const evs = [[showHr, hr, 'HR'], [showTech, tech, 'Technical']].filter(([show, ev]) => show && ev && ev.criticalFlags);
    const raisedBy = (key) => evs.filter(([, ev]) => ev.criticalFlags[key]).map(([, , who]) => who);
    const any = CRITICAL_FLAGS.some((f) => raisedBy(f.key).length);
    return `<p class="flags">${CRITICAL_FLAGS.map((f) => {
      const who = raisedBy(f.key);
      return `${box(who.length > 0, f.label)}${who.length ? ` <span class="muted">(${esc(who.join(', '))})</span>` : ''}`;
    }).join(' ')}</p>${any ? '<p class="warn">Review required</p>' : ''}`;
  }

  function fitLine(label, ev, justKey) {
    const fit = ev?.computedFit;
    const historical = ev?.fitHistorical ? ` <span class="muted">(previously recorded, historical: ${esc(fitLabel(ev.savedFit) || ev.savedFit)})</span>` : '';
    const ranges = { strong: '4.2+', acceptable: '3.5–4.1', borderline: '3.0–3.4', weak: '<3.0' };
    return `<p><strong>${esc(label)}:</strong> ${FIT_LEVELS.map((f) => box(fit === f.value, `${f.label} (${ranges[f.value]})`)).join(' ')}${historical}</p>
${ev?.recommendation ? `<p class="sub">Evaluator recommendation: ${esc(decisionLabel(ev.recommendation))}</p>` : ''}
${can(justKey) ? `<p class="sub">Justification / Key Strengths: <span class="line">${esc(ev?.justification || '')}</span></p>` : ''}`;
  }

  const finalHistorical = fd && LEGACY_FINAL_DECISIONS.some((d) => d.value === fd.decision)
    ? `<p class="muted">Recorded decision (historical vocabulary): ${esc(decisionLabel(fd.decision))}</p>` : '';
  const signer = (show, title, name, line) => show
    ? `<div>${esc(title)}<br><strong>${esc(name || NOT_RECORDED)}</strong><div class="line">${esc(line)}</div></div>` : '';

  return `<!doctype html><html dir="ltr" lang="en"><head><meta charset="UTF-8">
<title>Interview Assessment${can('assessment.candidate.fullName') && ctx.fullName ? ' — ' + esc(ctx.fullName) : ''}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;color:#1a1a1a;max-width:820px;margin:0 auto;padding:32px 36px;font-size:12px}
  .title{color:#b91c1c;font-weight:700;font-size:17px;text-align:center;letter-spacing:.2px;margin-bottom:18px}
  .draft{border:2px dashed #b91c1c;color:#b91c1c;font-weight:700;text-align:center;padding:6px;margin-bottom:14px}
  h2{color:#b91c1c;font-size:15px;font-weight:700;border-bottom:2px solid #b91c1c;padding-bottom:4px;margin:22px 0 8px}
  p{margin:6px 0}
  .meta{color:#555;font-size:11px}
  .muted{color:#666;font-size:11px}
  .warn{color:#b91c1c;font-weight:700}
  .info{display:grid;grid-template-columns:1fr 1fr;border:1px solid #c9c9c9}
  .info .cell{border:1px solid #c9c9c9;margin:-1px 0 0 -1px}
  .info .k{background:#b91c1c;color:#fff;font-weight:700;padding:5px 8px}
  .info .v{padding:6px 8px;min-height:26px}
  table{width:100%;border-collapse:collapse;margin:8px 0;table-layout:fixed}
  th{background:#b91c1c;color:#fff;text-align:left;font-weight:700;padding:5px 8px;border:1px solid #c9c9c9}
  td{border:1px solid #c9c9c9;padding:6px 8px;vertical-align:top;white-space:pre-wrap;word-wrap:break-word}
  td.score{font-weight:700}
  .guide{color:#777;font-size:10.5px}
  .summary{text-align:right;font-weight:700}
  .flags .box,.fit .box{margin-right:10px}
  .box{display:inline-block;white-space:nowrap}
  .box.on{font-weight:700;color:#b91c1c}
  .sub{margin-left:0}
  .line{border-bottom:1px solid #999;display:inline-block;min-width:60%;white-space:pre-wrap}
  .sign{margin-top:28px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
  .sign .line{display:block;border-top:1px solid #999;border-bottom:0;padding-top:4px;margin-top:34px;color:#666;font-size:10px}
  .cover{min-height:900px}
  .brand{color:#b91c1c;font-weight:700;font-size:20px;text-align:center}
  .dept{color:#666;text-align:center;margin-top:4px}
  .rule{border-top:3px solid #b91c1c;margin:18px 0 22px}
  .formtitle{font-weight:700;font-size:17px;text-align:center;margin-bottom:26px}
  .cf{margin:14px 0}
  @media print{body{padding:12px}.cover{min-height:0;page-break-after:always;break-after:page}}
</style></head><body>

<!-- Page 1 of the PDF: cover with candidate information and signatures. -->
<div class="cover">
  <div class="brand">ARABTEC CONSTRUCTION</div>
  <div class="dept">HUMAN RESOURCES DEPARTMENT</div>
  <div class="rule"></div>
  <div class="formtitle">INTERVIEW ASSESSMENT FORM</div>
  ${coverFields.length ? `<h2>Candidate Information</h2>${coverFields.map((f) => `<p class="cf"><strong>${esc(f.coverLabel || f.label)}:</strong> <span class="line">${esc(valueOf(f))}</span></p>`).join('')}` : ''}
  <h2>Interview Signatures</h2>
  <div class="sign">
    ${signer(showHr, 'HR Interviewer', hr?.evaluatorName, 'Name / Signature')}
    ${signer(showTech, 'Technical Interviewer', tech?.evaluatorName, 'Name / Signature')}
    ${signer(showFinal, 'Final Decision', fd?.decidedByName, 'Name / Signature & Stamp')}
  </div>
</div>

<!-- Page 2 of the PDF: the assessment itself. -->
<div class="title">ARABTEC CONSTRUCTION — ASSESSMENT &amp; EVALUATION</div>
${isDraft ? '<div class="draft">DRAFT PREVIEW — not every evaluation has been submitted</div>' : ''}

${infoFields.length ? `<h2>Candidate Personal Information</h2>
<div class="info">${infoFields.map((f) => `<div class="cell"><div class="k">${esc(f.label)}</div><div class="v">${esc(valueOf(f))}</div></div>`).join('')}</div>` : ''}

${showHr ? section('HR Assessment — Behavioral (Big Five Model)', HR_CRITERIA, hr, BEHAVIORAL_INSTRUCTION, 'behavioral') : ''}
${showTech ? section('Technical Assessment — Role Competency', TECHNICAL_CRITERIA, tech, null, 'technical') : ''}

${can('assessment.criticalFlags') && (showHr || showTech) ? `<h2>Critical Flags — Review if Any Are True</h2>${flagsHtml()}` : ''}

${showFinal ? `<h2>Final Recommendation</h2>
<p><strong>Decision:</strong> ${DECISIONS.map((d) => box(fd?.decision === d.value, d.label)).join(' ')}</p>
${finalHistorical}
<p class="muted">${fd ? `Recorded by ${esc(fd.decidedByName || NOT_RECORDED)} · ${esc(fmtUtc(fd.decidedAt) || NOT_RECORDED)}` : 'No final decision recorded'}</p>
${fd?.notes ? `<p><strong>Notes:</strong> ${esc(fd.notes)}</p>` : ''}
${showHr ? fitLine('Behavioral Fit', hr, 'assessment.finalRecommendation.behavioralJustification') : ''}
${showTech ? fitLine('Technical Fit', tech, 'assessment.finalRecommendation.technicalJustification') : ''}` : ''}

</body></html>`;
}
