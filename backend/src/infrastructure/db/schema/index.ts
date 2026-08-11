// Physical schema — the single import point for Drizzle Kit and repositories.
//
// This barrel and every file it re-exports import NOTHING from `modules/`.
// `boundary.test.ts` enforces that mechanically: the schema describes storage,
// the domain describes rules, and neither is allowed to learn about the other.

// NOTE ON IMPORT STYLE: files in this folder use EXTENSIONLESS relative imports
// (`./hiring`, not `./hiring.js`) — the rest of the codebase uses `.js`.
// Drizzle Kit bundles the schema through a CJS require path that cannot resolve
// a `.js` specifier back to `.ts`. `moduleResolution: bundler` accepts both, so
// this is contained to this folder and nothing else changes.

export * from './hiring';
export * from './interview';
export * from './offer';
export * from './platform';
export * from './talent';
export * from './ai';
export * from './matching';

/**
 * Named sequences for business identifiers.
 *
 * Created in the migration, not by Drizzle (it has no sequence primitive).
 * Repositories read them via `SELECT nextval(...)` in `nextTicketNo()` etc.
 *
 * These replace the legacy read-modify-write on a settings row, which produced
 * duplicate offer numbers on legal documents the moment two requests overlapped
 * (Audit #1 F-09). A sequence cannot collide.
 */
export const SEQUENCES = {
  requisitionTicketNo: 'seq_requisition_ticket_no',
  applicationNo: 'seq_application_no',
  interviewNo: 'seq_interview_no',
  offerNo: 'seq_offer_no',
  candidateNo: 'seq_candidate_no',
} as const;

/**
 * Surrogate-key sequences created implicitly by `bigserial`.
 *
 * `nextId()` allocates the identity BEFORE the aggregate is constructed, so an
 * aggregate is never in a half-formed state with a placeholder id.
 */
export const ID_SEQUENCES = {
  hiringRequisition: 'hiring_requisition_id_seq',
  hiringSeat: 'hiring_seat_id_seq',
  hiringApplication: 'hiring_application_id_seq',
  hiringStageHistory: 'hiring_stage_history_id_seq',
  interview: 'interview_id_seq',
  interviewPanel: 'interview_panel_id_seq',
  interviewAssessment: 'interview_assessment_id_seq',
  offer: 'offer_id_seq',
  offerCompensationLine: 'offer_compensation_line_id_seq',
  outboxEvent: 'outbox_event_id_seq',
  timelineEntry: 'timeline_entry_id_seq',
  candidate: 'candidate_id_seq',
  candidateDocument: 'candidate_document_id_seq',
  candidateProposal: 'candidate_proposal_id_seq',
  aiTask: 'ai_task_id_seq',
  cvIntakeBatch: 'cv_intake_batch_id_seq',
  cvIntakeItem: 'cv_intake_item_id_seq',
  candidateMatch: 'candidate_match_id_seq',
} as const;
