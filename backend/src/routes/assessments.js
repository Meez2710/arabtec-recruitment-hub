// Interview assessment (Arabtec form): HR + technical evaluations per application,
// unlocked once the candidate reaches an interview stage; plus a shared final decision.
import { Router } from 'express';
import { Assessments, Applications, Candidates, Requests, StageHistory } from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { appNorm } from '../lib/stages.js';

const router = Router();
router.use(requireAuth);

// Assessment unlocks once the candidate reaches interviewing and stays available downstream.
const INTERVIEW_STAGES = ['interviewing', 'waiting_feedback', 'issuing_offer', 'offer_sent', 'joined'];
const RECS = ['proceed', 'proceed_conditions', 'hold', 'cv_pool', 'reject'];
const FITS = ['strong', 'acceptable', 'borderline', 'weak'];
const FINAL = ['proceed', 'hold', 'reject', 'hired'];

function parse(a) {
  if (!a) return null;
  return {
    id: a.id, evaluatorType: a.evaluator_type, evaluatorId: a.evaluator_id, evaluatorName: a.evaluator_name,
    behavioral: a.behavioral ? JSON.parse(a.behavioral) : null,
    technical: a.technical ? JSON.parse(a.technical) : null,
    criticalFlags: a.critical_flags ? JSON.parse(a.critical_flags) : null,
    recommendation: a.recommendation, behavioralFit: a.behavioral_fit, technicalFit: a.technical_fit,
    behavioralJustification: a.behavioral_justification, technicalJustification: a.technical_justification,
    submitted: a.submitted === 1, updatedAt: a.updated_at,
  };
}

function bundle(appId) {
  const app = Applications.byId(appId);
  const cand = app ? Candidates.byId(app.candidate_id) : null;
  const req = app ? Requests.byId(app.request_id) : null;
  const list = Assessments.forApplication(appId);
  return {
    applicationId: appId,
    unlocked: app ? INTERVIEW_STAGES.includes(appNorm(app.status)) : false,
    candidate: cand ? { id: cand.id, fullName: cand.full_name, currentPosition: cand.current_position, yearsExperience: cand.years_experience, university: cand.university, major: cand.major, employer: cand.employer } : null,
    request: req ? { id: req.id, ticketNo: req.ticket_no, title: req.title } : null,
    hr: parse(list.find((x) => x.evaluator_type === 'hr')),
    technical: parse(list.find((x) => x.evaluator_type === 'technical')),
    finalDecision: (() => { const f = Assessments.finalDecision(appId); return f ? { decision: f.decision, decidedByName: f.decided_by_name, notes: f.notes, decidedAt: f.decided_at } : null; })(),
  };
}

/* GET assessment bundle for an application */
router.get('/application/:applicationId', requirePermission('candidate.view'), (req, res) => {
  const app = Applications.byId(Number(req.params.applicationId));
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  res.json({ assessment: bundle(app.id) });
});

/* Submit/update an evaluation (hr or technical) */
router.post('/application/:applicationId', requirePermission('interview.feedback'), (req, res) => {
  const app = Applications.byId(Number(req.params.applicationId));
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (!INTERVIEW_STAGES.includes(appNorm(app.status))) return res.status(409).json({ error: 'Assessment is available once the candidate reaches an interview stage.' });
  const d = req.body || {};
  const type = d.evaluatorType;
  if (!['hr', 'technical'].includes(type)) return res.status(400).json({ error: 'evaluatorType must be hr or technical.' });
  if (d.recommendation && !RECS.includes(d.recommendation)) return res.status(400).json({ error: 'Invalid recommendation.' });
  if (d.behavioralFit && !FITS.includes(d.behavioralFit)) return res.status(400).json({ error: 'Invalid behavioral fit.' });
  if (d.technicalFit && !FITS.includes(d.technicalFit)) return res.status(400).json({ error: 'Invalid technical fit.' });

  Assessments.upsert({ applicationId: app.id, evaluatorType: type, evaluatorId: req.user.id, evaluatorName: req.user.fullName, ...d });
  writeAudit(req, { action: 'assessment.submitted', entityType: 'application', entityId: app.id, newValue: { evaluatorType: type, recommendation: d.recommendation } });
  res.status(201).json({ assessment: bundle(app.id) });
});

/* Shared final decision (recruiter or technical interviewer / authorized roles) */
router.post('/application/:applicationId/final', requirePermission('interview.feedback'), (req, res) => {
  const app = Applications.byId(Number(req.params.applicationId));
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  const { decision, notes } = req.body || {};
  if (!FINAL.includes(decision)) return res.status(400).json({ error: 'Invalid final decision.' });
  Assessments.setFinalDecision({ applicationId: app.id, decision, decidedBy: req.user.id, decidedByName: req.user.fullName, notes });
  writeAudit(req, { action: 'assessment.final_decision', entityType: 'application', entityId: app.id, newValue: { decision }, comments: notes || null });
  res.status(201).json({ assessment: bundle(app.id) });
});

/* Form metadata (criteria + option lists matching the PDF) */
router.get('/meta', (req, res) => {
  res.json({
    behavioralCriteria: [
      { key: 'openness', label: 'Openness', hint: 'Adaptability, learning agility, response to new systems and processes.' },
      { key: 'conscientiousness', label: 'Conscientiousness', hint: 'Reliability, follow-through, accountability, documentation discipline.' },
      { key: 'extraversion', label: 'Extraversion', hint: 'Communication clarity, assertiveness, stakeholder coordination.' },
      { key: 'agreeableness', label: 'Agreeableness', hint: 'Cooperation, respect, teamwork without passivity.' },
      { key: 'emotional_stability', label: 'Emotional Stability', hint: 'Composure under pressure, stress tolerance, conflict response.' },
    ],
    technicalCriteria: [
      { key: 'technical_knowledge', label: 'Technical Knowledge', hint: 'Role-specific expertise and depth of knowledge for the position.' },
      { key: 'relevant_experience', label: 'Relevant Experience', hint: 'Years, project complexity and similarity to current scope.' },
      { key: 'problem_solving', label: 'Problem-Solving', hint: 'Critical thinking, structured approach, sound decision-making.' },
      { key: 'tools_software', label: 'Tools & Software', hint: 'Proficiency with role-required software, systems and tools.' },
      { key: 'planning_organizing', label: 'Planning & Organizing', hint: 'Prioritization, scheduling, resource and risk management.' },
    ],
    criticalFlags: [
      { key: 'blaming', label: 'Repeated blaming of others or no ownership' },
      { key: 'no_examples', label: 'No specific examples or evidence provided' },
      { key: 'cv_inconsistency', label: 'Inconsistencies between CV and stated experience' },
    ],
    recommendations: [
      { value: 'proceed', label: 'Proceed' }, { value: 'proceed_conditions', label: 'Proceed with Conditions' },
      { value: 'hold', label: 'Hold' }, { value: 'cv_pool', label: 'CV Pool' }, { value: 'reject', label: 'Reject' },
    ],
    fits: [
      { value: 'strong', label: 'Strong (4.2+)' }, { value: 'acceptable', label: 'Acceptable (3.5–4.1)' },
      { value: 'borderline', label: 'Borderline (3.0–3.4)' }, { value: 'weak', label: 'Weak (<3.0)' },
    ],
    finalDecisions: [
      { value: 'proceed', label: 'Proceed' }, { value: 'hold', label: 'Hold' }, { value: 'reject', label: 'Reject' }, { value: 'hired', label: 'Hired' },
    ],
    scoreGuide: '5 Excellent · 4 Proficient · 3 Average · 2 Below Standard · 1 Unsuitable · N/A Not Applicable',
  });
});

export default router;
