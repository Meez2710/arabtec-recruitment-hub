// Public surface of the Hiring module.
//
// Other modules import from HERE and nowhere else — never a repository, never a
// domain class, never a file under domain/ or application/. That boundary is
// what keeps tenancy, testing and eventual extraction a bounded change.
//
// Repository ADAPTERS are the exception, and they live inside this module (under
// infrastructure/, arriving with the persistence slice) precisely so the
// aggregate classes never have to leave it.

/* --------------------------------- services -------------------------------- */
export { HiringService } from './application/hiring-service.js';
export type {
  HiringServiceDeps,
  RecordHireInput,
  ReverseHireInput,
  HireResult,
} from './application/hiring-service.js';

/* ------------------------------ identity/scope ----------------------------- */
export { AuthContext, HIRING_PERMISSIONS } from './application/auth-context.js';
export type { AuthContextProps } from './application/auth-context.js';

/* ---------------------------------- ports ---------------------------------- */
export type { UnitOfWork, TransactionScope } from './application/ports/unit-of-work.js';
export type {
  RequisitionRepository,
  ApplicationRepository,
} from './application/ports/repositories.js';
export type {
  AICompletionRequest, AIProposal, AIService, AuditTimeline, EventBus,
  JobPriority, JobQueue, NotificationChannel, NotificationHub,
  NotificationRequest, TimelineEntry,
} from '../shared/kernel/ports.js';

/* ---------------------------------- errors --------------------------------- */
// Exported so the HTTP layer can map `code` to a status without parsing prose.
export {
  ApplicationError,
  ForbiddenError,
  NotFoundError,
  StaleAggregateError,
} from '../shared/kernel/errors.js';
export type { ApplicationErrorCode } from '../shared/kernel/errors.js';

export {
  CandidateAlreadyHiredError,
  DomainError,
  HeadcountBelowFilledError,
  IllegalTransitionError,
  InvalidEntryStageError,
  InvariantViolationError,
  MissingReasonError,
  NoOpenSeatError,
  OutstandingOfferError,
  RequisitionNotOpenError,
  SeatNotFilledError,
  SelfApprovalError,
} from './domain/errors.js';
export type { DomainErrorCode } from './domain/errors.js';

/* --------------------------- vocabulary & catalogs -------------------------- */
// The board consumes the catalogs to grey out invalid drop targets and to know
// which drops need confirmation. Affordance only — the server re-validates every
// transition regardless of what the client believed was legal.
export {
  ALL_STAGES,
  ENTRY_STAGES,
  NON_PIPELINE_STAGES,
  PIPELINE_STAGES,
  STAGE_LABELS,
  TERMINAL_STAGES,
  transitionCatalog,
} from './domain/stages.js';
export type {
  ApplicationStage,
  EntryStage,
  PipelineStage,
  TransitionDescriptor,
  TransitionTrigger,
} from './domain/stages.js';

export {
  REQUISITION_STATES,
  STATE_LABELS,
  deriveFillState,
  displayStatus,
  requisitionCatalog,
} from './domain/requisition-states.js';
export type {
  FillState,
  RequisitionAction,
  RequisitionState,
  RequisitionTransition,
} from './domain/requisition-states.js';

/* ----------------------------- migration support ---------------------------- */
// Consumed once by the data migration, and on read as a safety net for rows
// written before it ran. Not consulted by application code.
export { LEGACY_STAGE_ALIASES } from './domain/stages.js';
export { LEGACY_STATE_ALIASES } from './domain/requisition-states.js';

/* ---------------------------------- events ---------------------------------- */
export type { Actor, DomainEvent, Clock } from '../shared/kernel/domain.js';
export { systemClock } from '../shared/kernel/domain.js';
export type { OfferGateway } from './application/ports/offer-gateway.js';

/**
 * The Hiring context's published operation. Interview and Offer drive pipeline
 * stages through this rather than writing a stage themselves (BL-14).
 */
export interface PipelineGateway {
  applySystemTransition(
    input: { applicationId: number; toStage: string; reason?: string },
    ctx: import('../shared/kernel/auth-context.js').AuthContext,
  ): Promise<unknown>;
}
