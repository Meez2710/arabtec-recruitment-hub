// Formal event catalogue for the Interview context.
// Same contract as Hiring: emitted by constant, payload carries what a
// subscriber needs without a follow-up query.

export const INTERVIEW_EVENTS = {
  INTERVIEW_SCHEDULED: 'InterviewScheduled',
  INTERVIEW_RESCHEDULED: 'InterviewRescheduled',
  INTERVIEW_STATUS_CHANGED: 'InterviewStatusChanged',
  PANEL_CHANGED: 'InterviewPanelChanged',
  ASSESSMENT_RECORDED: 'InterviewAssessmentRecorded',
  ASSESSMENT_UPDATED: 'InterviewAssessmentUpdated',
} as const;

export type InterviewEventType = (typeof INTERVIEW_EVENTS)[keyof typeof INTERVIEW_EVENTS];

export const INTERVIEW_EVENT_TYPES: readonly InterviewEventType[] =
  Object.values(INTERVIEW_EVENTS);

export function isInterviewEventType(type: string): type is InterviewEventType {
  return (INTERVIEW_EVENT_TYPES as readonly string[]).includes(type);
}
