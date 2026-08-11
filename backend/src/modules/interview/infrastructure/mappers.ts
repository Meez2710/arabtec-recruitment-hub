// Interview context — row <-> props mappers. Pure, total, no decisions.

import type {
  interview, interviewAssessment, interviewPanel,
} from '../../../infrastructure/db/schema/index.js';
import type { InterviewProps, PanelMember } from '../domain/interview.js';
import type { Assessment, Score } from '../domain/assessment.js';

export type InterviewRow = typeof interview.$inferSelect;
export type InterviewInsert = typeof interview.$inferInsert;
export type PanelRow = typeof interviewPanel.$inferSelect;
export type PanelInsert = typeof interviewPanel.$inferInsert;
export type AssessmentRow = typeof interviewAssessment.$inferSelect;
export type AssessmentInsert = typeof interviewAssessment.$inferInsert;

/**
 * jsonb -> typed record. The criteria set is CONFIGURATION (it comes from the
 * assessment sheet), so the keys are open by design and the cast is the storage
 * boundary's unavoidable leap of faith. Confined here; nothing downstream casts.
 */
const asScores = (raw: unknown): Readonly<Record<string, Score>> =>
  (raw ?? {}) as Readonly<Record<string, Score>>;

const asFlags = (raw: unknown): Readonly<Record<string, boolean>> =>
  (raw ?? {}) as Readonly<Record<string, boolean>>;

export const interviewToProps = (
  row: InterviewRow,
  panel: readonly PanelRow[],
  assessments: readonly AssessmentRow[],
): InterviewProps => ({
  id: row.id,
  tenantId: row.tenantId,
  interviewNo: row.interviewNo,
  applicationId: row.applicationId,
  candidateId: row.candidateId,
  requisitionId: row.requisitionId,
  round: row.round,
  mode: row.mode,
  startsAt: row.startsAt,
  durationMinutes: row.durationMinutes,
  locationOrLink: row.locationOrLink,
  organiserUserId: row.organiserUserId,
  status: row.status,
  // Lead first, then by user id. Stable ordering matters: the aggregate
  // normalises to exactly one lead, and a reload that reshuffled the panel would
  // make `toState()` differ from what was saved for no reason.
  panel: [...panel]
    .sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.userId - b.userId)
    .map(panelToProps),
  assessments: [...assessments]
    .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime() || a.id - b.id)
    .map(assessmentToProps),
  rescheduleCount: row.rescheduleCount,
  lastRescheduledAt: row.lastRescheduledAt,
  cancelReason: row.cancelReason,
  externalEventId: row.externalEventId,
  version: row.version,
});

export const panelToProps = (row: PanelRow): PanelMember => ({
  userId: row.userId,
  role: row.role,
  isLead: row.isLead,
});

export const assessmentToProps = (row: AssessmentRow): Assessment => ({
  evaluatorRole: row.evaluatorRole,
  evaluatorUserId: row.evaluatorUserId,
  evaluatorName: row.evaluatorName,
  scores: asScores(row.scores),
  criticalFlags: asFlags(row.criticalFlags),
  justification: row.justification,
  submittedAt: row.submittedAt,
});

export const interviewToRow = (p: InterviewProps): InterviewInsert => ({
  id: p.id,
  tenantId: p.tenantId,
  interviewNo: p.interviewNo,
  applicationId: p.applicationId,
  candidateId: p.candidateId,
  requisitionId: p.requisitionId,
  round: p.round,
  mode: p.mode,
  startsAt: p.startsAt,
  durationMinutes: p.durationMinutes,
  locationOrLink: p.locationOrLink,
  organiserUserId: p.organiserUserId,
  status: p.status,
  rescheduleCount: p.rescheduleCount,
  lastRescheduledAt: p.lastRescheduledAt,
  cancelReason: p.cancelReason,
  externalEventId: p.externalEventId,
  version: p.version,
});

export const panelToRow = (interviewId: number, m: PanelMember): PanelInsert => ({
  interviewId,
  userId: m.userId,
  role: m.role,
  isLead: m.isLead,
});

export const assessmentToRow = (interviewId: number, a: Assessment): AssessmentInsert => ({
  interviewId,
  evaluatorUserId: a.evaluatorUserId,
  evaluatorRole: a.evaluatorRole,
  evaluatorName: a.evaluatorName,
  scores: a.scores,
  criticalFlags: a.criticalFlags,
  justification: a.justification,
  submittedAt: a.submittedAt,
});
