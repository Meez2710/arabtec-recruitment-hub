// Arabtec Construction — Interview Assessment Form
// Based on the official HR assessment document (Big Five Model + Technical Competency).
//
// Two evaluations per application: one HR (behavioral) + one Technical (competency).
// A final recommendation is derived from both scores.

// ── Criteria Definitions ──────────────────────────────────────────────────

export const HR_CRITERIA = [
  {
    key: 'openness',
    label: 'Openness',
    description: 'Adaptability, learning agility, response to new systems and processes.',
  },
  {
    key: 'conscientiousness',
    label: 'Conscientiousness',
    description: 'Reliability, follow-through, accountability, documentation discipline.',
  },
  {
    key: 'extraversion',
    label: 'Extraversion',
    description: 'Communication clarity, assertiveness, stakeholder coordination.',
  },
  {
    key: 'agreeableness',
    label: 'Agreeableness',
    description: 'Cooperation, respect, teamwork without passivity.',
  },
  {
    key: 'emotional_stability',
    label: 'Emotional Stability',
    description: 'Composure under pressure, stress tolerance, conflict response.',
  },
];

export const TECHNICAL_CRITERIA = [
  {
    key: 'technical_knowledge',
    label: 'Technical Knowledge',
    description: 'Role-specific expertise and depth of knowledge for the position.',
  },
  {
    key: 'relevant_experience',
    label: 'Relevant Experience',
    description: 'Years, project complexity and similarity to current scope.',
  },
  {
    key: 'problem_solving',
    label: 'Problem-Solving',
    description: 'Critical thinking, structured approach, sound decision-making.',
  },
  {
    key: 'tools_software',
    label: 'Tools & Software',
    description: 'Proficiency with role-required software, systems and tools.',
  },
  {
    key: 'planning_organizing',
    label: 'Planning & Organizing',
    description: 'Prioritization, scheduling, resource and risk management.',
  },
];

// ── Score Guide ───────────────────────────────────────────────────────────

export const SCORE_GUIDE = {
  5: 'Excellent',
  4: 'Proficient',
  3: 'Average',
  2: 'Below Standard',
  1: 'Unsuitable',
};

export const SCORE_OPTIONS = [1, 2, 3, 4, 5];

// ── Critical Flags ────────────────────────────────────────────────────────

export const CRITICAL_FLAGS = [
  { key: 'blaming', label: 'Repeated blaming of others or no ownership' },
  { key: 'no_evidence', label: 'No specific examples or evidence provided' },
  { key: 'cv_inconsistency', label: 'Inconsistencies between CV and stated experience' },
];

// ── Decision Options ──────────────────────────────────────────────────────

export const DECISIONS = [
  { value: 'proceed', label: 'Proceed' },
  { value: 'proceed_conditions', label: 'Proceed with Conditions' },
  { value: 'hold', label: 'Hold' },
  { value: 'cv_pool', label: 'CV Pool' },
  { value: 'reject', label: 'Reject' },
];

// ── Fit Ratings (thresholds) ──────────────────────────────────────────────

export const FIT_LEVELS = [
  { value: 'strong', label: 'Strong', min: 4.2, color: '#1f7a44' },
  { value: 'acceptable', label: 'Acceptable', min: 3.5, color: '#b7791f' },
  { value: 'borderline', label: 'Borderline', min: 3.0, color: '#b7791f' },
  { value: 'weak', label: 'Weak', min: 0, color: '#c0392b' },
];

// ── Scoring Helpers ───────────────────────────────────────────────────────

export function averageScore(scores) {
  if (!scores || typeof scores !== 'object') return null;
  const vals = Object.values(scores).filter(v => typeof v === 'number' && v >= 1 && v <= 5);
  if (!vals.length) return null;
  return parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
}

export function fitLevel(avg) {
  if (avg == null) return null;
  for (const f of FIT_LEVELS) {
    if (avg >= f.min) return f;
  }
  return FIT_LEVELS[FIT_LEVELS.length - 1];
}

export function overallAverage(hrScore, techScore) {
  const vals = [hrScore, techScore].filter(v => typeof v === 'number');
  if (!vals.length) return null;
  return parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
}

// Suggest next pipeline stage from combined scores
export function suggestStage(hrAvg, techAvg) {
  const overall = overallAverage(hrAvg, techAvg);
  if (overall == null) return null;
  if (overall >= 4.2) return 'offer';
  if (overall >= 3.5) return 'interview_technical';
  if (overall >= 3.0) return 'screening';
  return 'rejected';
}

// ── Printable Assessment HTML (matches the Arabtec PDF template) ──────────

export function assessmentHtml({ candidateName, position, department, interviewDate,
  education, yearsExperience, currentEmployer, noticePeriod, currentSalary, expectedSalary,
  hrScores, hrNotes, techScores, techNotes, criticalFlags,
  hrInterviewer, techInterviewer, finalDecider,
  hrFit, techFit, hrJustification, techJustification, decision,
}) {
  const name = candidateName || '—';
  const pos = position || '—';
  const dept = department || '—';
  const date = interviewDate || new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const hrAvg = averageScore(hrScores);
  const techAvg = averageScore(techScores);
  const overall = overallAverage(hrAvg, techAvg);
  const suggested = suggestStage(hrAvg, techAvg);

  function scoreCell(key, scores) {
    const val = scores?.[key];
    return val ? `${val} — ${SCORE_GUIDE[val]}` : '—';
  }

  function criteriaRows(criteria, scores, notes) {
    return criteria.map(c => `
      <tr>
        <td>${c.label}</td>
        <td style="font-size:11px;color:#555;">${c.description}</td>
        <td style="text-align:center;font-weight:700;">${scoreCell(c.key, scores)}</td>
        <td style="font-size:11px;">${notes?.[c.key] || '—'}</td>
      </tr>
    `).join('');
  }

  function flagsHtml(flags) {
    if (!flags || !Object.values(flags).some(Boolean)) return '<p>None flagged</p>';
    return CRITICAL_FLAGS.filter(f => flags[f.key]).map(f => `<div>☒ ${f.label}</div>`).join('');
  }

  return `<!doctype html><html dir="ltr"><head><meta charset="UTF-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Times New Roman',Georgia,serif;color:#1a1a1a;max-width:750px;margin:0 auto;padding:30px}
  .letterhead{border-bottom:3px solid #d2232a;padding-bottom:12px;margin-bottom:20px;text-align:center}
  .letterhead .title{font-size:16px;font-weight:700;letter-spacing:1px}
  .letterhead .sub{font-size:11px;color:#666;margin-top:4px}
  h2{font-size:14px;border-bottom:1px solid #ccc;padding-bottom:4px;margin:20px 0 10px}
  table{width:100%;border-collapse:collapse;font-size:12px;margin:10px 0}
  th,td{border:1px solid #ccc;padding:5px 8px;text-align:left;vertical-align:top}
  th{background:#f5f5f5;font-size:11px}
  .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;margin:10px 0}
  .info-grid div span:first-child{color:#666;font-size:10px;display:block}
  .score-legend{font-size:10px;color:#666;margin:8px 0}
  .section{margin:16px 0}
  .sign-section{margin-top:40px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;font-size:12px}
  .sign-line{border-top:1px solid #999;padding-top:4px;margin-top:30px}
  .fit-box{display:inline-block;padding:4px 12px;border:1px solid #999;margin:2px 4px;font-size:11px}
  .fit-box.checked{background:#d2232a;color:#fff;border-color:#d2232a}
  @media print{body{padding:15px}}
</style></head><body>

<div class="letterhead">
  <div class="title">ARABTEC CONSTRUCTION</div>
  <div class="sub">HUMAN RESOURCES DEPARTMENT<br>INTERVIEW ASSESSMENT FORM</div>
</div>

<h2>Candidate Information</h2>
<div class="info-grid">
  <div><span>Full Name</span>${name}</div>
  <div><span>Position Applied For</span>${pos}</div>
  <div><span>Department</span>${dept}</div>
  <div><span>Interview Date</span>${date}</div>
  <div><span>Education</span>${education || '—'}</div>
  <div><span>Years of Experience</span>${yearsExperience || '—'}</div>
  <div><span>Current Employer</span>${currentEmployer || '—'}</div>
  <div><span>Notice / Availability</span>${noticePeriod || '—'}</div>
  <div><span>Current Salary</span>${currentSalary || '—'}</div>
  <div><span>Expected Salary</span>${expectedSalary || '—'}</div>
</div>

<h2>HR Assessment — Behavioral (Big Five Model)</h2>
<p style="font-size:11px;color:#555;margin-bottom:6px;">Score each trait based on specific examples and observed evidence.</p>
<table>
  <thead><tr><th>Criterion</th><th>What to Evaluate</th><th>Score</th><th>Notes</th></tr></thead>
  <tbody>${criteriaRows(HR_CRITERIA, hrScores, hrNotes)}</tbody>
</table>
<div style="text-align:right;font-weight:700;">HR Average: ${hrAvg != null ? hrAvg + ' / 5' : '—'}</div>
${hrJustification ? `<div style="margin-top:8px;font-size:12px;"><strong>HR Justification:</strong> ${hrJustification}</div>` : ''}

<h2>Technical Assessment — Role Competency</h2>
<table>
  <thead><tr><th>Criterion</th><th>What to Evaluate</th><th>Score</th><th>Notes</th></tr></thead>
  <tbody>${criteriaRows(TECHNICAL_CRITERIA, techScores, techNotes)}</tbody>
</table>
<div style="text-align:right;font-weight:700;">Technical Average: ${techAvg != null ? techAvg + ' / 5' : '—'}</div>
${techJustification ? `<div style="margin-top:8px;font-size:12px;"><strong>Technical Justification:</strong> ${techJustification}</div>` : ''}

<p class="score-legend"><strong>Score Guide:</strong> 5 Excellent • 4 Proficient • 3 Average • 2 Below Standard • 1 Unsuitable</p>

<h2>Critical Flags</h2>
<div style="font-size:12px;">${flagsHtml(criticalFlags)}</div>

<h2>Final Recommendation</h2>
<table>
  <tr><td style="width:30%"><strong>Decision</strong></td>
    <td>${DECISIONS.map(d => `<span class="fit-box ${d.value === decision ? 'checked' : ''}">${d.label}</span>`).join(' ')}</td></tr>
  <tr><td><strong>Behavioral Fit</strong></td>
    <td>${FIT_LEVELS.map(f => `<span class="fit-box ${hrFit === f.value ? 'checked' : ''}">${f.label} (${f.min}+)</span>`).join(' ')}</td></tr>
  <tr><td><strong>Technical Fit</strong></td>
    <td>${FIT_LEVELS.map(f => `<span class="fit-box ${techFit === f.value ? 'checked' : ''}">${f.label} (${f.min}+)</span>`).join(' ')}</td></tr>
</table>

<div style="margin-top:12px;font-size:13px;font-weight:700;">
  Overall Score: ${overall != null ? overall + ' / 5' : '—'}
  ${suggested ? ' — Suggested: Move to <span style="color:#d2232a;">' + suggested.replace(/_/g, ' ').toUpperCase() + '</span>' : ''}
</div>

<h2>Interview Signatures</h2>
<div class="sign-section">
  <div><div class="sign-line">${hrInterviewer || 'HR Interviewer'}<br><span style="font-size:10px;color:#666;">Name</span></div></div>
  <div><div class="sign-line">${techInterviewer || 'Technical Interviewer'}<br><span style="font-size:10px;color:#666;">Name</span></div></div>
  <div><div class="sign-line">${finalDecider || 'Final Decision'}<br><span style="font-size:10px;color:#666;">Signature &amp; Stamp</span></div></div>
</div>

</body></html>`;
}
