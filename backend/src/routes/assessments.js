// Arabtec Interview Assessment Form — Big Five (HR) + Role Competency (Technical)
// Matches the official Arabtec assessment PDF: two evaluations per application,
// critical flags, fit ratings, and a final recommendation.
import { Router } from 'express';
import { Assessments, Applications, Candidates, Requests, StageHistory } from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { appNorm } from '../lib/stages.js';
import {
  HR_CRITERIA, TECHNICAL_CRITERIA, CRITICAL_FLAGS,
  DECISIONS, FIT_LEVELS, SCORE_GUIDE,
  averageScore, fitLevel, overallAverage, suggestStage,
  assessmentHtml,
} from '../lib/assessment.js';

const router = Router();
router.use(requireAuth);

const INTERVIEW_STAGES = ['interviewing', 'waiting_feedback', 'issuing_offer', 'offer_sent', 'joined'];
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
  const validRecs = DECISIONS.map(d => d.value);
  const validFits = FIT_LEVELS.map(f => f.value);
  if (d.recommendation && !validRecs.includes(d.recommendation)) return res.status(400).json({ error: 'Invalid recommendation.' });
  if (d.behavioralFit && !validFits.includes(d.behavioralFit)) return res.status(400).json({ error: 'Invalid behavioral fit.' });
  if (d.technicalFit && !validFits.includes(d.technicalFit)) return res.status(400).json({ error: 'Invalid technical fit.' });

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
    behavioralCriteria: HR_CRITERIA,
    technicalCriteria: TECHNICAL_CRITERIA,
    criticalFlags: CRITICAL_FLAGS,
    decisions: DECISIONS,
    fitLevels: FIT_LEVELS,
    scoreGuide: SCORE_GUIDE,
  });
});

// Preview printable assessment form (HTML — open in browser, Ctrl+P to save as PDF)
router.get('/application/:applicationId/preview', requirePermission('candidate.view'), (req, res) => {
  const app = Applications.byId(Number(req.params.applicationId));
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  const cand = Candidates.byId(app.candidate_id);
  const reqObj = app.request_id ? Requests.byId(app.request_id) : null;
  const ass = Assessments.forApplication(app.id);
  const hrAss = ass?.hr;
  const techAss = ass?.technical;

  const html = assessmentHtml({
    candidateName: cand?.full_name,
    position: reqObj?.title || app.position_applied,
    department: reqObj?.department_id ? 'Engineering' : null,
    interviewDate: new Date().toISOString(),
    education: cand?.university,
    yearsExperience: cand?.years_experience,
    currentEmployer: cand?.current_company,
    noticePeriod: cand?.notice_period,
    currentSalary: null,
    expectedSalary: cand?.expected_salary,
    hrScores: hrAss?.behavioral || hrAss?.ratings || {},
    hrNotes: {},
    techScores: techAss?.technical || techAss?.ratings || {},
    techNotes: {},
    criticalFlags: hrAss?.critical_flags || {},
    hrFit: hrAss?.behavioral_fit || fitLevel(averageScore(hrAss?.behavioral || hrAss?.ratings))?.value,
    techFit: techAss?.technical_fit || fitLevel(averageScore(techAss?.technical || techAss?.ratings))?.value,
    hrJustification: hrAss?.behavioral_justification,
    techJustification: techAss?.technical_justification,
    decision: ass?.final?.decision,
    hrInterviewer: req.user?.fullName,
    techInterviewer: null,
    finalDecider: null,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

export default router;
