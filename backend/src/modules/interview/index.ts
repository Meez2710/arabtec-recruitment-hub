// Public surface of the Interview module.

export { InterviewService, INTERVIEW_PERMISSIONS } from './application/interview-service.js';
export type {
  InterviewServiceDeps, ScheduleInterviewInput, InterviewSummary,
  ScheduleConflict, ScheduleResult,
} from './application/interview-service.js';

export type {
  InterviewRepository, InterviewUnitOfWork, InterviewTransactionScope,
} from './application/ports.js';

export { INTERVIEW_STATUSES, INTERVIEW_MODES } from './domain/interview.js';
export type {
  InterviewStatus, InterviewMode, PanelMember, RecommendationSummary,
} from './domain/interview.js';

// The assessment sheet, transcribed. The form renders from these.
export {
  BEHAVIOURAL_CRITERIA, TECHNICAL_CRITERIA, CRITICAL_FLAGS,
  DECISIONS, DECISION_LABELS, FIT_BANDS, SCORE_GUIDE,
  averageScore, completeness, criteriaFor, fitBandFor, hasAnyCriticalFlag,
} from './domain/assessment.js';
export type {
  Assessment, Criterion, Decision, EvaluatorRole, FitBand, Score, ScoreValue,
} from './domain/assessment.js';

export { INTERVIEW_EVENTS, INTERVIEW_EVENT_TYPES, isInterviewEventType } from './domain/events.js';
export type { InterviewEventType } from './domain/events.js';

export {
  AssessmentNotAllowedError, DuplicateAssessmentError, IllegalInterviewTransitionError,
  InterviewDomainError, InterviewReasonRequiredError, InvalidScoreError,
  NotAPanellistError, PanelRequiredError, SlotInPastError,
} from './domain/errors.js';
export type { InterviewErrorCode } from './domain/errors.js';
